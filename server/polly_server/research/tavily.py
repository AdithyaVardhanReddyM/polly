"""A small Tavily client: search and extract over the REST API.

We call the API directly (rather than through `langchain_tavily`'s tools) so
the research tools can number sources and shape the output for the model.
Tests swap the transport with `use_transport`.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx

from polly_server.config import settings

API = "https://api.tavily.com"
TIMEOUT = 60.0

_transport: httpx.BaseTransport | None = None


class TavilyError(RuntimeError):
    pass


def use_transport(transport: httpx.BaseTransport | None) -> None:
    global _transport
    _transport = transport


def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    if not settings.tavily_api_key:
        raise TavilyError("TAVILY_API_KEY is not set")
    with httpx.Client(
        base_url=API,
        timeout=TIMEOUT,
        transport=_transport,
        headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
    ) as client:
        try:
            response = client.post(path, json=body)
        except httpx.HTTPError as exc:
            raise TavilyError(f"Tavily request failed: {exc}") from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("detail") or response.text
        except ValueError:
            detail = response.text
        raise TavilyError(f"Tavily {response.status_code}: {str(detail)[:300]}")
    return response.json()


def search(
    query: str,
    *,
    depth: Literal["basic", "advanced"] = "advanced",
    max_results: int = 6,
    topic: Literal["general", "news"] = "general",
    time_range: Literal["day", "week", "month", "year"] | None = None,
    include_domains: list[str] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "query": query,
        "search_depth": depth,
        "max_results": max_results,
        "topic": topic,
        "include_favicon": True,
    }
    if time_range:
        body["time_range"] = time_range
    if include_domains:
        body["include_domains"] = include_domains
    return _post("/search", body)


def extract(urls: list[str], *, query: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "urls": urls,
        "extract_depth": "basic",
        "format": "markdown",
        "include_favicon": True,
    }
    if query:
        body["query"] = query
    return _post("/extract", body)
