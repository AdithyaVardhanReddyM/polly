"""GitHub: parsing PR links, anonymous and Composio-backed calls and PR
facts, all against mock transports."""

import httpx
import pytest
from fastapi.testclient import TestClient

from polly_server.api.app import app
from polly_server.integrations import github

client = TestClient(app)


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
    configure(composio_api_key="")
    yield routes, seen
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


def test_anonymous_calls_carry_no_credentials(gh):
    routes, seen = gh
    routes[("GET", "/repos/acme/web/pulls/7")] = {"title": "Add login"}
    assert github.get_json("/repos/acme/web/pulls/7")["title"] == "Add login"
    assert "authorization" not in seen[-1].headers
    assert not github.status().connected


def test_a_connected_account_goes_through_composio(gh, composio_account):
    routes, seen = gh
    calls = composio_account("github")
    calls.replies[("GET", "https://api.github.com/user")] = (200, {"login": "octo"})
    calls.replies[("POST", "https://api.github.com/repos/acme/web/issues/7/comments")] = (
        201,
        {"html_url": "https://github.com/acme/web/pull/7#issuecomment-1"},
    )

    status = client.get("/integrations").json()["github"]
    assert status == {"connected": True, "login": "octo"}

    ref = github.parse_pr_url("https://github.com/acme/web/pull/7")
    assert github.post_comment(ref, "Score: 90").endswith("#issuecomment-1")
    assert calls.seen[-1] == (
        "github",
        "POST",
        "https://api.github.com/repos/acme/web/issues/7/comments",
        {"body": "Score: 90"},
    )
    assert seen == []  # nothing went to GitHub directly

    github.get_json("/repos/acme/web/pulls", per_page=100)
    assert calls.seen[-1][2] == "https://api.github.com/repos/acme/web/pulls?per_page=100"


def test_posting_needs_a_connected_account(gh):
    ref = github.parse_pr_url("https://github.com/acme/web/pull/7")
    with pytest.raises(github.GitHubError) as err:
        github.post_comment(ref, "hi")
    assert err.value.status == 401


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
