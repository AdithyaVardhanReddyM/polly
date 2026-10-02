from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from polly_server import model_registry, projects, sessions
from polly_server.api.schemas import (
    ChangePaths,
    DecisionsIn,
    MessageIn,
    SessionCreate,
    SessionPatch,
    Transcript,
)
from polly_server.coder import agent as coder_agent
from polly_server.coder import permissions, runs
from polly_server.coder.changes import FileChange, FileDiff
from polly_server.coder.events import approval_payload, wire_message
from polly_server.coder.permissions import Rule
from polly_server.coder.prompt import INIT_PROMPT
from polly_server.coder.runs import Run, SessionBusy, manager, sse
from polly_server.config import settings
from polly_server.projects import Project
from polly_server.sessions import Session

router = APIRouter(tags=["sessions"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _session(session_id: str) -> Session:
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(404, f"no session {session_id!r}")
    return session


def _project_of(session: Session) -> Project:
    project = projects.get(session.project_id)
    if project is None:
        raise HTTPException(410, "the session's project was removed")
    return project


def _require_model() -> None:
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")


def _stream(run: Run, after: int = -1) -> StreamingResponse:
    async def body() -> AsyncIterator[str]:
        async for event in run.subscribe(after):
            yield sse(event)

    return StreamingResponse(body(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/sessions", response_model=Session, status_code=201)
def create_session(body: SessionCreate) -> Session:
    project = projects.get(body.project_id)
    if project is None:
        raise HTTPException(404, f"no project {body.project_id!r}")
    model = body.model or project.settings.default_model
    if not model_registry.known(model):
        raise HTTPException(400, f"unknown model {model!r}")
    return sessions.create(
        project.id, model=model, mode=body.mode or project.settings.default_mode, title=body.title
    )


@router.get("/sessions/{session_id}", response_model=Session)
def get_session(session_id: str) -> Session:
    return _session(session_id)


@router.patch("/sessions/{session_id}", response_model=Session)
def patch_session(session_id: str, body: SessionPatch) -> Session:
    session = _session(session_id)
    changes = body.model_dump(exclude_none=True)
    if "model" in changes and not model_registry.known(changes["model"]):
        raise HTTPException(400, f"unknown model {changes['model']!r}")
    if session.id in manager.active and ("model" in changes or "mode" in changes):
        raise HTTPException(409, "stop the current run before changing the model or mode")
    return sessions.update(session_id, **changes)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> None:
    await manager.cancel(session_id)
    coder_agent.forget(session_id)
    if not sessions.delete(session_id):
        raise HTTPException(404, f"no session {session_id!r}")


@router.get("/sessions/{session_id}/messages", response_model=Transcript)
async def transcript(session_id: str) -> Transcript:
    session = _session(session_id)
    project = _project_of(session)
    messages: list[dict[str, Any]] = []
    todos: list[dict[str, Any]] = []
    pending = None
    # The graph merges the checkpoint with its pending writes for us; raw
    # checkpoints only carry the channels the last step touched.
    try:
        graph = runs.build_coder(project, session)
    except RuntimeError:
        graph = None  # no model key: nothing to replay with
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
    project = _project_of(session)
    if session.status == "awaiting_approval":
        raise HTTPException(409, "decide on the pending action first")
    try:
        run = await manager.start(project, session, body.content)
    except SessionBusy:
        raise HTTPException(409, "this session is already running") from None
    return _stream(run)


@router.post("/sessions/{session_id}/decisions")
async def decide(session_id: str, body: DecisionsIn) -> StreamingResponse:
    _require_model()
    session = _session(session_id)
    project = _project_of(session)
    if session.status != "awaiting_approval":
        raise HTTPException(409, "this session is not waiting for a decision")

    # "Always allow": save the rule, then approve as usual.
    for remembered in body.remember:
        decision = (
            body.decisions[remembered.index] if remembered.index < len(body.decisions) else None
        )
        tool = _pending_tool_name(session, remembered.index)
        if decision and decision.type == "approve" and tool:
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
