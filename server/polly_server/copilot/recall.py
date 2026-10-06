"""Recall: a searchable text history of what was on the user's screen.

"Find the email about the DPA" works because every window the copilot looked
at is kept as text (never images): its title, URL, visible text and what the
vision model said about it. One entry per window per ten minutes, updated as
the window changes, searched by keywords and meaning together, and dropped
after the number of days set in Settings. Excluded apps, sites and windows
never get here: the helper does not read them.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any

from polly_server.config import settings
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot, visible_text

log = logging.getLogger(__name__)

# One entry per window per bucket: long enough to merge typing, short enough
# that a thread read twice on different days is two moments.
BUCKET_S = 10 * 60
TEXT_LIMIT = 8_000

_index: Any = None
_pending: set[asyncio.Task] = set()
_last_prune = 0.0


def index():
    global _index
    if _index is None:
        from polly_server.retrieval import HybridIndex

        _index = HybridIndex(settings.data_path("copilot") / "recall.sqlite", "recall")
    return _index


def _doc(snapshot: Snapshot, scene: str | None):
    from polly_server.retrieval import Doc

    at = snapshot.seconds or time.time()
    key = hashlib.sha1(snapshot.window_key.encode()).hexdigest()[:14]
    text_parts = [snapshot.window.title, snapshot.url or "", scene or "", visible_text(snapshot)]
    if snapshot.focused and snapshot.focused.value and not snapshot.focused.secure:
        text_parts.append(snapshot.focused.value)
    text = "\n".join(p for p in text_parts if p)[:TEXT_LIMIT]
    return Doc(
        id=f"{key}-{int(at // BUCKET_S)}",
        text=text,
        meta={
            "app": snapshot.app.name,
            "bundle_id": snapshot.app.bundleId,
            "window": snapshot.window.title,
            "url": snapshot.url or "",
        },
        at=at,
    )


def remember(snapshot: Snapshot, scene: str | None) -> None:
    """Stores the window in the background; never slows the copilot down."""
    prefs = copilot_settings.load()
    if not prefs.recall.enabled or snapshot.excluded:
        return
    if not (snapshot.ax or snapshot.ocr or snapshot.focused):
        return

    async def store() -> None:
        global _last_prune
        try:
            await index().upsert([_doc(snapshot, scene)])
            if time.time() - _last_prune > 3600:
                _last_prune = time.time()
                index().prune(time.time() - prefs.recall.days * 86_400)
        except Exception as exc:  # noqa: BLE001 - recall is best effort
            log.warning("recall store failed: %s", exc)

    task = asyncio.create_task(store())
    _pending.add(task)
    task.add_done_callback(_pending.discard)


# A hit this far below the best one is noise: it only shared a word or two.
RELATIVE_FLOOR = 0.6


async def search(query: str, k: int = 6) -> list[dict[str, Any]]:
    hits = await index().search(query, k=k)
    if not hits:
        return []
    floor = hits[0].score * RELATIVE_FLOOR
    found = []
    for hit in hits:
        if hit.score < floor:
            continue
        meta = hit.meta or {}
        # The stored text starts with the title and URL; the excerpt should show the page.
        lines = hit.text.split("\n")
        while lines and lines[0].strip() in (meta.get("window"), meta.get("url"), ""):
            lines.pop(0)
        found.append(
            {
                "id": hit.id,
                "app": meta.get("app", ""),
                "bundle_id": meta.get("bundle_id") or None,
                "window": meta.get("window", ""),
                "url": meta.get("url") or None,
                "at": hit.at,
                "excerpt": _excerpt("\n".join(lines), query),
                "score": hit.score,
            }
        )
    return found


def _excerpt(text: str, query: str, width: int = 280) -> str:
    """The part of the text around the first query word it contains."""
    flat = " ".join(text.split())
    lower = flat.casefold()
    for word in sorted(query.casefold().split(), key=len, reverse=True):
        if len(word) < 3:
            continue
        at = lower.find(word)
        if at != -1:
            start = max(0, at - width // 3)
            return ("…" if start else "") + flat[start : start + width] + "…"
    return flat[:width] + ("…" if len(flat) > width else "")


def clear() -> int:
    return index().prune(time.time() + 1)


def count() -> int:
    return index().count()
