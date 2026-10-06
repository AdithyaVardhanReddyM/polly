"""The user's to-dos and reminders, one list for the app, the agents and the
notch copilot.

A to-do with `remind_at` is also a reminder: the notch asks `due()` for the
ones whose time has come, shows them, and marks them reminded so each fires
once (snoozing moves the time and lets it fire again). To-dos come from three
places, recorded in `source`: the user typed them, an agent added one with
`add_todo`, or the copilot spotted one on screen. The copilot checks
`similar_open` first so it does not propose what is already on the list.

Stored in `<data_dir>/todos.json` behind a lock, like `memory.py`. Times are
epoch seconds; the agent tools read and write them as the user's local time.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import threading
import time
import uuid
from typing import TYPE_CHECKING, Annotated, Any, Literal

from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from polly_server.config import settings

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

MAX_TITLE = 200
MAX_NOTES = 4_000
# Finished to-dos kept for the "done" list; the oldest go first.
MAX_DONE = 500
# Open to-dos an agent sees in its system prompt; `list_todos` has the rest.
PROMPT_LIMIT = 10
# Two titles this alike (token-set Jaccard) are the same to-do.
SIMILAR = 0.8

Status = Literal["open", "done"]


class TodoSource(BaseModel):
    # copilot: detected on screen · user: typed in · agent: an agent added it
    kind: Literal["copilot", "user", "agent"] = "user"
    app: str | None = None
    bundle_id: str | None = None
    window: str | None = None
    url: str | None = None
    # The sentence it was detected from.
    excerpt: str | None = None
    agent_id: str | None = None


class TodoItem(BaseModel):
    id: str
    title: str
    notes: str = ""
    due_at: float | None = None
    remind_at: float | None = None
    # Set once the reminder was shown, so it fires once.
    reminded_at: float | None = None
    status: Status = "open"
    source: TodoSource = Field(default_factory=TodoSource)
    created_at: float = 0
    updated_at: float = 0
    completed_at: float | None = None


class TodoFields(BaseModel):
    title: str
    notes: str = ""
    due_at: float | None = None
    remind_at: float | None = None
    source: TodoSource | None = None


class TodoPatch(BaseModel):
    """Only the fields that were sent change; `null` clears a time."""

    title: str | None = None
    notes: str | None = None
    due_at: float | None = None
    remind_at: float | None = None
    status: Status | None = None


_lock = threading.Lock()


def _file():
    return settings.data_path() / "todos.json"


def _read() -> list[TodoItem]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[TodoItem] = []
    for raw in data.get("todos", []) if isinstance(data, dict) else []:
        try:
            found.append(TodoItem.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(todos: list[TodoItem]) -> None:
    done = sorted((t for t in todos if t.status == "done"), key=lambda t: t.completed_at or 0)
    dropped = {t.id for t in done[:-MAX_DONE]} if len(done) > MAX_DONE else set()
    kept = [t for t in todos if t.id not in dropped]
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(json.dumps({"todos": [t.model_dump() for t in kept]}, indent=2))
    draft.replace(path)


def _clean_title(title: str) -> str:
    title = " ".join(title.split())[:MAX_TITLE]
    if not title:
        raise ValueError("a to-do needs a title")
    return title


def _open_order(todo: TodoItem) -> tuple[bool, float, float]:
    # By due date, the undated last, then oldest first.
    return (todo.due_at is None, todo.due_at or 0, todo.created_at)


def all_todos(status: Literal["open", "done", "all"] = "open") -> list[TodoItem]:
    """Open ones by due date (undated last), done ones newest completed first;
    "all" is the open list followed by the done one."""
    with _lock:
        todos = _read()
    open_ = sorted((t for t in todos if t.status == "open"), key=_open_order)
    done = sorted(
        (t for t in todos if t.status == "done"), key=lambda t: t.completed_at or 0, reverse=True
    )
    if status == "open":
        return open_
    if status == "done":
        return done
    return [*open_, *done]


def get(todo_id: str) -> TodoItem | None:
    with _lock:
        return next((t for t in _read() if t.id == todo_id), None)


def add(
    fields: TodoFields | dict[str, Any], *, source: TodoSource | dict[str, Any] | None = None
) -> TodoItem:
    """Add a to-do. `source` wins over `fields.source`; neither means the user."""
    fields = TodoFields.model_validate(fields)
    origin = TodoSource.model_validate(source or fields.source or {"kind": "user"})
    now = time.time()
    todo = TodoItem(
        id=uuid.uuid4().hex[:8],
        title=_clean_title(fields.title),
        notes=fields.notes.strip()[:MAX_NOTES],
        due_at=fields.due_at,
        remind_at=fields.remind_at,
        source=origin,
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _write([*_read(), todo])
    return todo


def update(todo_id: str, patch: TodoPatch | dict[str, Any]) -> TodoItem | None:
    """Apply the fields `patch` sets. Done stamps `completed_at`, reopening
    clears it; a new `remind_at` lets the reminder fire again."""
    patch = TodoPatch.model_validate(patch)
    changes = patch.model_dump(exclude_unset=True)
    if "title" in changes:
        if changes["title"] is None:
            raise ValueError("a to-do needs a title")
        changes["title"] = _clean_title(changes["title"])
    if "notes" in changes:
        changes["notes"] = (changes["notes"] or "").strip()[:MAX_NOTES]
    if "status" in changes and changes["status"] is None:
        del changes["status"]

    with _lock:
        todos = _read()
        todo = next((t for t in todos if t.id == todo_id), None)
        if todo is None:
            return None
        now = time.time()
        if "status" in changes and changes["status"] != todo.status:
            changes["completed_at"] = now if changes["status"] == "done" else None
        if "remind_at" in changes and changes["remind_at"] != todo.remind_at:
            changes["reminded_at"] = None
        changed = todo.model_copy(update={**changes, "updated_at": now})
        _write([changed if t.id == todo_id else t for t in todos])
    return changed


def remove(todo_id: str) -> bool:
    with _lock:
        todos = _read()
        kept = [t for t in todos if t.id != todo_id]
        if len(kept) == len(todos):
            return False
        _write(kept)
    return True


def due(now: float | None = None) -> list[TodoItem]:
    """Open reminders whose time has come and that have not been shown yet,
    earliest first."""
    now = time.time() if now is None else now
    return sorted(
        (
            t
            for t in all_todos("open")
            if t.remind_at is not None and t.remind_at <= now and t.reminded_at is None
        ),
        key=lambda t: t.remind_at or 0,
    )


def _stamp(todo_id: str, **changes: Any) -> TodoItem | None:
    with _lock:
        todos = _read()
        todo = next((t for t in todos if t.id == todo_id), None)
        if todo is None:
            return None
        changed = todo.model_copy(update={**changes, "updated_at": time.time()})
        _write([changed if t.id == todo_id else t for t in todos])
    return changed


def mark_reminded(todo_id: str) -> TodoItem | None:
    """The reminder was shown; it will not fire again unless snoozed."""
    return _stamp(todo_id, reminded_at=time.time())


def snooze(todo_id: str, minutes: int) -> TodoItem | None:
    """Remind again `minutes` from now."""
    return _stamp(todo_id, remind_at=time.time() + minutes * 60, reminded_at=None)


def _words(text: str) -> list[str]:
    return re.sub(r"[\W_]+", " ", text.casefold()).split()


def similar_open(title: str) -> TodoItem | None:
    """An open to-do that already says the same thing: equal once case,
    punctuation and spacing are ignored, or sharing nearly all its words."""
    words = _words(title)
    if not words:
        return None
    wanted = set(words)
    best: tuple[float, TodoItem] | None = None
    for todo in all_todos("open"):
        theirs = _words(todo.title)
        if theirs == words:
            return todo
        union = wanted | set(theirs)
        score = len(wanted & set(theirs)) / len(union) if union else 0
        if score >= SIMILAR and (best is None or score > best[0]):
            best = (score, todo)
    return best[1] if best else None


# ---------- agents ----------


def parse_local(text: str, *, date_only: tuple[int, int] = (9, 0)) -> float:
    """An ISO 8601 date-time in the user's local time (an explicit offset
    wins) as epoch seconds. A bare date lands at `date_only` (hour, minute)."""
    text = text.strip()
    try:
        when = dt.datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(
            f"{text!r} is not an ISO 8601 date-time; write it like 2026-10-07T15:00"
        ) from None
    if len(text) <= 10:
        when = when.replace(hour=date_only[0], minute=date_only[1])
    if when.tzinfo is None:
        when = when.astimezone()  # the machine's zone is the user's
    return when.timestamp()


def _local(ts: float) -> str:
    when = dt.datetime.fromtimestamp(ts).astimezone()
    return f"{when:%a} {when.day} {when:%b %Y, %H:%M}"


def describe(todo: TodoItem) -> str:
    """One line an agent can read: id, title, and its times."""
    parts = [f"[{todo.id}] {todo.title}"]
    if todo.due_at is not None:
        parts.append(f"due {_local(todo.due_at)}")
    if todo.remind_at is not None:
        parts.append(f"remind {_local(todo.remind_at)}")
    if todo.status == "done" and todo.completed_at is not None:
        parts.append(f"done {_local(todo.completed_at)}")
    line = " · ".join(parts)
    return f"{line}\n  {todo.notes}" if todo.notes else line


def _when(value: str | None, *, date_only: tuple[int, int]) -> tuple[bool, float | None]:
    """(given, time) from a tool argument: absent, "none" to clear, or ISO."""
    if value is None or not value.strip():
        return False, None
    if value.strip().casefold() in {"none", "null", "clear"}:
        return True, None
    return True, parse_local(value, date_only=date_only)


# A bare due date means by the end of that day; a bare reminder, that morning.
_DUE_DAY = (23, 59)
_REMIND_DAY = (9, 0)

INSTRUCTIONS = """\
## The user's to-do list

