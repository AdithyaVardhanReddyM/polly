"""Sessions: one conversation with an agent.

A Coder session lives inside a project; research and review sessions may
have no project at all, and a change-research session points back at the
Coder session it reports on (`parent_session_id`).

A session is a LangGraph thread (`thread_id == session.id`) plus the bits
the app needs without replaying the thread: title, model, mode, usage and
status. Each lives in `<data_dir>/sessions/<id>/session.json`; the same folder
holds the session's tracked changes, compacted history and artifacts
(sources, reports, scorecards).
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from polly_server.coder.context import Mode
from polly_server.config import settings

SessionStatus = Literal["idle", "running", "awaiting_approval", "error"]


class UsageTotals(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

    def add(self, other: dict | UsageTotals) -> UsageTotals:
        o = other if isinstance(other, dict) else other.model_dump()
        return UsageTotals(
            input_tokens=self.input_tokens + int(o.get("input_tokens", 0) or 0),
            output_tokens=self.output_tokens + int(o.get("output_tokens", 0) or 0),
            total_tokens=self.total_tokens + int(o.get("total_tokens", 0) or 0),
        )


class Session(BaseModel):
    id: str
    project_id: str | None = None
    # Which catalog agent this conversation is with. Sessions saved before
    # there was more than one agent are Coder sessions.
    agent_id: str = "coder"
    # The session this one was started from (research on a Coder change).
    parent_session_id: str | None = None
    title: str = ""
    model: str
    mode: Mode = "supervised"
    created_at: float
    updated_at: float
    status: SessionStatus = "idle"
    usage: UsageTotals = Field(default_factory=UsageTotals)
    # Prompt tokens of the latest model call: how full the context is.
    context_tokens: int = 0
    last_error: str | None = None


_lock = threading.Lock()


def session_dir(session: Session | str) -> Path:
    sid = session if isinstance(session, str) else session.id
    return settings.data_path("sessions", sid)


def _file(sid: str) -> Path:
    return session_dir(sid) / "session.json"


def create(
    project_id: str | None,
    *,
    model: str,
    mode: Mode,
    title: str = "",
    agent_id: str = "coder",
    parent_session_id: str | None = None,
) -> Session:
    now = time.time()
    session = Session(
        id=uuid.uuid4().hex[:16],
        project_id=project_id,
        agent_id=agent_id,
        parent_session_id=parent_session_id,
        title=title,
        model=model,
        mode=mode,
        created_at=now,
        updated_at=now,
    )
    save(session)
    return session


def save(session: Session) -> Session:
    with _lock:
        _file(session.id).write_text(session.model_dump_json(indent=2))
    return session


def get(session_id: str) -> Session | None:
    path = _file(session_id)
    if not path.exists():
        return None
    return Session.model_validate_json(path.read_text())


def update(session_id: str, **changes) -> Session:
    session = get(session_id)
    if session is None:
        raise LookupError(session_id)
    return save(session.model_copy(update={**changes, "updated_at": time.time()}))


def _all() -> list[Session]:
    root = settings.data_path("sessions")
    found: list[Session] = []
    for entry in root.iterdir():
        path = entry / "session.json"
        if path.is_file():
            try:
                found.append(Session.model_validate_json(path.read_text()))
            except ValueError:
                continue
    return sorted(found, key=lambda s: s.updated_at, reverse=True)


def list_for(project_id: str, agent_id: str = "coder") -> list[Session]:
    """A project's sessions with one agent (the Coder by default)."""
    return [s for s in _all() if s.project_id == project_id and s.agent_id == agent_id]


def list_agent(agent_id: str) -> list[Session]:
    """Top-level sessions with an agent, across projects."""
    return [s for s in _all() if s.agent_id == agent_id and s.parent_session_id is None]


def list_children(parent_id: str) -> list[Session]:
    return [s for s in _all() if s.parent_session_id == parent_id]


def delete(session_id: str) -> bool:
    import shutil

    folder = session_dir(session_id)
    if not (folder / "session.json").exists():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True


def title_from(text: str) -> str:
    first = text.strip().splitlines()[0] if text.strip() else "New session"
    return first[:60] + ("…" if len(first) > 60 else "")
