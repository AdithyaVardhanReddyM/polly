"""A session's design document: artboards on an infinite canvas.

An artboard is a sized frame whose content is an HTML fragment styled with
Tailwind classes and inline styles. Every element carries a stable `data-id`,
which is how the agent and the app both point at a node. The app renders the
fragment as real DOM; the server only parses it to make node-level edits.

The document lives in `<session>/design.json`. Both sides write it: the
agent through its tools, the user through the app (`PUT /design`). `rev`
goes up on every write so a stale save from the app is refused, not merged.
"""

from __future__ import annotations

import re
import threading
import uuid
from typing import Any, Literal

from bs4 import BeautifulSoup, Comment
from bs4.element import NavigableString, Tag
from pydantic import BaseModel, Field

from polly_server.sessions import session_dir

GAP = 120  # canvas pixels between artboards placed automatically
MAX_OUTLINE_NODES = 400

# Never kept: the canvas is a drawing, not a running page.
_DROPPED_TAGS = {"script", "iframe", "object", "embed", "link", "meta", "base", "title", "head"}
_UNWRAPPED_TAGS = {"html", "body"}
# Their insides are one unit on the canvas; children get no ids.
_ATOMIC_TAGS = {"svg"}

Position = Literal["replace_children", "append", "prepend", "replace", "before", "after"]


class Artboard(BaseModel):
    id: str
    name: str
    x: float = 0
    y: float = 0
    width: float = 1440
    height: float = 900
    background: str = "#ffffff"
    html: str = ""


class SelectionRef(BaseModel):
    artboard_id: str
    node_id: str | None = None


class DesignDoc(BaseModel):
    rev: int = 0
    artboards: list[Artboard] = Field(default_factory=list)
    # Google Fonts families the canvas loads.
    fonts: list[str] = Field(default_factory=list)
    # What the user has selected in the app, for "make this bigger".
    selection: list[SelectionRef] = Field(default_factory=list)

    def artboard(self, artboard_id: str) -> Artboard:
        for board in self.artboards:
            if board.id == artboard_id:
                return board
        known = ", ".join(b.id for b in self.artboards) or "none yet"
        raise LookupError(f"no artboard {artboard_id!r} (artboards: {known})")


class StaleDocument(Exception):
    """The app saved from an older revision than the one on disk."""


_lock = threading.RLock()


def _path(session_id: str):
    return session_dir(session_id) / "design.json"


def load(session_id: str) -> DesignDoc:
    path = _path(session_id)
    if not path.exists():
        return DesignDoc()
    try:
        return DesignDoc.model_validate_json(path.read_text())
    except ValueError:
        return DesignDoc()


def save(session_id: str, doc: DesignDoc) -> DesignDoc:
    with _lock:
        doc.rev += 1
        path = _path(session_id)
        draft = path.with_suffix(".tmp")
        draft.write_text(doc.model_dump_json())
        draft.replace(path)
    return doc


def save_from_app(session_id: str, doc: DesignDoc) -> DesignDoc:
    """Store what the user edited, unless the agent wrote in the meantime."""
    with _lock:
        current = load(session_id)
        if doc.rev < current.rev:
            raise StaleDocument(current.rev)
        for board in doc.artboards:
            board.html = normalize(board.html)
        doc.fonts = clean_fonts(doc.fonts)
        doc.rev = current.rev
        return save(session_id, doc)


def new_id(prefix: str = "n") -> str:
    return f"{prefix}{uuid.uuid4().hex[:6]}"


def clean_fonts(families: list[str]) -> list[str]:
    seen: list[str] = []
    for family in families:
        name = re.sub(r"[^A-Za-z0-9 ]", "", family).strip()
        if name and name not in seen:
            seen.append(name)
    return seen[:12]


# ---------- HTML ----------


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html or "", "html.parser")


def _inside_atomic(tag: Tag) -> bool:
    return any(p.name in _ATOMIC_TAGS for p in tag.parents if isinstance(p, Tag))


