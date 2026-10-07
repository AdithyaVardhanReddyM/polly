"""OpenShell sandboxes: the sandbox's life, its files, and blocked connections
turned into approval cards. The gateway is a fake with OpenShell's own
messages."""

import asyncio
import shlex
import time
from types import SimpleNamespace

import grpc
import pytest
from langchain_core.messages import AIMessage
from openshell import ExecResult, GatewayError
from openshell._proto import openshell_pb2 as o
from openshell._proto import sandbox_pb2 as sb

from polly_server import openshell_sandbox, sandbox, sessions
from polly_server.agents import builders, custom
from polly_server.coder import permissions
from polly_server.coder.runs import RunManager
from polly_server.openshell_sandbox import OpenShellSandbox
from tests.conftest import scripted


class _NotFound(grpc.RpcError):
    def code(self):
        return grpc.StatusCode.NOT_FOUND

    def details(self):
        return "sandbox not found"

    def trailing_metadata(self):
        return ()


class FakeGateway:
    """One OpenShell gateway: `curl <host>` is denied until a rule for the
    host is approved, and each denial is drafted into a pending rule."""

    def __init__(self):
        self.phase = None
        self.specs = []
        self.commands = []
        self.files: dict[str, bytes] = {}
        self.allowed: set[str] = set()
        self.denials: list[str] = []
        self.chunks: list = []
        self.approved: list[tuple[str, str]] = []
        self.rejected: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self._stub = self

    # ---------- the SDK client ----------

    def get(self, name, *, workspace):
        if self.phase is None:
            raise GatewayError(_NotFound())
        return SimpleNamespace(name=name, status=SimpleNamespace(phase=self.phase))

    def create(self, *, workspace, spec, name, labels):
        self.specs.append(spec)
        self.phase = o.SANDBOX_PHASE_READY

    def start(self, name, *, workspace):
        self.phase = o.SANDBOX_PHASE_READY

    def wait_ready(self, name, *, workspace, timeout_seconds):
        assert self.phase == o.SANDBOX_PHASE_READY

    def delete(self, name, *, workspace, allow_missing=False):
        self.deleted.append(name)
        self.phase = None

    def exec(self, name, argv, *, workspace, workdir, env, stdin=None, timeout_seconds=None):
        assert workdir == "/sandbox" and env["HOME"] == "/sandbox"
        command = argv[-1]
        self.commands.append(command)
        if "cat > " in command:
            self.files[shlex.split(command.rsplit("cat > ", 1)[1])[0]] = stdin
            return ExecResult(0, "", "")
        if "base64 -w0" in command:
            path = shlex.split(command.rsplit("base64 -w0 ", 1)[1])[0]
            if path not in self.files:
                return ExecResult(2, "", "file_not_found")
            import base64

            return ExecResult(0, base64.b64encode(self.files[path]).decode(), "")
        if command.startswith("curl "):
            host = command.split()[1]
            if host in self.allowed:
                return ExecResult(0, f"hello from {host}", "")
            self.denials.append(f"NET:OPEN DENIED {host}:443 binary=/usr/bin/curl")
            if not any(c.proposed_rule.endpoints[0].host == host for c in self.chunks):
                self._draft(host)
            return ExecResult(7, "", f"curl: (7) Failed to connect to {host} port 443")
        return ExecResult(0, f"ran: {command}", "")

    def _draft(self, host):
        chunk = o.PolicyChunk(
            id=f"chunk-{len(self.chunks) + 1}",
            status="pending",
            rule_name=f"allow_{host.replace('.', '_')}_443",
            proposed_rule=sb.NetworkPolicyRule(
                name=f"allow_{host}",
                endpoints=[
                    sb.NetworkEndpoint(
                        host=host, port=443, access=sb.NETWORK_ACCESS_PRESET_READ_ONLY
                    )
                ],
                binaries=[sb.NetworkBinary(path="/usr/bin/curl")],
            ),
            rationale=f"curl tried to reach {host}:443",
            security_notes="No findings: the rule grants read-only access to one host.",
            validation_result="passed",
            confidence=0.9,
            hit_count=1,
            binary="/usr/bin/curl",
            review_token=f"token-{len(self.chunks) + 1}",
        )
        chunk.last_seen_time.FromSeconds(int(time.time()))
        self.chunks.append(chunk)

    # ---------- the raw gRPC stub ----------

    def GetSandboxLogs(self, request, timeout=None):
        assert request.sandbox.startswith("polly-")
        return o.GetSandboxLogsResponse(logs=[o.SandboxLogLine(message=m) for m in self.denials])

    def GetDraftPolicy(self, request, timeout=None):
        assert request.status_filter == "pending"
        return o.GetDraftPolicyResponse(chunks=[c for c in self.chunks if c.status == "pending"])

    def _chunk(self, chunk_id):
        return next(c for c in self.chunks if c.id == chunk_id)

    def ApproveDraftChunk(self, request, timeout=None):
        chunk = self._chunk(request.chunk_id)
        assert request.review_token == chunk.review_token
        chunk.status = "approved"
        self.allowed.add(chunk.proposed_rule.endpoints[0].host)
        self.approved.append((request.chunk_id, request.review_token))
        return o.ApproveDraftChunkResponse(policy_version=2, policy_hash="abc")

    def GetSandboxPolicyStatus(self, request, timeout=None):
        assert request.version == 2
        return o.GetSandboxPolicyStatusResponse(
            revision=o.SandboxPolicyRevision(version=2, status=o.POLICY_STATUS_LOADED),
            active_version=2,
        )

    def RejectDraftChunk(self, request, timeout=None):
        self._chunk(request.chunk_id).status = "rejected"
        self.rejected.append((request.chunk_id, request.reason))
        return o.RejectDraftChunkResponse()


