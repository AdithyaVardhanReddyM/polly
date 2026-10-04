"""Code sandboxes on Nebius ConTree: one per session, for agents that run code.

ConTree runs every command in a fresh microVM over a versioned filesystem;
what a command leaves on disk becomes the next version. A session's sandbox
is therefore just the id of its latest version, kept in
`<session_dir>/sandbox.json`, so a conversation picks its files up again
after a restart. Nothing is started until the agent first uses it.

`SessionSandbox` is a Deep Agents backend: given to `create_deep_agent`, the
agent's `execute` and file tools work inside the sandbox.

Sandboxes start from a Python image with the usual data libraries, built once
per Nebius project and found again by tag.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import mimetypes
import threading
from dataclasses import replace
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

from polly_server import variables
from polly_server.config import settings
from polly_server.sessions import session_dir

log = logging.getLogger(__name__)

BASE_IMAGE = "docker://docker.io/library/python:3.12-slim"
# Bump the number when PACKAGES changes: the image is rebuilt under the new tag.
IMAGE_TAG = "polly-python:1"
PACKAGES = "pandas numpy matplotlib seaborn scipy openpyxl requests"
SETUP = f"pip install -q --no-cache-dir {PACKAGES} && mkdir -p {{work}} {{out}}"

WORK_DIR = "/workspace"
# Files the agent wants the user to see; the app fetches them from here.
OUTPUT_DIR = "/outputs"
MAX_OUTPUT_BYTES = 25 * 1024 * 1024

PROMPT = f"""\
## Your sandbox

You have a private Linux sandbox with Python 3.12 and {PACKAGES.replace(" ", ", ")} \
installed; `pip install` works for anything else. `execute` runs a shell command in it and \
the file tools read and write its files. Files stay between your turns in this \
conversation, but no process outlives its command.

