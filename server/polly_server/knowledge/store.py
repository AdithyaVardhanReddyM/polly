"""Where knowledge bases live on disk.

Under `<data_dir>/knowledge/`:

- `library.json`: the bases and their files (names, status, sizes), behind a
  lock like `memory.py`;
- `files/<file_id>/<name>`: each upload as it came;
- `text/<file_id>.json`: the text read from it, page by page. Answers over
  small bases read it whole, and it can be chunked again without reading
  the file twice;
- `index.db`: the chunks, in a `HybridIndex` namespace "knowledge", with meta
  `{kb_id, file_id, file_name, page, chunk}`.
"""

from __future__ import annotations

import functools
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from polly_server.config import settings
from polly_server.knowledge.chunking import Page
from polly_server.retrieval import HybridIndex

FileStatus = Literal["processing", "ready", "error"]


class KnowledgeBase(BaseModel):
    id: str
    name: str
    description: str = ""
    files: int = 0
    # Total tokens across its files, roughly.
    tokens: int = 0
    created_at: float = 0
    updated_at: float = 0


class KnowledgeFile(BaseModel):
    id: str
    kb_id: str
    name: str
    size: int = 0
    mime: str = "application/octet-stream"
    status: FileStatus = "processing"
    error: str | None = None
    pages: int | None = None
    tokens: int = 0
    created_at: float = 0


class KnowledgeDetail(BaseModel):
    base: KnowledgeBase
    files: list[KnowledgeFile]


class _Base(BaseModel):
    id: str
    name: str
    description: str = ""
    created_at: float = 0
    updated_at: float = 0


class _Library(BaseModel):
    bases: list[_Base] = []
    files: list[KnowledgeFile] = []


_lock = threading.Lock()


def root() -> Path:
    return settings.data_path("knowledge")


def _file() -> Path:
    return root() / "library.json"


@functools.cache
def _index_at(path: Path) -> HybridIndex:
    return HybridIndex(path, "knowledge")


def index() -> HybridIndex:
    """The chunks of every base, one namespace filtered by `kb_id`."""
    return _index_at(root() / "index.db")


def _read() -> _Library:
    try:
        return _Library.model_validate_json(_file().read_text())
    except (OSError, ValueError):
        return _Library()


def _write(library: _Library) -> None:
    path = _file()
    draft = path.with_suffix(".tmp")
    draft.write_text(library.model_dump_json(indent=2))
    draft.replace(path)


def _summary(base: _Base, files: list[KnowledgeFile]) -> KnowledgeBase:
    mine = [f for f in files if f.kb_id == base.id]
    return KnowledgeBase(**base.model_dump(), files=len(mine), tokens=sum(f.tokens for f in mine))


def _clean_name(name: str) -> str:
    name = " ".join(name.split())[:80]
    if not name:
        raise ValueError("a knowledge base needs a name")
    return name


# ---------- bases ----------


def list_bases() -> list[KnowledgeBase]:
    """Newest updated first."""
    with _lock:
        library = _read()
    bases = [_summary(b, library.files) for b in library.bases]
    return sorted(bases, key=lambda b: b.updated_at, reverse=True)


def get_base(kb_id: str) -> KnowledgeBase | None:
    with _lock:
        library = _read()
    base = next((b for b in library.bases if b.id == kb_id), None)
    return _summary(base, library.files) if base else None


def detail(kb_id: str) -> KnowledgeDetail | None:
    """The base and its files, newest first."""
    with _lock:
        library = _read()
    base = next((b for b in library.bases if b.id == kb_id), None)
    if base is None:
        return None
    files = sorted(
        (f for f in library.files if f.kb_id == kb_id), key=lambda f: f.created_at, reverse=True
    )
    return KnowledgeDetail(base=_summary(base, library.files), files=files)


def create_base(name: str, description: str = "") -> KnowledgeBase:
    now = time.time()
    base = _Base(
        id=f"kb-{uuid.uuid4().hex[:8]}",
        name=_clean_name(name),
        description=description.strip()[:500],
        created_at=now,
        updated_at=now,
    )
    with _lock:
        library = _read()
        library.bases.append(base)
        _write(library)
    return _summary(base, [])


