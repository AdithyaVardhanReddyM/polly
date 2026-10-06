"""The copilot's eyes: a vision model looks at the focused window.

Nemotron, the brain, reads text only. Most of what it needs is text the
helper already read (accessibility and OCR), but layout, charts, images and
apps that draw on a canvas need eyes. Two uses:

- `glance`: when the user lands on a window (or it changes a lot), a short
  scene card: what the window shows, what the user seems to be doing, the
  facts that matter. Cached per window image, so typing in the same window
  never pays for it twice.
- `look`: the brain's tool. It asks one specific question about the window
  and gets a specific answer, rather than a summary that may have dropped the
  detail it needed.

Exact text and positions never come from here; they come from the helper.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass

from langchain_core.messages import HumanMessage

from polly_server import model_registry
from polly_server.copilot import replies
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot

log = logging.getLogger(__name__)

GLANCE_PROMPT = """\
You are the eyes of a desktop assistant. This is a screenshot of the user's \
{app} window titled "{title}". Look at it and reply with one JSON object only:

{{
  "summary": "one sentence: what this window shows and what the user is doing in it",
  "activity": "reading | writing | editing | browsing | chatting | filling_form | \
calculating | coding | watching | other",
  "key_items": ["up to 8 short facts that matter: names, numbers, dates, deadlines, \
questions put to the user, errors"],
  "visual_only": "anything important that is not plain text: a chart's trend, an image, \
a highlighted cell, a dialog, an error badge; empty string if nothing"
}}

Be literal and precise. Do not guess at text you cannot read."""

LOOK_PROMPT = """\
You are the eyes of a desktop assistant. This is a screenshot of the user's \
{app} window titled "{title}". Answer the question about it precisely and \
briefly. Quote text exactly as it appears. If the screenshot does not show the \
answer, say so.

Question: {question}"""


@dataclass
class Scene:
    summary: str
    activity: str
    key_items: list[str]
    visual_only: str

    def text(self) -> str:
        parts = [self.summary]
        if self.key_items:
            parts.append("Key items: " + "; ".join(self.key_items))
        if self.visual_only:
            parts.append("Not in the text: " + self.visual_only)
        return " ".join(parts)


# window key → (image hash, scene). Small: only recent windows matter.
_cache: OrderedDict[str, tuple[str, Scene]] = OrderedDict()
_CACHE_SIZE = 48
# Hashes this close are the same picture (a caret blink, a clock tick).
_SAME_PICTURE = 6


def _distance(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


def cached(snapshot: Snapshot) -> Scene | None:
    """The last scene for this window, whatever its image looked like then."""
    hit = _cache.get(snapshot.window_key)
    return hit[1] if hit else None


def fresh(snapshot: Snapshot) -> Scene | None:
    """The cached scene, if the window still looks the same."""
    hit = _cache.get(snapshot.window_key)
    if hit and snapshot.hash and _distance(hit[0], snapshot.hash) <= _SAME_PICTURE:
        return hit[1]
    return None


def _model(max_tokens: int):
    from polly_server.models import chat_model

    # Looking should take a second or two: the least thinking the model allows
    # (off where it can be turned off). Thinking counts against max_tokens, so
    # leave room for it on models that always think.
    model = copilot_settings.load().vision_model
    spec = model_registry.get(model)
    effort = next((e for e in ("none", "low") if e in spec.efforts), None)
    return chat_model(model=model, reasoning_effort=effort, max_tokens=max_tokens)


def _image_message(snapshot: Snapshot, prompt: str) -> HumanMessage:
    assert snapshot.screenshot is not None
    return HumanMessage(
        content=[
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{snapshot.screenshot.jpeg}"},
            },
        ]
    )


async def glance(snapshot: Snapshot) -> Scene | None:
    """A scene card for the window; from the cache when the picture is unchanged."""
    if snapshot.screenshot is None:
        return cached(snapshot)
    if scene := fresh(snapshot):
        return scene
    prompt = GLANCE_PROMPT.format(app=snapshot.app.name, title=snapshot.window.title)
    try:
        reply = await _model(4_000).ainvoke([_image_message(snapshot, prompt)])
    except Exception as exc:  # noqa: BLE001 - no eyes is a degraded answer, not a failure
        log.warning("glance failed: %s", exc)
        return cached(snapshot)
    data = replies.parse_json(replies.text_of(reply)) or {}
    summary = str(data.get("summary") or "").strip()
    if not summary:
        return cached(snapshot)
    scene = Scene(
        summary=summary,
        activity=str(data.get("activity") or "other"),
        key_items=[str(item) for item in data.get("key_items") or []][:8],
        visual_only=str(data.get("visual_only") or "").strip(),
    )
    _cache[snapshot.window_key] = (snapshot.hash or "", scene)
    _cache.move_to_end(snapshot.window_key)
    while len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return scene


async def look(snapshot: Snapshot, question: str) -> str:
    """One question about the window, answered from its screenshot."""
    if snapshot.screenshot is None:
        return "No screenshot of this window is available (Screen Recording may be off)."
    prompt = LOOK_PROMPT.format(
        app=snapshot.app.name, title=snapshot.window.title, question=question
    )
    try:
        reply = await _model(6_000).ainvoke([_image_message(snapshot, prompt)])
    except Exception as exc:  # noqa: BLE001
        return f"Could not look at the window ({type(exc).__name__}: {exc})."
    return replies.text_of(reply).strip() or "The vision model returned nothing."
