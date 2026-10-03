"""Turns an `AgentSpec` into something runnable.

There are three runtimes. All of them compile to a LangGraph graph, so they
stream, checkpoint and pause for approval the same way, and the server can
treat them identically:

- `deep`: LangChain Deep Agents, for long-running work such as coding, deep
  research and computer use. It adds planning, a virtual file system,
  subagents, skills, long-term memory and a sandbox backend.
- `agent`: a LangChain agent (`create_agent`). A model calls tools in a loop.
  Use it for quick, bounded tasks where the Deep Agents machinery is overhead.
- `graph`: a hand-written LangGraph graph, registered with `@graph(...)`. Use
  it for flows whose steps are fixed in code, such as routing a request to an
  agent, an approval flow, or a scheduled routine.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from polly_server.agents.spec import AgentSpec
from polly_server.models import chat_model

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langchain_core.tools import BaseTool
    from langgraph.graph.state import CompiledStateGraph

GraphBuilder = Callable[..., "CompiledStateGraph"]

_GRAPHS: dict[str, GraphBuilder] = {}


def graph(agent_id: str) -> Callable[[GraphBuilder], GraphBuilder]:
    """Register the hand-written graph that backs a `runtime="graph"` agent."""

    def register(builder: GraphBuilder) -> GraphBuilder:
        _GRAPHS[agent_id] = builder
        return builder

    return register


def _pick(tools: Mapping[str, BaseTool], names: tuple[str, ...], owner: str) -> list[BaseTool]:
    missing = [n for n in names if n not in tools]
    if missing:
        raise KeyError(f"{owner} needs tools that are not available: {', '.join(missing)}")
    return [tools[n] for n in names]


def build(
    spec: AgentSpec,
    *,
    tools: Mapping[str, BaseTool] | None = None,
    extra_tools: Sequence[BaseTool] = (),
    model: BaseChatModel | None = None,
    subagent_overrides: Mapping[str, Mapping[str, Any]] | None = None,
    **options: Any,
) -> CompiledStateGraph:
    """Build the agent described by `spec`.

    `tools` is the pool of tools available to this agent. The spec chooses
    from it by name. `extra_tools` are added to the main agent as they are: the
    tools of the apps it is connected to. `options` are passed on to the underlying constructor,
    for example `checkpointer`, `store`, `backend` (deep only) or
    `interrupt_on` (deep only). `subagent_overrides` (deep only) adds
    per-subagent settings by name, such as `model` or `middleware`.
    """
    tools = tools or {}
    model = model or chat_model(spec.model_tier)

    if spec.runtime == "deep":
        from deepagents import create_deep_agent

        overrides = subagent_overrides or {}
        subagents = [
            {
                "name": s.name,
                "description": s.description,
                "system_prompt": s.system_prompt or s.description,
                **({"tools": _pick(tools, s.tools, s.name)} if s.tools else {}),
                **overrides.get(s.name, {}),
            }
            for s in spec.subagents
        ]
        return create_deep_agent(
            model=model,
            tools=[*_pick(tools, spec.tools, spec.id), *extra_tools],
            system_prompt=spec.system_prompt or None,
            subagents=subagents or None,
            skills=list(spec.skills) or None,
            name=spec.id,
            **options,
        )

    if spec.runtime == "agent":
        from langchain.agents import create_agent

        return create_agent(
            model,
            [*_pick(tools, spec.tools, spec.id), *extra_tools],
            system_prompt=spec.system_prompt or None,
            name=spec.id,
            **options,
        )

    builder = _GRAPHS.get(spec.id)
    if builder is None:
        raise LookupError(f"no graph registered for {spec.id!r}; decorate one with @graph")
    return builder(spec=spec, tools=tools, extra_tools=extra_tools, model=model, **options)
