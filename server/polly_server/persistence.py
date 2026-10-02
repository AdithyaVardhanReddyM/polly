"""Where conversations live between runs.

Every agent run is checkpointed by LangGraph, so a session can be resumed,
reloaded in the app, or paused for approval and picked up later. The
checkpointer is one SQLite file under the data dir, opened for the life of
the server.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from polly_server.config import settings

if TYPE_CHECKING:
    from langgraph.checkpoint.base import BaseCheckpointSaver

_checkpointer: BaseCheckpointSaver | None = None
_conn = None


async def open_checkpointer() -> BaseCheckpointSaver:
    """Open (once) the SQLite checkpointer. Called from the app's lifespan."""
    global _checkpointer, _conn
    if _checkpointer is not None:
        return _checkpointer

    import aiosqlite
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    path = settings.data_path() / "checkpoints.sqlite"
    _conn = await aiosqlite.connect(str(path))
    saver = AsyncSqliteSaver(_conn)
    await saver.setup()
    _checkpointer = saver
    return saver


async def close_checkpointer() -> None:
    global _checkpointer, _conn
    if _conn is not None:
        await _conn.close()
    _checkpointer = None
    _conn = None


def use(checkpointer: BaseCheckpointSaver | None) -> None:
    """Swap the checkpointer; tests use an in-memory one."""
    global _checkpointer
    _checkpointer = checkpointer


def get_checkpointer() -> BaseCheckpointSaver:
    if _checkpointer is None:
        raise RuntimeError("checkpointer is not open; the server opens it on startup")
    return _checkpointer
