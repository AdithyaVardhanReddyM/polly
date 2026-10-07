"""Code sandboxes on NVIDIA OpenShell: one per session, behind a network policy
the user controls.

With `POLLY_SANDBOX=openshell`, each conversation's code runs in an OpenShell
sandbox named `polly-<session id>` on the gateway the `openshell` CLI has
active (or `POLLY_OPENSHELL_GATEWAY`). Unlike ConTree's fresh microVM per
command, the sandbox is a machine that stays up: files and installed packages
are there until the conversation is deleted.

Its network is closed except for Python reaching PyPI. When a command is
blocked, OpenShell drafts the rule that would have let it through and checks it
with its prover. Polly turns those drafts into an approval card: the agent
pauses, the user sees where it wanted to go, which program asked and what the
prover found, and approves or rejects. An approved rule goes live in the running
sandbox and the command runs again; a rejection goes back to the agent.

Only the lead agent of a conversation pauses. A teammate, or a subagent inside
a tool, is told what was blocked instead; the drafts wait in OpenShell for the
user (`openshell rule get polly-<id>`).
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import logging
import os
import shlex
import threading
import time
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

from polly_server.config import settings
from polly_server.sandbox import MAX_OUTPUT_BYTES, PACKAGES
from polly_server.sessions import session_dir

log = logging.getLogger(__name__)

WORKSPACE = "default"
WORK_DIR = "/sandbox"
# Files the agent wants the user to see; the app fetches them from here.
OUTPUT_DIR = "/sandbox/outputs"

# Python reaches PyPI; nothing else reaches anything until the user allows it.
# OpenShell matches the real path of the program that connects.
PYTHON = ("/usr/local/bin/python3*", "/usr/bin/python3*")
PYPI = ("pypi.org", "files.pythonhosted.org")
SETUP = (
    "python3 -m pip install -q --user --no-cache-dir --disable-pip-version-check "
    f"{PACKAGES} && mkdir -p {OUTPUT_DIR}"
)
ENV = {"HOME": WORK_DIR}

START_TIMEOUT = 300
SETUP_TIMEOUT = 900
COMMAND_TIMEOUT = 300
MAX_OUTPUT_CHARS = 100_000
# How long OpenShell gets to draft a rule for a blocked connection, and to load
# an approved one.
DRAFT_WAIT = 10.0
POLICY_WAIT = 15.0
# The gateway's clock and ours may differ a little.
CLOCK_SLACK = 2.0

TOOL = "network_access"


def configured() -> bool:
    """The SDK is installed and a gateway is registered for it."""
    if importlib.util.find_spec("openshell") is None:
        return False
    home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "openshell"
    name = settings.openshell_gateway or os.environ.get("OPENSHELL_GATEWAY", "")
    if not name:
        try:
            name = (home / "active_gateway").read_text().strip()
        except OSError:
            return False
    return bool(name) and (home / "gateways" / name / "metadata.json").is_file()


_client: Any = None
_client_lock = threading.Lock()


def _connect() -> Any:
    global _client
    with _client_lock:
        if _client is None:
            from openshell import SandboxClient

            _client = SandboxClient.from_active_cluster(
                cluster=settings.openshell_gateway or None, timeout=60
            )
        return _client


def _pb() -> tuple[Any, Any, Any]:
    from openshell._proto import datamodel_pb2, openshell_pb2, sandbox_pb2

    return openshell_pb2, sandbox_pb2, datamodel_pb2


def _scope() -> Any:
    return _pb()[2].WorkspaceSelector(workspace=WORKSPACE)


def base_policy() -> Any:
    """The policy every sandbox starts with: its own folder, the system read
    only, and PyPI for Python."""
    _, sb, _ = _pb()
    pypi = sb.NetworkPolicyRule(
        name="pypi",
        endpoints=[
            sb.NetworkEndpoint(
                host=host,
                port=443,
                protocol="rest",
                enforcement=sb.NETWORK_ENFORCEMENT_MODE_ENFORCE,
                access=sb.NETWORK_ACCESS_PRESET_READ_ONLY,
            )
            for host in PYPI
        ],
        binaries=[sb.NetworkBinary(path=path) for path in PYTHON],
    )
    return sb.SandboxPolicy(
        version=1,
        filesystem=sb.FilesystemPolicy(
            include_workdir=True,
            read_only=["/usr", "/lib", "/bin", "/etc", "/proc", "/dev/urandom", "/var/log"],
            read_write=["/tmp", "/dev/null"],
        ),
        landlock=sb.LandlockPolicy(compatibility="best_effort"),
        network_policies={"pypi": pypi},
    )


def _enum_label(message: Any, field: str, prefix: str) -> str:
    value = getattr(message, field)
    enum = message.DESCRIPTOR.fields_by_name[field].enum_type
    found = enum.values_by_number.get(value)
    name = found.name.removeprefix(prefix) if found else ""
    return "" if name in ("", "UNSPECIFIED") else name.lower().replace("_", "-")


def _seconds(stamp: Any) -> float:
    return stamp.seconds + stamp.nanos / 1e9 if stamp is not None else 0.0


def _request(chunk: Any, command: str) -> dict[str, Any]:
    """One approval request for a drafted rule, in the shape of a Deep Agents
    HITL action request."""
    rule = chunk.proposed_rule
    endpoints = []
    for e in rule.endpoints:
        endpoints.append(
            {
                "host": e.host,
                "port": e.port,
                "access": _enum_label(e, "access", "NETWORK_ACCESS_PRESET_"),
                "rules": [f"{r.allow.method} {r.allow.path}".strip() for r in e.rules],
            }
        )
    where = ", ".join(f"{e['host']}:{e['port']}" for e in endpoints) or chunk.rule_name
    binary = chunk.binary or ", ".join(b.path for b in rule.binaries)
    return {
        "name": TOOL,
        "args": {
            "command": command,
            "chunk_id": chunk.id,
            "rule_name": chunk.rule_name or rule.name,
            "endpoints": endpoints,
            "binary": binary,
            "rationale": chunk.rationale,
            "security_notes": chunk.security_notes,
            "validation": chunk.validation_result,
            "confidence": round(float(chunk.confidence), 2),
            "hits": int(chunk.hit_count),
        },
        "description": f"Let {binary or 'the sandbox'} connect to {where}",
    }


def _where(requests: list[dict[str, Any]]) -> str:
    return (
        ", ".join(f"{e['host']}:{e['port']}" for r in requests for e in r["args"]["endpoints"])
        or "the network"
    )


def _lead_task(session_id: str) -> str | None:
    """The checkpoint namespace of the lead agent's own tool call, or None when
    this is a teammate, a subagent, or no graph at all: only the lead can pause
    for the user."""
    try:
        from langgraph.config import get_config

        configurable = get_config().get("configurable") or {}
    except RuntimeError:
        return None
    if configurable.get("thread_id") != session_id:
        return None
    namespace = str(configurable.get("checkpoint_ns") or "")
    return None if "|" in namespace else namespace


def _response(output: str, exit_code: int | None) -> ExecuteResponse:
    truncated = len(output) > MAX_OUTPUT_CHARS
    if truncated:
        output = output[:MAX_OUTPUT_CHARS] + "\n… (output truncated)"
    return ExecuteResponse(output=output, exit_code=exit_code, truncated=truncated)


def _with_note(response: ExecuteResponse, note: str) -> ExecuteResponse:
    return ExecuteResponse(
        output=f"{response.output}\n\n[{note}]".lstrip(),
        exit_code=response.exit_code,
        truncated=response.truncated,
    )


class OpenShellSandbox(BaseSandbox):
    """One session's OpenShell sandbox, created on first use."""

    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self._lock = threading.Lock()
        self._ready_once = False

    @property
    def id(self) -> str:
        return f"polly-{self._session_id}"

    # ---------- state ----------

    def _state_file(self) -> Path:
        return session_dir(self._session_id) / "openshell.json"

    def _state(self) -> dict[str, Any]:
        try:
            return json.loads(self._state_file().read_text())
        except (OSError, ValueError):
            return {}

    def _save(self, **changes: Any) -> None:
        state = {**self._state(), **changes}
        self._state_file().write_text(json.dumps({k: v for k, v in state.items() if v}))

    def saved_version(self) -> str | None:
        """The sandbox's name once it has been set up; `read_output` asks."""
        return self._state().get("name")

    # ---------- the sandbox ----------

    def _ready(self) -> Any:
        """The client, once this session's sandbox is up and set up."""
        client = _connect()
        with self._lock:
            if self._ready_once:
                return client
            import grpc
            from openshell import GatewayError

            o, _, _ = _pb()
            fresh = False
            try:
                ref = client.get(self.id, workspace=WORKSPACE)
            except GatewayError as exc:
                if exc.code() != grpc.StatusCode.NOT_FOUND:
                    raise
                ref = None
            if ref is not None and ref.status.phase == o.SANDBOX_PHASE_ERROR:
                log.warning("sandbox %s failed; starting a new one", self.id)
                client.delete(self.id, workspace=WORKSPACE, allow_missing=True)
                ref = None
            if ref is None:
                spec = o.SandboxSpec(
                    template=o.SandboxTemplate(image=settings.openshell_image),
                    policy=base_policy(),
                )
                client.create(
                    workspace=WORKSPACE,
                    spec=spec,
                    name=self.id,
                    labels={"app": "polly", "session": self._session_id},
                )
                self._save(name=None, setup=None)
                fresh = True
            elif ref.status.phase == o.SANDBOX_PHASE_STOPPED:
                client.start(self.id, workspace=WORKSPACE)
            client.wait_ready(self.id, workspace=WORKSPACE, timeout_seconds=START_TIMEOUT)
            if fresh or not self._state().get("setup"):
                log.info("setting up sandbox %s", self.id)
                done = self._exec(client, ["bash", "-lc", SETUP], timeout=SETUP_TIMEOUT)
                if done.exit_code != 0:
                    raise RuntimeError(
                        f"could not set up the sandbox: {(done.stderr or done.stdout)[-2000:]}"
                    )
            self._save(name=self.id, setup=True)
            self._ready_once = True
            return client

    def _exec(
        self, client: Any, argv: list[str], *, timeout: int, stdin: bytes | None = None
    ) -> Any:
        return client.exec(
            self.id,
            argv,
            workspace=WORKSPACE,
            workdir=WORK_DIR,
            env=ENV,
            stdin=stdin,
            timeout_seconds=timeout,
        )

    def _run(self, command: str, timeout: int | None) -> ExecuteResponse:
        try:
            client = self._ready()
            done = self._exec(client, ["bash", "-c", command], timeout=timeout or COMMAND_TIMEOUT)
        except Exception as exc:  # noqa: BLE001 - the agent should read why, not crash
            log.exception("sandbox %s could not run a command", self.id)
            return ExecuteResponse(output=f"The sandbox is unavailable: {exc}", exit_code=1)
        output = done.stdout
        if done.stderr:
            output = f"{output}\n{done.stderr}" if output else done.stderr
        return _response(output, done.exit_code)

    # ---------- what the network policy blocked ----------

    def _denials(self, since: float) -> list[str]:
        from google.protobuf.timestamp_pb2 import Timestamp

        o, _, _ = _pb()
        stamp = Timestamp()
        stamp.FromNanoseconds(int(max(since - CLOCK_SLACK, 0) * 1e9))
        logs = _connect()._stub.GetSandboxLogs(
            o.GetSandboxLogsRequest(
                workspace_scope=_scope(), sandbox=self.id, lines=500, since_time=stamp
            ),
            timeout=15,
        )
        return [line.message for line in logs.logs if "DENIED" in line.message.upper()]

    def _drafts(self, since: float) -> list[Any]:
        o, _, _ = _pb()
        drafts = _connect()._stub.GetDraftPolicy(
            o.GetDraftPolicyRequest(
                workspace_scope=_scope(), sandbox=self.id, status_filter="pending"
            ),
            timeout=15,
        )
        return [
            c
            for c in drafts.chunks
            if not c.HasField("last_seen_time") or _seconds(c.last_seen_time) >= since - CLOCK_SLACK
        ]

    def _blocked(self, since: float) -> tuple[list[str], list[Any]]:
        """What the policy denied since `since`, and the rules OpenShell drafted
        for it; drafting takes a moment, so wait for it when something was denied."""
        try:
            denials = self._denials(since)
            drafts = self._drafts(since)
            deadline = time.monotonic() + DRAFT_WAIT
            while denials and not drafts and time.monotonic() < deadline:
                time.sleep(0.5)
                drafts = self._drafts(since)
        except Exception:  # noqa: BLE001 - the command ran; this is only advice
            log.exception("could not read the policy log of %s", self.id)
            return [], []
        return denials, drafts

    def _approve(self, chunk_id: str, token: str) -> str | None:
        """Approve a drafted rule and wait for the sandbox to load it; an error
        message when that fails."""
        o, _, _ = _pb()
        stub = _connect()._stub
        try:
            approved = stub.ApproveDraftChunk(
                o.ApproveDraftChunkRequest(
                    workspace_scope=_scope(),
                    sandbox=self.id,
                    chunk_id=chunk_id,
                    review_token=token,
                ),
                timeout=30,
            )
            deadline = time.monotonic() + POLICY_WAIT
            while time.monotonic() < deadline:
                status = stub.GetSandboxPolicyStatus(
                    o.GetSandboxPolicyStatusRequest(
                        workspace_scope=_scope(),
                        sandbox=self.id,
                        version=approved.policy_version,
                    ),
                    timeout=15,
                )
                if status.revision.status == o.POLICY_STATUS_FAILED:
                    return status.revision.load_error or "the sandbox could not load the rule"
                if (
                    status.revision.status in (o.POLICY_STATUS_LOADED, o.POLICY_STATUS_SUPERSEDED)
                    or status.active_version >= approved.policy_version
                ):
                    return None
                time.sleep(0.5)
            return None  # approved; it will load shortly
        except Exception as exc:  # noqa: BLE001 - reported to the agent
            log.exception("could not approve rule %s for %s", chunk_id, self.id)
            return str(exc)

    def _reject(self, chunk_id: str, reason: str) -> None:
        o, _, _ = _pb()
        try:
            _connect()._stub.RejectDraftChunk(
                o.RejectDraftChunkRequest(
                    workspace_scope=_scope(), sandbox=self.id, chunk_id=chunk_id, reason=reason
                ),
                timeout=30,
            )
        except Exception:  # noqa: BLE001 - the user said no either way
            log.exception("could not reject rule %s for %s", chunk_id, self.id)

    # ---------- the backend protocol ----------

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        # The file tools come through here; they never touch the network.
        return self._run(command, timeout)

    async def aexecute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        """Run the agent's command. When the network policy blocks it, the lead
        agent pauses for the user's decision; anyone else is told in the output."""
        task = _lead_task(self._session_id)
        held = self._state().get("held")
        mine = held and (held.get("task"), held.get("command")) == (task, command)
        if mine and task is not None:
            # Resuming after the user's decision: the tool call runs again from
            # the top, and `interrupt` now returns what they decided.
            return await self._settle(held, timeout)
        if held:
            self._save(held=None)  # a decision that never came

        since = time.time()
        result = await asyncio.to_thread(self._run, command, timeout)
        denials, drafts = await asyncio.to_thread(self._blocked, since)
        if not denials and not drafts:
            return result
        requests = [_request(c, command) for c in drafts]
        if task is None or not requests:
            return _with_note(result, self._blocked_note(denials, requests))

        held = {
            "task": task,
            "command": command,
            "output": result.output,
            "exit_code": result.exit_code,
            "chunks": [{"id": c.id, "token": c.review_token} for c in drafts],
            "requests": requests,
        }
        self._save(held=held)
        return await self._settle(held, timeout)

    async def _settle(self, held: dict[str, Any], timeout: int | None) -> ExecuteResponse:
        from langgraph.types import interrupt

        requests = held["requests"]
        answer = interrupt(
            {
                "action_requests": requests,
                "review_configs": [
                    {"action_name": TOOL, "allowed_decisions": ["approve", "reject"]}
                    for _ in requests
                ],
            }
        )
        self._save(held=None)
        decisions = answer.get("decisions") if isinstance(answer, dict) else None
        decisions = decisions or []
        approved, failed, refused = [], [], []
        reason = ""
        for i, chunk in enumerate(held["chunks"]):
            decision = decisions[i] if i < len(decisions) else {}
            where = _where([requests[i]])
            if decision.get("type") == "approve":
                error = await asyncio.to_thread(self._approve, chunk["id"], chunk["token"])
                if error:
                    failed.append(f"{where} ({error})")
                else:
                    approved.append(where)
            else:
                reason = reason or str(decision.get("message") or "")
                await asyncio.to_thread(self._reject, chunk["id"], reason or "declined in Polly")
                refused.append(where)

        notes = []
        if refused:
            notes.append(
                f"The user did not allow network access to {', '.join(refused)}"
                + (f": {reason}" if reason else ".")
                + " Do not try to reach it another way; work without it or ask the user."
            )
        if failed:
            notes.append(f"Allowing {', '.join(failed)} failed.")
        if approved:
            rerun = await asyncio.to_thread(self._run, held["command"], timeout)
            notes.insert(
                0,
                f"The user allowed network access to {', '.join(approved)}; "
                "the command was run again.",
            )
            return _with_note(rerun, " ".join(notes))
        original = _response(held["output"], held.get("exit_code"))
        return _with_note(original, " ".join(notes))

    def _blocked_note(self, denials: list[str], requests: list[dict[str, Any]]) -> str:
        if requests:
            return (
                f"The sandbox's network policy blocked {_where(requests)}. "
                "It stays blocked unless the user allows it; tell them what you need and why."
            )
        shown = "; ".join(denials[:3])
        return f"The sandbox's network policy blocked a connection: {shown}"

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        out = []
        for path, content in files:
            if not path.startswith("/"):
                out.append(FileUploadResponse(path=path, error="invalid_path"))
                continue
            quoted = shlex.quote(path)
            write = f'mkdir -p "$(dirname {quoted})" && cat > {quoted}'
            try:
                done = self._exec(self._ready(), ["bash", "-c", write], timeout=120, stdin=content)
            except Exception:  # noqa: BLE001 - reported per file
                log.exception("could not upload %s to %s", path, self.id)
                out.append(FileUploadResponse(path=path, error="permission_denied"))
                continue
            error = None
            if done.exit_code != 0:
                error = "is_directory" if "Is a directory" in done.stderr else "permission_denied"
            out.append(FileUploadResponse(path=path, error=error))
        return out

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        out = []
        for path in paths:
            if not path.startswith("/"):
                out.append(FileDownloadResponse(path=path, error="invalid_path"))
                continue
            quoted = shlex.quote(path)
            read = (
                f"if [ -d {quoted} ]; then echo is_directory >&2; exit 3; fi; "
                f"if [ ! -e {quoted} ]; then echo file_not_found >&2; exit 2; fi; "
                f"if [ $(stat -c %s {quoted}) -gt {MAX_OUTPUT_BYTES} ]; then exit 4; fi; "
                f"base64 -w0 {quoted}"
            )
            try:
                done = self._exec(self._ready(), ["bash", "-c", read], timeout=120)
            except Exception:  # noqa: BLE001 - reported per file
                log.exception("could not download %s from %s", path, self.id)
                out.append(FileDownloadResponse(path=path, error="permission_denied"))
                continue
            if done.exit_code == 0:
                content = base64.b64decode(done.stdout.strip())
                out.append(FileDownloadResponse(path=path, content=content))
            else:
                error = {2: "file_not_found", 3: "is_directory"}.get(
                    done.exit_code, "permission_denied"
                )
                out.append(FileDownloadResponse(path=path, error=error))
        return out

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return await asyncio.to_thread(self.upload_files, files)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return await asyncio.to_thread(self.download_files, paths)

    def discard(self) -> None:
        """Delete the sandbox; its conversation is gone."""
        if not self.saved_version():
            return
        try:
            _connect().delete(self.id, workspace=WORKSPACE, allow_missing=True)
        except Exception:  # noqa: BLE001 - the gateway may be down; nothing else to do
            log.exception("could not delete sandbox %s", self.id)
