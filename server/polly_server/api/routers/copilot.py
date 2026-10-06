"""The copilot's HTTP surface; the notch window calls it.

`/observe` takes a screen snapshot and streams what the copilot offers for
it. `/act`, `/ask` and `/rewrite` run what the user asked for. All four stream
`CopilotEvent` frames (`apps/desktop/src/shared/contracts.ts`).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from polly_server.coder.runs import sse
from polly_server.config import settings
from polly_server.copilot import actions, brain, lenses, recall, vision
from polly_server.copilot import log as seen
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot, visible_text

log = logging.getLogger(__name__)

router = APIRouter(prefix="/copilot", tags=["copilot"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _require_model() -> None:
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")


def _stream(events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    async def body() -> AsyncIterator[str]:
        try:
            async for event in events:
                yield sse(event)
        except Exception as exc:  # noqa: BLE001 - the notch shows it instead of hanging
            log.exception("copilot stream failed")
            yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        yield sse({"type": "done"})

    return StreamingResponse(body(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------- settings, log, recall ----------


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return copilot_settings.load().model_dump()


@router.patch("/settings")
def patch_settings(body: dict[str, Any]) -> dict[str, Any]:
    try:
        return copilot_settings.update(body).model_dump()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/log")
def get_log(limit: int = 100) -> dict[str, Any]:
    return {"entries": seen.entries(limit)}


@router.delete("/log", status_code=204)
def clear_log() -> None:
    seen.clear()


@router.get("/recall")
async def search_recall(q: str, k: int = 8) -> dict[str, Any]:
    return {"hits": await recall.search(q, k=k), "count": recall.count()}


@router.delete("/recall", status_code=204)
def clear_recall() -> None:
    recall.clear()


# ---------- feedback ----------


class FeedbackIn(BaseModel):
    kind: Literal["ignore", "mute", "apply", "todo_ignored", "todo_accepted"]
    lens: str = ""
    hint_kind: str = ""
    title: str = ""


@router.post("/feedback", status_code=204)
def feedback(body: FeedbackIn) -> None:
    """Ignored and accepted to-dos are not proposed again; "Don't show these" mutes a hint
    kind for the lens it was shown in."""
    if body.kind == "mute" and body.lens and body.hint_kind:
        copilot_settings.mute(body.lens, body.hint_kind)
    elif body.kind in ("todo_ignored", "todo_accepted") and body.title:
        brain.remember_todo(body.title)


# ---------- the streams ----------


class ObserveIn(BaseModel):
    trigger: Literal["switch", "typing", "content", "visual", "open"]
    snapshot: Snapshot


async def _observe(trigger: str, snapshot: Snapshot) -> AsyncIterator[dict[str, Any]]:
    started = time.monotonic()
    prefs = copilot_settings.load()
    lens = lenses.detect(snapshot)
    context = {
        "label": lenses.label(snapshot),
        "lens": lens.id,
        "app": snapshot.app.name,
        "bundle_id": snapshot.app.bundleId,
    }
    yield {"type": "context", "context": context}
    if prefs.suggest.chips and trigger in ("switch", "open"):
        yield {"type": "chips", "chips": [chip.dump() for chip in lens.chips]}

    scene = await _scene(snapshot)
    scene_text = scene.text() if scene else None
    if scene:
        yield {"type": "scene", "summary": scene.summary}
    recall.remember(snapshot, scene_text)

    if not (prefs.suggest.chips or prefs.suggest.hints or prefs.suggest.todos):
        seen.record(trigger, snapshot, scene=scene_text, outcome="quiet", started=started)
        return

    data = await brain.triage(trigger, snapshot, scene_text)
    outcome: list[str] = []

    label = " ".join(str(data.get("label") or "").split())[:80]
    if label and label != context["label"]:
        yield {"type": "context", "context": {**context, "label": label}}
    if prefs.suggest.chips and (chips := brain.clean_chips(data.get("chips"))):
        yield {"type": "chips", "chips": chips}
        outcome.append("chips")

    if prefs.suggest.todos:
        for proposal in brain.todo_proposals(data.get("todos"), snapshot):
            yield {"type": "todo", "todo": proposal}
            outcome.append("to-do")

    hint = brain.pick_hint(data, snapshot, lens.id) if prefs.suggest.hints else None
    if hint:
        brain.remember_hint(snapshot.window_key, hint["title"])
        outcome.append(f"hint: {hint['title']}")
        async for event in brain.write_hint(hint, snapshot, scene_text):
            yield event
    elif not outcome:
        yield {"type": "quiet", "reason": "nothing worth interrupting for"}

    seen.record(
        trigger,
        snapshot,
        scene=scene_text,
        outcome=", ".join(outcome) or "quiet",
        started=started,
    )


# Below this much text, the brain can't tell what the window is without eyes.
THIN_TEXT = 600
_looking: set[asyncio.Task] = set()


async def _scene(snapshot: Snapshot) -> vision.Scene | None:
    """What the window shows, without making the brain wait when it can help.

    With enough text read from the window, the brain goes ahead on the last
    scene for it (or none) while the vision model looks in the background, so
    the next call has a fresh one. With little text (a canvas app, an image,
    a scanned PDF) the brain waits for the eyes.
    """
    if scene := vision.fresh(snapshot):
        return scene
    if snapshot.screenshot is None:
        return vision.cached(snapshot)
    text = len(visible_text(snapshot)) + len(
        (snapshot.focused.value or "") if snapshot.focused else ""
    )
    if text < THIN_TEXT:
        return await vision.glance(snapshot)
    task = asyncio.create_task(vision.glance(snapshot))
    _looking.add(task)
    task.add_done_callback(_looking.discard)
    return vision.cached(snapshot)


@router.post("/observe")
def observe(body: ObserveIn) -> StreamingResponse:
    _require_model()
    if body.snapshot.excluded:
        return _stream(_excluded())
    return _stream(_observe(body.trigger, body.snapshot))


async def _excluded() -> AsyncIterator[dict[str, Any]]:
    yield {"type": "quiet", "reason": "excluded"}


class ChipIn(BaseModel):
    id: str
    label: str
    agentic: bool = False


class ActIn(BaseModel):
    chip: ChipIn
    snapshot: Snapshot
    kb_ids: list[str] = Field(default_factory=list)


@router.post("/act")
def act(body: ActIn) -> StreamingResponse:
    _require_model()
    return _stream(
        actions.act(
            body.chip.id,
            body.chip.label,
            body.snapshot,
            body.kb_ids,
            agentic=body.chip.agentic,
        )
    )


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class AskIn(BaseModel):
    message: str
    history: list[Turn] = Field(default_factory=list)
    snapshot: Snapshot | None = None
    kb_ids: list[str] = Field(default_factory=list)


@router.post("/ask")
def ask(body: AskIn) -> StreamingResponse:
    _require_model()
    if not body.message.strip():
        raise HTTPException(422, "a question needs some text")
    return _stream(
        actions.ask(
            body.message.strip(),
            [t.model_dump() for t in body.history],
            body.snapshot,
            body.kb_ids,
        )
    )


class RewriteIn(BaseModel):
    text: str
    instruction: str
    token: str | None = None
    app: str | None = None


@router.post("/rewrite")
def rewrite(body: RewriteIn) -> StreamingResponse:
    _require_model()
    if not body.text.strip():
        raise HTTPException(422, "nothing selected to rewrite")
    return _stream(actions.rewrite(body.text, body.instruction, body.token, body.app))
