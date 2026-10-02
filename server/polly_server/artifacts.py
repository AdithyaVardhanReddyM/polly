"""JSON artifacts a run leaves next to its session: the sources it cited, a
change report, a pull request scorecard, the facts of the PR it reviewed.

Tools find the session they belong to through the run's context, falling
back to a context variable the `RunManager` sets (subagents do not always see
the parent's runtime context).
"""

from __future__ import annotations

import contextvars
import json
import threading
from pathlib import Path
from typing import Any

from polly_server.sessions import session_dir

_lock = threading.Lock()

_session_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "polly_session", default=None
)


def set_current_session(session_id: str | None) -> contextvars.Token:
    return _session_var.set(session_id)


def reset_current_session(token: contextvars.Token) -> None:
    try:
        _session_var.reset(token)
    except (ValueError, LookupError):
        pass


def session_id_of(runtime: Any = None) -> str:
    context = getattr(runtime, "context", None)
    if isinstance(context, dict) and context.get("session_id"):
        return str(context["session_id"])
    config = getattr(runtime, "config", None) or {}
    thread = (config.get("configurable") or {}).get("thread_id")
    if thread:
        return str(thread)
    found = _session_var.get()
    if found:
        return found
    raise RuntimeError("no session in the run context")


def _path(session_id: str, name: str) -> Path:
    if not name.isidentifier():
        raise ValueError(f"bad artifact name {name!r}")
    return session_dir(session_id) / f"{name}.json"


def load(session_id: str, name: str, default: Any = None) -> Any:
    path = _path(session_id, name)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except ValueError:
        return default


def save(session_id: str, name: str, data: Any) -> None:
    with _lock:
        _path(session_id, name).write_text(json.dumps(data, indent=2, default=str))
