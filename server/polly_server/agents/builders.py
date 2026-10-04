"""Assembling the agents that are not the Coder: Researcher, Deep Research,
Reviewer, the change research that follows a Coder run, and the agents
people make themselves.

None of them touch the user's disk. Deep agents keep their scratch files in
graph state (the Deep Agents default backend), or in a ConTree sandbox when
the agent runs code (`sandbox.py`). The only tools they get are read-only
(web, GitHub) plus the one that hands in their result, the apps the user
connected and allowed them (`integrations/`), the shared memory
(`memory.py`) and `ask_teammate`, when they have teammates (`team.py`).

An agent is built either to lead a session, or as a teammate in another
agent's session (`as_agent`, see `delegation.py`).
"""

from __future__ import annotations

import datetime as dt
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from polly_server import memory, model_registry, sandbox, variables
from polly_server import tools as tool_registry
from polly_server.agents import catalog, delegation, orchestrator, runtime, team
from polly_server.agents.spec import AgentSpec
from polly_server.coder.context import CoderContext
from polly_server.config import settings
from polly_server.integrations import assignments, composio
from polly_server.models import chat_model, tier_model
from polly_server.persistence import get_checkpointer
from polly_server.sessions import Session

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langgraph.graph.state import CompiledStateGraph

# Which tier each subagent runs on: scouts and helpers are many, short calls
# (Nano); the critic has to reason about a whole draft (Ultra).
SUBAGENT_TIERS: dict[str, str] = {"scout": "fast", "researcher": "fast", "critic": "strong"}

_cache: dict[tuple[Any, ...], CompiledStateGraph] = {}


def default_model(agent_id: str) -> str:
    spec = catalog.get(agent_id)
    if spec and spec.model and model_registry.known(spec.model):
        return spec.model
    return tier_model(spec.model_tier if spec else "default")


def runnable(agent_id: str) -> bool:
    spec = catalog.get(agent_id)
    return spec is not None and spec.status == "ready"


def listed(spec: AgentSpec) -> bool:
    return spec.metadata.get("internal") != "true"


def _dated(prompt: str, *, sources: bool = True) -> str:
    today = dt.date.today()
    dated = f"{prompt}\n\nToday is {today:%A, %d %B %Y}."
    return f"{dated} Prefer sources from the last year." if sources else dated


def _resolve(spec: AgentSpec, apps: tuple[str, ...]) -> AgentSpec:
    """Drop tools that are not configured (no Tavily key: no web tools), so a
    missing integration degrades the agent instead of breaking it."""
    subagents = tuple(replace(s, tools=tool_registry.available(s.tools)) for s in spec.subagents)
    tools = tool_registry.available(spec.tools)
    searches = bool(tools) if spec.division == "custom" else spec.id != "designer"
    prompt = _dated(spec.system_prompt, sources=searches)
    in_sandbox = spec.sandbox and sandbox.available()
    if in_sandbox:
        prompt = f"{prompt}\n\n{sandbox.PROMPT}"
    settings_prompt = variables.prompt_for(spec.id, sandbox=in_sandbox)
    if settings_prompt:
        prompt = f"{prompt}\n\n{settings_prompt}"
    return replace(
        spec,
        tools=tools,
        subagents=subagents,
        system_prompt=with_apps(prompt, apps),
    )


def with_apps(prompt: str, apps: tuple[str, ...]) -> str:
    """Tell the agent which connected apps it can act in."""
    return f"{prompt}\n\n{composio.prompt_for(apps)}" if apps else prompt


def build_agent(
    session: Session,
    *,
    model: BaseChatModel | None = None,
    fast_model: BaseChatModel | None = None,
    strong_model: BaseChatModel | None = None,
    checkpointer: Any | None = None,
    use_cache: bool = True,
    as_agent: str | None = None,
) -> CompiledStateGraph:
    """The agent that leads `session`, or with `as_agent`, a teammate at work
    in it: on its own model, sharing the session's sandbox."""
    agent_id = as_agent or session.agent_id
    spec = catalog.get(agent_id)
    if spec is None or spec.status != "ready" or spec.id == "coder":
        raise LookupError(f"{agent_id!r} is not an agent Polly can run here")

    # Work goes out from the lead and comes back to it: a teammate has no team.
    mates = team.roster(session) if as_agent is None else ()
    model_id = (session.model if as_agent is None else "") or default_model(spec.id)

    # Connecting an app, changing what the agent may use, editing a custom
    # agent or changing the team rebuilds it on the next turn.
    apps = assignments.active(spec.id)
    made_as = (spec.system_prompt, spec.tools, spec.sandbox, spec.memory)
    settings_now = tuple(
        (v.name, v.secret, "" if v.secret else v.value) for v in variables.usable([spec.id])
    )
    key = (
        session.id,
        spec.id,
        model_id,
        dt.date.today().isoformat(),
        apps,
        made_as,
        settings_now,
        team.signature(session, mates),
    )
    if use_cache and key in _cache:
        return _cache[key]

    connected = list(composio.tools_for(apps))
    spec = _resolve(spec, apps if connected else ())
    if team.is_orchestrator(spec) and as_agent is None:
        # Polly makes its team as it goes: it has `ask_teammate` from the
        # start, and the tool finds agents added after it was built.
        connected += [*orchestrator.tools_for(session), delegation.tool_for(session, mates)]
        spec = replace(
            spec, system_prompt=f"{spec.system_prompt}\n\n{orchestrator.prompt(session, mates)}"
        )
    elif mates:
        connected.append(delegation.tool_for(session, mates))
        spec = replace(spec, system_prompt=f"{spec.system_prompt}\n\n{team.prompt(session, mates)}")
    main = model or chat_model(model=model_id)
    options: dict[str, Any] = {
        "checkpointer": checkpointer or get_checkpointer(),
        # Same shape as the Coder's: the run passes one context to every agent.
        "context_schema": CoderContext,
        "middleware": [memory.middleware(spec.id)] if spec.memory else [],
    }
    if spec.sandbox and sandbox.available():
        options["backend"] = sandbox.for_session(session.id)

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

        options["middleware"] = [TodoListMiddleware(), *options["middleware"]]
        options["subagent_overrides"] = {
            s.name: {"model": tier(SUBAGENT_TIERS[s.name])}
            for s in spec.subagents
            if s.name in SUBAGENT_TIERS
        }

    agent = runtime.build(
        spec, tools=tool_registry.registry(), extra_tools=connected, model=main, **options
    )
    if use_cache:
        _cache[key] = agent
    return agent


def forget(session_id: str) -> None:
    for key in [k for k in _cache if k[0] == session_id]:
        _cache.pop(key, None)
    delegation.forget(session_id)


def needs_search(agent_id: str) -> bool:
    """Research agents are no use without a search key."""
    return agent_id in {"researcher", "deep-research", "change-research"}


def search_ready() -> bool:
    return bool(settings.tavily_api_key)
