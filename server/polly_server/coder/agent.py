"""Assembling the Coder for one session.

`build_coder` turns the catalog's `coder` spec into a runnable Deep Agent:
the project folder as its filesystem and shell, the session's model, the
permission middleware, todos, memory and the shared checkpointer. The
backend is the seam for later: swap the local shell for a sandbox and
nothing else changes.
"""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING, Any

from polly_server import memory
from polly_server import tools as tool_registry
from polly_server.agents import builders, catalog, delegation, runtime, team
from polly_server.coder.changes import ChangeTracker, make_tracked_backend
from polly_server.coder.context import CoderContext
from polly_server.coder.permissions import (
    PermissionMiddleware,
    ReadOnlyToolsMiddleware,
    build_interrupt_on,
)
from polly_server.integrations import assignments, composio
from polly_server.models import chat_model
from polly_server.persistence import get_checkpointer
from polly_server.projects import Project, memory_dir
from polly_server.sessions import Session, session_dir

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langgraph.graph.state import CompiledStateGraph

MEMORY_FILES = ["/POLLY.md", "/memories/MEMORY.md"]

_cache: dict[tuple[str, str], CompiledStateGraph] = {}


def tracker_for(project: Project, session: Session) -> ChangeTracker:
    return ChangeTracker(project.path, session_dir(session) / "changes")


def make_backend(project: Project, session: Session):
    """The project folder at `/` (edits tracked), plus private routes for
    memory and compacted history."""
    from deepagents.backends import CompositeBackend, FilesystemBackend

    memories = memory_dir(project)
    memories.mkdir(parents=True, exist_ok=True)
    history = session_dir(session) / "history"
    history.mkdir(parents=True, exist_ok=True)
    return CompositeBackend(
        default=make_tracked_backend(
            project.path,
            tracker_for(project, session),
            virtual_mode=True,
            inherit_env=True,
            timeout=120,
        ),
        routes={
            "/memories/": FilesystemBackend(root_dir=memories, virtual_mode=True),
            "/conversation_history/": FilesystemBackend(root_dir=history, virtual_mode=True),
        },
    )


def build_coder(
    project: Project,
    session: Session,
    *,
    model: BaseChatModel | None = None,
    fast_model: BaseChatModel | None = None,
    checkpointer: Any | None = None,
    use_cache: bool = True,
) -> CompiledStateGraph:
    from langchain.agents.middleware import TodoListMiddleware

    apps = assignments.active("coder")
    mates = team.roster(session)
    effort = session.reasoning_effort
    key = (session.id, session.model, effort, apps, team.signature(session, mates))
    if use_cache and key in _cache:
        return _cache[key]

    spec = catalog.get("coder")
    assert spec is not None
    have = tool_registry.registry()
    spec = replace(
        spec,
        tools=tool_registry.available(spec.tools),
        # A helper whose tools are not configured (the librarian without web
        # search) is left out rather than failing the whole build.
        subagents=tuple(s for s in spec.subagents if all(t in have for t in s.tools)),
    )
    connected = list(composio.tools_for(apps))
    if connected:
        spec = replace(spec, system_prompt=builders.with_apps(spec.system_prompt, apps))
    if mates:
        connected.append(delegation.tool_for(session, mates))
        spec = replace(spec, system_prompt=f"{spec.system_prompt}\n\n{team.prompt(session, mates)}")

    main = model or chat_model(model=session.model, reasoning_effort=effort)
    fast = fast_model or chat_model("fast")

    agent = runtime.build(
        spec,
        tools=tool_registry.registry(),
        extra_tools=connected,
        model=main,
        backend=make_backend(project, session),
        memory=MEMORY_FILES,
        middleware=[TodoListMiddleware(), PermissionMiddleware(), memory.middleware("coder")],
        interrupt_on=build_interrupt_on(),
        context_schema=CoderContext,
        checkpointer=checkpointer or get_checkpointer(),
        subagent_overrides={
            "explorer": {"model": fast, "middleware": [ReadOnlyToolsMiddleware()]},
            "tester": {"model": fast, "middleware": [PermissionMiddleware()]},
            "librarian": {
                "model": fast,
                "middleware": [ReadOnlyToolsMiddleware(also={"research_search", "web_extract"})],
            },
        },
    )
    if use_cache:
        _cache[key] = agent
    return agent


def forget(session_id: str) -> None:
    for key in [k for k in _cache if k[0] == session_id]:
        _cache.pop(key, None)
