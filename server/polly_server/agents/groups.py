"""Groups: a set of agents the user talks to together.

A group is a name, its members and the one that leads. A conversation in a
group is a session with the lead (`Session.group_id`); the other members
join it as the lead's teammates (`team.py`), so a group runs on the same
machinery as one agent calling on another. Kept in `<data_dir>/groups.json`.
"""

from __future__ import annotations

import json
import threading
import time
import uuid

from pydantic import BaseModel, Field

from polly_server.config import settings

PREFIX = "group-"
MIN_MEMBERS = 2
MAX_MEMBERS = 8


class Group(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=40)
    # Agent ids, the lead included, in the order the user added them.
    members: list[str]
    lead: str
    created_at: float = 0
    updated_at: float = 0

    def others(self, agent_id: str | None = None) -> list[str]:
        """The members besides `agent_id` (the lead by default)."""
        me = agent_id or self.lead
        return [m for m in self.members if m != me]


_lock = threading.Lock()


def _file():
    return settings.data_path() / "groups.json"


def _read() -> list[Group]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[Group] = []
    for raw in data.get("groups", []) if isinstance(data, dict) else []:
        try:
            found.append(Group.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(groups: list[Group]) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(json.dumps({"groups": [g.model_dump() for g in groups]}, indent=2))
    draft.replace(path)


def _checked(members: list[str], lead: str) -> list[str]:
    members = list(dict.fromkeys(members))
    if not MIN_MEMBERS <= len(members) <= MAX_MEMBERS:
        raise ValueError(f"a group has {MIN_MEMBERS} to {MAX_MEMBERS} agents")
    if lead not in members:
        raise ValueError("the lead has to be one of the group's agents")
    return members


def all_groups() -> list[Group]:
    """Oldest first."""
    with _lock:
        return sorted(_read(), key=lambda g: g.created_at)


def get(group_id: str | None) -> Group | None:
    if not group_id:
        return None
    with _lock:
        return next((g for g in _read() if g.id == group_id), None)


def create(name: str, members: list[str], lead: str) -> Group:
    now = time.time()
    group = Group(
        id=f"{PREFIX}{uuid.uuid4().hex[:10]}",
        name=name,
        members=_checked(members, lead),
        lead=lead,
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _write([*_read(), group])
    return group


def update(group_id: str, **changes) -> Group:
    with _lock:
        groups = _read()
        for i, current in enumerate(groups):
            if current.id == group_id:
                merged = {**current.model_dump(), **changes, "updated_at": time.time()}
                merged["members"] = _checked(merged["members"], merged["lead"])
                groups[i] = Group.model_validate(merged)
                _write(groups)
                return groups[i]
    raise LookupError(group_id)


def delete(group_id: str) -> bool:
    with _lock:
        groups = _read()
        kept = [g for g in groups if g.id != group_id]
        if len(kept) == len(groups):
            return False
        _write(kept)
    return True


def without(agent_id: str) -> list[str]:
    """Take a deleted agent out of every group. The next member takes over a
    group it led; a group left with one agent is dissolved, and its id is
    returned so its conversations can go too."""
    dissolved: list[str] = []
    with _lock:
        groups = _read()
        kept: list[Group] = []
        for group in groups:
            if agent_id not in group.members:
                kept.append(group)
                continue
            members = group.others(agent_id)
            if len(members) < MIN_MEMBERS:
                dissolved.append(group.id)
                continue
            lead = group.lead if group.lead != agent_id else members[0]
            kept.append(
                group.model_copy(
                    update={"members": members, "lead": lead, "updated_at": time.time()}
                )
            )
        _write(kept)
    return dissolved
