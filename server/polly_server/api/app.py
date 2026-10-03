"""HTTP surface of the agent server. The desktop app (and later the web app)
talks to this; nothing here is exposed beyond localhost by default."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from polly_server import __version__, persistence
from polly_server.agents import builders, catalog
from polly_server.api.routers import design, integrations, models, projects, reviews, sessions
from polly_server.api.schemas import (
    AgentIntegrationsIn,
    AgentList,
    AgentSummary,
    Health,
    ModelInfo,
    Provider,
)
from polly_server.config import settings
from polly_server.integrations import assignments, composio


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
            configured=settings.sandbox_configured,
        ),
        search=Provider(provider="Tavily", configured=bool(settings.tavily_api_key)),
        github=Provider(provider="GitHub", configured=composio.is_connected("github")),
        composio=Provider(provider="Composio", configured=composio.configured()),
    )


@app.get("/agents", response_model=AgentList)
def list_agents() -> AgentList:
    return AgentList(agents=[AgentSummary.of(a) for a in catalog.CATALOG if builders.listed(a)])


@app.get("/agents/{agent_id}", response_model=AgentSummary)
def get_agent(agent_id: str) -> AgentSummary:
    spec = catalog.get(agent_id)
    if spec is None or not builders.listed(spec):
        raise HTTPException(status_code=404, detail=f"no agent named {agent_id!r}")
    return AgentSummary.of(spec)


@app.put("/agents/{agent_id}/integrations", response_model=AgentSummary)
def set_agent_integrations(agent_id: str, body: AgentIntegrationsIn) -> AgentSummary:
    """Choose which connected apps an agent may use."""
    spec = catalog.get(agent_id)
    if spec is None or not builders.listed(spec):
        raise HTTPException(status_code=404, detail=f"no agent named {agent_id!r}")
    try:
        assignments.set_enabled(agent_id, body.integrations)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return AgentSummary.of(spec)
