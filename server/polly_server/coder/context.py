"""Per-run context handed to the Coder's graph.

Nothing here is persisted: it is rebuilt for every run from the project,
the session and the mode the user picked. Middleware and tools read it from
`runtime.context`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, TypedDict

if TYPE_CHECKING:
    from polly_server.coder.permissions import Policy

# Our names for what Claude Code calls permission modes:
#   supervised  ask before every edit and command
#   trusted     edits go through; commands and deletes still ask
#   autonomous  never asks (the project's deny-list is still enforced)
#   plan        read-only; the agent writes a plan instead of code
Mode = Literal["supervised", "trusted", "autonomous", "plan"]
MODES: tuple[Mode, ...] = ("supervised", "trusted", "autonomous", "plan")


class CoderContext(TypedDict):
    project_id: str
    project_path: str
    session_id: str
    mode: Mode
    policy: Policy
