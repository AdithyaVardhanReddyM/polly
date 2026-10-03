"""Connecting accounts through Composio, and choosing which agents may use
them. Web search (Tavily) is reported here too, though it is not a Composio
toolkit: it is built in to every agent."""

from __future__ import annotations

import re
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, Response
from starlette.concurrency import run_in_threadpool

from polly_server.agents import builders
from polly_server.agents import catalog as agents
from polly_server.api.schemas import (
    ConnectStart,
    IntegrationCategory,
    IntegrationOut,
    Integrations,
    Provider,
)
from polly_server.config import settings
from polly_server.integrations import assignments, catalog, composio, github
from polly_server.integrations.composio import ComposioError
from polly_server.integrations.github import GitHubError

router = APIRouter(prefix="/integrations", tags=["integrations"])

LOGOS = "https://logos.composio.dev/api"
# Logos are served from here so the app never loads images from other hosts.
LOGO_SLUGS = catalog.SLUGS | {"tavily", "composio"}


def github_error(exc: GitHubError) -> HTTPException:
    code = exc.status if exc.status in (400, 401, 403, 404, 409, 422, 429) else 502
    return HTTPException(code, str(exc))


def _error(exc: ComposioError) -> HTTPException:
    code = exc.status if exc.status in (400, 401, 403, 404, 409, 422, 429) else 502
    return HTTPException(code, str(exc))


def _state(item: catalog.Integration, connections: dict[str, composio.Connection]) -> str:
    if item.auth == "none":
        return "ready"
    connection = connections.get(item.slug)
    if connection is None:
        return "available"
    return "connected" if connection.status == "active" else "expired"


def _list(fresh: bool) -> Integrations:
    connections = composio.connections(fresh=fresh)
    counts = composio.tool_counts()
    users: dict[str, list[str]] = {}
    for agent in agents.everyone():
        if not builders.listed(agent):
            continue
        for slug in assignments.enabled(agent.id):
            users.setdefault(slug, []).append(agent.id)
    return Integrations(
        composio=Provider(provider="Composio", configured=composio.configured()),
        tavily=Provider(provider="Tavily", configured=bool(settings.tavily_api_key)),
        github=github.status().model_dump(),
        categories=[IntegrationCategory(id=c, label=label) for c, label in catalog.CATEGORIES],
        items=[
            IntegrationOut(
                slug=item.slug,
                name=item.name,
                category=item.category,
                description=item.description,
                auth=item.auth,
                state=_state(item, connections),
                connected_at=c.connected_at if (c := connections.get(item.slug)) else None,
                tools=counts.get(item.slug),
                agents=users.get(item.slug, []),
            )
            for item in catalog.CATALOG
        ],
    )


@router.get("", response_model=Integrations)
async def list_integrations(fresh: bool = False) -> Integrations:
    """`fresh` skips the short cache: the app sets it while it waits for a
    sign-in to finish in the browser."""
    return await run_in_threadpool(_list, fresh)


@router.get("/connected", response_class=HTMLResponse, include_in_schema=False)
def connected_page() -> str:
    """Where Composio sends the browser after a sign-in."""
    return CONNECTED_PAGE


@router.get("/{slug}/logo")
async def logo(slug: str, theme: Literal["light", "dark"] = "light") -> Response:
    """The app's mark, drawn for a light or a dark background."""
    if slug not in LOGO_SLUGS:
        raise HTTPException(404, "no such integration")
    folder = settings.data_path("cache", "logos", theme)
    cached = next(iter(folder.glob(f"{slug}.*")), None)
    if cached is None:
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as http:
                reply = await http.get(f"{LOGOS}/{slug}", params={"theme": theme})
        except httpx.HTTPError:
            raise HTTPException(502, "could not fetch the logo") from None
        kind = reply.headers.get("content-type", "").split(";")[0].strip()
        if reply.status_code != 200 or not re.fullmatch(r"image/(png|svg\+xml|jpeg|webp)", kind):
            raise HTTPException(404, "no logo")
        ext = {"image/svg+xml": "svg", "image/jpeg": "jpg"}.get(kind, kind.split("/")[1])
        cached = folder / f"{slug}.{ext}"
        cached.write_bytes(reply.content)
    kind = {"svg": "image/svg+xml", "jpg": "image/jpeg"}.get(
        cached.suffix[1:], f"image/{cached.suffix[1:]}"
    )
    return Response(
        cached.read_bytes(),
        media_type=kind,
        headers={
            "Cache-Control": "public, max-age=604800",
            # An SVG from elsewhere must never run script if opened directly.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{slug}/connect", response_model=ConnectStart)
async def connect(slug: str) -> ConnectStart:
    """Start a sign-in. The app opens the returned link in the browser and
    polls the list until the account shows up."""
    try:
        return ConnectStart(url=await run_in_threadpool(composio.connect, slug))
    except ComposioError as exc:
        raise _error(exc) from None


@router.delete("/{slug}", response_model=Integrations)
async def disconnect(slug: str) -> Integrations:
    if catalog.get(slug) is None:
        raise HTTPException(404, "no such integration")
    try:
        await run_in_threadpool(composio.disconnect, slug)
    except ComposioError as exc:
        raise _error(exc) from None
    return await run_in_threadpool(_list, False)


CONNECTED_PAGE = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connected · Polly</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #fafafb; color: #1c1b22;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  main { text-align: center; padding: 32px; }
  .mark { width: 52px; height: 52px; margin: 0 auto 18px; border-radius: 50%;
    background: #f3eeff; color: #907ad6; display: grid; place-items: center; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 6px; }
  p { margin: 0; color: #6b6a75; }
  @media (prefers-color-scheme: dark) {
    body { background: #111114; color: #ececf1; }
    .mark { background: #26213a; color: #a08ce4; }
    p { color: #a1a0ab; }
  }
</style>
<main>
  <div class="mark">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  </div>
  <h1>You're connected</h1>
  <p>You can close this tab and go back to Polly.</p>
</main>
</html>
"""
