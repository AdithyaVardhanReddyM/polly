"""Routines: a task an agent or a group runs by itself, again and again.

A routine is a message (`prompt`), who gets it (an agent, with a team or
not, or a group) and when: on a cron schedule, or whenever something happens
on GitHub. Each time it fires it starts a new conversation the user can open
later. No one is watching, so the run cannot stop to ask anything
(`agents/asks.py`).

Kept in `<data_dir>/routines.json`.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from pydantic import BaseModel, Field

from polly_server.config import settings

PREFIX = "routine-"
KEEP_RUNS = 20
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
GitHubEvent = Literal["pull_request.opened", "issues.opened"]
EVENTS: dict[str, str] = {
    "pull_request.opened": "a pull request is opened",
    "issues.opened": "an issue is opened",
}


class ScheduleTrigger(BaseModel):
    kind: Literal["schedule"] = "schedule"
    cron: str
    timezone: str = "UTC"


class GitHubTrigger(BaseModel):
    kind: Literal["github"] = "github"
    repo: str
    event: GitHubEvent


Trigger = Annotated[ScheduleTrigger | GitHubTrigger, Field(discriminator="kind")]

RunStatus = Literal["running", "done", "error", "skipped"]


class RoutineRun(BaseModel):
    session_id: str | None = None
    started_at: float
    status: RunStatus = "running"
    # Why it ran (the schedule, a GitHub event, by hand) or why it was skipped.
    note: str = ""


class Routine(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=60)
    prompt: str = Field(min_length=1, max_length=4_000)
    trigger: Trigger
    # Who runs it: an agent (and the team it is given), or a group.
    agent_id: str
    group_id: str | None = None
    members: list[str] | None = None
    enabled: bool = True
    created_at: float = 0
    updated_at: float = 0
    next_run_at: float | None = None
    last_run_at: float | None = None
    # GitHub routines: the newest item seen, so nothing fires twice; None
    # until the first look, which only takes note of what is there.
    cursor: int | None = None
    runs: list[RoutineRun] = Field(default_factory=list)


_lock = threading.Lock()


def _file():
    return settings.data_path() / "routines.json"


def _read() -> list[Routine]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[Routine] = []
    for raw in data.get("routines", []) if isinstance(data, dict) else []:
        try:
            found.append(Routine.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(routines: list[Routine]) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(json.dumps({"routines": [r.model_dump() for r in routines]}, indent=2))
    draft.replace(path)


# ---------- triggers ----------


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"unknown time zone {name!r}") from None


def check(trigger: ScheduleTrigger | GitHubTrigger) -> ScheduleTrigger | GitHubTrigger:
    """`trigger`, or `ValueError` saying what is wrong with it."""
    if isinstance(trigger, ScheduleTrigger):
        if not croniter.is_valid(trigger.cron):
            raise ValueError(f"{trigger.cron!r} is not a cron schedule")
        _zone(trigger.timezone)
    elif not REPO.match(trigger.repo):
        raise ValueError(f"{trigger.repo!r} is not a repository (owner/name)")
    return trigger


def trigger_from(
    *, cron: str = "", timezone: str = "UTC", repo: str = "", event: str = ""
) -> ScheduleTrigger | GitHubTrigger:
    cron, repo = cron.strip(), repo.strip()
    if bool(cron) == bool(repo):
        raise ValueError("give either a cron schedule or a GitHub repository")
    if cron:
        return check(ScheduleTrigger(cron=cron, timezone=timezone.strip() or "UTC"))
    if event not in EVENTS:
        raise ValueError(f"the GitHub event is one of: {', '.join(EVENTS)}")
    return check(GitHubTrigger(repo=repo, event=event))  # type: ignore[arg-type]


def next_after(trigger: ScheduleTrigger | GitHubTrigger, after: float) -> float | None:
    """When a schedule next fires after `after` (a timestamp); None for events."""
    if not isinstance(trigger, ScheduleTrigger):
        return None
    start = datetime.fromtimestamp(after, _zone(trigger.timezone))
    return float(croniter(trigger.cron, start).get_next(float))


def describe(trigger: ScheduleTrigger | GitHubTrigger) -> str:
    if isinstance(trigger, ScheduleTrigger):
        return f"on the schedule `{trigger.cron}` ({trigger.timezone})"
    return f"whenever {EVENTS[trigger.event]} in {trigger.repo}"


# ---------- the store ----------


def all_routines() -> list[Routine]:
    with _lock:
        return sorted(_read(), key=lambda r: r.created_at)


def get(routine_id: str) -> Routine | None:
    with _lock:
        return next((r for r in _read() if r.id == routine_id), None)


def create(**fields) -> Routine:
    now = time.time()
    trigger = check(fields.pop("trigger"))
    routine = Routine(
        id=f"{PREFIX}{uuid.uuid4().hex[:10]}",
        trigger=trigger,
        created_at=now,
        updated_at=now,
        next_run_at=next_after(trigger, now),
        **fields,
    )
    with _lock:
        _write([*_read(), routine])
    return routine


def update(routine_id: str, **changes) -> Routine:
    """Change a routine. A new schedule, or switching it back on, counts from now."""
    with _lock:
        routines = _read()
        for i, current in enumerate(routines):
            if current.id != routine_id:
                continue
            merged = current.model_validate({**current.model_dump(), **changes})
            check(merged.trigger)
            if "trigger" in changes or ("enabled" in changes and not current.enabled):
                merged.next_run_at = next_after(merged.trigger, time.time())
                if merged.trigger != current.trigger:
                    merged.cursor = None
            merged.updated_at = time.time()
            routines[i] = merged
            _write(routines)
            return merged
    raise LookupError(routine_id)


def delete(routine_id: str) -> bool:
    with _lock:
        routines = _read()
        kept = [r for r in routines if r.id != routine_id]
        if len(kept) == len(routines):
            return False
        _write(kept)
    return True


def record(routine_id: str, run: RoutineRun, **changes) -> Routine | None:
    """Add a run to a routine's history (and change other fields with it)."""
    with _lock:
        routines = _read()
        for i, current in enumerate(routines):
            if current.id == routine_id:
                runs = [*current.runs, run][-KEEP_RUNS:]
                fields = {"runs": runs, **changes}
                if run.status != "skipped":
                    fields["last_run_at"] = run.started_at
                routines[i] = current.model_copy(update=fields)
                _write(routines)
                return routines[i]
    return None


def set_fields(routine_id: str, **changes) -> None:
    """Change bookkeeping (cursor, next run) without touching `updated_at`."""
    with _lock:
        routines = _read()
        for i, current in enumerate(routines):
            if current.id == routine_id:
                routines[i] = current.model_copy(update=changes)
                _write(routines)
                return


def settle(routine_id: str, session_id: str, run_status: RunStatus) -> None:
    """Mark the run in `session_id` finished."""
    with _lock:
        routines = _read()
        for i, current in enumerate(routines):
            if current.id != routine_id:
                continue
            runs = [
                r.model_copy(update={"status": run_status}) if r.session_id == session_id else r
                for r in current.runs
            ]
            routines[i] = current.model_copy(update={"runs": runs})
            _write(routines)
            return
