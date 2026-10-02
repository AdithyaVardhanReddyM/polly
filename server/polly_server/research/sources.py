"""Numbered sources, one list per session.

Every page a research tool returns gets a number the first time it is seen
(`[1]`, `[2]`, …). Numbers are stable for the whole session, so the model can
cite them inline and the app can resolve them into links.
"""

from __future__ import annotations

import threading
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel

from polly_server import artifacts

_lock = threading.Lock()


class Source(BaseModel):
    id: int
    url: str
    title: str = ""
    favicon: str | None = None


def normalise(url: str) -> str:
    """Same page, same number: drop fragments and trailing slashes."""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def all_for(session_id: str) -> list[Source]:
    return [Source.model_validate(s) for s in artifacts.load(session_id, "sources", [])]


def register(session_id: str, items: list[dict]) -> tuple[list[Source], list[Source]]:
    """Number `items` ({url, title?, favicon?}). Returns the source for each
    item, in order, and the ones that are new to this session."""
    with _lock:
        book = all_for(session_id)
        by_url = {normalise(s.url): s for s in book}
        out: list[Source] = []
        new: list[Source] = []
        for item in items:
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            key = normalise(url)
            found = by_url.get(key)
            if found is None:
                found = Source(
                    id=len(book) + 1,
                    url=url,
                    title=str(item.get("title") or "").strip()[:300],
                    favicon=item.get("favicon") or None,
                )
                book.append(found)
                by_url[key] = found
                new.append(found)
            elif not found.title and item.get("title"):
                found.title = str(item["title"]).strip()[:300]
            out.append(found)
        if new:
            artifacts.save(session_id, "sources", [s.model_dump() for s in book])
        return out, new


def resolve(session_id: str, ids: list[int]) -> list[Source]:
    book = {s.id: s for s in all_for(session_id)}
    return [book[i] for i in ids if i in book]
