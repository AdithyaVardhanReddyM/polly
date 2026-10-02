"""Every file the Coder touched in a session, with a way back.

Before the agent first writes, edits or deletes a file in a session, the
tracker keeps a copy of how the file was (or notes that it did not exist).
The Changes panel diffs against that baseline; *accept* forgets the
baseline, *revert* restores it. Shell commands can change files too; in a
git repository those show up through `git status` and revert through git.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from polly_server.coder.permissions import PRIVATE_PREFIXES

ChangeKind = Literal["created", "modified", "deleted"]
MAX_DIFF_BYTES = 1024 * 1024


class FileChange(BaseModel):
    path: str  # relative to the project root, POSIX style
    kind: ChangeKind
    additions: int
    deletions: int
    # "agent": made through the file tools (exact baseline);
    # "shell": seen in `git status` after a command (baseline is HEAD).
    source: Literal["agent", "shell"] = "agent"


class FileDiff(BaseModel):
    path: str
    kind: ChangeKind
    before: str
    after: str
    binary: bool = False


def _rel(file_path: str) -> str:
    return file_path.strip().lstrip("/")


def _read(path: Path) -> bytes | None:
    try:
        return path.read_bytes() if path.is_file() else None
    except OSError:
        return None


def _text(data: bytes | None) -> tuple[str, bool]:
    if data is None:
        return "", False
    if b"\0" in data[:8192] or len(data) > MAX_DIFF_BYTES:
        return "", True
    return data.decode("utf-8", errors="replace"), False


def _counts(before: str, after: str) -> tuple[int, int]:
    adds = dels = 0
    for line in difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            adds += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    return adds, dels


class ChangeTracker:
    """Baselines and a manifest under `<session_dir>/changes/`."""

    def __init__(self, project_root: str | Path, folder: str | Path) -> None:
        self.root = Path(project_root).resolve()
        self.folder = Path(folder)
        self.baselines = self.folder / "baseline"
        self.baselines.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.folder / "manifest.json"
        self._lock = threading.Lock()
        # Files that were already dirty when the session started are the
        # user's work in progress, not the agent's: never listed via git.
        self._preexisting_path = self.folder / "preexisting.json"
        if not self._preexisting_path.exists():
            self._preexisting_path.write_text(json.dumps(sorted(self._git_dirty())))
        self.preexisting = set(json.loads(self._preexisting_path.read_text() or "[]"))

    # ---------- manifest ----------

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.manifest_path.exists():
            return {}
        try:
            return json.loads(self.manifest_path.read_text() or "{}")
        except ValueError:
            return {}

    def _save(self, manifest: dict[str, dict[str, Any]]) -> None:
        self.manifest_path.write_text(json.dumps(manifest, indent=2))

    def _abs(self, rel: str) -> Path:
        target = (self.root / rel).resolve()
        if target != self.root and self.root not in target.parents:
            raise ValueError(f"{rel!r} is outside the project")
        return target

    # ---------- recording ----------

    def tracks(self, file_path: str) -> bool:
        return not file_path.startswith(PRIVATE_PREFIXES)

    def before_write(self, file_path: str) -> None:
        """Keep the original once per session, before the first change."""
        if not self.tracks(file_path):
            return
        rel = _rel(file_path)
        with self._lock:
            manifest = self._load()
            if rel in manifest:
                return
            original = _read(self._abs(rel))
            entry: dict[str, Any] = {
                "source": "agent",
                "baseline": None,
                "existed": original is not None,
            }
            if original is not None:
                name = hashlib.sha1(rel.encode()).hexdigest()
                (self.baselines / name).write_bytes(original)
                entry["baseline"] = name
            manifest[rel] = entry
            self._save(manifest)

    def after_write(self, file_path: str) -> FileChange | None:
        if not self.tracks(file_path):
            return None
        rel = _rel(file_path)
        change = self._change(rel, self._load().get(rel))
        if change is None:  # back to how it was: nothing to show
            with self._lock:
                manifest = self._load()
                entry = manifest.pop(rel, None)
                if entry and entry.get("baseline"):
                    (self.baselines / entry["baseline"]).unlink(missing_ok=True)
                self._save(manifest)
        return change

    def _git_status(self) -> list[tuple[str, str]]:
        if not (self.root / ".git").exists():
            return []
        try:
            out = subprocess.run(
                ["git", "status", "--porcelain", "-z", "--untracked-files=all"],
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=20,
            ).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        return [(item[:2], item[3:]) for item in out.split("\0") if len(item) > 3]

    def _git_dirty(self) -> set[str]:
        return {rel for _, rel in self._git_status()}

    def sync_git(self) -> list[FileChange]:
        """Pick up files a shell command changed (git repositories only)."""
        found: list[FileChange] = []
        status_lines = self._git_status()
        if not status_lines:
            return []
        with self._lock:
            manifest = self._load()
            for status, rel in status_lines:
                if rel in manifest or rel in self.preexisting or rel.endswith("/"):
                    continue
                manifest[rel] = {"source": "shell", "baseline": None, "existed": "?" not in status}
                change = self._change(rel, manifest[rel])
                if change:
                    found.append(change)
                else:
                    manifest.pop(rel)
            self._save(manifest)
        return found

    # ---------- reading ----------

    def _baseline(self, rel: str, entry: dict[str, Any]) -> bytes | None:
        if entry.get("source") == "shell":
            if not entry.get("existed"):
                return None
            try:
                proc = subprocess.run(
                    ["git", "show", f"HEAD:{rel}"], cwd=self.root, capture_output=True, timeout=20
                )
            except (OSError, subprocess.TimeoutExpired):
                return None
            return proc.stdout if proc.returncode == 0 else None
        name = entry.get("baseline")
        return (self.baselines / name).read_bytes() if name else None

    def _change(self, rel: str, entry: dict[str, Any] | None) -> FileChange | None:
        if entry is None:
            return None
        before = self._baseline(rel, entry)
        after = _read(self._abs(rel))
        if before == after:
            return None
        if before is None and after is not None:
            kind: ChangeKind = "created"
        elif after is None:
            kind = "deleted"
        else:
            kind = "modified"
        (b, bb), (a, ab) = _text(before), _text(after)
        adds, dels = (0, 0) if (bb or ab) else _counts(b, a)
        return FileChange(
            path=rel, kind=kind, additions=adds, deletions=dels, source=entry.get("source", "agent")
        )

    def list(self) -> list[FileChange]:
        manifest = self._load()
        changes = [c for rel, entry in manifest.items() if (c := self._change(rel, entry))]
        return sorted(changes, key=lambda c: c.path)

    def diff(self, file_path: str) -> FileDiff | None:
        rel = _rel(file_path)
        entry = self._load().get(rel)
        change = self._change(rel, entry)
        if change is None or entry is None:
            return None
        before, bb = _text(self._baseline(rel, entry))
        after, ab = _text(_read(self._abs(rel)))
        return FileDiff(path=rel, kind=change.kind, before=before, after=after, binary=bb or ab)

    # ---------- deciding ----------

    def accept(self, paths: list[str] | None = None) -> list[str]:
        with self._lock:
            manifest = self._load()
            chosen = [_rel(p) for p in paths] if paths else list(manifest)
            done = []
            for rel in chosen:
                entry = manifest.pop(rel, None)
                if entry is None:
                    continue
                if entry.get("baseline"):
                    (self.baselines / entry["baseline"]).unlink(missing_ok=True)
                done.append(rel)
            self._save(manifest)
        return done

    def revert(self, paths: list[str]) -> list[str]:
        done = []
        with self._lock:
            manifest = self._load()
            for rel in (_rel(p) for p in paths):
                entry = manifest.get(rel)
                if entry is None:
                    continue
                target = self._abs(rel)
                original = self._baseline(rel, entry)
                if original is None:
                    if target.is_dir():
                        shutil.rmtree(target)
                    else:
                        target.unlink(missing_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(original)
                if entry.get("baseline"):
                    (self.baselines / entry["baseline"]).unlink(missing_ok=True)
                manifest.pop(rel)
                done.append(rel)
            self._save(manifest)
        return done


def make_tracked_backend(project_root: str, tracker: ChangeTracker, **kwargs: Any):
    """`LocalShellBackend` that tells the tracker before and after it writes."""
    from deepagents.backends import LocalShellBackend
    from langgraph.config import get_stream_writer

    def emit(change: FileChange | None) -> None:
        if change is None:
            return
        try:
            get_stream_writer()({"type": "file.changed", **change.model_dump()})
        except Exception:  # noqa: BLE001 - outside a graph run there is no writer
            pass

    class TrackedLocalShellBackend(LocalShellBackend):
        def write(self, file_path, content):
            tracker.before_write(file_path)
            result = super().write(file_path, content)
            if not result.error:
                emit(tracker.after_write(file_path))
            return result

        def edit(self, file_path, old_string, new_string, replace_all=False):
            tracker.before_write(file_path)
            result = super().edit(file_path, old_string, new_string, replace_all)
            if not result.error:
                emit(tracker.after_write(file_path))
            return result

        def delete(self, file_path):
            tracker.before_write(file_path)
            result = super().delete(file_path)
            if not getattr(result, "error", None):
                emit(tracker.after_write(file_path))
            return result

        def execute(self, command, *, timeout=None):
            result = super().execute(command, timeout=timeout)
            for change in tracker.sync_git():
                emit(change)
            return result

    return TrackedLocalShellBackend(project_root, **kwargs)
