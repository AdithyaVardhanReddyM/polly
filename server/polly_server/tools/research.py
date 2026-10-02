"""Research tools: web search and page reading, with numbered sources.

Each result carries a session-stable number the model cites inline (`[3]`).
New sources are announced to the app as `sources.added` events so it can show
them while the run is still going.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from langchain.tools import ToolRuntime
from langchain_core.tools import tool

from polly_server import artifacts
from polly_server.research import sources, tavily

SNIPPET_CHARS = 700
PAGE_CHARS = 9_000
MAX_EXTRACT_URLS = 3


def _announce(runtime: ToolRuntime, new: list[sources.Source]) -> None:
    if not new:
        return
    writer = getattr(runtime, "stream_writer", None)
    if writer is None:
        return
    try:
        writer({"type": "sources.added", "sources": [s.model_dump() for s in new]})
    except Exception:  # noqa: BLE001 - the stream may be closed; the sources are saved anyway
        pass


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split()) if limit <= SNIPPET_CHARS else text.strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " …"


@tool
def research_search(
    runtime: ToolRuntime,
    query: Annotated[str, "A focused search query: names, versions, dates beat vague phrases."],
    topic: Annotated[
        Literal["general", "news"], "Use 'news' for recent events and announcements."
    ] = "general",
    time_range: Annotated[
        Literal["any", "day", "week", "month", "year"], "Only results from this recent window."
    ] = "any",
    domains: Annotated[
        list[str] | None, "Restrict to these domains, e.g. ['docs.python.org']. Optional."
    ] = None,
) -> str:
    """Search the web. Returns numbered sources ([n] title, URL, snippet) to cite inline."""
    try:
        data = tavily.search(
            query,
            topic=topic,
            time_range=None if time_range == "any" else time_range,
            include_domains=[d for d in (domains or []) if d][:10] or None,
        )
    except tavily.TavilyError as exc:
        return f"Search failed: {exc}"
    results: list[dict[str, Any]] = [r for r in data.get("results") or [] if r.get("url")]
    if not results:
        return f"No results for {query!r}. Try a broader or differently worded query."
    numbered, new = sources.register(artifacts.session_id_of(runtime), results)
    _announce(runtime, new)
    lines = [f"Results for {query!r}:"]
    for src, result in zip(numbered, results, strict=False):
        lines.append(f"\n[{src.id}] {src.title or result.get('title') or src.url}\n{src.url}")
        snippet = str(result.get("content") or "")
        if snippet:
            lines.append(_clip(snippet, SNIPPET_CHARS))
    return "\n".join(lines)


@tool
def web_extract(
    runtime: ToolRuntime,
    urls: Annotated[list[str], "Up to 3 http(s) URLs to read in full, usually from search."],
    focus: Annotated[str, "What you are looking for on the pages (optional)."] = "",
) -> str:
    """Read web pages in full (as markdown). Use it when snippets are not enough."""
    picked = [u.strip() for u in urls if urlsplit(u.strip()).scheme in ("http", "https")]
    picked = picked[:MAX_EXTRACT_URLS]
    if not picked:
        return "Give one to three http(s) URLs."
    try:
        data = tavily.extract(picked, query=focus or None)
    except tavily.TavilyError as exc:
        return f"Reading failed: {exc}"
    results: list[dict[str, Any]] = [r for r in data.get("results") or [] if r.get("url")]
    numbered, new = sources.register(
        artifacts.session_id_of(runtime),
        [
            {"url": r.get("url"), "title": r.get("title"), "favicon": r.get("favicon")}
            for r in results
        ],
    )
    _announce(runtime, new)
    parts: list[str] = []
    for src, result in zip(numbered, results, strict=False):
        body = _clip(str(result.get("raw_content") or ""), PAGE_CHARS)
        parts.append(f"[{src.id}] {src.title or src.url}\n{src.url}\n\n{body or '(empty page)'}")
    for failed in data.get("failed_results") or []:
        url = failed.get("url") if isinstance(failed, dict) else failed
        parts.append(f"Could not read {url}.")
    return "\n\n---\n\n".join(parts) or "Nothing could be read from those URLs."


RESEARCH_TOOLS = (research_search, web_extract)
