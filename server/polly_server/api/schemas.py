"""Wire shapes. Mirrored by `apps/desktop/src/shared/contracts.ts` — keep the
two in step."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from polly_server.agents.spec import AgentSpec, Division, Runtime, Status
from polly_server.coder.context import Mode
from polly_server.coder.permissions import Rule
from polly_server.projects import Project
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
    subagents: list[str]
    computer: bool
    avatar: dict[str, str]

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
            subagents=[s.name for s in spec.subagents],
            computer=spec.computer,
            avatar={"seed": spec.id, **spec.avatar},
        )


class AgentList(BaseModel):
    agents: list[AgentSummary]


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
    model: str | None = None
    mode: Mode | None = None
    title: str = ""


class SessionPatch(BaseModel):
    model: str | None = None
    mode: Mode | None = None
    title: str | None = None


class SessionList(BaseModel):
    sessions: list[Session]


class MessageIn(BaseModel):
    content: str = Field(min_length=1)


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


class Transcript(BaseModel):
    session: Session
    messages: list[dict[str, Any]]
    todos: list[dict[str, Any]]
    pending_approval: dict[str, Any] | None
    run_id: str | None


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


class TokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=400)


class Integrations(BaseModel):
    github: dict[str, Any]
    tavily: Provider


# ---------- reviews ----------


class ReviewCreate(BaseModel):
    pr_url: str = Field(min_length=1, max_length=500)
    model: str | None = None


class CommentPreview(BaseModel):
    markdown: str


class CommentPosted(BaseModel):
    url: str
