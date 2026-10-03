from __future__ import annotations

from fastapi import APIRouter, HTTPException

from polly_server import model_registry, sandbox, sessions
from polly_server.agents import builders, catalog, custom, drafting
from polly_server.api.schemas import (
    AgentConfig,
    AgentCreate,
    AgentDraft,
    AgentDraftIn,
    AgentIntegrationsIn,
    AgentList,
    AgentPatch,
    AgentSummary,
)
from polly_server.coder.runs import manager
from polly_server.config import settings
from polly_server.integrations import assignments

router = APIRouter(tags=["agents"])


def _listed(agent_id: str):
    spec = catalog.get(agent_id)
    if spec is None or not builders.listed(spec):
        raise HTTPException(404, f"no agent named {agent_id!r}")
    return spec


def _custom(agent_id: str) -> custom.CustomAgent:
    agent = custom.get(agent_id)
    if agent is None:
        if catalog.get(agent_id) is not None:
            raise HTTPException(400, "built-in agents cannot be changed")
        raise HTTPException(404, f"no agent named {agent_id!r}")
    return agent


def _check_model(model: str | None) -> None:
    if model and not model_registry.known(model):
        raise HTTPException(400, f"unknown model {model!r}")


def _set_integrations(agent_id: str, slugs: list[str]) -> None:
    try:
        assignments.set_enabled(agent_id, slugs)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/agents", response_model=AgentList)
def list_agents() -> AgentList:
    return AgentList(agents=[AgentSummary.of(a) for a in catalog.everyone() if builders.listed(a)])


@router.post("/agents", response_model=AgentSummary, status_code=201)
def create_agent(body: AgentCreate) -> AgentSummary:
    """Make a custom agent."""
    _check_model(body.model)
    fields = body.model_dump(exclude={"integrations"})
    fields["name"] = body.name.strip()
    if not fields["name"]:
        raise HTTPException(422, "an agent needs a name")
    agent = custom.create(**fields)
    _set_integrations(agent.id, body.integrations)
    return AgentSummary.of(agent.to_spec())


@router.post("/agents/draft", response_model=AgentDraft)
async def draft_agent(body: AgentDraftIn) -> AgentDraft:
    """Write a name, tagline and instructions from a description of the agent."""
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")
    try:
        draft = await drafting.draft(body.description)
    except drafting.DraftFailed as exc:
        raise HTTPException(502, f"Could not write a draft: {exc}. Try again.") from None
    return AgentDraft(**draft.model_dump())


@router.get("/agents/{agent_id}", response_model=AgentSummary)
def get_agent(agent_id: str) -> AgentSummary:
    return AgentSummary.of(_listed(agent_id))


@router.get("/agents/{agent_id}/config", response_model=AgentConfig)
def get_agent_config(agent_id: str) -> AgentConfig:
    """Everything the builder edits, instructions included."""
    return AgentConfig.of(_custom(agent_id))


@router.patch("/agents/{agent_id}", response_model=AgentSummary)
def update_agent(agent_id: str, body: AgentPatch) -> AgentSummary:
    _custom(agent_id)
    _check_model(body.model)
    changes = body.model_dump(exclude_none=True, exclude={"integrations"})
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        if not changes["name"]:
            raise HTTPException(422, "an agent needs a name")
    if body.integrations is not None:
        _set_integrations(agent_id, body.integrations)
    agent = custom.update(agent_id, **changes)
    return AgentSummary.of(agent.to_spec())


@router.delete("/agents/{agent_id}", status_code=204)
async def delete_agent(agent_id: str) -> None:
    """Delete a custom agent and its conversations."""
    _custom(agent_id)
    for session in sessions.list_agent(agent_id):
        await manager.cancel(session.id)
        builders.forget(session.id)
        sandbox.forget(session.id)
        sessions.delete(session.id)
    assignments.clear(agent_id)
    custom.delete(agent_id)


@router.put("/agents/{agent_id}/integrations", response_model=AgentSummary)
def set_agent_integrations(agent_id: str, body: AgentIntegrationsIn) -> AgentSummary:
    """Choose which connected apps an agent may use."""
    spec = _listed(agent_id)
    _set_integrations(agent_id, body.integrations)
    return AgentSummary.of(spec)
