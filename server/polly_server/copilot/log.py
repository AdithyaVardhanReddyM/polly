"""What Polly saw: a short, in-memory record of every snapshot the copilot used.

Settings → Copilot shows it, so the user can check what left their Mac and
what came of it. Never written to disk.
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from typing import Any

from polly_server.copilot.context import Snapshot

_entries: deque[dict[str, Any]] = deque(maxlen=300)


def record(
    trigger: str,
    snapshot: Snapshot,
    *,
    scene: str | None,
    outcome: str,
    started: float,
) -> None:
    ax_chars = sum(len(b.text) for b in snapshot.ax)
    ocr_chars = sum(len(b.text) for b in snapshot.ocr or [])
    if snapshot.focused and snapshot.focused.value:
        ax_chars += len(snapshot.focused.value)
    _entries.appendleft(
        {
            "id": uuid.uuid4().hex[:10],
            "at": snapshot.seconds or time.time(),
            "trigger": trigger,
            "app": snapshot.app.name,
            "window": snapshot.window.title,
            "url": snapshot.url,
            "sent": {
                "ax_chars": ax_chars,
                "ocr_chars": ocr_chars,
                "screenshot": snapshot.screenshot is not None,
            },
            "scene": scene,
            "outcome": outcome,
            "ms": round((time.monotonic() - started) * 1000),
        }
    )


def entries(limit: int = 100) -> list[dict[str, Any]]:
    return list(_entries)[:limit]


def clear() -> None:
    _entries.clear()