Polly keeps the user's to-dos and reminders: the list they see in the app and \
the notch. It is theirs, and separate from any plan you keep for your own work. \
Open right now:

<todos>
{todos}
</todos>

When the user asks you to remember to do something, to remind them, or to keep \
track of a task for them, add it with `add_todo` (`remind` makes the notch \
remind them at that time). Use `complete_todo` when they say one is done, and \
`update_todo` to change one. Times are the user's local time; it is now {now}."""


def prompt() -> str:
    open_ = all_todos("open")
    lines = [f"- {describe(t)}" for t in open_[:PROMPT_LIMIT]]
    if len(open_) > PROMPT_LIMIT:
        lines.append(f"- …and {len(open_) - PROMPT_LIMIT} more (call `list_todos`)")
    now = dt.datetime.now().astimezone()
    return INSTRUCTIONS.format(
        todos="\n".join(lines) or "(nothing open)",
        now=f"{_local(now.timestamp())} ({now:%Z, UTC%z})",
    )


def tools_for(agent_id: str) -> list[BaseTool]:
    source = TodoSource(kind="agent", agent_id=agent_id)

    @tool
    def add_todo(
        title: Annotated[str, "What to do, as a short imperative: 'Send Maria the deck'."],
        notes: Annotated[str | None, "Details worth keeping with it."] = None,
        due: Annotated[str | None, "When it is due: ISO 8601 local time, 2026-10-07T17:00."] = None,
        remind: Annotated[
            str | None, "When to remind the user: ISO 8601 local time, 2026-10-07T09:00."
        ] = None,
    ) -> str:
        """Add a to-do (with `remind`, a reminder) to the user's list."""
        try:
            _, due_at = _when(due, date_only=_DUE_DAY)
            _, remind_at = _when(remind, date_only=_REMIND_DAY)
            todo = add(
                TodoFields(title=title, notes=notes or "", due_at=due_at, remind_at=remind_at),
                source=source,
            )
        except ValueError as exc:
            return f"Not added: {exc}."
        return f"Added {describe(todo)}"

    @tool
    def list_todos(
        status: Annotated[Literal["open", "done", "all"], "Which to-dos to list."] = "open",
    ) -> str:
        """List the user's to-dos with their ids."""
        found = all_todos(status)
        if not found:
            return f"No {status} to-dos." if status != "all" else "The list is empty."
        return "\n".join(f"- {describe(t)}" for t in found[:100])

    @tool
    def update_todo(
        todo_id: Annotated[str, "The id shown in brackets."],
        title: Annotated[str | None, "A new title."] = None,
        notes: Annotated[str | None, "New notes (replaces the old ones)."] = None,
        due: Annotated[str | None, "New due time, ISO 8601 local; 'none' clears it."] = None,
        remind: Annotated[str | None, "New reminder time, ISO 8601 local; 'none' clears."] = None,
        status: Annotated[Literal["open", "done"] | None, "Reopen or finish it."] = None,
    ) -> str:
        """Change one of the user's to-dos. Only the fields you pass change."""
        patch: dict[str, Any] = {}
        try:
            if title is not None:
                patch["title"] = title
            if notes is not None:
                patch["notes"] = notes
            if status is not None:
                patch["status"] = status
            given, at = _when(due, date_only=_DUE_DAY)
            if given:
                patch["due_at"] = at
            given, at = _when(remind, date_only=_REMIND_DAY)
            if given:
                patch["remind_at"] = at
            todo = update(todo_id.strip().strip("[]"), patch)
        except ValueError as exc:
            return f"Not changed: {exc}."
        if todo is None:
            return f"No to-do with id {todo_id!r}."
        return f"Updated {describe(todo)}"

    @tool
    def complete_todo(todo_id: Annotated[str, "The id shown in brackets."]) -> str:
        """Mark one of the user's to-dos done."""
        todo = update(todo_id.strip().strip("[]"), {"status": "done"})
        if todo is None:
            return f"No to-do with id {todo_id!r}."
        return f"Done: {todo.title}"

    return [add_todo, list_todos, update_todo, complete_todo]


def middleware(agent_id: str) -> Any:
    """Gives an agent the user's to-do list: the four tools, and the open
    to-dos in its system prompt each time the model is called."""
    from langchain.agents.middleware.types import AgentMiddleware

    class TodosMiddleware(AgentMiddleware):
        name = "PollyTodos"

        def __init__(self) -> None:
            super().__init__()
            self.tools = tools_for(agent_id)

        def _with_todos(self, request):
            system = request.system_message
            text = system.text if system is not None else ""
            return request.override(
                system_message=SystemMessage(content=f"{text}\n\n{prompt()}".strip())
            )

        def wrap_model_call(self, request, handler):
            return handler(self._with_todos(request))

        async def awrap_model_call(self, request, handler):
            return await handler(self._with_todos(request))

    return TodosMiddleware()
