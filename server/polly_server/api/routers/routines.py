from __future__ import annotations

from fastapi import APIRouter, HTTPException

from polly_server.agents import builders, catalog, groups, team
from polly_server.api.schemas import (
    RoutineIn,
    RoutineList,
    RoutineOut,
    RoutinePatch,
)
from polly_server.routines import scheduler, store, triggers

router = APIRouter(prefix="/routines", tags=["routines"])


def _out(routine: store.Routine) -> RoutineOut:
    return RoutineOut.of(routine, running=scheduler.busy(routine))


def _routine(routine_id: str) -> store.Routine:
    routine = store.get(routine_id)
    if routine is None:
        raise HTTPException(404, f"no routine {routine_id!r}")
    return routine


def _target(body: RoutineIn) -> dict:
    """Who runs the routine, checked."""
    if body.group_id:
        group = groups.get(body.group_id)
        if group is None:
            raise HTTPException(404, f"no group {body.group_id!r}")
        return {"agent_id": group.lead, "group_id": group.id, "members": None}
    spec = catalog.get(body.agent_id)
    if spec is None or not builders.listed(spec):
        raise HTTPException(404, f"no agent {body.agent_id!r}")
    if spec.id == "coder" or spec.status != "ready":
        raise HTTPException(400, f"{spec.name} cannot run routines")
    members = None
    if body.members is not None:
        try:
            members = team.check(body.members, spec.id)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
    return {"agent_id": spec.id, "group_id": None, "members": members}


@router.get("", response_model=RoutineList)
def list_routines() -> RoutineList:
    return RoutineList(routines=[_out(r) for r in store.all_routines()])


@router.post("", response_model=RoutineOut, status_code=201)
def create_routine(body: RoutineIn) -> RoutineOut:
    try:
        routine = store.create(
            name=body.name.strip(),
            prompt=body.prompt.strip(),
            trigger=body.trigger,
            enabled=body.enabled,
            **_target(body),
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return _out(routine)


@router.get("/{routine_id}", response_model=RoutineOut)
def get_routine(routine_id: str) -> RoutineOut:
    return _out(_routine(routine_id))


@router.patch("/{routine_id}", response_model=RoutineOut)
def update_routine(routine_id: str, body: RoutinePatch) -> RoutineOut:
    _routine(routine_id)
    changes = body.model_dump(exclude_none=True)
    if body.trigger is not None:
        changes["trigger"] = body.trigger
        triggers.forget(routine_id)
    try:
        return _out(store.update(routine_id, **changes))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/{routine_id}", status_code=204)
def delete_routine(routine_id: str) -> None:
    if not store.delete(routine_id):
        raise HTTPException(404, f"no routine {routine_id!r}")
    triggers.forget(routine_id)


@router.post("/{routine_id}/run", response_model=RoutineOut)
async def run_routine(routine_id: str) -> RoutineOut:
    """Run a routine now, whatever its trigger."""
    run = await scheduler.fire(_routine(routine_id), note="run by hand")
    if run.status == "skipped":
        raise HTTPException(409, f"Not started: {run.note}.")
    return _out(_routine(routine_id))