- Work in {WORK_DIR}. Write a script to a file and run it rather than a long one-liner.
- Compute, don't guess: if a number, a table or a chart can come from running code, run it.
- Save what the user should see (charts as PNG, CSVs, reports) under {OUTPUT_DIR}/ and \
show it in your reply with markdown: `![Monthly revenue]({OUTPUT_DIR}/revenue.png)` for an \
image, `[results.csv]({OUTPUT_DIR}/results.csv)` for any other file. Give each new chart \
a new file name.
- If a command fails, read the error, fix the cause and run it again."""


def available() -> bool:
    return settings.sandbox_configured and importlib.util.find_spec("contree_sdk") is not None


def _on_sdk_loop(coro) -> Any:
    """Run `coro` on the ConTree SDK's own event loop and wait for it. The
    client and everything made from it stay on that one loop, whichever
    thread or loop the agent calls from."""
    from contree_sdk._internals.utils.wrapper import coro_sync

    return coro_sync(coro)


_client: Any = None
_base_lock: asyncio.Lock | None = None


def _contree() -> Any:
    global _client
    if _client is None:
        from contree_sdk import Contree
        from contree_sdk.auth import IAMAuth
        from contree_sdk.config import ContreeConfig

        auth = IAMAuth(token=settings.nebius_api_key, project_id=settings.nebius_project_id)
        _client = Contree(ContreeConfig(auth=auth))
    return _client


async def _base_image() -> Any:
    """The Python image sandboxes start from; built on first use."""
    global _base_lock
    from contree_sdk.sdk.exceptions import NotFoundError

    _base_lock = _base_lock or asyncio.Lock()
    async with _base_lock:
        client = _contree()
        try:
            return await client.images.use(IMAGE_TAG, strict=True)
        except NotFoundError:
            pass
        log.info("building the sandbox image %s", IMAGE_TAG)
        image = await client.images.oci(BASE_IMAGE)
        built = await image.run(
            shell=SETUP.format(work=WORK_DIR, out=OUTPUT_DIR),
            disposable=False,
            tag=IMAGE_TAG,
            timeout=600,
        )
        if built.exit_code != 0:
            raise RuntimeError(f"could not build the sandbox image: {built.stderr or built.stdout}")
        return built


class SessionSandbox(BaseSandbox):
    """One session's ConTree sandbox, started on first use."""

    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self._inner: Any = None
        self._session: Any = None
        self._starting: asyncio.Lock | None = None

    @property
    def id(self) -> str:
        return f"polly-{self._session_id}"

    # ---------- state ----------

    def _state_file(self):
        return session_dir(self._session_id) / "sandbox.json"

    def saved_version(self) -> str | None:
        try:
            return json.loads(self._state_file().read_text()).get("image") or None
        except (OSError, ValueError):
            return None

    def _save_version(self) -> None:
        version = getattr(self._session, "uuid", None)
        if version:
            self._state_file().write_text(json.dumps({"image": str(version)}))

    async def _ready(self) -> Any:
        from contree_sdk.langchain.sandbox import ContreeSandbox

        self._starting = self._starting or asyncio.Lock()
        async with self._starting:
            if self._inner is None:
                saved = self.saved_version()
                if saved:
                    image = await _contree().images.use(UUID(saved))
                else:
                    image = await _base_image()
                self._session = image.session()
                self._inner = ContreeSandbox(self._session)
        return self._inner

    # ---------- the backend protocol ----------

    async def _execute(self, command: str, timeout: int | None) -> ExecuteResponse:
        inner = await self._ready()
        found = self._variables()
        result = await inner.aexecute(variables.env_exports(found) + command, timeout=timeout)
        self._save_version()
        if found:
            result = replace(result, output=variables.redact(result.output or "", found))
        return result

    def _variables(self) -> list[variables.Variable]:
        """The variables the agents in this session may use (`variables.py`):
        the session's lead and its teammates share one sandbox."""
        from polly_server import sessions
        from polly_server.agents import team

        session = sessions.get(self._session_id)
        if session is None:
            return []
        ids = [session.agent_id, *(m.id for m in team.roster(session))]
        return variables.usable(ids)

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        return _on_sdk_loop(self._execute(command, timeout))

    async def aexecute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        return await asyncio.to_thread(self.execute, command, timeout=timeout)

    async def _upload(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        inner = await self._ready()
        result = await inner.aupload_files(files)
        self._save_version()
        return result

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return _on_sdk_loop(self._upload(files))

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return await asyncio.to_thread(self.upload_files, files)

    async def _download(self, paths: list[str]) -> list[FileDownloadResponse]:
        inner = await self._ready()
        return await inner.adownload_files(paths)

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return _on_sdk_loop(self._download(paths))

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return await asyncio.to_thread(self.download_files, paths)


_sandboxes: dict[str, SessionSandbox] = {}
_registry_lock = threading.Lock()


def for_session(session_id: str) -> SessionSandbox:
    """The session's sandbox; the agent and the app's file requests share it."""
    with _registry_lock:
        if session_id not in _sandboxes:
            _sandboxes[session_id] = SessionSandbox(session_id)
        return _sandboxes[session_id]


def forget(session_id: str) -> None:
    with _registry_lock:
        _sandboxes.pop(session_id, None)


class NoSuchOutput(LookupError):
    pass


def output_path(raw: str) -> PurePosixPath:
    """`raw` as a path under the output folder, or `NoSuchOutput`."""
    path = PurePosixPath(raw if raw.startswith("/") else f"{OUTPUT_DIR}/{raw}")
    if ".." in path.parts or path.parts[:2] != ("/", OUTPUT_DIR.strip("/")) or len(path.parts) < 3:
        raise NoSuchOutput(raw)
    return path


async def read_output(session_id: str, raw: str) -> tuple[bytes, str]:
    """A file the agent saved for the user, and its media type. The last copy
    fetched is kept beside the session, so it still shows when ConTree cannot
    be reached."""
    path = output_path(raw)
    kept = session_dir(session_id) / "outputs" / "/".join(path.parts[2:])
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    box = for_session(session_id)
    if available() and box.saved_version():
        try:
            (found,) = await box.adownload_files([str(path)])
        except Exception:  # noqa: BLE001 - fall back to the copy we kept
            log.exception("could not read %s from the sandbox", path)
        else:
            if found.content is not None and len(found.content) <= MAX_OUTPUT_BYTES:
                kept.parent.mkdir(parents=True, exist_ok=True)
                kept.write_bytes(found.content)
                return found.content, media
    if kept.is_file():
        return kept.read_bytes(), media
    raise NoSuchOutput(raw)
