"""From LangGraph's stream to Polly's event protocol.

`translate` is a pure async generator: it consumes what
`agent.astream(..., stream_mode=["messages", "updates", "custom"], subgraphs=True)`
yields and produces the flat, JSON-friendly events the app renders. The
`RunManager` numbers them and fans them out; the desktop store applies them.

Event types (mirrored by `CoderEvent` in `apps/desktop/src/shared/contracts.ts`):

    message.delta       {message_id, agent, text?, reasoning?}
    message.completed   {message_id, agent, text, reasoning, tool_calls, usage?}
    tool.call           {call_id, agent, name, args, message_id}
    tool.result         {call_id, agent, name, status, output, duration_ms}
    subagent.started    {task_id, name, description, call_id}
    subagent.completed  {task_id, name, summary}
    approval.required   {interrupt_id, requests: [...]}
    todos.updated       {todos}
    file.changed        {path, kind, additions, deletions}
    usage               {input_tokens, output_tokens, total_tokens, run_total, context_tokens}
    compaction          {node}
    tool.streaming      {agent, name, artboard_id?}   a tool call still being written
    notice              {tone, text}   something the user should know about the run

A teammate at work (`agents/delegation.py`) sends the same events through the
lead's run, each marked `via` (the lead's `ask_teammate` call) and `teammate`
(its agent id).
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage

from polly_server.coder.permissions import kind_of

MAX_OUTPUT_CHARS = 20_000


def text_of(message: BaseMessage) -> str:
    try:
        return message.text or ""
    except Exception:  # noqa: BLE001 - odd content shapes from providers
        content = message.content
        return content if isinstance(content, str) else str(content)


def _reasoning_of(message: BaseMessage) -> str:
    value = message.additional_kwargs.get("reasoning_content") or ""
    return value if isinstance(value, str) else str(value)


REJECTED_PREFIX = "User rejected the tool call"
_ARTBOARD_ARG = re.compile(r'"artboard_id"\s*:\s*"([^"]+)"')


def tool_status(message: ToolMessage, output: str) -> str:
    """ok | error | blocked (by policy) | rejected (by the user)."""
    if message.status != "error":
        return "ok"
    if output.startswith(REJECTED_PREFIX):
        return "rejected"
    if output.startswith("Blocked:"):
        return "blocked"
    return "error"


def _clip(text: str) -> tuple[str, bool]:
    if len(text) > MAX_OUTPUT_CHARS:
        return text[:MAX_OUTPUT_CHARS] + "\n… (truncated)", True
    return text, False


def _usage(message: AIMessage) -> dict[str, int] | None:
    usage = getattr(message, "usage_metadata", None)
    if not usage:
        return None
    return {
        "input_tokens": int(usage.get("input_tokens", 0) or 0),
        "output_tokens": int(usage.get("output_tokens", 0) or 0),
        "total_tokens": int(usage.get("total_tokens", 0) or 0),
    }


def wire_message(message: BaseMessage) -> dict[str, Any] | None:
    """A stored message as the app shows it (used to reload a session)."""
    if isinstance(message, AIMessage):
        return {
            "role": "assistant",
            "id": message.id or uuid.uuid4().hex,
            "text": text_of(message),
            "reasoning": _reasoning_of(message),
            "tool_calls": [
                {"id": c.get("id"), "name": c.get("name"), "args": c.get("args") or {}}
                for c in (message.tool_calls or [])
            ],
            "usage": _usage(message),
        }
    if isinstance(message, ToolMessage):
        output, truncated = _clip(text_of(message))
        return {
            "role": "tool",
            "id": message.id or uuid.uuid4().hex,
            "call_id": message.tool_call_id,
            "name": message.name or "",
            "status": tool_status(message, output),
            "output": output,
            "truncated": truncated,
        }
    if message.type == "human":
        if message.additional_kwargs.get("polly_hidden"):
            return None  # a nudge Polly sent the model, not something the user said
        shown = message.additional_kwargs.get("polly_display") or text_of(message)
        return {"role": "user", "id": message.id or uuid.uuid4().hex, "text": shown}
    return None


def approval_payload(interrupt: Any) -> dict[str, Any]:
    """The `approval.required` event for a Deep Agents HITL interrupt."""
    # A checkpoint's pending write holds the interrupts as a list; the stream
    # hands them over one at a time.
    if isinstance(interrupt, list | tuple):
        interrupt = interrupt[0] if interrupt else {}
    value = getattr(interrupt, "value", interrupt) or {}
    requests = []
    for index, action in enumerate(value.get("action_requests") or []):
        name = action.get("name", "")
        args = action.get("args") or {}
        config = (value.get("review_configs") or [{}])[
            index if index < len(value.get("review_configs") or []) else 0
        ]
        requests.append(
            {
                "index": index,
                "name": name,
                "args": args,
                "description": action.get("description") or "",
                "allowed_decisions": config.get("allowed_decisions") or ["approve", "reject"],
                "kind": kind_of(name),
                "preview": {
                    "path": args.get("file_path"),
                    "command": args.get("command"),
                },
            }
        )
    return {
        "interrupt_id": getattr(interrupt, "id", None) or getattr(interrupt, "interrupt_id", None),
        "requests": requests,
    }


class _Translator:
    def __init__(self, *, main_agent: str) -> None:
        self.main_agent = main_agent
        self.run_total = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        self.context_tokens = 0
        # Open streaming messages, by agent name.
        self.open: dict[str, str] = {}
        # `task` calls that have not been matched to a subagent namespace yet.
        self.pending_tasks: list[dict[str, Any]] = []
        self.tasks_by_ns: dict[str, dict[str, Any]] = {}
        self.tasks_by_call: dict[str, dict[str, Any]] = {}
        self.call_started: dict[str, float] = {}
        # Tool calls the model is still writing: (message id, index) -> state.
        self.drafts: dict[tuple[str, int], dict[str, Any]] = {}
        self.call_names: dict[str, str] = {}

    # ---------- helpers ----------

    def _agent_for(self, ns: tuple[str, ...], metadata: dict[str, Any] | None) -> str:
        name = (metadata or {}).get("lc_agent_name")
        if name and name != self.main_agent:
            return str(name)
        if ns:
            task = self.tasks_by_ns.get(ns[0])
            if task:
                return str(task["name"])
            return "subagent"
        return self.main_agent

    def _subagent_events(self, ns: tuple[str, ...]) -> list[dict[str, Any]]:
        """First sight of a subgraph namespace: it is a subagent starting."""
        if not ns or ns[0] in self.tasks_by_ns:
            return []
        task = self.pending_tasks.pop(0) if self.pending_tasks else None
        if task is None:
            task = {
                "task_id": uuid.uuid4().hex,
                "name": "subagent",
                "description": "",
                "call_id": None,
            }
        self.tasks_by_ns[ns[0]] = task
        return [{"type": "subagent.started", **task}]

    # ---------- the three stream modes ----------

    def on_messages(self, ns: tuple[str, ...], data: Any) -> list[dict[str, Any]]:
        try:
            chunk, metadata = data
        except (TypeError, ValueError):
            return []
        if not isinstance(chunk, AIMessageChunk):
            return []
        if (metadata or {}).get("langgraph_node") != "model":
            return []  # summarisation and other side calls stay quiet
        text = text_of(chunk)
        reasoning = _reasoning_of(chunk)
        drafts = self._draft_events(chunk, self._agent_for(ns, metadata))
        if not text and not reasoning:
            return drafts
        events = self._subagent_events(ns) + drafts
        agent = self._agent_for(ns, metadata)
        message_id = chunk.id or self.open.get(agent) or uuid.uuid4().hex
        self.open[agent] = message_id
        payload: dict[str, Any] = {
            "type": "message.delta",
            "message_id": message_id,
            "agent": agent,
        }
        if text:
            payload["text"] = text
        if reasoning:
            payload["reasoning"] = reasoning
        events.append(payload)
        return events

    def _draft_events(self, chunk: AIMessageChunk, agent: str) -> list[dict[str, Any]]:
        """A long tool call (a whole artboard of HTML) takes a while to write.
        Say which tool is coming, and which artboard, as soon as it is known."""
        events: list[dict[str, Any]] = []
        for part in getattr(chunk, "tool_call_chunks", None) or []:
            key = (chunk.id or "", int(part.get("index") or 0))
            draft = self.drafts.setdefault(key, {"name": "", "args": "", "artboard": None})
            fresh = False
            if part.get("name") and not draft["name"]:
                draft["name"] = part["name"]
                fresh = True
            if draft["artboard"] is None and part.get("args"):
                draft["args"] = (draft["args"] + part["args"])[:400]
                found = _ARTBOARD_ARG.search(draft["args"])
                if found:
                    draft["artboard"] = found.group(1)
                    fresh = True
            if fresh and draft["name"]:
                event = {"type": "tool.streaming", "agent": agent, "name": draft["name"]}
                if draft["artboard"]:
                    event["artboard_id"] = draft["artboard"]
                events.append(event)
        return events

    def on_updates(self, ns: tuple[str, ...], data: Any) -> list[dict[str, Any]]:
        if not isinstance(data, dict):
            return []
        events: list[dict[str, Any]] = []
        for node, update in data.items():
            if node == "__interrupt__":
                for interrupt in update or ():
                    events.append({"type": "approval.required", **approval_payload(interrupt)})
                continue
            if not isinstance(update, dict):
                continue
            if "todos" in update and not ns:
                events.append({"type": "todos.updated", "todos": list(update["todos"] or [])})
            if node.startswith("SummarizationMiddleware") and update.get("messages"):
                events.append({"type": "compaction", "node": node})
            for message in update.get("messages") or []:
                events += self._subagent_events(ns)
                if isinstance(message, AIMessage) and not isinstance(message, AIMessageChunk):
                    events += self._on_ai_message(ns, message)
                elif isinstance(message, AIMessageChunk):
                    events += self._on_ai_message(ns, message)
                elif isinstance(message, ToolMessage):
                    events += self._on_tool_message(ns, message)
        return events

    def on_custom(self, ns: tuple[str, ...], data: Any) -> list[dict[str, Any]]:
        if isinstance(data, dict) and isinstance(data.get("type"), str):
            return [data]
        return []

    # ---------- messages ----------

    def _on_ai_message(self, ns: tuple[str, ...], message: AIMessage) -> list[dict[str, Any]]:
        agent = self._agent_for(ns, {"lc_agent_name": None})
        message_id = message.id or self.open.get(agent) or uuid.uuid4().hex
        self.open.pop(agent, None)
        events: list[dict[str, Any]] = []
        usage = _usage(message)
        tool_calls = []
        for call in message.tool_calls or []:
            call_id = call.get("id") or uuid.uuid4().hex
            name = call.get("name") or ""
            args = call.get("args") or {}
            tool_calls.append({"id": call_id, "name": name, "args": args})
            self.call_started[call_id] = time.monotonic()
            self.call_names[call_id] = name
            if name == "task":
                task = {
                    "task_id": uuid.uuid4().hex,
                    "name": str(args.get("subagent_type") or "subagent"),
                    "description": str(args.get("description") or ""),
                    "call_id": call_id,
                }
                self.pending_tasks.append(task)
                self.tasks_by_call[call_id] = task
        events.append(
            {
                "type": "message.completed",
                "message_id": message_id,
                "agent": agent,
                "text": text_of(message),
                "reasoning": _reasoning_of(message),
                "tool_calls": tool_calls,
                "usage": usage,
            }
        )
        for call in tool_calls:
            events.append(
                {
                    "type": "tool.call",
                    "agent": agent,
                    "message_id": message_id,
                    "call_id": call["id"],
                    "name": call["name"],
                    "args": call["args"],
                }
            )
        if usage:
            for key in self.run_total:
                self.run_total[key] += usage.get(key, 0)
            if agent == self.main_agent:
                self.context_tokens = usage["input_tokens"]
            events.append(
                {
                    "type": "usage",
                    **usage,
                    "run_total": dict(self.run_total),
                    "context_tokens": self.context_tokens,
                }
            )
        return events

    def _on_tool_message(self, ns: tuple[str, ...], message: ToolMessage) -> list[dict[str, Any]]:
        agent = self._agent_for(ns, None)
        call_id = message.tool_call_id
        output, truncated = _clip(text_of(message))
        started = self.call_started.pop(call_id, None)
        status = tool_status(message, output)
        events: list[dict[str, Any]] = [
            {
                "type": "tool.result",
                "agent": agent,
                "call_id": call_id,
                "name": message.name or self.call_names.pop(call_id, ""),
                "status": status,
                "output": output,
                "truncated": truncated,
                "duration_ms": int((time.monotonic() - started) * 1000) if started else None,
            }
        ]
        task = self.tasks_by_call.pop(call_id, None)
        if task:
            if task in self.pending_tasks:
                self.pending_tasks.remove(task)
            events.append(
                {
                    "type": "subagent.completed",
                    "task_id": task["task_id"],
                    "name": task["name"],
                    "summary": output,
                }
            )
        return events


async def translate(
    stream: AsyncIterator[Any], *, main_agent: str = "coder"
) -> AsyncIterator[dict[str, Any]]:
    """Turn a subgraph-aware, multi-mode LangGraph stream into Polly events."""
    tr = _Translator(main_agent=main_agent)
    async for item in stream:
        # With subgraphs=True and several modes: (namespace, mode, data).
        if not (isinstance(item, tuple) and len(item) == 3):
            continue
        ns, mode, data = item
        ns = tuple(ns or ())
        if mode == "messages":
            events = tr.on_messages(ns, data)
        elif mode == "updates":
            events = tr.on_updates(ns, data)
        elif mode == "custom":
            events = tr.on_custom(ns, data)
        else:
            events = []
        for event in events:
            yield event
