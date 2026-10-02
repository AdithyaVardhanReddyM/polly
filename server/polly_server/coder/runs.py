"""Running the Coder: one background task per session, fanned out as SSE.

A run keeps going when the app disconnects (the user closed the window, or
reloaded); clients subscribe to its events from any sequence number. One run
per session at a time; starting another while one is live is a 409.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import HumanMessage
from langgraph.types import Command

from polly_server import sessions
from polly_server.coder import permissions
from polly_server.coder.agent import build_coder
from polly_server.coder.context import CoderContext
from polly_server.coder.events import translate
from polly_server.model_registry import get as model_spec
from polly_server.projects import Project
from polly_server.sessions import Session

log = logging.getLogger(__name__)

KEEP_RUNS = 50  # finished runs kept in memory for late subscribers


class SessionBusy(Exception):
    pass


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
        project: Project,
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
        self, project: Project, session: Session, decisions: list[dict[str, Any]]
    ) -> Run:
        return self._launch(project, session, Command(resume={"decisions": decisions}), None)

    async def cancel(self, session_id: str) -> bool:
        run = self.active.get(session_id)
        if run is None or run.task is None:
            return False
        run.task.cancel()
        return True

    # ---------- internals ----------

    def _launch(
        self, project: Project, session: Session, payload: Any, policy: permissions.Policy | None
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
        project: Project,
        session: Session,
        payload: Any,
        policy: permissions.Policy | None,
    ) -> None:
        status = "completed"
        error: str | None = None
        policy = policy or permissions.policy_for(project, session.mode)
        token = permissions.set_current_policy(policy)
        context: CoderContext = {
            "project_id": project.id,
            "project_path": project.path,
            "session_id": session.id,
            "mode": session.mode,
            "policy": policy,
        }
        usage = session.usage
        context_tokens = session.context_tokens
        interrupted = False
        started = time.time()
        try:
            sessions.update(session.id, status="running", last_error=None)
            await run.push(
                {
                    "type": "run.started",
                    "session_id": session.id,
                    "model": session.model,
                    "mode": session.mode,
                }
            )
            agent = build_coder(project, session)
            stream = agent.astream(
                payload,
                config={"configurable": {"thread_id": session.id}},
                context=context,
                stream_mode=["messages", "updates", "custom"],
                subgraphs=True,
            )
            # A resumed run replays the model message that paused it; its
            # tokens were already counted when it first streamed.
            replayed = isinstance(payload, Command)
            async for event in translate(stream, main_agent="coder"):
                if event["type"] == "usage":
                    if replayed:
                        replayed = False
                        event["replayed"] = True
                    else:
                        usage = usage.add(event)
                    context_tokens = int(event.get("context_tokens") or context_tokens)
                    event["session_total"] = usage.model_dump()
                    event["context_window"] = _context_window(session.model)
                if event["type"] == "approval.required":
                    interrupted = True
                await run.push(event)
            if interrupted:
                status = "awaiting_approval"
        except asyncio.CancelledError:
            status = "cancelled"
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


def _context_window(model_id: str) -> int | None:
    try:
        return model_spec(model_id).context_window
    except LookupError:
        return None


manager = RunManager()
