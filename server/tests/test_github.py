"""GitHub: parsing PR links, the Device Flow, token storage and PR facts,
all against a mock transport."""

import json
import stat

import httpx
import pytest
from fastapi.testclient import TestClient

from polly_server.api.app import app
from polly_server.integrations import github

client = TestClient(app)

TOKEN = "gho_" + "a" * 36


@pytest.fixture
def gh(configure):
    """Route GitHub calls to a handler the test fills in."""
    routes: dict[tuple[str, str], object] = {}
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        key = (request.method, request.url.path)
        reply = routes.get(key)
        if callable(reply):
            reply = reply(request)
        if reply is None:
            return httpx.Response(404, json={"message": "Not Found"})
        status, body, *headers = reply if isinstance(reply, tuple) else (200, reply)
        return httpx.Response(status, json=body, headers=headers[0] if headers else None)

    github.use_transport(httpx.MockTransport(handler))
    configure(github_client_id="Iv1.test", github_token="")
    github.disconnect()
    yield routes, seen
    github.disconnect()
    github.use_transport(None)


def test_parse_pr_url_accepts_pull_links_only():
    ref = github.parse_pr_url("https://github.com/acme/web-app/pull/42/files")
    assert (ref.owner, ref.repo, ref.number) == ("acme", "web-app", 42)
    assert ref.slug == "acme/web-app#42"
    for bad in (
        "https://github.com/acme/web-app/issues/42",
        "https://evil.com/acme/web-app/pull/42",
        "https://github.com.evil.com/a/b/pull/1",
        "https://github.com/acme/../pull/1",
        "github.com/acme/web/pull/1",
    ):
        with pytest.raises(ValueError):
            github.parse_pr_url(bad)


def test_device_flow_pending_slow_down_then_connected(gh):
    routes, seen = gh
    routes[("POST", "/login/device/code")] = {
        "device_code": "dev-secret",
        "user_code": "ABCD-1234",
        "verification_uri": "https://github.com/login/device",
        "expires_in": 900,
        "interval": 5,
    }
    replies = iter(
        [
            {"error": "authorization_pending"},
            {"error": "slow_down", "interval": 10},
            {"access_token": TOKEN, "token_type": "bearer"},
        ]
    )
    routes[("POST", "/login/oauth/access_token")] = lambda _req: (200, next(replies))
    routes[("GET", "/user")] = (200, {"login": "octo"}, {"x-oauth-scopes": "repo, read:user"})

    res = client.post("/integrations/github/device")
    assert res.status_code == 200
    start = res.json()
    assert start["user_code"] == "ABCD-1234"
    assert "device_code" not in start  # stays on the server

    poll = f"/integrations/github/device/{start['flow_id']}/poll"
    assert client.post(poll).json()["status"] == "pending"
    slowed = client.post(poll).json()
    assert slowed == {**slowed, "status": "pending", "interval": 10}
    done = client.post(poll).json()
    assert done["status"] == "connected"
    assert done["github"]["login"] == "octo"
    assert done["github"]["scopes"] == ["repo", "read:user"]

    secret = github._secret_file()
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600
    assert github.token() == TOKEN
    assert TOKEN not in json.dumps(client.get("/integrations").json())
    # The flow is spent.
    assert client.post(poll).json()["status"] == "expired"
    assert seen[-1].url.path == "/user"


def test_device_flow_denied(gh):
    routes, _ = gh
    routes[("POST", "/login/device/code")] = {
        "device_code": "d",
        "user_code": "X",
        "expires_in": 900,
        "interval": 5,
    }
    routes[("POST", "/login/oauth/access_token")] = {"error": "access_denied"}
    flow = client.post("/integrations/github/device").json()["flow_id"]
    assert client.post(f"/integrations/github/device/{flow}/poll").json()["status"] == "denied"
    assert not github.status().connected


def test_device_flow_needs_a_client_id(gh, configure):
    configure(github_client_id="")
    res = client.post("/integrations/github/device")
    assert res.status_code == 400
    assert "GITHUB_CLIENT_ID" in res.json()["detail"]


def test_pat_is_checked_then_stored_and_can_be_removed(gh):
    routes, seen = gh
    assert (
        client.post("/integrations/github/token", json={"token": "not a token"}).status_code == 400
    )
    routes[("GET", "/user")] = (401, {"message": "Bad credentials"})
    assert client.post("/integrations/github/token", json={"token": TOKEN}).status_code == 401
    assert not github.status().connected

    routes[("GET", "/user")] = {"login": "octo"}
    res = client.post("/integrations/github/token", json={"token": TOKEN})
    assert res.status_code == 200
    assert res.json()["connected"] and res.json()["source"] == "pat"
    assert seen[-1].headers["authorization"] == f"Bearer {TOKEN}"

    assert client.delete("/integrations/github").json()["connected"] is False
    assert github.token() is None


def _pr_routes(routes, *, files, ci_conclusion="success"):
    api = "/repos/acme/web/"
    routes[("GET", api + "pulls/7")] = {
        "title": "Add login",
        "user": {"login": "dev"},
        "state": "open",
        "body": "Adds a login form. Fixes #12 and adds the form handler.",
        "base": {"ref": "main"},
        "head": {"ref": "login", "sha": "abc123"},
        "additions": 40,
        "deletions": 2,
        "changed_files": len(files),
    }
    routes[("GET", api + "pulls/7/files")] = [{"filename": f, "patch": "@@"} for f in files]
    routes[("GET", api + "commits/abc123/check-runs")] = {
        "check_runs": [{"name": "test", "status": "completed", "conclusion": ci_conclusion}]
    }
    routes[("GET", api + "commits/abc123/status")] = {"statuses": []}


def test_pr_facts(gh):
    routes, _ = gh
    _pr_routes(
        routes,
        files=["src/login.py", "tests/test_login.py", "package.json", "uv.lock"],
        ci_conclusion="failure",
    )
    facts = github.pr_facts(github.parse_pr_url("https://github.com/acme/web/pull/7"))
    assert facts["slug"] == "acme/web#7"
    assert facts["linked_issue"] and facts["has_description"]
    assert facts["tests_touched"] == ["tests/test_login.py"]
    assert facts["manifests_touched"] == ["package.json"]
    assert facts["code_files"] == 3  # the lockfile does not count
    assert facts["ci"]["state"] == "failing" and facts["ci"]["failing"] == ["test"]
    assert facts["partial"] is False


def test_review_rejects_bad_links_and_needs_a_model(gh, configure):
    configure(nebius_api_key="")
    assert (
        client.post("/reviews", json={"pr_url": "https://github.com/a/b/pull/1"}).status_code == 503
    )
    configure(nebius_api_key="test-key")
    res = client.post("/reviews", json={"pr_url": "https://gitlab.com/a/b/-/merge_requests/1"})
    assert res.status_code == 400


def test_review_of_a_missing_pr_is_404(gh, configure):
    configure(nebius_api_key="test-key")
    res = client.post("/reviews", json={"pr_url": "https://github.com/acme/nope/pull/1"})
    assert res.status_code == 404
