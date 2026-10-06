from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from polly_server import artifacts, model_registry, projects, sandbox, sessions
from polly_server.agents import builders, catalog, groups, team
from polly_server.api.routers.design import context_note
from polly_server.api.schemas import (
    Artifacts,
    ChangePaths,
    DecisionsIn,
    MessageIn,
    SessionCreate,
    SessionList,
    SessionPatch,
    Transcript,
)
from polly_server.coder import agent as coder_agent
from polly_server.coder import permissions, runs
from polly_server.coder.changes import FileChange, FileDiff
from polly_server.coder.events import approval_payload, wire_message
from polly_server.coder.permissions import Rule
from polly_server.coder.prompt import INIT_PROMPT
from polly_server.coder.runs import NothingToResearch, Run, SessionBusy, manager, sse
from polly_server.config import settings
from polly_server.projects import Project
from polly_server.research import sources
from polly_server.sessions import Session

router = APIRouter(tags=["sessions"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _session(session_id: str) -> Session:
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(404, f"no session {session_id!r}")
    return session


def _project_of(session: Session) -> Project:
    project = projects.get(session.project_id) if session.project_id else None
    if project is None:
        if session.project_id is None:
            raise HTTPException(400, "this session has no project")
        raise HTTPException(410, "the session's project was removed")
    return project


def _project_for_run(session: Session) -> Project | None:
    """The Coder needs its project; the other agents run without one."""
    if session.agent_id == "coder":
        return _project_of(session)
    return projects.get(session.project_id) if session.project_id else None


def _require_model() -> None:
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")


def _require_search(agent_id: str) -> None:
    if builders.needs_search(agent_id) and not builders.search_ready():
        raise HTTPException(503, "TAVILY_API_KEY is not set; research needs web search")


def _stream(run: Run, after: int = -1) -> StreamingResponse:
    async def body() -> AsyncIterator[str]:
        async for event in run.subscribe(after):
            yield sse(event)

    return StreamingResponse(body(), media_type="text/event-stream", headers=SSE_HEADERS)


def _members(ids: list[str] | None, agent_id: str) -> list[str] | None:
    if ids is None:
        return None
    try:
        return team.check(ids, agent_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


def _addressed(session: Session, mentions: list[str]) -> tuple[Session, str]:
    """The teammates the user addressed with `@Name`, as a note for the lead.
    Outside a group, one who was not on the conversation's team joins it."""
    on_team = {m.id: m for m in team.roster(session)}
    known = [m for m in dict.fromkeys(mentions) if m != session.agent_id]
    if session.group_id is None:
        joining = [m for m in known if m not in on_team and team.can_join(catalog.get(m))]
        if joining:
            members = [*on_team, *joining][: team.MAX_TEAMMATES]
            session = sessions.update(session.id, members=members)
            on_team = {m.id: m for m in team.roster(session)}
    mentioned = tuple(on_team[m] for m in known if m in on_team)
    return session, team.mention_note(mentioned) if mentioned else ""


@router.post("/sessions", response_model=Session, status_code=201)
def create_session(body: SessionCreate) -> Session:
    group = None
    if body.group_id is not None:
        group = groups.get(body.group_id)
        if group is None:
            raise HTTPException(404, f"no group {body.group_id!r}")
    spec = catalog.get(group.lead if group else body.agent_id)
    if spec is None or not builders.listed(spec):
        raise HTTPException(404, f"no agent {body.agent_id!r}")
    if spec.status != "ready":
        raise HTTPException(400, f"{spec.name} is not available yet")

    if spec.id == "coder":
        project = projects.get(body.project_id) if body.project_id else None
        if project is None:
            raise HTTPException(404, f"no project {body.project_id!r}")
        model = body.model or project.settings.default_model
        mode = body.mode or project.settings.default_mode
        project_id: str | None = project.id
    else:
        if body.project_id and projects.get(body.project_id) is None:
            raise HTTPException(404, f"no project {body.project_id!r}")
        model = body.model or builders.default_model(spec.id)
        mode = "plan"  # research and review never write to disk
        project_id = body.project_id
    if not model_registry.known(model):
        raise HTTPException(400, f"unknown model {model!r}")
    return sessions.create(
        project_id,
        model=model,
        reasoning_effort=body.reasoning_effort,
        mode=mode,
        title=body.title,
        agent_id=spec.id,
        group_id=group.id if group else None,
        # A group's conversation follows the group; no team of its own.
        members=None if group else _members(body.members, spec.id),
    )


@router.get("/sessions", response_model=SessionList)
def list_sessions(agent_id: str | None = None, group_id: str | None = None) -> SessionList:
    """Top-level sessions with one agent, or the conversations of one group,
    newest first (Coder sessions are listed per project:
    `GET /projects/{id}/sessions`)."""
    if group_id is not None:
        return SessionList(sessions=sessions.list_group(group_id))
    if agent_id is None:
        raise HTTPException(422, "give an agent_id or a group_id")
    return SessionList(sessions=sessions.list_agent(agent_id))


@router.get("/sessions/{session_id}", response_model=Session)
def get_session(session_id: str) -> Session:
    return _session(session_id)


@router.patch("/sessions/{session_id}", response_model=Session)
def patch_session(session_id: str, body: SessionPatch) -> Session:
    session = _session(session_id)
    changes = body.model_dump(exclude_none=True)
    if "model" in changes and not model_registry.known(changes["model"]):
        raise HTTPException(400, f"unknown model {changes['model']!r}")
    if session.id in manager.active and changes.keys() & {"model", "mode", "reasoning_effort"}:
        raise HTTPException(409, "stop the current run before changing the model, effort or mode")
    if session.agent_id != "coder":
        changes.pop("mode", None)
    if "members" in changes:
        if session.group_id is not None:
            raise HTTPException(400, "a group conversation follows its group: change the group")
        changes["members"] = _members(changes["members"], session.agent_id)
    return sessions.update(session_id, **changes)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> None:
    await manager.cancel(session_id)
    coder_agent.forget(session_id)
    builders.forget(session_id)
    sandbox.forget(session_id)
    if not sessions.delete(session_id):
        raise HTTPException(404, f"no session {session_id!r}")


@router.get("/sessions/{session_id}/messages", response_model=Transcript)
async def transcript(session_id: str) -> Transcript:
    session = _session(session_id)
    project = _project_for_run(session)
    messages: list[dict[str, Any]] = []
    todos: list[dict[str, Any]] = []
    pending = None
    # The graph merges the checkpoint with its pending writes for us; raw
    # checkpoints only carry the channels the last step touched.
    try:
        graph = runs.build_graph(project, session)
    except (RuntimeError, LookupError):
        graph = None  # no model key, or an agent we no longer run
    if graph is not None:
        state = await graph.aget_state({"configurable": {"thread_id": session.id}})
        messages = [w for m in state.values.get("messages", []) if (w := wire_message(m))]
        todos = list(state.values.get("todos") or [])
        if state.interrupts:
            pending = approval_payload(state.interrupts[0])
    run = manager.for_session(session.id)
    return Transcript(
        session=session,
        messages=messages,
        todos=todos,
        pending_approval=pending,
        run_id=run.id if run and not run.done else None,
    )


@router.post("/sessions/{session_id}/messages")
async def send_message(session_id: str, body: MessageIn) -> StreamingResponse:
    _require_model()
    session = _session(session_id)
    _require_search(session.agent_id)
    project = _project_for_run(session)
    if session.status == "awaiting_approval":
        raise HTTPException(409, "decide on the pending action first")
    text, display = body.content, None
    if session.agent_id == "designer":
        # The Designer needs to know what is on the canvas and what is selected.
        text = f"{body.content}\n\n<canvas>\n{context_note(session.id)}\n</canvas>"
        display = body.content
    if body.mentions:
        session, note = _addressed(session, body.mentions)
        if note:
            text = f"{text}\n\n{note}"
            display = body.content
    try:
        run = await manager.start(project, session, text, display=display)
    except SessionBusy:
        raise HTTPException(409, "this session is already running") from None
    return _stream(run)


@router.post("/sessions/{session_id}/decisions")
async def decide(session_id: str, body: DecisionsIn) -> StreamingResponse:
    _require_model()
    session = _session(session_id)
    project = _project_for_run(session)
    if session.status != "awaiting_approval":
        raise HTTPException(409, "this session is not waiting for a decision")

    # "Always allow": save the rule, then approve as usual.
    for remembered in body.remember:
        decision = (
            body.decisions[remembered.index] if remembered.index < len(body.decisions) else None
        )
        tool = _pending_tool_name(session, remembered.index)
        if decision and decision.type == "approve" and tool and project is not None:
            permissions.add_rule(project, Rule(tool=tool, pattern=remembered.pattern))

    decisions = [d.model_dump(exclude_none=True) for d in body.decisions]
    try:
        run = await manager.resume(project, session, decisions)
    except SessionBusy:
        raise HTTPException(409, "this session is already running") from None
    return _stream(run)


def _pending_tool_name(session: Session, index: int) -> str | None:
    run = manager.for_session(session.id)
    if run is None:
        return None
    for event in reversed(run.events):
        if event["type"] == "approval.required":
            requests = event.get("requests") or []
            return requests[index]["name"] if index < len(requests) else None
    return None


@router.get("/sessions/{session_id}/events")
async def events(session_id: str, after: int = -1) -> StreamingResponse:
    session = _session(session_id)
    run = manager.for_session(session.id)
    if run is None:
        raise HTTPException(404, "no run for this session yet")
    return _stream(run, after)


@router.post("/sessions/{session_id}/cancel", status_code=202)
async def cancel(session_id: str) -> dict[str, bool]:
    _session(session_id)
    return {"cancelled": await manager.cancel(session_id)}


@router.post("/projects/{project_id}/init", response_model=Session, status_code=201)
async def init_project(project_id: str) -> Session:
    """Create a session that writes `/POLLY.md`, unattended."""
    _require_model()
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(404, f"no project {project_id!r}")
    session = sessions.create(
        project.id,
        model=project.settings.default_model,
        mode="autonomous",
        title="Generate POLLY.md",
    )
    await manager.start(
        project,
        session,
        INIT_PROMPT,
        policy=permissions.init_policy(),
        display="Generate POLLY.md: a guide to this project for the Coder",
    )
    return session


# ---------- changes ----------


@router.get("/sessions/{session_id}/changes", response_model=list[FileChange])
def list_changes(session_id: str) -> list[FileChange]:
    session = _session(session_id)
    return coder_agent.tracker_for(_project_of(session), session).list()


@router.get("/sessions/{session_id}/changes/diff", response_model=FileDiff)
def change_diff(session_id: str, path: str) -> FileDiff:
    session = _session(session_id)
    diff = coder_agent.tracker_for(_project_of(session), session).diff(path)
    if diff is None:
        raise HTTPException(404, f"no change to {path!r} in this session")
    return diff


@router.post("/sessions/{session_id}/changes/accept", response_model=list[FileChange])
def accept_changes(session_id: str, body: ChangePaths) -> list[FileChange]:
    session = _session(session_id)
    tracker = coder_agent.tracker_for(_project_of(session), session)
    tracker.accept(body.paths or None)
    return tracker.list()


@router.post("/sessions/{session_id}/changes/revert", response_model=list[FileChange])
def revert_changes(session_id: str, body: ChangePaths) -> list[FileChange]:
    session = _session(session_id)
    if session.id in manager.active:
        raise HTTPException(409, "stop the current run before reverting")
    tracker = coder_agent.tracker_for(_project_of(session), session)
    paths = body.paths or [c.path for c in tracker.list()]
    tracker.revert(paths)
    return tracker.list()


# ---------- research and artifacts ----------


@router.post("/sessions/{session_id}/research", response_model=Session, status_code=201)
async def research_changes(session_id: str) -> Session:
    """Research a Coder session's pending changes now (it also happens on its
    own after each Coder run, unless the project turned it off)."""
    _require_model()
    session = _session(session_id)
    if session.agent_id != "coder":
        raise HTTPException(400, "only Coder sessions have changes to research")
    if session.id in manager.active:
        raise HTTPException(409, "wait for the Coder to finish first")
    project = _project_of(session)
    try:
        return await manager.research_change(project, session)
    except NothingToResearch as why:
        code = 503 if "not set" in str(why) else 409
        raise HTTPException(code, str(why)) from None


@router.get("/sessions/{session_id}/research", response_model=SessionList)
def research_sessions(session_id: str) -> SessionList:
    """Sessions started from this one (change research), newest first."""
    _session(session_id)
    return SessionList(sessions=sessions.list_children(session_id))


@router.get("/sessions/{session_id}/outputs")
async def session_output(session_id: str, path: str) -> Response:
    """A file the agent saved for the user in its sandbox: a chart, a CSV."""
    session = _session(session_id)
    try:
        content, media = await sandbox.read_output(session.id, path)
    except sandbox.NoSuchOutput:
        raise HTTPException(404, f"no output {path!r}") from None
    name = path.rsplit("/", 1)[-1].replace('"', "")
    # Images show in the chat; anything else is a download.
    shown = media.startswith("image/") and media != "image/svg+xml"
    disposition = "inline" if shown else f'attachment; filename="{name}"'
    return Response(
        content,
        media_type=media if shown else "application/octet-stream",
        headers={"Cache-Control": "no-store", "Content-Disposition": disposition},
    )


@router.get("/sessions/{session_id}/artifacts", response_model=Artifacts)
def session_artifacts(session_id: str) -> Artifacts:
    session = _session(session_id)
    return Artifacts(
        sources=[s.model_dump() for s in sources.all_for(session.id)],
        report=artifacts.load(session.id, "report"),
        scorecard=artifacts.load(session.id, "scorecard"),
        pr=artifacts.load(session.id, "pr"),
    )
