import pytest

from polly_server.coder import permissions
from polly_server.coder.permissions import Policy, Rule

EDIT = ("edit_file", {"file_path": "/src/app.py", "old_string": "a", "new_string": "b"})
WRITE = ("write_file", {"file_path": "/src/new.py", "content": "x"})
DELETE = ("delete", {"file_path": "/src/old.py"})
RUN = ("execute", {"command": "npm test"})
READ = ("read_file", {"file_path": "/src/app.py"})


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("supervised", ["ask", "ask", "ask", "ask", "allow"]),
        ("trusted", ["allow", "allow", "ask", "ask", "allow"]),
        ("autonomous", ["allow", "allow", "allow", "allow", "allow"]),
        ("plan", ["deny", "deny", "deny", "deny", "allow"]),
    ],
)
def test_mode_matrix(mode, expected):
    policy = Policy(mode=mode)
    calls = [EDIT, WRITE, DELETE, RUN, READ]
    assert [policy.decide(n, a) for n, a in calls] == expected


def test_denylist_wins_everywhere():
    for mode in permissions.MODES if hasattr(permissions, "MODES") else ("autonomous",):
        policy = Policy(mode=mode, deny_cmds=("rm -rf /", "sudo "))
        assert policy.decide("execute", {"command": "sudo rm -rf /"}) == "deny"
        assert policy.decide("execute", {"command": "echo hi && sudo reboot"}) == "deny"


def test_rules_and_allowlist_skip_the_question():
    policy = Policy(
        mode="supervised",
        rules=(Rule(tool="edit_file", pattern="src/**"),),
        allow_cmds=("npm test",),
    )
    assert policy.decide(*EDIT) == "allow"
    assert policy.decide("edit_file", {"file_path": "/docs/x.md"}) == "ask"
    assert policy.decide("execute", {"command": "npm test -- --watch"}) == "allow"
    assert policy.decide("execute", {"command": "npm run build"}) == "ask"


def test_private_paths_are_never_gated():
    policy = Policy(mode="plan")
    assert policy.decide("edit_file", {"file_path": "/memories/MEMORY.md"}) == "allow"


def test_init_policy_only_writes_polly_md():
    policy = permissions.init_policy()
    assert policy.decide("write_file", {"file_path": "/POLLY.md", "content": ""}) == "allow"
    assert policy.decide("write_file", {"file_path": "/README.md", "content": ""}) == "deny"
    assert policy.decide("execute", {"command": "ls"}) == "deny"


def test_rules_round_trip(project):
    assert permissions.load_rules(project) == []
    rules = permissions.add_rule(project, Rule(tool="execute", pattern="pytest"))
    assert rules == [Rule(tool="execute", pattern="pytest")]
    permissions.add_rule(project, Rule(tool="execute", pattern="pytest"))  # no duplicate
    assert len(permissions.load_rules(project)) == 1
    assert permissions.remove_rule(project, 0) == []


def test_plan_mode_hides_write_tools():
    from langchain.agents.middleware.types import ModelRequest

    class Tool:
        def __init__(self, name):
            self.name = name

    class Runtime:
        context = {"policy": Policy(mode="plan")}

    request = ModelRequest(
        model=None,
        system_message=None,
        messages=[],
        tool_choice=None,
        tools=[Tool("read_file"), Tool("edit_file"), Tool("execute")],
        response_format=None,
        state={},
        runtime=Runtime(),
    )
    seen = {}
    permissions.PermissionMiddleware().wrap_model_call(request, lambda r: seen.update(req=r))
    assert [t.name for t in seen["req"].tools] == ["read_file"]
    assert "Plan mode" in seen["req"].system_message.text


def test_commands_reaching_outside_the_project_always_ask():
    root = "/Users/me/code/app"
    for mode in ("trusted", "autonomous"):
        policy = Policy(mode=mode, root=root, allow_cmds=("touch",))
        assert policy.decide("execute", {"command": "touch /src/__init__.py"}) == "ask"
        assert policy.decide("execute", {"command": "cat ~/.ssh/id_rsa > /tmp/x"}) == "ask"
        assert policy.decide("execute", {"command": "ls $HOME/Documents"}) == "ask"
        assert policy.decide("execute", {"command": "rm -r /Users/me/other"}) == "ask"
    autonomous = Policy(mode="autonomous", root=root)
    assert autonomous.decide("execute", {"command": f"pytest {root}/tests -q"}) == "allow"
    assert autonomous.decide("execute", {"command": "python -m pytest 2>/dev/null"}) == "allow"
    assert autonomous.decide("execute", {"command": "/usr/bin/env python3 -V"}) == "allow"
    assert autonomous.decide("execute", {"command": "ls src/ && cat src/a.py"}) == "allow"


def test_outside_paths_parsing():
    root = "/p"
    assert permissions.outside_paths("echo hi > /etc/hosts", root) == ["/etc/hosts"]
    assert permissions.outside_paths("cd /p && make", root) == []
    assert permissions.outside_paths("FOO=/opt/x make", root) == []
    assert permissions.outside_paths("grep -r 'a/b' src", root) == []
