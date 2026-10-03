"""Which integrations each agent may use.

A built-in agent starts with the ones its spec names (`AgentSpec.integrations`).
The user can change that set from the Integrations page; the change is kept in
`<data_dir>/integrations.json` and wins over the spec. Custom agents will
store their choice the same way.
"""

from __future__ import annotations

import json
import threading

from polly_server.agents import catalog as agents
from polly_server.config import settings
from polly_server.integrations import catalog, composio

_lock = threading.Lock()


def _file():
    return settings.data_path() / "integrations.json"


def _saved() -> dict[str, list[str]]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return {}
    chosen = data.get("agents") if isinstance(data, dict) else None
    return chosen if isinstance(chosen, dict) else {}


def enabled(agent_id: str) -> tuple[str, ...]:
    """The integrations `agent_id` is allowed, connected or not."""
    saved = _saved().get(agent_id)
    if saved is None:
        spec = agents.get(agent_id)
        saved = list(spec.integrations) if spec else []
    return tuple(s for s in saved if s in catalog.SLUGS)


def set_enabled(agent_id: str, slugs: list[str]) -> tuple[str, ...]:
    unknown = [s for s in slugs if s not in catalog.SLUGS]
    if unknown:
        raise ValueError(f"unknown integrations: {', '.join(unknown)}")
    with _lock:
        saved = _saved()
        saved[agent_id] = list(dict.fromkeys(slugs))
        _file().write_text(json.dumps({"agents": saved}, indent=2))
    return enabled(agent_id)


def active(agent_id: str) -> tuple[str, ...]:
    """What the agent can use right now: allowed and connected. Sorted, so it
    can key a cache."""
    usable = composio.usable()
    return tuple(sorted(s for s in enabled(agent_id) if s in usable))
