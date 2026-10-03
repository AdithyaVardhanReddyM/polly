"""GitHub: the few API calls the Reviewer needs.

The account is connected through Composio (Integrations > GitHub). When it
is, every call goes through Composio's proxy, which adds the user's
credentials; Polly never holds a GitHub token. Without an account, public
repositories are read anonymously, within GitHub's anonymous rate limit.
"""

from __future__ import annotations

import base64
import re
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from pydantic import BaseModel

from polly_server.integrations import composio
from polly_server.integrations.composio import ComposioError

API = "https://api.github.com"
WEB = "https://github.com"
TIMEOUT = 30.0

_transport: httpx.BaseTransport | None = None


class GitHubError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def use_transport(transport: httpx.BaseTransport | None) -> None:
    """Tests route anonymous requests through a mock transport."""
    global _transport
    _transport = transport


# ---------- the account ----------


class GitHubStatus(BaseModel):
    connected: bool
    login: str | None = None


_logins: dict[str, str | None] = {}


def connected() -> bool:
    return composio.is_connected("github")


def status() -> GitHubStatus:
    connection = composio.connections().get("github")
    if connection is None or connection.status != "active":
        return GitHubStatus(connected=False)
    if connection.id not in _logins:
        try:
            _logins[connection.id] = get_json("/user").get("login")
        except GitHubError:
            return GitHubStatus(connected=True)
    return GitHubStatus(connected=True, login=_logins[connection.id])


# ---------- REST ----------


def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    """One GitHub API call; returns the parsed JSON body."""
    signed_in = connected()
    if signed_in:
        url = f"{API}{path}" + (f"?{urlencode(params)}" if params else "")
        try:
            code, data = composio.proxy("github", method, url, json_body)
        except ComposioError as exc:
            raise GitHubError(exc.status, f"GitHub through Composio: {exc}") from exc
    else:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        with httpx.Client(base_url=API, timeout=TIMEOUT, transport=_transport) as client:
            try:
                response = client.request(
                    method, path, params=params, json=json_body, headers=headers
                )
            except httpx.HTTPError as exc:
                raise GitHubError(502, f"could not reach GitHub: {exc}") from exc
        code = response.status_code
        try:
            data = response.json()
        except ValueError:
            data = response.text
    if code >= 400:
        message = (data.get("message") if isinstance(data, dict) else None) or str(data)
        if code in (401, 403) and not signed_in:
            message = f"{message} (connect GitHub in Integrations for private repos)"
        elif code == 404:
            message = "not found, or this GitHub account cannot see it"
        raise GitHubError(code, str(message)[:300])
    return data


def get_json(path: str, **params: Any) -> Any:
    return _request("GET", path, params=params or None)


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
    if not connected():
        raise GitHubError(401, "connect GitHub first")
    posted = _request("POST", f"{ref.api}/issues/{ref.number}/comments", json_body={"body": body})
    return str(posted.get("html_url") or ref.url)
