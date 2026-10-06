"""Sessions: one conversation with an agent.

A Coder session lives inside a project; research and review sessions may
have no project at all, and a change-research session points back at the
Coder session it reports on (`parent_session_id`).

A conversation in a group (`group_id`) is a session with the agent that leads
the group; the other members join as its teammates.

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
from polly_server.model_registry import Effort

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
    # The group this conversation belongs to (`agents/groups.py`); `agent_id`
    # is then the agent that leads it.
    group_id: str | None = None
    # The teammates the user picked for this conversation; null follows the
    # agent's own team (`agents/team.py`).
    members: list[str] | None = None
    title: str = ""
    model: str
    # How hard a thinking model thinks; null runs at the default (high).
    reasoning_effort: Effort | None = None
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
    group_id: str | None = None,
    members: list[str] | None = None,
    reasoning_effort: Effort | None = None,
) -> Session:
    now = time.time()
    session = Session(
        id=uuid.uuid4().hex[:16],
        project_id=project_id,
        agent_id=agent_id,
        parent_session_id=parent_session_id,
        group_id=group_id,
        members=members,
        title=title,
        model=model,
        reasoning_effort=reasoning_effort,
        mode=mode,
        created_at=now,
        updated_at=now,
    )
    save(session)
    return session


def save(session: Session) -> Session:
    # Written whole, then swapped in: a reader never sees a half-written file.
    with _lock:
        path = _file(session.id)
        draft = path.with_suffix(".tmp")
        draft.write_text(session.model_dump_json(indent=2))
        draft.replace(path)
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


def list_agent(agent_id: str, *, groups: bool = False) -> list[Session]:
    """Top-level sessions with an agent, across projects. The group
    conversations it leads are listed with their group, unless `groups`."""
    return [
        s
        for s in _all()
        if s.agent_id == agent_id and s.parent_session_id is None and (groups or s.group_id is None)
    ]


def list_group(group_id: str) -> list[Session]:
    return [s for s in _all() if s.group_id == group_id]


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
