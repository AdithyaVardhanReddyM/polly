"""The agents people make themselves.

A custom agent is a name, a tagline, instructions, a model and a few
switches: web search, a code sandbox, memory. They are kept in
`<data_dir>/agents.json` and turned into the same `AgentSpec` the built-in
agents are declared with, so everything downstream (sessions, runs, the
sidebar) treats them alike. The apps an agent may use are not stored here:
they live with every other agent's in `integrations/assignments.py`.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field

from polly_server.agents.spec import AgentSpec
from polly_server.config import settings

PREFIX = "custom-"
# Web search for a custom agent is the research pair: numbered, citable sources.
SEARCH_TOOLS = ("research_search", "web_extract")

FALLBACK_PROMPT = "You are {name}, a helpful assistant. {tagline}"


class CustomAgent(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=40)
    tagline: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=400)
    system_prompt: str = Field(default="", max_length=20_000)
    # A model id from the registry; empty means Polly's default.
    model: str = ""
    search: bool = True
    sandbox: bool = False
    memory: bool = True
    # DiceBear voxel-bot options; `seed` picks the robot.
    avatar: dict[str, str] = Field(default_factory=dict)
    # Who made it: the user in the builder, or Polly with the user's approval.
    origin: Literal["user", "polly"] = "user"
    created_at: float = 0
    updated_at: float = 0

    def to_spec(self) -> AgentSpec:
        prompt = self.system_prompt.strip() or FALLBACK_PROMPT.format(
            name=self.name, tagline=self.tagline
        )
        return AgentSpec(
            id=self.id,
            name=self.name,
            division="custom",
            tagline=self.tagline,
            description=self.description,
            status="ready",
            # A sandbox needs the Deep Agents file tools and shell; without
            # one, a model in a tool loop is enough.
            runtime="deep" if self.sandbox else "agent",
            system_prompt=prompt,
            tools=SEARCH_TOOLS if self.search else (),
            sandbox=self.sandbox,
            memory=self.memory,
            model=self.model,
            avatar=self.avatar,
            metadata={"origin": self.origin},
        )


_lock = threading.Lock()


def _file():
    return settings.data_path() / "agents.json"


def _read() -> list[CustomAgent]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[CustomAgent] = []
    for raw in data.get("agents", []) if isinstance(data, dict) else []:
        try:
            found.append(CustomAgent.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(agents: list[CustomAgent]) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(json.dumps({"agents": [a.model_dump() for a in agents]}, indent=2))
    draft.replace(path)


def is_custom(agent_id: str) -> bool:
    return agent_id.startswith(PREFIX)


def all_agents() -> list[CustomAgent]:
    with _lock:
        return sorted(_read(), key=lambda a: a.created_at)


def get(agent_id: str) -> CustomAgent | None:
    if not is_custom(agent_id):
        return None
    with _lock:
        return next((a for a in _read() if a.id == agent_id), None)


def spec(agent_id: str) -> AgentSpec | None:
    agent = get(agent_id)
    return agent.to_spec() if agent else None


def specs() -> tuple[AgentSpec, ...]:
    return tuple(a.to_spec() for a in all_agents())


def create(**fields) -> CustomAgent:
    now = time.time()
    agent_id = f"{PREFIX}{uuid.uuid4().hex[:10]}"
    avatar = dict(fields.pop("avatar", None) or {})
    avatar.setdefault("seed", agent_id)
    agent = CustomAgent(id=agent_id, avatar=avatar, created_at=now, updated_at=now, **fields)
    with _lock:
        _write([*_read(), agent])
    return agent


def update(agent_id: str, **changes) -> CustomAgent:
    with _lock:
        agents = _read()
        for i, current in enumerate(agents):
            if current.id == agent_id:
                merged = {**current.model_dump(), **changes, "updated_at": time.time()}
                agents[i] = CustomAgent.model_validate(merged)
                _write(agents)
                return agents[i]
    raise LookupError(agent_id)


def delete(agent_id: str) -> bool:
    with _lock:
        agents = _read()
        kept = [a for a in agents if a.id != agent_id]
        if len(kept) == len(agents):
            return False
        _write(kept)
    return True
