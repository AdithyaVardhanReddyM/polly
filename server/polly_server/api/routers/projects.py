from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from polly_server import projects, sessions
from polly_server.api.schemas import (
    ProjectCreate,
    ProjectList,
    ProjectMemory,
    ProjectPatch,
    RuleList,
    SessionList,
)
from polly_server.coder import permissions
from polly_server.coder.permissions import Rule
from polly_server.projects import FileContent, Project, ProjectError, TreeNode

router = APIRouter(prefix="/projects", tags=["projects"])


def _project(project_id: str) -> Project:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(404, f"no project {project_id!r}")
    return project


@router.get("", response_model=ProjectList)
def list_projects() -> ProjectList:
    return ProjectList(projects=projects.list_projects())


@router.post("", response_model=Project, status_code=201)
def create_project(body: ProjectCreate) -> Project:
    try:
        return projects.add(body.path)
    except ProjectError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: str) -> Project:
    return _project(project_id)


@router.patch("/{project_id}", response_model=Project)
def patch_project(project_id: str, body: ProjectPatch) -> Project:
    _project(project_id)
    changes = body.model_dump(exclude_none=True)
    return projects.update(project_id, **changes)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    if not projects.remove(project_id):
        raise HTTPException(404, f"no project {project_id!r}")


@router.get("/{project_id}/tree", response_model=list[TreeNode])
def project_tree(
    project_id: str, path: str = "", depth: int = Query(default=1, ge=1, le=4)
) -> list[TreeNode]:
    try:
        return projects.tree(_project(project_id), path, depth)
    except ProjectError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/{project_id}/file", response_model=FileContent)
def project_file(project_id: str, path: str) -> FileContent:
    try:
        return projects.read_file(_project(project_id), path)
    except ProjectError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/{project_id}/rules", response_model=RuleList)
def list_rules(project_id: str) -> RuleList:
    return RuleList(rules=permissions.load_rules(_project(project_id)))


@router.post("/{project_id}/rules", response_model=RuleList)
def add_rule(project_id: str, rule: Rule) -> RuleList:
    return RuleList(rules=permissions.add_rule(_project(project_id), rule))


@router.delete("/{project_id}/rules/{index}", response_model=RuleList)
def delete_rule(project_id: str, index: int) -> RuleList:
    return RuleList(rules=permissions.remove_rule(_project(project_id), index))


@router.get("/{project_id}/memory", response_model=ProjectMemory)
def project_memory(project_id: str) -> ProjectMemory:
    project = _project(project_id)
    polly = project.root / "POLLY.md"
    memory = projects.memory_dir(project) / "MEMORY.md"
    return ProjectMemory(
        polly_md=polly.read_text(errors="replace") if polly.is_file() else None,
        memory_md=memory.read_text(errors="replace") if memory.is_file() else None,
    )


@router.get("/{project_id}/sessions", response_model=SessionList)
def project_sessions(project_id: str) -> SessionList:
    return SessionList(sessions=sessions.list_for(_project(project_id).id))
