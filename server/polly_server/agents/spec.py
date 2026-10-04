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
    # Names resolved against the tool registry: search, git, sandbox…
    tools: tuple[str, ...] = ()
    # Connected apps the agent may use from the start (Composio toolkit slugs,
    # see `integrations/catalog.py`). The user can change the set later.
    integrations: tuple[str, ...] = ()
    subagents: tuple[SubagentSpec, ...] = ()
    # Other agents it may hand work to from the start (agent ids, see
    # `team.py`). The user can change the set later.
    teammates: tuple[str, ...] = ()
    # Folders of SKILL.md files the agent can load on demand.
    skills: tuple[str, ...] = ()
    # Whether the agent gets its own virtual desktop, not just a code sandbox.
    computer: bool = False
    # Whether the agent can run code in a sandbox (`sandbox.py`): its file
    # tools and its shell then work inside the sandbox.
    sandbox: bool = False
    # Whether it reads and adds to what Polly remembers about the user
    # (`memory.py`).
    memory: bool = True
    model_tier: Literal["default", "fast", "strong"] = "default"
    # A model id that wins over the tier: what a custom agent was made with.
    model: str = ""
    # DiceBear "voxel-bot" options (eyesVariant, topVariant, chestVariant,
    # mouthVariant, bodyColor, glowColor…). The seed defaults to the agent id,
    # so an agent with no overrides still gets a stable, unique robot.
    avatar: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
