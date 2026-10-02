from pathlib import Path

import pytest

from polly_server import projects


def test_add_is_idempotent(tmp_path):
    a = projects.add(str(tmp_path))
    b = projects.add(str(tmp_path))
    assert a.id == b.id == projects.project_id_for(tmp_path.resolve())
    assert projects.get(a.id) is not None
    assert projects.remove(a.id)
    assert projects.get(a.id) is None


@pytest.mark.parametrize("bad", ["relative/path", "/definitely/not/here", "/", str(Path.home())])
def test_refuses_bad_folders(bad):
    with pytest.raises(projects.ProjectError):
        projects.validate_folder(bad)


def test_tree_hides_noise_and_read_file(project):
    root = project.root
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()
    nodes = projects.tree(project, depth=2)
    names = [n.name for n in nodes]
    assert names == ["src", "README.md"]
    assert nodes[0].children and nodes[0].children[0].path == "src/app.py"
    assert projects.read_file(project, "src/app.py").content.startswith("print")
    with pytest.raises(projects.ProjectError):
        projects.read_file(project, "../outside")


def test_settings_update(project):
    updated = projects.update(project.id, default_mode="trusted", command_allowlist=["npm test"])
    assert updated.settings.default_mode == "trusted"
    assert projects.get(project.id).settings.command_allowlist == ["npm test"]
