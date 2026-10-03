"""The Designer's canvas over HTTP: the document the app and the agent share,
the images a user drops onto it, and the screenshots the critic asks for."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from polly_server import sessions
from polly_server.config import settings
from polly_server.design import document
from polly_server.design import tools as design_tools
from polly_server.design.document import DesignDoc, StaleDocument
from polly_server.sessions import session_dir

router = APIRouter(tags=["design"])

MAX_ASSET_BYTES = 15 * 1024 * 1024
ASSET_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/avif": "avif",
}


class Asset(BaseModel):
    name: str
    url: str


class ScreenshotIn(BaseModel):
    data_url: str


def _require(session_id: str) -> None:
    if sessions.get(session_id) is None:
        raise HTTPException(404, f"no session {session_id!r}")


def _assets_dir(session_id: str):
    folder = session_dir(session_id) / "assets"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def asset_url(session_id: str, name: str) -> str:
    return f"http://{settings.host}:{settings.port}/sessions/{session_id}/design/assets/{name}"


def list_assets(session_id: str) -> list[Asset]:
    folder = session_dir(session_id) / "assets"
    if not folder.is_dir():
        return []
    files = sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime)
    return [Asset(name=f.name, url=asset_url(session_id, f.name)) for f in files if f.is_file()]


def context_note(session_id: str) -> str:
    """What the agent is told about the canvas with each message."""
    note = document.summary(document.load(session_id))
    assets = list_assets(session_id)
    if assets:
        note += "\nImages the user uploaded (use these exact src values):\n"
        note += "\n".join(f"- {a.url}" for a in assets[-20:])
    return note


@router.get("/sessions/{session_id}/design", response_model=DesignDoc)
def get_design(session_id: str) -> DesignDoc:
    _require(session_id)
    return document.load(session_id)


@router.put("/sessions/{session_id}/design", response_model=DesignDoc)
def put_design(session_id: str, body: DesignDoc) -> DesignDoc:
    _require(session_id)
    try:
        return document.save_from_app(session_id, body)
    except StaleDocument:
        raise HTTPException(409, "the design changed on the server; reload it") from None


@router.get("/sessions/{session_id}/design/assets", response_model=list[Asset])
def get_assets(session_id: str) -> list[Asset]:
    _require(session_id)
    return list_assets(session_id)


@router.post("/sessions/{session_id}/design/assets", response_model=Asset, status_code=201)
async def upload_asset(session_id: str, request: Request, name: str = "image") -> Asset:
    """Store an image; the body is the file itself, typed by `content-type`."""
    _require(session_id)
    kind = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    extension = ASSET_TYPES.get(kind)
    if extension is None:
        raise HTTPException(415, "only PNG, JPEG, WebP, GIF, AVIF and SVG images can be added")
    data = await request.body()
    if not data:
        raise HTTPException(400, "the image is empty")
    if len(data) > MAX_ASSET_BYTES:
        raise HTTPException(413, "images can be at most 15 MB")
    stem = re.sub(r"[^a-z0-9]+", "-", name.rsplit(".", 1)[0].lower()).strip("-")[:40] or "image"
    filename = f"{stem}-{uuid.uuid4().hex[:6]}.{extension}"
    (_assets_dir(session_id) / filename).write_bytes(data)
    return Asset(name=filename, url=asset_url(session_id, filename))


@router.get("/sessions/{session_id}/design/assets/{name}")
def get_asset(session_id: str, name: str) -> FileResponse:
    if not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9]+", name):
        raise HTTPException(404, "no such image")
    path = session_dir(session_id) / "assets" / name
    if not path.is_file():
        raise HTTPException(404, "no such image")
    # SVG can carry script; as an <img> it never runs, opened directly it must not.
    headers = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"}
    return FileResponse(path, headers=headers)


@router.post("/sessions/{session_id}/design/screenshots/{request_id}", status_code=202)
def post_screenshot(session_id: str, request_id: str, body: ScreenshotIn) -> dict[str, bool]:
    """The app answering a `design.screenshot` event."""
    _require(session_id)
    if not body.data_url.startswith("data:image/"):
        raise HTTPException(400, "expected an image data URL")
    return {"accepted": design_tools.deliver_screenshot(request_id, body.data_url)}
