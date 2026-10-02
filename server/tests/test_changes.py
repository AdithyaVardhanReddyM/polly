import subprocess
import tempfile
from pathlib import Path

from polly_server.coder.changes import ChangeTracker, make_tracked_backend


def _backend(project, _tmp_path):
    # The tracker lives in the session dir, never inside the project.
    tracker = ChangeTracker(project.path, Path(tempfile.mkdtemp()) / "changes")
    return tracker, make_tracked_backend(project.path, tracker, virtual_mode=True)


def test_write_edit_delete_are_tracked_and_revertible(project, tmp_path):
    tracker, backend = _backend(project, tmp_path)
    root = project.root

    backend.write("/new.txt", "fresh\n")
    backend.edit("/src/app.py", "print('hi')", "print('hello')")
    backend.delete("/README.md")

    changes = {c.path: c for c in tracker.list()}
    assert changes["new.txt"].kind == "created"
    assert changes["src/app.py"].kind == "modified"
    assert (changes["src/app.py"].additions, changes["src/app.py"].deletions) == (1, 1)
    assert changes["README.md"].kind == "deleted"

    diff = tracker.diff("/src/app.py")
    assert diff.before == "print('hi')\n" and diff.after == "print('hello')\n"

    tracker.revert(["new.txt", "src/app.py", "README.md"])
    assert not (root / "new.txt").exists()
    assert (root / "src/app.py").read_text() == "print('hi')\n"
    assert (root / "README.md").read_text() == "# demo\n"
    assert tracker.list() == []


def test_accept_keeps_the_file_and_forgets_the_change(project, tmp_path):
    tracker, backend = _backend(project, tmp_path)
    backend.write("/a.txt", "a")
    assert [c.path for c in tracker.list()] == ["a.txt"]
    tracker.accept(["a.txt"])
    assert tracker.list() == []
    assert (project.root / "a.txt").read_text() == "a"


def test_undoing_by_hand_drops_the_change(project, tmp_path):
    tracker, backend = _backend(project, tmp_path)
    backend.edit("/src/app.py", "hi", "yo")
    backend.edit("/src/app.py", "yo", "hi")
    assert tracker.list() == []


def test_private_paths_are_not_tracked(project, tmp_path):
    tracker, _ = _backend(project, tmp_path)
    tracker.before_write("/memories/MEMORY.md")
    assert tracker.list() == []


def test_shell_changes_in_git_repos(project, tmp_path):
    root = project.root
    git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run([*git, "init", "-q"], cwd=root, check=True)
    subprocess.run([*git, "add", "-A"], cwd=root, check=True)
    subprocess.run([*git, "commit", "-qm", "init"], cwd=root, check=True)
    (root / "dirty.txt").write_text("user's work in progress")

    tracker, backend = _backend(project, tmp_path)
    backend.execute("echo changed >> src/app.py && echo new > made.txt")
    paths = {c.path: c for c in tracker.list()}
    assert set(paths) == {"src/app.py", "made.txt"}  # not the user's dirty.txt
    assert paths["src/app.py"].source == "shell"
    tracker.revert(["src/app.py", "made.txt"])
    assert (root / "src/app.py").read_text() == "print('hi')\n"
    assert not (root / "made.txt").exists()
