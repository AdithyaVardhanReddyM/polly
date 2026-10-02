"""Projects: the folders the Coder is allowed to work in.

A project is a folder on this machine plus its settings and its memory. The
list lives in `<data_dir>/projects.json`; per-project state (memory, rules)
lives in `<data_dir>/projects/<id>/`.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

from pydantic import BaseModel, Field

from polly_server.coder.context import Mode
from polly_server.config import settings
from polly_server.model_registry import DEFAULT_MODEL

# Never shown in the file tree; never worth an agent's attention.
HIDDEN = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        ".mypy_cache",
        ".next",
        ".turbo",
        "dist",
        "build",
        "out",
        ".DS_Store",
        ".polly",
    }
)
MAX_FILE_BYTES = 512 * 1024
MAX_TREE_ENTRIES = 2_000


class ProjectSettings(BaseModel):
    default_model: str = DEFAULT_MODEL
    default_mode: Mode = "supervised"
    # Shell commands (by prefix) that never need approval / are always blocked.
    command_allowlist: list[str] = Field(default_factory=list)
    command_denylist: list[str] = Field(
        default_factory=lambda: ["rm -rf /", "sudo ", "git push --force", "git push -f"]
    )


class Project(BaseModel):
    id: str
    name: str
    path: str
    created_at: float
    settings: ProjectSettings = Field(default_factory=ProjectSettings)

    @property
    def root(self) -> Path:
        return Path(self.path)

    @property
    def is_git(self) -> bool:
        return (self.root / ".git").exists()


class TreeNode(BaseModel):
    name: str
    path: str  # relative to the project root, POSIX style
    kind: str  # "file" | "dir"
    size: int | None = None
    children: list[TreeNode] | None = None  # only for dirs within `depth`


class FileContent(BaseModel):
    path: str
    content: str
    truncated: bool


class ProjectError(ValueError):
    """A path or project the server refuses to use."""


_lock = threading.Lock()


def _store_path() -> Path:
    return settings.data_path() / "projects.json"


def _read_all() -> list[Project]:
    path = _store_path()
    if not path.exists():
        return []
    raw = json.loads(path.read_text() or "[]")
    return [Project.model_validate(p) for p in raw]


def _write_all(projects: list[Project]) -> None:
    _store_path().write_text(json.dumps([p.model_dump() for p in projects], indent=2))


def project_id_for(path: Path) -> str:
    return hashlib.sha1(str(path).encode()).hexdigest()[:12]


def project_dir(project: Project | str) -> Path:
    pid = project if isinstance(project, str) else project.id
    return settings.data_path("projects", pid)


def memory_dir(project: Project | str) -> Path:
    return project_dir(project) / "memory"


def list_projects() -> list[Project]:
    with _lock:
        return sorted(_read_all(), key=lambda p: p.created_at, reverse=True)


def get(project_id: str) -> Project | None:
    with _lock:
        return next((p for p in _read_all() if p.id == project_id), None)


def validate_folder(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ProjectError("the project path must be absolute")
    path = path.resolve()
    if not path.exists():
        raise ProjectError(f"{path} does not exist")
    if not path.is_dir():
        raise ProjectError(f"{path} is not a folder")
    if path == Path(path.anchor) or path == Path.home():
        raise ProjectError("pick a project folder, not the whole disk or your home folder")
    return path


def add(raw_path: str) -> Project:
    """Register a folder as a project; re-registering returns the existing one."""
    path = validate_folder(raw_path)
    with _lock:
        projects = _read_all()
        pid = project_id_for(path)
        for existing in projects:
            if existing.id == pid:
                return existing
        project = Project(id=pid, name=path.name, path=str(path), created_at=time.time())
        projects.append(project)
        _write_all(projects)
    memory_dir(project).mkdir(parents=True, exist_ok=True)
    return project


def update(project_id: str, **changes) -> Project:
    with _lock:
        projects = _read_all()
        for i, p in enumerate(projects):
            if p.id == project_id:
                merged = p.settings.model_copy(update=changes)
                projects[i] = p.model_copy(update={"settings": merged})
                _write_all(projects)
                return projects[i]
    raise LookupError(project_id)


def remove(project_id: str) -> bool:
    """Forget a project. Never touches the folder itself."""
    with _lock:
        projects = _read_all()
        kept = [p for p in projects if p.id != project_id]
        if len(kept) == len(projects):
            return False
        _write_all(kept)
        return True


# ---------- looking inside a project ----------


def _inside(project: Project, rel: str) -> Path:
    """Resolve a project-relative path, refusing anything that escapes the root."""
    root = project.root.resolve()
    target = (root / rel.lstrip("/")).resolve()
    if target != root and root not in target.parents:
        raise ProjectError(f"{rel!r} is outside the project")
    return target


def tree(project: Project, rel: str = "", depth: int = 1) -> list[TreeNode]:
    """Entries under `rel`, folders first, expanded `depth` levels deep."""
    budget = [MAX_TREE_ENTRIES]

    def walk(folder: Path, base: str, level: int) -> list[TreeNode]:
        try:
            entries = sorted(folder.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except OSError:
            return []
        nodes: list[TreeNode] = []
        for entry in entries:
            if entry.name in HIDDEN or budget[0] <= 0:
                continue
            budget[0] -= 1
            rel_path = f"{base}/{entry.name}" if base else entry.name
            if entry.is_dir():
                children = walk(entry, rel_path, level + 1) if level < depth else None
                nodes.append(
                    TreeNode(name=entry.name, path=rel_path, kind="dir", children=children)
                )
            else:
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = None
                nodes.append(TreeNode(name=entry.name, path=rel_path, kind="file", size=size))
        return nodes

    return walk(_inside(project, rel), rel.strip("/"), 1)


def read_file(project: Project, rel: str) -> FileContent:
    target = _inside(project, rel)
    if not target.is_file():
        raise ProjectError(f"{rel!r} is not a file")
    data = target.read_bytes()
    truncated = len(data) > MAX_FILE_BYTES
    text = data[:MAX_FILE_BYTES].decode("utf-8", errors="replace")
    return FileContent(path=rel.strip("/"), content=text, truncated=truncated)