def update_base(
    kb_id: str, *, name: str | None = None, description: str | None = None
) -> KnowledgeBase | None:
    changes: dict[str, Any] = {"updated_at": time.time()}
    if name is not None:
        changes["name"] = _clean_name(name)
    if description is not None:
        changes["description"] = description.strip()[:500]
    with _lock:
        library = _read()
        base = next((b for b in library.bases if b.id == kb_id), None)
        if base is None:
            return None
        changed = base.model_copy(update=changes)
        library.bases = [changed if b.id == kb_id else b for b in library.bases]
        _write(library)
        return _summary(changed, library.files)


def delete_base(kb_id: str) -> bool:
    """The base, its files on disk and its chunks."""
    with _lock:
        library = _read()
        if not any(b.id == kb_id for b in library.bases):
            return False
        gone = [f for f in library.files if f.kb_id == kb_id]
        library.bases = [b for b in library.bases if b.id != kb_id]
        library.files = [f for f in library.files if f.kb_id != kb_id]
        _write(library)
    for file in gone:
        _remove_from_disk(file.id)
    index().delete_where("kb_id", kb_id)
    return True


def _touch(library: _Library, kb_id: str) -> None:
    now = time.time()
    library.bases = [
        b.model_copy(update={"updated_at": now}) if b.id == kb_id else b for b in library.bases
    ]


# ---------- files ----------


def safe_name(name: str) -> str:
    """A file name that stays inside its folder on every OS."""
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r'[\x00-\x1f<>:"/|?*]', "_", name).strip(" .")
    return name[:150] or "file"


def upload_dir(file_id: str) -> Path:
    return root() / "files" / file_id


def upload_path(file: KnowledgeFile) -> Path:
    return upload_dir(file.id) / safe_name(file.name)


def text_path(file_id: str) -> Path:
    return root() / "text" / f"{file_id}.json"


def new_file(kb_id: str, name: str, mime: str) -> KnowledgeFile:
    """A file record to save an upload under; `add_file` stores it."""
    return KnowledgeFile(
        id=f"kf-{uuid.uuid4().hex[:10]}",
        kb_id=kb_id,
        name=" ".join(name.split())[:200] or "file",
        mime=mime,
        created_at=time.time(),
    )


def add_file(file: KnowledgeFile) -> bool:
    """Record a file; False when its base is gone."""
    with _lock:
        library = _read()
        if not any(b.id == file.kb_id for b in library.bases):
            return False
        library.files.append(file)
        _touch(library, file.kb_id)
        _write(library)
    return True


def get_file(file_id: str) -> KnowledgeFile | None:
    with _lock:
        return next((f for f in _read().files if f.id == file_id), None)


def files_of(kb_ids: list[str]) -> list[KnowledgeFile]:
    """Oldest first: the order they were added."""
    wanted = set(kb_ids)
    with _lock:
        files = [f for f in _read().files if f.kb_id in wanted]
    return sorted(files, key=lambda f: f.created_at)


def update_file(file_id: str, **changes: Any) -> KnowledgeFile | None:
    with _lock:
        library = _read()
        file = next((f for f in library.files if f.id == file_id), None)
        if file is None:
            return None
        changed = file.model_copy(update=changes)
        library.files = [changed if f.id == file_id else f for f in library.files]
        _touch(library, file.kb_id)
        _write(library)
    return changed


def delete_file(kb_id: str, file_id: str) -> bool:
    with _lock:
        library = _read()
        if not any(f.id == file_id and f.kb_id == kb_id for f in library.files):
            return False
        library.files = [f for f in library.files if f.id != file_id]
        _touch(library, kb_id)
        _write(library)
    _remove_from_disk(file_id)
    index().delete_where("file_id", file_id)
    return True


def _remove_from_disk(file_id: str) -> None:
    shutil.rmtree(upload_dir(file_id), ignore_errors=True)
    text_path(file_id).unlink(missing_ok=True)


def save_text(file_id: str, pages: list[Page]) -> None:
    path = text_path(file_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"pages": [{"page": p.number, "text": p.text} for p in pages]}),
        encoding="utf-8",
    )


def load_text(file_id: str) -> list[Page]:
    try:
        data = json.loads(text_path(file_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [Page(p.get("page"), p.get("text", "")) for p in data.get("pages", [])]