@pytest.fixture
def gateway(configure, monkeypatch):
    configure(sandbox_provider="openshell", nebius_api_key="test-key")
    fake = FakeGateway()
    monkeypatch.setattr(openshell_sandbox, "_connect", lambda: fake)
    monkeypatch.setattr(openshell_sandbox, "configured", lambda: True)
    monkeypatch.setattr(openshell_sandbox, "DRAFT_WAIT", 0.2)
    sandbox._sandboxes.clear()
    yield fake
    sandbox._sandboxes.clear()
    for agent in custom.all_agents():
        custom.delete(agent.id)


def _box():
    session = sessions.create(None, model="fake", mode="plan", agent_id="researcher")
    return OpenShellSandbox(session.id)


def test_the_base_policy_lets_only_python_reach_pypi():
    policy = openshell_sandbox.base_policy()
    assert list(policy.network_policies) == ["pypi"]
    rule = policy.network_policies["pypi"]
    assert {e.host for e in rule.endpoints} == {"pypi.org", "files.pythonhosted.org"}
    assert all(
        e.port == 443
        and e.enforcement == sb.NETWORK_ENFORCEMENT_MODE_ENFORCE
        and e.access == sb.NETWORK_ACCESS_PRESET_READ_ONLY
        for e in rule.endpoints
    )
    assert [b.path for b in rule.binaries] == ["/usr/local/bin/python3*", "/usr/bin/python3*"]
    assert policy.filesystem.include_workdir and "/tmp" in policy.filesystem.read_write
    assert "/usr" in policy.filesystem.read_only


def test_the_sandbox_is_made_and_set_up_once(gateway):
    box = _box()
    assert box.saved_version() is None
    result = box.execute("echo hi")
    assert result.exit_code == 0 and result.output == "ran: echo hi"
    (spec,) = gateway.specs
    assert spec.template.image == "python:3.12-slim"
    assert list(spec.policy.network_policies) == ["pypi"]
    assert "pip install" in gateway.commands[0] and "/sandbox/outputs" in gateway.commands[0]
    assert box.saved_version() == box.id == f"polly-{box._session_id}"

    # After a restart the sandbox is found again, not made or set up again.
    again = OpenShellSandbox(box._session_id)
    again.execute("ls")
    assert len(gateway.specs) == 1 and gateway.commands[1:] == ["echo hi", "ls"]


def test_a_failed_sandbox_is_replaced(gateway):
    box = _box()
    box.execute("true")
    gateway.phase = o.SANDBOX_PHASE_ERROR
    OpenShellSandbox(box._session_id).execute("true")
    assert gateway.deleted == [box.id] and len(gateway.specs) == 2


def test_files_go_in_and_come_out(gateway):
    box = _box()
    (up,) = box.upload_files([("/sandbox/outputs/chart.png", b"\x89PNG\x00\xff")])
    assert up.error is None
    found, missing, relative = box.download_files(
        ["/sandbox/outputs/chart.png", "/sandbox/none.txt", "chart.png"]
    )
    assert found.content == b"\x89PNG\x00\xff" and found.error is None
    assert missing.error == "file_not_found" and relative.error == "invalid_path"


