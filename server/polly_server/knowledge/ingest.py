"""Reading uploads into a knowledge base, in the background.

An upload is saved and recorded as `processing` straight away; a task then
reads it (`extract.py`), cuts it into chunks (`chunking.py`), keeps its text
and writes the chunks to the index, and marks the file `ready`, or `error`
with a message the user can act on. If embedding fails the chunks are still
indexed for keyword search and get their vectors later (`retry_pending`).

A file left `processing` by a server that stopped is picked up again the next
time its base is looked at (`resume`).
"""

from __future__ import annotations

import asyncio
import logging

from polly_server.config import settings
from polly_server.knowledge import extract, store
from polly_server.knowledge.chunking import chunk_pages, estimate_tokens
from polly_server.knowledge.store import KnowledgeFile
from polly_server.retrieval import Doc

log = logging.getLogger(__name__)

_tasks: dict[str, asyncio.Task[None]] = {}
_retry: asyncio.Task[None] | None = None


def _alive(task: asyncio.Task | None) -> bool:
    if task is None or task.done():
        return False
    try:
        return task.get_loop() is asyncio.get_running_loop()
    except RuntimeError:
        return False


def schedule(file: KnowledgeFile) -> None:
    """Read `file` in a background task on the running loop."""
    if _alive(_tasks.get(file.id)):
        return
    task = asyncio.get_running_loop().create_task(_process(file), name=f"knowledge:{file.id}")
    _tasks[file.id] = task

    def finished(done: asyncio.Task[None]) -> None:
        if _tasks.get(file.id) is done:
            del _tasks[file.id]

    task.add_done_callback(finished)


def resume(kb_id: str | None = None) -> None:
    """Restart files stuck in `processing` with nothing working on them."""
    for file in store.files_of([kb_id] if kb_id else [b.id for b in store.list_bases()]):
        if file.status == "processing":
            schedule(file)


def cancel(file_id: str) -> None:
    """Stop reading a file that is being deleted. Chunks it writes while
    stopping are removed once it has stopped."""
    task = _tasks.pop(file_id, None)
    if task is not None and _alive(task):
        task.cancel()
        task.add_done_callback(lambda _: store.index().delete_where("file_id", file_id))


async def wait() -> None:
    """Until every file being read is done (for tests and shutdown)."""
    while running := [t for t in _tasks.values() if _alive(t)]:
        await asyncio.gather(*running, return_exceptions=True)


def retry_pending() -> None:
    """Give vectors to chunks indexed while embedding was down, in the
    background; does nothing when nothing waits or a retry is running."""
    global _retry
    if _alive(_retry) or not store.index().pending():
        return

    async def go() -> None:
        index = store.index()
        while await index.embed_pending():
            pass

    _retry = asyncio.get_running_loop().create_task(go(), name="knowledge:embed-pending")


def _no_text(file: KnowledgeFile) -> str:
    if extract.kind_of(file.name) not in {"pdf", "image"}:
        return "Polly found no text in this file."
    if not settings.model_configured:
        return "This file is a scan or a picture; reading it needs NEBIUS_API_KEY."
    return "Polly found no text in this file, and could not read it as an image."


async def _process(file: KnowledgeFile) -> None:
    try:
        pages = await extract.extract(store.upload_path(file))
        text = "\n\n".join(p.text for p in pages if p.text.strip())
        if not text.strip():
            raise extract.Unreadable(_no_text(file))
        await asyncio.to_thread(store.save_text, file.id, pages)
        chunks = chunk_pages(pages)
        if store.get_file(file.id) is None:
            return  # deleted while it was being read
        index = store.index()
        await index.upsert(
            [
                Doc(
                    id=f"{file.id}:{c.index}",
                    text=c.text,
                    meta={
                        "kb_id": file.kb_id,
                        "file_id": file.id,
                        "file_name": file.name,
                        "page": c.page,
                        "chunk": c.index,
                    },
                    at=file.created_at,
                )
                for c in chunks
            ]
        )
        done = store.update_file(
            file.id,
            status="ready",
            error=None,
            pages=len(pages) if extract.kind_of(file.name) == "pdf" else None,
            tokens=estimate_tokens(text),
        )
        if done is None:
            await asyncio.to_thread(index.delete_where, "file_id", file.id)
    except asyncio.CancelledError:
        raise
    except extract.Unreadable as exc:
        store.update_file(file.id, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - the user sees why, the server goes on
        log.exception("knowledge: could not read %s", file.name)
        store.update_file(file.id, status="error", error=f"Polly could not read this file ({exc}).")