def _clean(soup: BeautifulSoup, taken: set[str] | None = None) -> None:
    """Strip what must not run and give every element a unique `data-id`."""
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()
    for tag in soup.find_all(_DROPPED_TAGS):
        tag.decompose()
    for tag in soup.find_all(_UNWRAPPED_TAGS):
        tag.unwrap()
    seen = set(taken or ())
    for tag in soup.find_all(True):
        for attr in [a for a in tag.attrs if a.lower().startswith("on")]:
            del tag[attr]
        for attr in ("href", "src"):
            if str(tag.get(attr, "")).strip().lower().startswith("javascript:"):
                del tag[attr]
        if _inside_atomic(tag):
            tag.attrs.pop("data-id", None)
            continue
        node_id = tag.get("data-id")
        if not node_id or node_id in seen:
            node_id = new_id()
            tag["data-id"] = node_id
        seen.add(str(node_id))


def normalize(html: str, taken: set[str] | None = None) -> str:
    soup = _soup(html)
    _clean(soup, taken)
    return str(soup).strip()


def ids_in(html: str) -> list[str]:
    return [str(t["data-id"]) for t in _soup(html).find_all(attrs={"data-id": True})]


def _find(soup: BeautifulSoup, node_id: str) -> Tag:
    tag = soup.find(attrs={"data-id": node_id})
    if not isinstance(tag, Tag):
        raise LookupError(f"no node {node_id!r} on this artboard; call get_design to see the ids")
    return tag


def node_html(board: Artboard, node_id: str | None) -> str:
    if not node_id:
        return board.html
    return str(_find(_soup(board.html), node_id))


def insert(board: Artboard, html: str, target_id: str | None, position: Position) -> list[str]:
    """Put a fragment on the artboard; returns the ids of its top-level nodes."""
    soup = _soup(board.html)
    taken = set(ids_in(board.html))
    target = _find(soup, target_id) if target_id else None
    if target is not None and position in ("replace", "replace_children"):
        # Ids about to disappear are free again, so a rewrite can keep them.
        doomed = target if position == "replace" else None
        gone = {str(t["data-id"]) for t in target.find_all(attrs={"data-id": True})}
        if doomed is not None:
            gone.add(str(doomed["data-id"]))
        taken -= gone
    elif target is None and position in ("replace", "replace_children"):
        taken = set()

    fragment = _soup(html)
    _clean(fragment, taken)
    nodes = [n for n in list(fragment.contents) if not (isinstance(n, str) and not n.strip())]
    top = [str(n["data-id"]) for n in nodes if isinstance(n, Tag) and n.get("data-id")]

    if target is None:
        if position in ("replace", "replace_children"):
            soup.clear()
        if position == "prepend":
            for node in reversed(nodes):
                soup.insert(0, node)
        else:
            for node in nodes:
                soup.append(node)
    elif position == "replace_children":
        target.clear()
        for node in nodes:
            target.append(node)
    elif position == "append":
        for node in nodes:
            target.append(node)
    elif position == "prepend":
        for node in reversed(nodes):
            target.insert(0, node)
    elif position == "before":
        for node in nodes:
            target.insert_before(node)
    elif position == "after":
        for node in reversed(nodes):
            target.insert_after(node)
    else:  # replace
        for node in nodes:
            target.insert_before(node)
        target.decompose()

    board.html = str(soup).strip()
    return top


def parse_style(text: str) -> dict[str, str]:
    style: dict[str, str] = {}
    # Split on `;` outside parentheses, so `url(data:…;base64,…)` survives.
    for part in re.split(r";(?![^(]*\))", text or ""):
        name, sep, value = part.partition(":")
        if sep and name.strip() and value.strip():
            style[name.strip().lower()] = value.strip()
    return style


def format_style(style: dict[str, str]) -> str:
    return "; ".join(f"{k}: {v}" for k, v in style.items())


