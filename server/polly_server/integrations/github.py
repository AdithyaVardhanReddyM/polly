"""GitHub: sign-in with the OAuth Device Flow, and the few API calls agents need.

The Device Flow suits a desktop app: no client secret and no redirect
server. The app shows a short code, the user enters it at
github.com/login/device, and the server polls until GitHub hands over a token.
A personal access token (pasted in the app or `GITHUB_TOKEN`) works too.

The token stays on this machine, in `<data_dir>/secrets/github.json` (mode
0600). It is never sent to the app.
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel

from polly_server.config import settings

API = "https://api.github.com"
WEB = "https://github.com"
SCOPES = "repo read:user"
TIMEOUT = 30.0

_transport: httpx.BaseTransport | None = None
_lock = threading.Lock()


class GitHubError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def use_transport(transport: httpx.BaseTransport | None) -> None:
    """Tests route every request through a mock transport."""
    global _transport
    _transport = transport


# ---------- the token ----------


class GitHubStatus(BaseModel):
    connected: bool
    login: str | None = None
    source: Literal["oauth", "pat", "env"] | None = None
    scopes: list[str] = []
    device_flow_available: bool


def _secret_file():
    return settings.data_path("secrets") / "github.json"


def _stored() -> dict[str, Any] | None:
    path = _secret_file()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("token") else None


def _store(data: dict[str, Any]) -> None:
    path = _secret_file()
    with _lock:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh)
        os.chmod(path, 0o600)


def token() -> str | None:
    stored = _stored()
    if stored:
        return str(stored["token"])
    return settings.github_token or None


def status() -> GitHubStatus:
    stored = _stored()
    available = bool(settings.github_client_id)
    if stored:
        return GitHubStatus(
            connected=True,
            login=stored.get("login"),
            source=stored.get("source") or "oauth",
            scopes=list(stored.get("scopes") or []),
            device_flow_available=available,
        )
    if settings.github_token:
        return GitHubStatus(connected=True, source="env", device_flow_available=available)
    return GitHubStatus(connected=False, device_flow_available=available)


def disconnect() -> None:
    with _lock:
        _secret_file().unlink(missing_ok=True)


def _save_token(value: str, source: Literal["oauth", "pat"]) -> GitHubStatus:
    """Check a token against GitHub, then keep it."""
    response = _request("GET", "/user", token_override=value)
    login = response.json().get("login")
    scopes = [s.strip() for s in response.headers.get("x-oauth-scopes", "").split(",") if s.strip()]
    _store(
        {
            "token": value,
            "login": login,
            "source": source,
            "scopes": scopes,
            "connected_at": time.time(),
        }
    )
    return status()


def connect_with_token(value: str) -> GitHubStatus:
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{20,255}", value):
        raise GitHubError(400, "that does not look like a GitHub token")
    return _save_token(value, "pat")


# ---------- device flow ----------


@dataclass
class _Flow:
    device_code: str
    interval: int
    expires_at: float


_flows: dict[str, _Flow] = {}


class DeviceStart(BaseModel):
    flow_id: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class DevicePoll(BaseModel):
    status: Literal["pending", "connected", "expired", "denied", "error"]
    interval: int | None = None
    message: str | None = None
    github: GitHubStatus | None = None


def _oauth_post(path: str, data: dict[str, str]) -> dict[str, Any]:
    with httpx.Client(base_url=WEB, timeout=TIMEOUT, transport=_transport) as client:
        try:
            response = client.post(path, data=data, headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise GitHubError(502, f"could not reach GitHub: {exc}") from exc
    try:
        body = response.json()
    except ValueError:
        raise GitHubError(502, f"unexpected reply from GitHub ({response.status_code})") from None
    if response.status_code >= 400 and "error" not in body:
        raise GitHubError(response.status_code, str(body)[:200])
    return body


def start_device_flow() -> DeviceStart:
    if not settings.github_client_id:
        raise GitHubError(400, "set GITHUB_CLIENT_ID (an OAuth App with Device Flow enabled)")
    body = _oauth_post(
        "/login/device/code", {"client_id": settings.github_client_id, "scope": SCOPES}
    )
    if "error" in body:
        raise GitHubError(400, body.get("error_description") or body["error"])
    flow_id = secrets.token_urlsafe(16)
    expires_in = int(body.get("expires_in") or 900)
    interval = int(body.get("interval") or 5)
    _flows[flow_id] = _Flow(body["device_code"], interval, time.time() + expires_in)
    return DeviceStart(
        flow_id=flow_id,
        user_code=body["user_code"],
        verification_uri=body.get("verification_uri") or f"{WEB}/login/device",
        expires_in=expires_in,
        interval=interval,
    )


def poll_device_flow(flow_id: str) -> DevicePoll:
    flow = _flows.get(flow_id)
    if flow is None:
        return DevicePoll(status="expired", message="start signing in again")
    if time.time() > flow.expires_at:
        _flows.pop(flow_id, None)
        return DevicePoll(status="expired", message="the code expired; start again")
    body = _oauth_post(
        "/login/oauth/access_token",
        {
            "client_id": settings.github_client_id,
            "device_code": flow.device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
    )
    error = body.get("error")
    if error == "authorization_pending":
        return DevicePoll(status="pending", interval=flow.interval)
    if error == "slow_down":
        flow.interval = int(body.get("interval") or flow.interval + 5)
        return DevicePoll(status="pending", interval=flow.interval)
    if error == "expired_token":
        _flows.pop(flow_id, None)
        return DevicePoll(status="expired", message="the code expired; start again")
    if error == "access_denied":
        _flows.pop(flow_id, None)
        return DevicePoll(status="denied", message="sign-in was cancelled on GitHub")
    if error:
        _flows.pop(flow_id, None)
        return DevicePoll(status="error", message=body.get("error_description") or error)
    access = body.get("access_token")
    if not access:
        return DevicePoll(status="error", message="GitHub did not return a token")
    _flows.pop(flow_id, None)
    return DevicePoll(status="connected", github=_save_token(str(access), "oauth"))


# ---------- REST ----------


def _request(
    method: str,
    path: str,
    *,
    token_override: str | None = None,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    accept: str = "application/vnd.github+json",
) -> httpx.Response:
    headers = {"Accept": accept, "X-GitHub-Api-Version": "2022-11-28"}
    auth = token_override or token()
    if auth:
        headers["Authorization"] = f"Bearer {auth}"
    with httpx.Client(base_url=API, timeout=TIMEOUT, transport=_transport) as client:
        try:
            response = client.request(method, path, params=params, json=json_body, headers=headers)
        except httpx.HTTPError as exc:
            raise GitHubError(502, f"could not reach GitHub: {exc}") from exc
    if response.status_code >= 400:
        try:
            message = response.json().get("message") or response.text
        except ValueError:
            message = response.text
        if response.status_code in (401, 403) and not auth:
            message = f"{message} (connect GitHub in Integrations for private repos)"
        elif response.status_code == 404:
            message = "not found, or this GitHub account cannot see it"
        raise GitHubError(response.status_code, str(message)[:300])
    return response


def get_json(path: str, **params: Any) -> Any:
    return _request("GET", path, params=params or None).json()


# ---------- pull requests ----------

_PR_URL = re.compile(
    r"^https?://(?:www\.)?github\.com/"
    r"(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/"
    r"(?P<repo>[A-Za-z0-9._-]{1,100})/pull/(?P<number>\d{1,9})(?:[/?#].*)?$"
)


class PRRef(BaseModel):
    owner: str
    repo: str
    number: int

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}#{self.number}"

    @property
    def api(self) -> str:
        return f"/repos/{self.owner}/{self.repo}"

    @property
    def url(self) -> str:
        return f"{WEB}/{self.owner}/{self.repo}/pull/{self.number}"


def parse_pr_url(url: str) -> PRRef:
    match = _PR_URL.match(url.strip())
    if not match or match["repo"] in (".", ".."):
        raise ValueError("expected a pull request URL like https://github.com/owner/repo/pull/123")
    return PRRef(owner=match["owner"], repo=match["repo"], number=int(match["number"]))


TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs)(/|$)|(_test|\.test|\.spec|_spec)\.|(^|/)test_"
)
SKIP_PATH = re.compile(
    r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock|"
    r"go\.sum|composer\.lock|Gemfile\.lock|\.min\.(js|css)|\.map|\.snap)$|(^|/)(dist|vendor|build)/"
)
MANIFEST_PATH = re.compile(
    r"(^|/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|go\.mod|Cargo\.toml|"
    r"Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json)$"
)


def pr_files(ref: PRRef, max_pages: int = 3) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        batch = get_json(f"{ref.api}/pulls/{ref.number}/files", per_page=100, page=page)
        files += batch
        if len(batch) < 100:
            break
    return files


def ci_state(ref: PRRef, sha: str) -> dict[str, Any]:
    """Checks and commit statuses folded into passing | failing | pending | none."""
    failing: list[str] = []
    pending: list[str] = []
    passing = 0
    try:
        runs = get_json(f"{ref.api}/commits/{sha}/check-runs", per_page=100).get("check_runs", [])
    except GitHubError:
        runs = []
    for run in runs:
        if run.get("status") != "completed":
            pending.append(run.get("name", "check"))
        elif run.get("conclusion") in ("failure", "timed_out", "cancelled", "action_required"):
            failing.append(run.get("name", "check"))
        elif run.get("conclusion") in ("success", "neutral", "skipped"):
            passing += 1
    try:
        combined = get_json(f"{ref.api}/commits/{sha}/status")
    except GitHubError:
        combined = {}
    for st in combined.get("statuses") or []:
        if st.get("state") in ("failure", "error"):
            failing.append(st.get("context", "status"))
        elif st.get("state") == "pending":
            pending.append(st.get("context", "status"))
        elif st.get("state") == "success":
            passing += 1
    state = "failing" if failing else "pending" if pending else "passing" if passing else "none"
    return {"state": state, "failing": failing, "pending": pending, "passing": passing}


def pr_facts(ref: PRRef) -> dict[str, Any]:
    """What code can tell for sure about a PR, before any model reads it."""
    pr = get_json(f"{ref.api}/pulls/{ref.number}")
    files = pr_files(ref)
    names = [f.get("filename", "") for f in files]
    code = [n for n in names if not SKIP_PATH.search(n) and not n.endswith((".md", ".txt"))]
    tests = [n for n in names if TEST_PATH.search(n)]
    manifests = [n for n in names if MANIFEST_PATH.search(n)]
    head_sha = (pr.get("head") or {}).get("sha", "")
    body = pr.get("body") or ""
    return {
        "url": ref.url,
        "slug": ref.slug,
        "owner": ref.owner,
        "repo": ref.repo,
        "number": ref.number,
        "title": pr.get("title") or "",
        "author": (pr.get("user") or {}).get("login"),
        "state": "merged" if pr.get("merged") else pr.get("state"),
        "draft": bool(pr.get("draft")),
        "base": (pr.get("base") or {}).get("ref"),
        "head": (pr.get("head") or {}).get("ref"),
        "head_sha": head_sha,
        "additions": int(pr.get("additions") or 0),
        "deletions": int(pr.get("deletions") or 0),
        "changed_files": int(pr.get("changed_files") or len(files)),
        "has_description": len(body.strip()) >= 30,
        "linked_issue": bool(
            re.search(r"(?i)\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+", body)
        ),
        "tests_touched": tests,
        "code_files": len(code),
        "manifests_touched": manifests,
        "ci": ci_state(ref, head_sha) if head_sha else {"state": "none"},
        "partial": len(files) >= 300 or (int(pr.get("additions") or 0) > 3000),
    }


def pr_body(ref: PRRef) -> str:
    return str(get_json(f"{ref.api}/pulls/{ref.number}").get("body") or "")


def file_at(ref: PRRef, path: str, sha: str) -> str:
    safe = quote(path.lstrip("/"), safe="/")
    if ".." in safe.split("/"):
        raise GitHubError(400, "bad path")
    data = get_json(f"{ref.api}/contents/{safe}", ref=sha)
    if isinstance(data, list):
        return "(a directory: " + ", ".join(d.get("name", "") for d in data[:100]) + ")"
    if data.get("encoding") == "base64":
        return base64.b64decode(data.get("content") or "").decode("utf-8", errors="replace")
    return str(data.get("content") or "")


def post_comment(ref: PRRef, body: str) -> str:
    if not token():
        raise GitHubError(401, "connect GitHub first")
    response = _request("POST", f"{ref.api}/issues/{ref.number}/comments", json_body={"body": body})
    return str(response.json().get("html_url") or ref.url)
