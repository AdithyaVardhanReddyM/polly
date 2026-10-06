"""Knowledge bases: make one, add files, search it and chat with it
(`polly_server/knowledge/`). Files are read in the background; the app polls
the base to see each one go from `processing` to `ready` or `error`."""

from __future__ import annotations

import asyncio
import mimetypes
import shutil
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from polly_server.api.routers.sessions import SSE_HEADERS
from polly_server.coder.runs import sse
from polly_server.config import settings
from polly_server.knowledge import answering, extract, ingest, store
from polly_server.knowledge.answering import ChatTurn, KnowledgeHit
from polly_server.knowledge.store import KnowledgeBase, KnowledgeDetail, KnowledgeFile

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

MAX_UPLOAD = 50 * 1024 * 1024
_READ = 1024 * 1024


class BaseList(BaseModel):
    bases: list[KnowledgeBase]


class BaseIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class BasePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)


class FileList(BaseModel):
    files: list[KnowledgeFile]


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=2_000)
    k: int = Field(default=8, ge=1, le=50)


class HitList(BaseModel):
    hits: list[KnowledgeHit]


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    history: list[ChatTurn] = []


def _base(kb_id: str) -> KnowledgeBase:
    base = store.get_base(kb_id)
    if base is None:
        raise HTTPException(404, f"no knowledge base {kb_id!r}")
    return base


@router.get("", response_model=BaseList)
async def list_bases() -> BaseList:
    """Newest updated first."""
    ingest.resume()
    return BaseList(bases=store.list_bases())


@router.post("", response_model=KnowledgeBase, status_code=201)
def create_base(body: BaseIn) -> KnowledgeBase:
    try:
        return store.create_base(body.name, body.description)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/{kb_id}", response_model=KnowledgeDetail)
async def get_base(kb_id: str) -> KnowledgeDetail:
    ingest.resume(kb_id)
    found = store.detail(kb_id)
    if found is None:
        raise HTTPException(404, f"no knowledge base {kb_id!r}")
    return found


@router.patch("/{kb_id}", response_model=KnowledgeBase)
def update_base(kb_id: str, body: BasePatch) -> KnowledgeBase:
    try:
        changed = store.update_base(kb_id, name=body.name, description=body.description)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if changed is None:
        raise HTTPException(404, f"no knowledge base {kb_id!r}")
    return changed


@router.delete("/{kb_id}", status_code=204)
async def delete_base(kb_id: str) -> Response:
    _base(kb_id)
    for file in store.files_of([kb_id]):
        ingest.cancel(file.id)
    await asyncio.to_thread(store.delete_base, kb_id)
    return Response(status_code=204)


async def _save(upload: UploadFile, file: KnowledgeFile) -> int:
    """Copy the upload to disk; its size, or 413 past the limit."""
    path = store.upload_path(file)
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with path.open("wb") as out:
        while (data := await upload.read(_READ)) and size + len(data) <= MAX_UPLOAD:
            size += len(data)
            out.write(data)
    if data:
        shutil.rmtree(store.upload_dir(file.id), ignore_errors=True)
        raise HTTPException(413, f"{upload.filename} is larger than 50 MB")
    return size


@router.post("/{kb_id}/files", response_model=FileList, status_code=201)
async def add_files(kb_id: str, files: Annotated[list[UploadFile], File()]) -> FileList:
    """Save each upload and start reading it. Files Polly cannot read are
    kept with status `error` and a message saying what it can read."""
    _base(kb_id)
    if not files:
        raise HTTPException(422, "no files")
    too_big = [f.filename for f in files if f.size is not None and f.size > MAX_UPLOAD]
    if too_big:
        raise HTTPException(413, f"larger than 50 MB: {', '.join(map(str, too_big))}")

    added: list[KnowledgeFile] = []
    for upload in files:
        name = upload.filename or "file"
        mime = (
            upload.content_type
            if upload.content_type and upload.content_type != "application/octet-stream"
            else mimetypes.guess_type(name)[0] or "application/octet-stream"
        )
        file = store.new_file(kb_id, name, mime)
        try:
            size = await _save(upload, file)
        except HTTPException:
            for done in added:
                ingest.cancel(done.id)
                store.delete_file(kb_id, done.id)
            raise
        file = file.model_copy(update={"size": size})
        if extract.kind_of(name) is None:
            file = file.model_copy(
                update={"status": "error", "error": extract.unsupported_message(name)}
            )
        if not store.add_file(file):
            shutil.rmtree(store.upload_dir(file.id), ignore_errors=True)
            raise HTTPException(404, f"no knowledge base {kb_id!r}")
        if file.status == "processing":
            ingest.schedule(file)
        added.append(file)
    return FileList(files=added)


@router.delete("/{kb_id}/files/{file_id}", status_code=204)
async def delete_file(kb_id: str, file_id: str) -> Response:
    ingest.cancel(file_id)
    if not await asyncio.to_thread(store.delete_file, kb_id, file_id):
        raise HTTPException(404, f"no file {file_id!r} in {kb_id!r}")
    return Response(status_code=204)


@router.post("/{kb_id}/search", response_model=HitList)
async def search(kb_id: str, body: SearchIn) -> HitList:
    _base(kb_id)
    return HitList(hits=await answering.search([kb_id], body.query, body.k))


@router.post("/{kb_id}/chat")
async def chat(kb_id: str, body: ChatIn) -> StreamingResponse:
    """A cited answer as SSE: `sources`, `delta`…, `sources` (the cited
    ones), `done`; or `error`."""
    _base(kb_id)
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")

    async def body_() -> AsyncIterator[str]:
        async for event in answering.answer([kb_id], body.message, body.history):
            yield sse(event)

    return StreamingResponse(body_(), media_type="text/event-stream", headers=SSE_HEADERS)
