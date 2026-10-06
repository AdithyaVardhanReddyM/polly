"""Running agents: one background task per session, fanned out as SSE.

A run keeps going when the app disconnects (the user closed the window, or
reloaded); clients subscribe to its events from any sequence number. One run
per session at a time; starting another while one is live is a 409.

The Coder runs against a project; the other agents (Researcher, Deep
Research, Reviewer, change research) run without one. When a Coder run
finishes with changes, change research starts on its own (see
`research.chain`).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from polly_server import artifacts, sessions
from polly_server.agents import builders
from polly_server.coder import permissions
from polly_server.coder.agent import build_coder, tracker_for
from polly_server.coder.events import text_of, translate
from polly_server.config import settings
from polly_server.model_registry import get as model_spec
from polly_server.projects import Project
from polly_server.research import chain
from polly_server.sessions import Session

log = logging.getLogger(__name__)

KEEP_RUNS = 50  # finished runs kept in memory for late subscribers
# A reply the output limit cut off before it did anything gets one nudge to act.
CUT_OFF_RETRIES = 1
NUDGE = (
    "Your last reply hit the output limit while you were still thinking, so nothing "
    "happened and the user saw nothing. Keep your thinking to a few lines. Tell the "
    "user in one sentence what you will do, then make your first tool call now. Put "
    "long content (HTML, code, documents) in tool calls, never in your thinking, and "
    "write it in parts if it is large."
)


class SessionBusy(Exception):
    pass


class NothingToResearch(Exception):
    pass


class OutputLimitReached(Exception):
    """The model kept spending its output budget on thinking and never acted."""


def build_graph(project: Project | None, session: Session) -> Any:
    """The graph that runs a session: the Coder, or one of the other agents."""
    if session.agent_id == "coder":
        if project is None:
            raise LookupError("a Coder session needs a project")
        return build_coder(project, session)
    return builders.build_agent(session)


class Run:
    def __init__(self, session_id: str) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.session_id = session_id
        self.events: list[dict[str, Any]] = []
        self.done = False
        self.changed = asyncio.Condition()
        self.task: asyncio.Task | None = None

    async def push(self, event: dict[str, Any]) -> None:
        event["seq"] = len(self.events)
        event["run_id"] = self.id
        self.events.append(event)
        async with self.changed:
            self.changed.notify_all()

    async def finish(self) -> None:
        self.done = True
        async with self.changed:
            self.changed.notify_all()

    async def subscribe(self, after: int = -1) -> AsyncIterator[dict[str, Any]]:
        index = after + 1
        while True:
            while index < len(self.events):
                yield self.events[index]
                index += 1
            if self.done:
                return
            async with self.changed:
                await self.changed.wait()


def sse(event: dict[str, Any]) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event, default=str)}\n\n"


class RunManager:
    def __init__(self) -> None:
        self.active: dict[str, Run] = {}
        self.recent: dict[str, Run] = {}

    # ---------- public ----------

    def get(self, run_id: str) -> Run | None:
        for run in (*self.active.values(), *self.recent.values()):
            if run.id == run_id:
                return run
        return None

    def for_session(self, session_id: str) -> Run | None:
        return self.active.get(session_id) or self.recent.get(session_id)

    async def start(
        self,
        project: Project | None,
        session: Session,
        text: str,
        *,
        policy: permissions.Policy | None = None,
        display: str | None = None,
    ) -> Run:
        """Start a run. `display` replaces `text` in the transcript the user
        sees, for prompts Polly writes on their behalf."""
        extra = {"polly_display": display} if display else {}
        payload = {"messages": [HumanMessage(content=text, additional_kwargs=extra)]}
        if not session.title:
            session = sessions.update(session.id, title=sessions.title_from(display or text))
        return self._launch(project, session, payload, policy)

    async def resume(
        self, project: Project | None, session: Session, decisions: list[dict[str, Any]]
    ) -> Run:
        return self._launch(project, session, Command(resume={"decisions": decisions}), None)

    async def cancel(self, session_id: str) -> bool:
        run = self.active.get(session_id)
        if run is None or run.task is None:
            return False
        run.task.cancel()
        return True

    async def research_change(
        self, project: Project, session: Session, *, agent: Any = None, auto: bool = False
    ) -> Session:
        """Start change research for a Coder session's pending changes and
        return the new child session. `auto` skips a change set that was
        already researched."""
        if not settings.model_configured:
            raise NothingToResearch("NEBIUS_API_KEY is not set")
        if not builders.search_ready():
            raise NothingToResearch("TAVILY_API_KEY is not set; research needs web search")
        paths, diff, manifests = chain.diff_text(tracker_for(project, session))
        if not paths:
            raise NothingToResearch("this session has no pending changes")
        fingerprint = hashlib.sha256(diff.encode()).hexdigest()
        if auto and artifacts.load(session.id, "researched") == fingerprint:
            raise NothingToResearch("these changes were already researched")

        agent = agent or build_graph(project, session)
        state = await agent.aget_state({"configurable": {"thread_id": session.id}})
        messages = list((state.values or {}).get("messages") or [])
        asked, said = chain.conversation(messages)
        child = sessions.create(
            project.id,
            model=builders.default_model("change-research"),
            mode="plan",
            title=f"Research: {session.title or 'changes'}"[:80],
            agent_id="change-research",
            parent_session_id=session.id,
        )
        await self.start(
            project,
            child,
            chain.prompt(asked, said, paths, diff, manifests),
            display=chain.display(paths),
        )
        artifacts.save(session.id, "researched", fingerprint)
        return child

    # ---------- internals ----------

    def _launch(
        self,
        project: Project | None,
        session: Session,
        payload: Any,
        policy: permissions.Policy | None,
    ) -> Run:
        if session.id in self.active:
            raise SessionBusy(session.id)
        run = Run(session.id)
        self.active[session.id] = run
        run.task = asyncio.create_task(self._drive(run, project, session, payload, policy))
        return run

    async def _drive(
        self,
        run: Run,
        project: Project | None,
        session: Session,
        payload: Any,
        policy: permissions.Policy | None,
    ) -> None:
        status = "completed"
        error: str | None = None
        if policy is None:
            if session.agent_id == "coder" and project is not None:
                policy = permissions.policy_for(project, session.mode)
            else:
                policy = permissions.Policy(mode="plan")
        token = permissions.set_current_policy(policy)
        session_token = artifacts.set_current_session(session.id)
        context: dict[str, Any] = {
            "project_id": project.id if project else "",
            "project_path": project.path if project else "",
            "session_id": session.id,
            "mode": session.mode,
            "policy": policy,
        }
        usage = session.usage
        context_tokens = session.context_tokens
        interrupted = False
        started = time.time()
        agent: Any = None
        try:
            sessions.update(session.id, status="running", last_error=None)
            await run.push(
                {
                    "type": "run.started",
                    "session_id": session.id,
                    "agent_id": session.agent_id,
                    "model": session.model,
                    "mode": session.mode,
                }
            )
            agent = build_graph(project, session)
            config = {"configurable": {"thread_id": session.id}}
            # A resumed run replays the model message that paused it; its
            # tokens were already counted when it first streamed.
            replayed = isinstance(payload, Command)
            retries = 0
            while True:
                stream = agent.astream(
                    payload,
                    config=config,
                    context=context,
                    stream_mode=["messages", "updates", "custom"],
                    subgraphs=True,
                )
                async for event in translate(stream, main_agent=session.agent_id):
                    if event["type"] == "usage":
                        if replayed:
                            replayed = False
                            event["replayed"] = True
                        else:
                            usage = usage.add(event)
                        # A teammate's usage (`delegation.py`) counts towards the
                        # session but says nothing about the lead's context.
                        context_tokens = int(event.get("context_tokens") or context_tokens)
                        event["context_tokens"] = context_tokens
                        event["session_total"] = usage.model_dump()
                        event["context_window"] = _context_window(session.model)
                    if event["type"] == "approval.required":
                        interrupted = True
                    await run.push(event)
                if interrupted:
                    break
                cut = await _cut_off(agent, config)
                if cut is None:
                    break
                if cut == "silent" and retries < CUT_OFF_RETRIES:
                    retries += 1
                    await run.push(
                        {
                            "type": "notice",
                            "tone": "info",
                            "text": "The model ran out of room while thinking; "
                            "asking it to act now.",
                        }
                    )
                    nudge = HumanMessage(content=NUDGE, additional_kwargs={"polly_hidden": True})
                    payload = {"messages": [nudge]}
                    continue
                limit = _max_output(session.model)
                if cut == "silent":
                    raise OutputLimitReached(
                        f"The model used its whole output budget ({limit:,} tokens) thinking and "
                        "stopped before doing anything. Try again, or pick another model."
                    )
                await run.push(
                    {
                        "type": "notice",
                        "tone": "warn",
                        "text": "The reply was cut off at the model's output limit "
                        f"({limit:,} tokens).",
                    }
                )
                break
            if interrupted:
                status = "awaiting_approval"
        except asyncio.CancelledError:
            status = "cancelled"
        except OutputLimitReached as exc:
            status = "error"
            error = str(exc)
        except Exception as exc:  # noqa: BLE001 - surfaced to the user as an event
            log.exception("run %s failed", run.id)
            status = "error"
            error = f"{type(exc).__name__}: {exc}"
        finally:
            permissions.set_current_policy(None)
            try:
                permissions._policy_var.reset(token)
            except (ValueError, LookupError):
                pass
            session_status = {
                "completed": "idle",
                "cancelled": "idle",
                "awaiting_approval": "awaiting_approval",
                "error": "error",
            }[status]
            try:
                sessions.update(
                    session.id,
                    status=session_status,
                    usage=usage,
                    context_tokens=context_tokens,
                    last_error=error,
                )
            except LookupError:
                pass  # the session was deleted mid-run
            if project is not None and chain.wanted(project, session, policy, status):
                await self._follow_up(run, project, session, agent)
            artifacts.reset_current_session(session_token)
            await run.push(
                {
                    "type": "run.finished",
                    "status": status,
                    "error": error,
                    "duration_ms": int((time.time() - started) * 1000),
                }
            )
            await run.finish()
            self.active.pop(session.id, None)
            self.recent[session.id] = run
            while len(self.recent) > KEEP_RUNS:
                self.recent.pop(next(iter(self.recent)))

    async def _follow_up(self, run: Run, project: Project, session: Session, agent: Any) -> None:
        """Start change research after a Coder run, if there is something to
        research. Never fails the run that triggered it."""
        try:
            child = await self.research_change(project, session, agent=agent, auto=True)
        except NothingToResearch as why:
            log.info("no change research for %s: %s", session.id, why)
            return
        except Exception:  # noqa: BLE001 - research is a bonus, not part of the run
            log.exception("could not start change research for %s", session.id)
            return
        await run.push(
            {
                "type": "research.started",
                "session_id": child.id,
                "parent_session_id": session.id,
                "title": child.title,
            }
        )


async def _cut_off(agent: Any, config: dict[str, Any]) -> str | None:
    """Whether the run's last reply was stopped by the output limit: "silent"
    when it said and did nothing (all thinking), "truncated" when it said
    something; None when it ended on its own."""
    state = await agent.aget_state(config)
    messages = list((state.values or {}).get("messages") or [])
    last = messages[-1] if messages else None
    if not isinstance(last, AIMessage) or last.tool_calls:
        return None
    if (last.response_metadata or {}).get("finish_reason") != "length":
        return None
    return "truncated" if text_of(last).strip() else "silent"


def _max_output(model_id: str) -> int:
    try:
        return model_spec(model_id).max_output_tokens
    except LookupError:
        return 0


def _context_window(model_id: str) -> int | None:
    try:
        return model_spec(model_id).context_window
    except LookupError:
        return None


manager = RunManager()