def test_outside_the_leads_turn_a_block_is_reported_not_asked(gateway):
    box = _box()
    result = asyncio.run(box.aexecute("curl api.github.com"))
    assert result.exit_code == 7
    assert "network policy blocked api.github.com:443" in result.output
    assert gateway.approved == [] and gateway.rejected == []


def test_a_sandbox_without_a_draft_still_says_what_was_blocked(gateway):
    box = _box()
    box.execute("true")
    gateway.denials.append("HTTP:POST DENIED example.com:443 /upload")
    result = asyncio.run(box.aexecute("python3 upload.py"))
    assert "blocked a connection: HTTP:POST DENIED example.com:443" in result.output


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _agent_session(monkeypatch, fake):
    made = custom.create(name="Fetcher", sandbox=True)
    real = builders.build_agent
    monkeypatch.setattr(
        builders,
        "build_agent",
        lambda session, **_: real(session, model=fake, use_cache=False),
    )
    return sessions.create(None, model="fake", mode="plan", agent_id=made.id)


def _tool_output(run):
    return next(e["output"] for e in reversed(run.events) if e["type"] == "tool.result")


@pytest.mark.usefixtures("memory_checkpointer")
@pytest.mark.parametrize("answer", ["approve", "reject"])
def test_a_blocked_connection_becomes_an_approval_card(gateway, monkeypatch, answer):
    fake = scripted(_call("execute", {"command": "curl api.github.com"}, "c1"), "Done.")
    session = _agent_session(monkeypatch, fake)

    async def go():
        manager = RunManager()
        first = await manager.start(None, session, "fetch it")
        await first.task
        decision = {"type": "approve"}
        if answer == "reject":
            decision = {"type": "reject", "message": "use the cached copy"}
        second = await manager.resume(None, sessions.get(session.id), [decision])
        await second.task
        return first, second

    first, second = asyncio.run(go())
    assert first.events[-1]["status"] == "awaiting_approval", first.events[-1]
    (card,) = [e for e in first.events if e["type"] == "approval.required"]
    (request,) = card["requests"]
    assert request["name"] == "network_access" and request["kind"] == "network"
    assert request["args"]["endpoints"] == [
        {"host": "api.github.com", "port": 443, "access": "read-only", "rules": []}
    ]
    assert request["args"]["binary"] == "/usr/bin/curl"
    assert request["args"]["validation"] == "passed"
    assert "read-only access to one host" in request["args"]["security_notes"]
    assert request["preview"]["command"] == "curl api.github.com"

    assert second.events[-1]["status"] == "completed", second.events[-1]
    curls = [c for c in gateway.commands if c.startswith("curl")]
    output = str(_tool_output(second))
    if answer == "approve":
        assert gateway.approved == [("chunk-1", "token-1")] and gateway.rejected == []
        assert curls == ["curl api.github.com"] * 2  # run again once allowed
        assert "hello from api.github.com" in output
        assert "The user allowed network access to api.github.com:443" in output
    else:
        assert gateway.rejected == [("chunk-1", "use the cached copy")]
        assert gateway.approved == [] and curls == ["curl api.github.com"]
        assert "did not allow network access to api.github.com:443: use the cached" in output
    assert "held" not in OpenShellSandbox(session.id)._state()


def test_outputs_and_prompt_follow_the_backend(gateway):
    assert str(sandbox.output_path("/sandbox/outputs/a.png")) == "/sandbox/outputs/a.png"
    assert str(sandbox.output_path("/outputs/a.png")) == "/sandbox/outputs/a.png"
    assert str(sandbox.output_path("a.png")) == "/sandbox/outputs/a.png"
    for bad in ("/sandbox/x.png", "/sandbox/outputs/../x", "/sandbox/outputs"):
        with pytest.raises(sandbox.NoSuchOutput):
            sandbox.output_path(bad)
    text = sandbox.prompt()
    assert "/sandbox/outputs/revenue.png" in text and "network is closed" in text
    assert isinstance(sandbox.for_session("abc"), OpenShellSandbox)


def test_a_deleted_conversation_deletes_its_sandbox(gateway, monkeypatch):
    monkeypatch.setattr(sandbox, "available", lambda: True)
    box = _box()
    box.execute("true")
    sandbox.forget(box._session_id)
    deadline = time.monotonic() + 2
    while not gateway.deleted and time.monotonic() < deadline:
        time.sleep(0.01)
    assert gateway.deleted == [box.id]


def test_network_requests_have_their_own_kind():
    assert permissions.kind_of("network_access") == "network"