def update(
    board: Artboard,
    node_id: str,
    *,
    classes: str | None = None,
    style: dict[str, str | None] | None = None,
    text: str | None = None,
    attributes: dict[str, str | None] | None = None,
) -> None:
    soup = _soup(board.html)
    tag = _find(soup, node_id)
    if classes is not None:
        if classes.strip():
            tag["class"] = classes.split()
        else:
            tag.attrs.pop("class", None)
    if style:
        merged = parse_style(str(tag.get("style", "")))
        for name, value in style.items():
            key = name.strip().lower()
            if value is None or not str(value).strip():
                merged.pop(key, None)
            else:
                merged[key] = str(value).strip()
        if merged:
            tag["style"] = format_style(merged)
        else:
            tag.attrs.pop("style", None)
    if text is not None:
        if tag.find(True) is not None:
            raise ValueError(
                f"node {node_id!r} has child elements; set the text of the leaf that holds it"
            )
        tag.string = text
    for name, value in (attributes or {}).items():
        key = name.strip()
        if not key or key.lower().startswith("on") or key in ("data-id", "class", "style"):
            continue
        if value is None:
            tag.attrs.pop(key, None)
        else:
            tag[key] = value
    board.html = str(soup).strip()


def delete(board: Artboard, node_ids: list[str]) -> int:
    soup = _soup(board.html)
    removed = 0
    for node_id in node_ids:
        tag = soup.find(attrs={"data-id": node_id})
        if isinstance(tag, Tag):
            tag.decompose()
            removed += 1
    board.html = str(soup).strip()
    return removed


# ---------- what the agent reads ----------


def _own_text(tag: Tag) -> str:
    text = " ".join(str(c).strip() for c in tag.children if isinstance(c, NavigableString))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:60] + ("…" if len(text) > 60 else "")


def outline(board: Artboard, node_id: str | None = None, limit: int = MAX_OUTLINE_NODES) -> str:
    """The artboard as an indented tree: `tag #id .classes "text"`."""
    soup = _soup(board.html)
    root: Any = _find(soup, node_id) if node_id else soup
    lines: list[str] = []

    def walk(tag: Tag, depth: int) -> None:
        if len(lines) >= limit:
            return
        classes = " ".join(tag.get("class") or [])
        parts = [f"{'  ' * depth}{tag.name} #{tag.get('data-id', '?')}"]
        if classes:
            parts.append("." + classes[:90] + ("…" if len(classes) > 90 else ""))
        text = _own_text(tag)
        if text:
            parts.append(f'"{text}"')
        if tag.name == "img":
            parts.append(f"src={str(tag.get('src', ''))[:60]}")
        lines.append(" ".join(parts))
        if tag.name in _ATOMIC_TAGS:
            return
        for child in tag.children:
            if isinstance(child, Tag):
                walk(child, depth + 1)

    if isinstance(root, Tag) and node_id:
        walk(root, 0)
    else:
        for child in root.children:
            if isinstance(child, Tag):
                walk(child, 0)
    if len(lines) >= limit:
        lines.append("… (truncated; pass node_id to look inside a node)")
    return "\n".join(lines) or "(empty)"


def place_next(doc: DesignDoc, width: float) -> tuple[float, float]:
    """Where a new artboard goes: to the right of the others, on their top line."""
    if not doc.artboards:
        return 0.0, 0.0
    right = max(b.x + b.width for b in doc.artboards)
    top = min(b.y for b in doc.artboards)
    return right + GAP, top


def summary(doc: DesignDoc) -> str:
    """One line per artboard, plus fonts and the user's selection."""
    if not doc.artboards:
        return "The canvas is empty."
    lines = ["Artboards on the canvas:"]
    for board in doc.artboards:
        state = "empty" if not board.html.strip() else f"{len(ids_in(board.html))} nodes"
        lines.append(
            f'- {board.id} "{board.name}" {round(board.width)}x{round(board.height)} ({state})'
        )
    if doc.fonts:
        lines.append("Fonts loaded: " + ", ".join(doc.fonts))
    picked = [s for s in doc.selection if any(b.id == s.artboard_id for b in doc.artboards)]
    if picked:
        lines.append("The user has selected:")
        for ref in picked[:12]:
            board = doc.artboard(ref.artboard_id)
            if not ref.node_id:
                lines.append(f"- the artboard {board.id}")
                continue
            try:
                first = outline(board, ref.node_id, limit=1).splitlines()[0].strip()
            except LookupError:
                continue
            lines.append(f"- on {board.id}: {first}")
    return "\n".join(lines)
