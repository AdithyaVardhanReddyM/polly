"""What Polly remembers about the user, shared by every agent.

One list of short facts ("prefers TypeScript", "works at a bank, so no data
leaves the EU") in `<data_dir>/memory.json`. An agent with memory sees the
list in its system prompt on every model call, so a fact one agent saved is
known to the others on their next turn, and gets two tools: `remember` and
`forget`. The user can read, add and delete memories in Settings.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import TYPE_CHECKING, Annotated, Any

from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from polly_server.config import settings

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

MAX_MEMORIES = 200
MAX_CHARS = 400
# The prompt carries the newest memories up to this many characters.
PROMPT_BUDGET = 6_000

INSTRUCTIONS = """\
## What you know about the user

Polly keeps one memory about the user, shared by all of its agents. What it \
holds right now:

<memory>
{memories}
</memory>

Use it quietly: apply what it says without announcing that you remembered.

Whenever a message from the user tells you something that will still matter \
in later conversations, call `remember` first, before you start on the task: \
their name, who they are, what they work on, tools and styles they prefer, \
standing instructions ("always…", "never…"). One short, self-contained fact per \
call, written in the third person ("The user prefers dark-themed charts"). Do \
not save what only matters to this task, anything already in memory, or \
secrets such as passwords and keys. Call `forget` with a memory's id when the \
user says it is wrong or out of date."""


class Memory(BaseModel):
    id: str
    text: str
    # The agent that saved it; "user" when the user wrote it themselves.
    source: str = "user"
    created_at: float = 0


_lock = threading.Lock()


def _file():
    return settings.data_path() / "memory.json"


def _read() -> list[Memory]:
    try:
        data = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    found: list[Memory] = []
    for raw in data.get("memories", []) if isinstance(data, dict) else []:
        try:
            found.append(Memory.model_validate(raw))
        except ValueError:
            continue
    return found


def _write(memories: list[Memory]) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(json.dumps({"memories": [m.model_dump() for m in memories]}, indent=2))
    draft.replace(path)


def all_memories() -> list[Memory]:
    """Oldest first."""
    with _lock:
        return _read()


def add(text: str, *, source: str = "user") -> Memory:
    text = " ".join(text.split())[:MAX_CHARS]
    if not text:
        raise ValueError("a memory needs some text")
    with _lock:
        memories = _read()
        same = next((m for m in memories if m.text.casefold() == text.casefold()), None)
        if same:
            return same
        memory = Memory(id=uuid.uuid4().hex[:6], text=text, source=source, created_at=time.time())
        # Full: the oldest makes room.
        _write([*memories, memory][-MAX_MEMORIES:])
    return memory


def remove(memory_id: str) -> bool:
    with _lock:
        memories = _read()
        kept = [m for m in memories if m.id != memory_id]
        if len(kept) == len(memories):
            return False
        _write(kept)
    return True


def clear() -> None:
    with _lock:
        _write([])


def prompt() -> str:
    lines: list[str] = []
    used = 0
    for m in reversed(all_memories()):
        line = f"- [{m.id}] {m.text}"
        if used + len(line) > PROMPT_BUDGET:
            break
        lines.append(line)
        used += len(line)
    listed = "\n".join(reversed(lines)) or "(nothing yet)"
    return INSTRUCTIONS.format(memories=listed)


def tools_for(agent_id: str) -> list[BaseTool]:
    @tool
    def remember(
        fact: Annotated[str, "One lasting fact about the user, in the third person."],
    ) -> str:
        """Save a fact about the user to Polly's shared memory, for every later conversation."""
        try:
            memory = add(fact, source=agent_id)
        except ValueError as exc:
            return f"Not saved: {exc}."
        return f"Saved as [{memory.id}]."

    @tool
    def forget(memory_id: Annotated[str, "The id shown in brackets before the memory."]) -> str:
        """Delete one memory about the user that is wrong or out of date."""
        if remove(memory_id.strip().strip("[]")):
            return "Forgotten."
        return f"No memory with id {memory_id!r}."

    return [remember, forget]


def middleware(agent_id: str) -> Any:
    """Gives an agent the shared memory: the two tools, and the current list
    in its system prompt each time the model is called."""
    from langchain.agents.middleware.types import AgentMiddleware

    class UserMemoryMiddleware(AgentMiddleware):
        name = "PollyMemory"

        def __init__(self) -> None:
            super().__init__()
            self.tools = tools_for(agent_id)

        def _with_memory(self, request):
            system = request.system_message
            text = system.text if system is not None else ""
            return request.override(
                system_message=SystemMessage(content=f"{text}\n\n{prompt()}".strip())
            )

        def wrap_model_call(self, request, handler):
            return handler(self._with_memory(request))

        async def awrap_model_call(self, request, handler):
            return await handler(self._with_memory(request))

    return UserMemoryMiddleware()
