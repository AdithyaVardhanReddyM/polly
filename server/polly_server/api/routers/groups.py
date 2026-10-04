from __future__ import annotations

from fastapi import APIRouter, HTTPException

from polly_server import sandbox, sessions
from polly_server.agents import builders, groups, team
from polly_server.agents.groups import Group
from polly_server.api.schemas import GroupCreate, GroupList, GroupPatch
from polly_server.coder.runs import manager

router = APIRouter(prefix="/groups", tags=["groups"])


def _group(group_id: str) -> Group:
    group = groups.get(group_id)
    if group is None:
        raise HTTPException(404, f"no group {group_id!r}")
    return group


def _name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(422, "a group needs a name")
    return name


def _checked(members: list[str]) -> list[str]:
    try:
        return team.check(members)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("", response_model=GroupList)
def list_groups() -> GroupList:
    return GroupList(groups=groups.all_groups())


@router.post("", response_model=Group, status_code=201)
def create_group(body: GroupCreate) -> Group:
    """Make a group: its agents, and the one that leads."""
    try:
        return groups.create(_name(body.name), _checked(body.members), body.lead)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/{group_id}", response_model=Group)
def get_group(group_id: str) -> Group:
    return _group(group_id)


@router.patch("/{group_id}", response_model=Group)
def update_group(group_id: str, body: GroupPatch) -> Group:
    """Rename a group, change who is in it or who leads. Conversations already
    started keep the lead they began with."""
    _group(group_id)
    changes = body.model_dump(exclude_none=True)
    if "name" in changes:
        changes["name"] = _name(changes["name"])
    if "members" in changes:
        changes["members"] = _checked(changes["members"])
    try:
        return groups.update(group_id, **changes)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: str) -> None:
    """Delete a group and its conversations. The agents stay."""
    _group(group_id)
    for session in sessions.list_group(group_id):
        await manager.cancel(session.id)
        builders.forget(session.id)
        sandbox.forget(session.id)
        sessions.delete(session.id)
    groups.delete(group_id)
