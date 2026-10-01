"""Wire shapes. Mirrored by `apps/desktop/src/shared/contracts.ts` — keep the
two in step."""

from __future__ import annotations

from pydantic import BaseModel

from polly_server.agents.spec import AgentSpec, Division, Runtime, Status


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
