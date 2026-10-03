"""HTTP surface of the agent server. The desktop app (and later the web app)
talks to this; nothing here is exposed beyond localhost by default."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from polly_server import __version__, persistence, sandbox
from polly_server.api.routers import (
    agents,
    design,
    integrations,
    memory,
    models,
    projects,
    reviews,
    sessions,
)
from polly_server.api.schemas import Health, ModelInfo, Provider
from polly_server.config import settings
from polly_server.integrations import composio


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await persistence.open_checkpointer()
    try:
        yield
    finally:
        await persistence.close_checkpointer()


app = FastAPI(title="Polly agent server", version=__version__, lifespan=lifespan)

# The Electron renderer (file:// in production, the Vite dev server in dev)
# and the browser build all call the server directly.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(models.router)
app.include_router(agents.router)
app.include_router(memory.router)
app.include_router(projects.router)
app.include_router(sessions.router)
app.include_router(design.router)
app.include_router(integrations.router)
app.include_router(reviews.router)


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(
        service="polly-server",
        version=__version__,
        model=ModelInfo(
            provider="Nebius Token Factory",
            id=settings.model,
            configured=settings.model_configured,
        ),
        sandbox=Provider(
            provider="Nebius ConTree"
            if settings.sandbox_provider == "contree"
            else settings.sandbox_provider,
            configured=sandbox.available(),
        ),
        search=Provider(provider="Tavily", configured=bool(settings.tavily_api_key)),
        github=Provider(provider="GitHub", configured=composio.is_connected("github")),
        composio=Provider(provider="Composio", configured=composio.configured()),
    )
