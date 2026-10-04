"""Firing routines: on their schedule, on GitHub events, or by hand.

A loop in the server checks every routine every `TICK` seconds. A routine
whose time has come starts a new conversation with its agent or group and
the routine's message, under a policy that never waits for the user: no one
is there to answer (`agents/asks.py`). A schedule missed while the server was
off fires once when it comes back, not once per missed slot. A routine whose
last run is still going is skipped, and the skip is noted in its history.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import time

from polly_server import sessions
from polly_server.agents import builders, groups
from polly_server.coder import permissions
from polly_server.config import settings
from polly_server.routines import store, triggers

log = logging.getLogger(__name__)

TICK = 30.0

_task: asyncio.Task | None = None


def _runs():
    from polly_server.coder.runs import manager

    return manager


def busy(routine: store.Routine) -> bool:
    """Whether a run of `routine` is still going."""
    active = _runs().active
    return any(r.status == "running" and r.session_id in active for r in routine.runs)


def _skip(routine: store.Routine, why: str) -> store.RoutineRun:
    run = store.RoutineRun(started_at=time.time(), status="skipped", note=why)
    store.record(routine.id, run)
    log.info("routine %s skipped: %s", routine.id, why)
    return run


async def fire(routine: store.Routine, *, note: str, extra: str = "") -> store.RoutineRun:
    """Start one run of `routine` now."""
    if busy(routine):
        return _skip(routine, "the last run had not finished")
    if not settings.model_configured:
        return _skip(routine, "NEBIUS_API_KEY is not set")
    group = groups.get(routine.group_id) if routine.group_id else None
    if routine.group_id and group is None:
        return _skip(routine, "its group was deleted")
    agent_id = group.lead if group else routine.agent_id
    if agent_id == "coder" or not builders.runnable(agent_id):
        return _skip(routine, f"{agent_id} cannot run routines")

    now = time.time()
    session = sessions.create(
        None,
        model=builders.default_model(agent_id),
        mode="plan",
        title=f"{routine.name} · {dt.datetime.now():%d %b %H:%M}",
        agent_id=agent_id,
        group_id=group.id if group else None,
        members=None if group else routine.members,
    )
    text = f"{routine.prompt}\n\n{extra}" if extra else routine.prompt
    shown = f"{routine.prompt}\n\n*{note}*" if extra else routine.prompt
    policy = permissions.Policy(mode="plan", ask_means_deny=True)
    await _runs().start(None, session, text, policy=policy, display=shown)
    run = store.RoutineRun(session_id=session.id, started_at=now, note=note)
    store.record(routine.id, run)
    return run


def _settle(routine: store.Routine) -> None:
    """Mark finished runs done or failed."""
    active = _runs().active
    for run in routine.runs:
        if run.status != "running" or not run.session_id or run.session_id in active:
            continue
        session = sessions.get(run.session_id)
        failed = session is not None and session.status == "error"
        store.settle(routine.id, run.session_id, "error" if failed else "done")


async def tick(now: float | None = None) -> None:
    """Fire every routine that is due."""
    now = time.time() if now is None else now
    for routine in store.all_routines():
        try:
            _settle(routine)
            if not routine.enabled:
                continue
            trigger = routine.trigger
            if isinstance(trigger, store.ScheduleTrigger):
                if routine.next_run_at is not None and routine.next_run_at <= now:
                    # Counted from now: missed slots fire once, not each.
                    store.set_fields(routine.id, next_run_at=store.next_after(trigger, now))
                    await fire(routine, note="on schedule")
            elif triggers.due(routine, now):
                for item in await triggers.look(routine):
                    await fire(
                        store.get(routine.id) or routine,
                        note=f"#{item['number']} opened",
                        extra=triggers.describe(trigger, item),
                    )
        except Exception:  # noqa: BLE001 - one broken routine must not stop the others
            log.exception("routine %s failed to fire", routine.id)


async def _loop() -> None:
    while True:
        await tick()
        await asyncio.sleep(TICK)


def start() -> None:
    global _task
    if settings.routines and _task is None:
        _task = asyncio.get_running_loop().create_task(_loop())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _task
        _task = None
