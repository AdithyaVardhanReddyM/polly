"""Variables: the settings and secrets agents need, kept out of the chat.

A variable is a name (`SLACK_CHANNEL`, `OPENWEATHER_API_KEY`), a line about
what it is for, a value and the agents allowed to use it (none listed: every
agent). The user sets them in Settings > Variables, or on the card Polly shows
when an agent it is making needs one; either way the value goes straight to
this store and never through a model or a transcript.

How agents get them:

* a plain setting (not secret) is written into the agent's instructions;
* a secret is only ever an environment variable in the code sandbox
  (`sandbox.py`), and is blanked out of anything a command prints.

Kept in `<data_dir>/variables.json`, readable by the user only.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import threading
import time

from pydantic import BaseModel, Field, field_validator

from polly_server.config import settings

NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
# Shorter values are not blanked out of output: they would match everywhere.
MIN_REDACT = 4


class Variable(BaseModel):
    name: str
    description: str = Field(default="", max_length=200)
    secret: bool = True
    value: str = Field(default="", max_length=10_000)
    # Agent ids allowed to use it; empty means every agent.
    agents: list[str] = Field(default_factory=list)
    updated_at: float = 0

    @field_validator("name")
    @classmethod
    def _name(cls, name: str) -> str:
        if not NAME.match(name):
            raise ValueError("use capital letters, digits and _ (like SLACK_CHANNEL)")
        return name

    @property
    def is_set(self) -> bool:
        return bool(self.value)

    def allows(self, agent_id: str) -> bool:
        return not self.agents or agent_id in self.agents


_lock = threading.Lock()


def _file():
    return settings.data_path() / "variables.json"


def _read() -> list[Variable]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[Variable] = []
    for raw in data.get("variables", []) if isinstance(data, dict) else []:
        try:
            found.append(Variable.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(variables: list[Variable]) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    # Created readable by the user only, before any value is written to it.
    fd = os.open(draft, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump({"variables": [v.model_dump() for v in variables]}, out, indent=2)
    draft.replace(path)


def check_name(name: str) -> str:
    name = name.strip()
    if not NAME.match(name):
        raise ValueError(f"{name!r} is not a variable name: use capital letters, digits and _")
    return name


# ---------- the store ----------


def all_variables() -> list[Variable]:
    with _lock:
        return sorted(_read(), key=lambda v: v.name)


def get(name: str) -> Variable | None:
    with _lock:
        return next((v for v in _read() if v.name == name), None)


def is_set(name: str) -> bool:
    found = get(name)
    return found is not None and found.is_set


def put(
    name: str,
    *,
    value: str | None = None,
    description: str | None = None,
    secret: bool | None = None,
    agents: list[str] | None = None,
) -> Variable:
    """Create or change a variable; what is not given stays as it was."""
    name = check_name(name)
    with _lock:
        found = _read()
        current = next((v for v in found if v.name == name), None) or Variable(name=name)
        changes = {
            k: v
            for k, v in {
                "value": value,
                "description": description,
                "secret": secret,
                "agents": list(dict.fromkeys(agents)) if agents is not None else None,
            }.items()
            if v is not None
        }
        updated = Variable.model_validate(
            {**current.model_dump(), **changes, "updated_at": time.time()}
        )
        _write([*(v for v in found if v.name != name), updated])
    return updated


def declare(
    name: str, description: str = "", *, secret: bool = True, agent: str | None = None
) -> Variable:
    """Make sure a variable exists (unset) so the user sees it to fill in.
    Made for `agent`, a new one is limited to that agent; one that exists
    lets it in."""
    current = get(check_name(name))
    if current is None:
        return put(name, description=description, secret=secret, agents=[agent] if agent else None)
    if agent:
        grant(name, agent)
    if description and not current.description:
        return put(name, description=description)
    return get(name) or current


def grant(name: str, agent_id: str) -> None:
    """Let `agent_id` use `name` if the variable is limited to some agents."""
    current = get(name)
    if current is not None and current.agents and agent_id not in current.agents:
        put(name, agents=[*current.agents, agent_id])


def delete(name: str) -> bool:
    with _lock:
        found = _read()
        kept = [v for v in found if v.name != name]
        if len(kept) == len(found):
            return False
        _write(kept)
    return True


def forget_agent(agent_id: str) -> None:
    """A deleted agent loses its place on every variable's list."""
    with _lock:
        found = _read()
        if any(agent_id in v.agents for v in found):
            _write(
                [
                    v.model_copy(update={"agents": [a for a in v.agents if a != agent_id]})
                    for v in found
                ]
            )


# ---------- what agents get ----------


def usable(agent_ids: list[str] | tuple[str, ...]) -> list[Variable]:
    """Set variables any of `agent_ids` may use."""
    return [v for v in all_variables() if v.is_set and any(v.allows(a) for a in agent_ids)]


def prompt_for(agent_id: str, *, sandbox: bool) -> str:
    """The section of an agent's instructions about its variables."""
    found = usable([agent_id])
    if not found:
        return ""
    lines = ["## Your settings", ""]
    for v in found:
        about = f": {v.description}" if v.description else ""
        if not v.secret:
            lines.append(f"- `{v.name}` = `{v.value}`{about}")
        elif sandbox:
            lines.append(f"- `${v.name}` is set in your sandbox's environment{about}")
    if len(lines) == 2:
        return ""
    if any(v.secret for v in found) and sandbox:
        lines.append("")
        lines.append(
            "Secrets are environment variables in your sandbox only: read them from the "
            "environment in your code. Never print them, write them to a file or repeat them."
        )
    return "\n".join(lines)


def env_exports(found: list[Variable]) -> str:
    """Shell `export` lines that put `found` into a command's environment."""
    return "".join(f"export {v.name}={shlex.quote(v.value)}; " for v in found)


def redact(text: str, found: list[Variable]) -> str:
    """Blank secret values out of `text`."""
    for v in found:
        if v.secret and len(v.value) >= MIN_REDACT and v.value in text:
            text = text.replace(v.value, f"[secret {v.name}]")
    return text
