"""Wire shapes. Mirrored by `apps/desktop/src/shared/contracts.ts` — keep the
two in step."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from polly_server import variables
from polly_server.agents import builders, team
from polly_server.agents.custom import CustomAgent
from polly_server.agents.groups import Group
from polly_server.agents.spec import AgentSpec, Division, Runtime, Status
from polly_server.coder.context import Mode
from polly_server.coder.permissions import Rule
from polly_server.integrations import assignments
from polly_server.projects import Project
from polly_server.routines import store
from polly_server.sessions import Session


class AgentSummary(BaseModel):
    id: str
    name: str
    division: Division
    tagline: str
    description: str
    status: Status
    runtime: Runtime
    tools: list[str]
    # Connected apps the agent may use (Composio toolkit slugs).
    integrations: list[str]
    subagents: list[str]
    # Other agents it may hand work to (agent ids).
    teammates: list[str]
    # Whether other agents can hand work to it.
    can_join: bool
    computer: bool
    avatar: dict[str, str]
    # Made by the user: can be edited and deleted.
    custom: bool
    # Made by Polly, with the user's approval, for a task.
    hired: bool
    # Sets up teams of agents for a task (Polly).
    orchestrator: bool
    # Runs code in a sandbox.
    sandbox: bool
    # Reads and adds to the shared memory about the user.
    memory: bool
    # The model a new conversation starts on.
    model: str

    @classmethod
    def of(cls, spec: AgentSpec) -> AgentSummary:
        return cls(
            id=spec.id,
            name=spec.name,
            division=spec.division,
            tagline=spec.tagline,
            description=spec.description,
            status=spec.status,
            runtime=spec.runtime,
            tools=list(spec.tools),
            integrations=list(assignments.enabled(spec.id)),
            subagents=[s.name for s in spec.subagents],
            teammates=list(team.chosen(spec.id)),
            can_join=team.can_join(spec),
            computer=spec.computer,
            avatar={"seed": spec.id, **spec.avatar},
            custom=spec.division == "custom",
            hired=spec.metadata.get("origin") == "polly",
            orchestrator=spec.metadata.get("orchestrator") == "true",
            sandbox=spec.sandbox,
            memory=spec.memory,
            model=builders.default_model(spec.id),
        )


class AgentList(BaseModel):
    agents: list[AgentSummary]


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    tagline: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=400)
    system_prompt: str = Field(default="", max_length=20_000)
    model: str = ""
    search: bool = True
    sandbox: bool = False
    memory: bool = True
    avatar: dict[str, str] = Field(default_factory=dict)
    integrations: list[str] = Field(default_factory=list, max_length=100)
    teammates: list[str] = Field(default_factory=list, max_length=team.MAX_TEAMMATES)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    tagline: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=400)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    model: str | None = None
    search: bool | None = None
    sandbox: bool | None = None
    memory: bool | None = None
    avatar: dict[str, str] | None = None
    integrations: list[str] | None = Field(default=None, max_length=100)
    teammates: list[str] | None = Field(default=None, max_length=team.MAX_TEAMMATES)


class AgentConfig(CustomAgent):
    """A custom agent as the builder edits it."""

    integrations: list[str]
    teammates: list[str]

    @classmethod
    def of(cls, agent: CustomAgent) -> AgentConfig:
        return cls(
            **agent.model_dump(),
            integrations=list(assignments.enabled(agent.id)),
            teammates=list(team.chosen(agent.id)),
        )


class AgentDraftIn(BaseModel):
    description: str = Field(min_length=3, max_length=2_000)


class AgentDraft(BaseModel):
    """A first version of an agent, written by a model from one sentence."""

    name: str
    tagline: str
    description: str
    system_prompt: str
    search: bool
    sandbox: bool


# ---------- teams and groups ----------


class AgentTeammatesIn(BaseModel):
    teammates: list[str] = Field(max_length=team.MAX_TEAMMATES)


class Collaboration(BaseModel):
    # Every agent may call on every other, whatever its own team.
    open: bool


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    # Agent ids, the lead included.
    members: list[str]
    lead: str


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    members: list[str] | None = None
    lead: str | None = None


class GroupList(BaseModel):
    groups: list[Group]


class MemoryIn(BaseModel):
    text: str = Field(min_length=1, max_length=400)


class MemoryOut(BaseModel):
    id: str
    text: str
    source: str
    created_at: float


class MemoryList(BaseModel):
    memories: list[MemoryOut]


class Provider(BaseModel):
    provider: str
    configured: bool


class ModelInfo(Provider):
    id: str


class Health(BaseModel):
    service: str
    version: str
    model: ModelInfo
    sandbox: Provider
    search: Provider
    github: Provider
    composio: Provider


# ---------- models ----------


class ModelOption(BaseModel):
    id: str
    label: str
    vendor: str
    context_window: int
    reasoning: bool
    vision: bool
    tokens_per_second: float | None
    input_price: float | None
    output_price: float | None
    is_default: bool
    is_default_fast: bool


class ModelList(BaseModel):
    models: list[ModelOption]
    default: str
    default_fast: str


# ---------- projects ----------


class ProjectCreate(BaseModel):
    path: str


class ProjectPatch(BaseModel):
    default_model: str | None = None
    default_mode: Mode | None = None
    command_allowlist: list[str] | None = None
    command_denylist: list[str] | None = None
    auto_research: bool | None = None


class ProjectList(BaseModel):
    projects: list[Project]


class RuleList(BaseModel):
    rules: list[Rule]


class ProjectMemory(BaseModel):
    polly_md: str | None
    memory_md: str | None


# ---------- sessions ----------


class SessionCreate(BaseModel):
    # The Coder needs a project; the other agents run without one.
    project_id: str | None = None
    agent_id: str = "coder"
    # A conversation in a group: its lead is the agent, whatever `agent_id` says.
    group_id: str | None = None
    # The teammates for this conversation; null follows the agent's own team.
    members: list[str] | None = None
    model: str | None = None
    mode: Mode | None = None
    title: str = ""


class SessionPatch(BaseModel):
    model: str | None = None
    mode: Mode | None = None
    title: str | None = None
    members: list[str] | None = None


class SessionList(BaseModel):
    sessions: list[Session]


class MessageIn(BaseModel):
    content: str = Field(min_length=1)
    # Agents the user addressed with `@Name`; they join the conversation's team.
    mentions: list[str] = Field(default_factory=list, max_length=team.MAX_TEAMMATES)


class Decision(BaseModel):
    type: Literal["approve", "edit", "reject"]
    edited_action: dict[str, Any] | None = None
    message: str | None = None


class RememberRule(BaseModel):
    """ "Always allow" ticked on an approval card."""

    index: int
    pattern: str


class DecisionsIn(BaseModel):
    decisions: list[Decision]
    remember: list[RememberRule] = Field(default_factory=list)


class AnswerIn(BaseModel):
    """The user's answer to a card (`agents/asks.py`)."""

    interrupt_id: str | None = None
    approved: bool | None = None
    answer: str | None = Field(default=None, max_length=4_000)
    connected: bool | None = None
    done: bool | None = None


