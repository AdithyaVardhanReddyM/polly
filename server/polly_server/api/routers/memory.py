from __future__ import annotations

from fastapi import APIRouter, HTTPException

from polly_server import memory
from polly_server.api.schemas import MemoryIn, MemoryList, MemoryOut

router = APIRouter(prefix="/memory", tags=["memory"])


def _list() -> MemoryList:
    newest_first = reversed(memory.all_memories())
    return MemoryList(memories=[MemoryOut(**m.model_dump()) for m in newest_first])


@router.get("", response_model=MemoryList)
def list_memories() -> MemoryList:
    """What Polly remembers about the user, newest first."""
    return _list()


@router.post("", response_model=MemoryList, status_code=201)
def add_memory(body: MemoryIn) -> MemoryList:
    try:
        memory.add(body.text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return _list()


@router.delete("/{memory_id}", response_model=MemoryList)
def delete_memory(memory_id: str) -> MemoryList:
    if not memory.remove(memory_id):
        raise HTTPException(404, f"no memory {memory_id!r}")
    return _list()


@router.delete("", response_model=MemoryList)
def clear_memories() -> MemoryList:
    memory.clear()
    return _list()
