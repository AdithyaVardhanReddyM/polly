"""A snapshot of the screen, as the native helper reads it, turned into text.

The shapes mirror `ContextSnapshot` in `apps/desktop/src/shared/sense.ts`
(camelCase kept, so the app can post the helper's JSON unchanged). `describe`
renders one for a prompt: the app and window, the field the user is typing
in, the selection, the form fields, then the visible text, accessibility text
first and OCR for what it missed.
"""

from __future__ import annotations

import time
from datetime import datetime
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Rect(_Model):
    x: float
    y: float
    width: float
    height: float


class App(_Model):
    name: str = ""
    bundleId: str = ""  # noqa: N815 - the helper's field name
    pid: int = 0


class Window(_Model):
    id: int | None = None
    title: str = ""
    frame: Rect | None = None


class Focused(_Model):
    role: str = ""
    subrole: str | None = None
    label: str | None = None
    value: str | None = None
    selectedText: str | None = None  # noqa: N815
    editable: bool = False
    secure: bool = False
    frame: Rect | None = None
    token: str = ""


class Selection(_Model):
    text: str = ""
    bounds: Rect | None = None
    editable: bool = False
    token: str = ""


class Block(_Model):
    text: str
    frame: Rect | None = None
    source: str = "ax"
    role: str | None = None


class FormField(_Model):
    label: str = ""
    role: str = ""
    value: str | None = None
    frame: Rect | None = None
    token: str = ""


class Screenshot(_Model):
    jpeg: str
    width: int = 0
    height: int = 0


class Snapshot(_Model):
    at: float = Field(default_factory=lambda: time.time() * 1000)
    app: App = Field(default_factory=App)
    window: Window = Field(default_factory=Window)
    url: str | None = None
    excluded: bool = False
    document: str | None = None
    focused: Focused | None = None
    selection: Selection | None = None
    ax: list[Block] = Field(default_factory=list)
    fields: list[FormField] = Field(default_factory=list)
    ocr: list[Block] | None = None
    screenshot: Screenshot | None = None
    hash: str | None = None

    @property
    def host(self) -> str:
        return (urlparse(self.url).hostname or "") if self.url else ""

    @property
    def window_key(self) -> str:
        """Identifies "this window showing this page" across snapshots."""
        page = ""
        if self.url:
            parsed = urlparse(self.url)
            page = f"{parsed.hostname or ''}{parsed.path}"
        return f"{self.app.bundleId}|{self.window.title}|{page}"

    @property
    def seconds(self) -> float:
        return self.at / 1000


# How much screen text a prompt carries. Ultra has room for far more; this
# keeps each always-on call fast and cheap.
TEXT_BUDGET = 14_000


def _lines(blocks: list[Block]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        text = " ".join(block.text.split())
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def visible_text(snapshot: Snapshot, budget: int = TEXT_BUDGET) -> str:
    """Accessibility text, then OCR lines the accessibility tree did not have."""
    ax = _lines(snapshot.ax)
    text = "\n".join(ax)
    if snapshot.ocr:
        known = text.casefold()
        extra = [line for line in _lines(snapshot.ocr) if line.casefold() not in known]
        if extra:
            read = "\n".join(extra)
            text = f"{text}\n\n[read from the screenshot]\n{read}" if text else read
    if len(text) > budget:
        text = text[:budget] + "\n…"
    return text.strip()


def _quote(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) > limit:
        text = text[:limit] + "…"
    return f'"""\n{text}\n"""'


def describe(snapshot: Snapshot, scene: str | None = None, *, budget: int = TEXT_BUDGET) -> str:
    """The snapshot as prompt text."""
    parts = [f"App: {snapshot.app.name} ({snapshot.app.bundleId})"]
    if snapshot.window.title:
        parts.append(f"Window: {snapshot.window.title}")
    if snapshot.url:
        parts.append(f"URL: {snapshot.url}")
    if snapshot.document:
        parts.append(f"File: {snapshot.document}")

    focused = snapshot.focused
    if focused and not focused.secure:
        what = focused.role.removeprefix("AX") or "element"
        label = f' "{focused.label}"' if focused.label else ""
        state = "editable" if focused.editable else "read-only"
        if focused.value:
            parts.append(
                f"Focused: {what}{label} ({state}). Its current text:\n"
                + _quote(focused.value, 6_000)
            )
        else:
            parts.append(f"Focused: {what}{label} ({state}), empty.")

    if snapshot.selection and snapshot.selection.text.strip():
        parts.append("Selected text:\n" + _quote(snapshot.selection.text, 4_000))

    if snapshot.fields:
        rows = []
        for n, field in enumerate(snapshot.fields, start=1):
            value = field.value if field.value not in (None, "") else "(empty)"
            rows.append(
                f"  [{n}] {field.label or '(no label)'} · {field.role.removeprefix('AX')}"
                f" · {value[:120]}"
            )
        parts.append("Form fields in this window:\n" + "\n".join(rows))

    if scene:
        parts.append(f"What the screenshot shows (vision model): {scene}")

    text = visible_text(snapshot, budget)
    parts.append("Visible text:\n" + (_quote(text, budget + 10) if text else "(none read)"))
    return "\n".join(parts)


def now_line() -> str:
    now = datetime.now().astimezone()
    return now.strftime("Now: %A %d %B %Y, %H:%M (%Z, UTC%z)")