class Transcript(BaseModel):
    session: Session
    messages: list[dict[str, Any]]
    todos: list[dict[str, Any]]
    pending_approval: dict[str, Any] | None
    run_id: str | None
    # A card the run is waiting on (`ask.required`), if any.
    pending_ask: dict[str, Any] | None = None


class ChangePaths(BaseModel):
    """Files to accept or revert; empty means all of them."""

    paths: list[str] = Field(default_factory=list)


class Artifacts(BaseModel):
    """What a run left behind: cited sources, a change report, a scorecard
    and the facts of the reviewed PR (each null until there is one)."""

    sources: list[dict[str, Any]]
    report: dict[str, Any] | None
    scorecard: dict[str, Any] | None
    pr: dict[str, Any] | None


# ---------- integrations ----------


class IntegrationOut(BaseModel):
    slug: str
    name: str
    category: str
    description: str
    # oauth | api_key | none | custom (see `integrations/catalog.py`)
    auth: str
    # connected | expired | available | ready (needs no account)
    state: str
    connected_at: str | None = None
    # How many tools the app gives an agent; null when not known.
    tools: int | None = None
    # Agents allowed to use it.
    agents: list[str] = []


class IntegrationCategory(BaseModel):
    id: str
    label: str


class Integrations(BaseModel):
    composio: Provider
    tavily: Provider
    github: dict[str, Any]
    categories: list[IntegrationCategory]
    items: list[IntegrationOut]


class ConnectStart(BaseModel):
    url: str


class AgentIntegrationsIn(BaseModel):
    integrations: list[str] = Field(max_length=100)


# ---------- reviews ----------


class ReviewCreate(BaseModel):
    pr_url: str = Field(min_length=1, max_length=500)
    model: str | None = None


class CommentPreview(BaseModel):
    markdown: str


class CommentPosted(BaseModel):
    url: str


# ---------- variables ----------


class VariableOut(BaseModel):
    """A variable as the app shows it: a secret's value never leaves the server."""

    name: str
    description: str
    secret: bool
    is_set: bool
    # Only for settings that are not secret.
    value: str | None
    agents: list[str]
    updated_at: float

    @classmethod
    def of(cls, v: variables.Variable) -> VariableOut:
        return cls(
            name=v.name,
            description=v.description,
            secret=v.secret,
            is_set=v.is_set,
            value=None if v.secret else v.value,
            agents=v.agents,
            updated_at=v.updated_at,
        )


class VariableList(BaseModel):
    variables: list[VariableOut]


class VariableIn(BaseModel):
    """Set or change a variable; what is left out stays as it was."""

    value: str | None = Field(default=None, max_length=10_000)
    description: str | None = Field(default=None, max_length=200)
    secret: bool | None = None
    agents: list[str] | None = Field(default=None, max_length=100)


# ---------- routines ----------


class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    prompt: str = Field(min_length=1, max_length=4_000)
    trigger: store.Trigger
    # An agent, or a group (whose lead then runs it).
    agent_id: str = ""
    group_id: str | None = None
    members: list[str] | None = Field(default=None, max_length=team.MAX_TEAMMATES)
    enabled: bool = True


class RoutinePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    prompt: str | None = Field(default=None, min_length=1, max_length=4_000)
    trigger: store.Trigger | None = None
    enabled: bool | None = None


class RoutineOut(store.Routine):
    # In words: "on the schedule `0 8 * * *` (UTC)".
    when: str
    running: bool

    @classmethod
    def of(cls, routine: store.Routine, *, running: bool) -> RoutineOut:
        return cls(**routine.model_dump(), when=store.describe(routine.trigger), running=running)


class RoutineList(BaseModel):
    routines: list[RoutineOut]
