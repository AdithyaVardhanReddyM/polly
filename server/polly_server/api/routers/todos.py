"""The user's to-dos and reminders. The notch polls `/todos/due`, shows each
reminder, then marks it reminded or snoozes it (`todos.py`)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from polly_server import todos
from polly_server.todos import TodoFields, TodoItem, TodoPatch

router = APIRouter(prefix="/todos", tags=["todos"])


class TodoList(BaseModel):
    todos: list[TodoItem]


class SnoozeIn(BaseModel):
    # Up to a month.
    minutes: int = Field(ge=1, le=60 * 24 * 31)


def _found(todo: TodoItem | None, todo_id: str) -> TodoItem:
    if todo is None:
        raise HTTPException(404, f"no to-do {todo_id!r}")
    return todo


@router.get("", response_model=TodoList)
def list_todos(status: Literal["open", "done", "all"] = "open") -> TodoList:
    """Open ones by due date (undated last); done ones newest completed first."""
    return TodoList(todos=todos.all_todos(status))


@router.get("/due", response_model=TodoList)
def due_todos() -> TodoList:
    """Reminders whose time has come and that were not shown yet."""
    return TodoList(todos=todos.due())


@router.post("", response_model=TodoItem, status_code=201)
def add_todo(body: TodoFields) -> TodoItem:
    try:
        return todos.add(body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.patch("/{todo_id}", response_model=TodoItem)
def update_todo(todo_id: str, body: TodoPatch) -> TodoItem:
    try:
        return _found(todos.update(todo_id, body), todo_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/{todo_id}", status_code=204)
def delete_todo(todo_id: str) -> Response:
    if not todos.remove(todo_id):
        raise HTTPException(404, f"no to-do {todo_id!r}")
    return Response(status_code=204)


@router.post("/{todo_id}/reminded", response_model=TodoItem)
def mark_reminded(todo_id: str) -> TodoItem:
    return _found(todos.mark_reminded(todo_id), todo_id)


@router.post("/{todo_id}/snooze", response_model=TodoItem)
def snooze(todo_id: str, body: SnoozeIn) -> TodoItem:
    return _found(todos.snooze(todo_id, body.minutes), todo_id)
