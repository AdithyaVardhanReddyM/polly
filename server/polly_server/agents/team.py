"""Agents working together: who may hand work to whom.

An agent hands work to a teammate, another agent, with `ask_teammate`
(`delegation.py`). Who is on its team is decided most specific first:

* in a group conversation, the other members of the group (`groups.py`);
* in a conversation whose team the user changed, that choice
  (`Session.members`);
* otherwise the agent's own team: what the user picked for it, or the
  spec's `teammates` until they do;
* with open collaboration on (Settings), every agent that can be called on.

The user's choices are kept in `<data_dir>/teams.json`.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from polly_server.agents import catalog, groups
from polly_server.agents.spec import AgentSpec
from polly_server.config import settings
from polly_server.sessions import Session

# The Coder works in a project folder and the Designer on a canvas. Both need
# their own workspace, so they call on teammates but are not called on.
OWN_WORKSPACE = frozenset({"coder", "designer"})
MAX_TEAMMATES = 8

PROMPT = """\
## Your teammates

You are not working alone. These agents are on your team, and `ask_teammate` hands one \
of them a piece of work:

{listing}

- Call on a teammate when the work is theirs to do better than you; what each is for is \
written above. Do the rest yourself.
- A teammate sees only the message you send, so write a complete brief: what you need, \
what you already know, and what to hand back.
- A teammate remembers what it did for you earlier in this conversation. Go back to the \
same one to follow up, to correct it or to build on what it returned, instead of \
starting over with a new brief.
- Independent pieces of work can go to several teammates in one step; they run at the \
same time.
- The user sees each teammate's reply as it arrives. Do not repeat it: build on it, and \
say where your answer rests on their work."""

GROUP_PROMPT = """\
## The group

This conversation is the group "{name}", and you lead it. The user is talking to the \
whole group: you decide who does what, bring the right members in and give the final \
answer. When the user addresses a member by name (`@Name`), hand that request to them."""

_lock = threading.Lock()


def _file():
    return settings.data_path() / "teams.json"


def _saved() -> dict[str, Any]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _teams(saved: dict[str, Any]) -> dict[str, list[str]]:
    teams = saved.get("agents")
    return teams if isinstance(teams, dict) else {}


def _write(saved: dict[str, Any]) -> None:
    _file().write_text(json.dumps(saved, indent=2))


# ---------- who can be on a team ----------


def can_join(spec: AgentSpec | None) -> bool:
    """Whether other agents can hand work to this one."""
    return (
        spec is not None
        and spec.status == "ready"
        and spec.metadata.get("internal") != "true"
        and spec.id not in OWN_WORKSPACE
    )


def can_lead(spec: AgentSpec | None) -> bool:
    """Whether the agent runs conversations of its own, and so can have a team."""
    return spec is not None and spec.status == "ready" and spec.metadata.get("internal") != "true"


def _valid(ids: list[str] | tuple[str, ...], agent_id: str) -> tuple[str, ...]:
    """`ids` that still name an agent `agent_id` can call on, in order."""
    return tuple(i for i in dict.fromkeys(ids) if i != agent_id and can_join(catalog.get(i)))[
        :MAX_TEAMMATES
    ]


def check(ids: list[str], agent_id: str | None = None) -> list[str]:
    """`ids` without repeats, or `ValueError` naming what cannot be on a team."""
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_TEAMMATES:
        raise ValueError(f"a team has at most {MAX_TEAMMATES} teammates")
    for i in ids:
        spec = catalog.get(i)
        if spec is None or spec.metadata.get("internal") == "true":
            raise ValueError(f"no agent {i!r}")
        if i == agent_id:
            raise ValueError(f"{spec.name} cannot be its own teammate")
        if not can_join(spec):
            why = "works in its own workspace" if i in OWN_WORKSPACE else "is not available yet"
            raise ValueError(f"{spec.name} {why} and cannot be called on by other agents")
    return ids


# ---------- an agent's own team ----------


def is_open() -> bool:
    """Open collaboration: every agent may call on every other."""
    return bool(_saved().get("open"))


def set_open(on: bool) -> bool:
    with _lock:
        saved = _saved()
        saved["open"] = bool(on)
        _write(saved)
    return bool(on)


def chosen(agent_id: str) -> tuple[str, ...]:
    """The team picked for `agent_id`: the user's choice, or the spec's."""
    picked = _teams(_saved()).get(agent_id)
    if picked is None:
        spec = catalog.get(agent_id)
        picked = list(spec.teammates) if spec else []
    return _valid(picked, agent_id)


def of(agent_id: str) -> tuple[str, ...]:
    """Who `agent_id` can call on in a conversation of its own."""
    if is_open():
        return _valid([a.id for a in catalog.everyone()], agent_id)
    return chosen(agent_id)


def set_team(agent_id: str, ids: list[str]) -> tuple[str, ...]:
    ids = check(ids, agent_id)
    with _lock:
        saved = _saved()
        saved["agents"] = {**_teams(saved), agent_id: ids}
        _write(saved)
    return chosen(agent_id)


def clear(agent_id: str) -> None:
    """Forget a deleted agent: its own team, and its place on the others'."""
    with _lock:
        saved = _saved()
        teams = _teams(saved)
        teams.pop(agent_id, None)
        saved["agents"] = {k: [i for i in v if i != agent_id] for k, v in teams.items()}
        _write(saved)


# ---------- a conversation's team ----------


def roster(session: Session) -> tuple[AgentSpec, ...]:
    """The teammates the session's agent can call on, as they are now."""
    group = groups.get(session.group_id)
    if group is not None:
        ids = _valid(group.others(session.agent_id), session.agent_id)
    elif session.members is not None:
        ids = _valid(session.members, session.agent_id)
    else:
        ids = of(session.agent_id)
    return tuple(spec for i in ids if (spec := catalog.get(i)) is not None)


def signature(session: Session, mates: tuple[AgentSpec, ...]) -> tuple[Any, ...]:
    """What the lead's prompt says about its team, to key a cache."""
    group = groups.get(session.group_id)
    return (group.name if group else "", *((m.id, m.name, m.tagline, m.description) for m in mates))


def prompt(session: Session, mates: tuple[AgentSpec, ...]) -> str:
    """The section of the lead's system prompt about its team."""
    lines = []
    for m in mates:
        about = " ".join(part for part in (m.tagline, m.description) if part)
        lines.append(f"- **{m.name}** (`{m.id}`): {about}".rstrip(": "))
    text = PROMPT.format(listing="\n".join(lines))
    group = groups.get(session.group_id)
    return f"{GROUP_PROMPT.format(name=group.name)}\n\n{text}" if group else text


def mention_note(mentioned: tuple[AgentSpec, ...]) -> str:
    """Appended to a message in which the user addressed teammates by name."""
    names = ", ".join(f"{m.name} (`{m.id}`)" for m in mentioned)
    return f"<addressed>\nThe user addressed {names}. Hand them this request.\n</addressed>"
