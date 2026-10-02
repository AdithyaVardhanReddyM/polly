"""What an agent *is*, independent of how it runs.

A spec is plain data: the built-in agents are declared as specs in
`catalog.py`, and agents people create in the app will be stored the same way.
The runtime turns a spec into a Deep Agent (model + tools + subagents + skills
+ memory + a sandbox backend).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Division = Literal["coding", "research", "everyday", "custom"]
Status = Literal["ready", "building", "planned"]

# How an agent runs — see `runtime.py`:
#   deep   LangChain Deep Agents. Long-running, multi-step work: planning, a
#          file system, subagents, skills, a sandbox. Coding, deep research,
#          computer use.
#   agent  A LangChain agent (`create_agent`). A model in a tool loop, for
#          quick, bounded tasks: a cited answer, triaging an inbox.
#   graph  A hand-written LangGraph graph, for flows whose steps we want to
#          fix in code rather than leave to the model.
Runtime = Literal["deep", "agent", "graph"]


@dataclass(frozen=True)
class SubagentSpec:
    name: str
    description: str
    system_prompt: str = ""
    tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class AgentSpec:
    id: str
    name: str
    division: Division
    tagline: str
    description: str
    status: Status = "planned"
    runtime: Runtime = "agent"
    system_prompt: str = ""
    # Names resolved against the tool registry: integrations, search, sandbox…
    tools: tuple[str, ...] = ()
    subagents: tuple[SubagentSpec, ...] = ()
    # Folders of SKILL.md files the agent can load on demand.
    skills: tuple[str, ...] = ()
    # Whether the agent gets its own virtual desktop, not just a code sandbox.
    computer: bool = False
    model_tier: Literal["default", "fast", "strong"] = "default"
    # DiceBear "voxel-bot" options (eyesVariant, topVariant, chestVariant,
    # mouthVariant, bodyColor, glowColor…). The seed defaults to the agent id,
    # so an agent with no overrides still gets a stable, unique robot.
    avatar: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
