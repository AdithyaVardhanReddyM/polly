"""Assembling the agents that are not the Coder: Researcher, Deep Research,
Reviewer and the change research that follows a Coder run.

None of them touch the user's disk. Deep agents keep their scratch files in
graph state (the Deep Agents default backend), and the only tools they get
are read-only (web, GitHub) plus the one that hands in their result.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from polly_server import tools as tool_registry
from polly_server.agents import catalog, runtime
from polly_server.agents.spec import AgentSpec
from polly_server.coder.context import CoderContext
from polly_server.config import settings
from polly_server.models import chat_model, tier_model
from polly_server.persistence import get_checkpointer
from polly_server.sessions import Session

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langgraph.graph.state import CompiledStateGraph

# Which tier each subagent runs on: scouts and helpers are many, short calls
# (Nano); the critic has to reason about a whole draft (Ultra).
SUBAGENT_TIERS: dict[str, str] = {"scout": "fast", "researcher": "fast", "critic": "strong"}

_cache: dict[tuple[str, str, str], CompiledStateGraph] = {}


def default_model(agent_id: str) -> str:
    spec = catalog.get(agent_id)
    return tier_model(spec.model_tier if spec else "default")


def runnable(agent_id: str) -> bool:
    spec = catalog.get(agent_id)
    return spec is not None and spec.status == "ready"


def listed(spec: AgentSpec) -> bool:
    return spec.metadata.get("internal") != "true"


def _dated(prompt: str) -> str:
    today = dt.date.today()
    return f"{prompt}\n\nToday is {today:%A, %d %B %Y}. Prefer sources from the last year."


def _resolve(spec: AgentSpec) -> AgentSpec:
    """Drop tools that are not configured (no Tavily key: no web tools), so a
    missing integration degrades the agent instead of breaking it."""
    subagents = tuple(replace(s, tools=tool_registry.available(s.tools)) for s in spec.subagents)
    return replace(
        spec,
        tools=tool_registry.available(spec.tools),
        subagents=subagents,
        system_prompt=_dated(spec.system_prompt),
    )


def build_agent(
    session: Session,
    *,
    model: BaseChatModel | None = None,
    fast_model: BaseChatModel | None = None,
    strong_model: BaseChatModel | None = None,
    checkpointer: Any | None = None,
    use_cache: bool = True,
) -> CompiledStateGraph:
    spec = catalog.get(session.agent_id)
    if spec is None or spec.status != "ready" or spec.id == "coder":
        raise LookupError(f"{session.agent_id!r} is not an agent Polly can run here")

    key = (session.id, session.model, dt.date.today().isoformat())
    if use_cache and key in _cache:
        return _cache[key]

    spec = _resolve(spec)
    main = model or chat_model(model=session.model or default_model(spec.id))
    options: dict[str, Any] = {
        "checkpointer": checkpointer or get_checkpointer(),
        # Same shape as the Coder's: the run passes one context to every agent.
        "context_schema": CoderContext,
    }

    if spec.runtime == "deep":
        from langchain.agents.middleware import TodoListMiddleware

        made: dict[str, BaseChatModel] = {}

        def tier(name: str) -> BaseChatModel:
            if name == "fast" and fast_model is not None:
                return fast_model
            if name == "strong" and strong_model is not None:
                return strong_model
            if name not in made:
                made[name] = chat_model(name)  # type: ignore[arg-type]
            return made[name]

        options["middleware"] = [TodoListMiddleware()]
        options["subagent_overrides"] = {
            s.name: {"model": tier(SUBAGENT_TIERS[s.name])}
            for s in spec.subagents
            if s.name in SUBAGENT_TIERS
        }

    agent = runtime.build(spec, tools=tool_registry.registry(), model=main, **options)
    if use_cache:
        _cache[key] = agent
    return agent


def forget(session_id: str) -> None:
    for key in [k for k in _cache if k[0] == session_id]:
        _cache.pop(key, None)


def needs_search(agent_id: str) -> bool:
    """Research agents are no use without a search key."""
    return agent_id in {"researcher", "deep-research", "change-research"}


def search_ready() -> bool:
    return bool(settings.tavily_api_key)
