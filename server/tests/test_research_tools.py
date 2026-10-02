"""Research tools against a stubbed Tavily: numbered, de-duplicated sources
that stay stable for a session and are announced as events."""

import json
from types import SimpleNamespace

import httpx
import pytest

from polly_server import artifacts, sessions
from polly_server.research import sources, tavily
from polly_server.tools import reports
from polly_server.tools.research import research_search, web_extract


@pytest.fixture
def stub_tavily(configure):
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append({"path": request.url.path, **body})
        assert request.headers["authorization"] == "Bearer tvly-test"
        if request.url.path == "/search":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"url": "https://docs.example.com/a/", "title": "A", "content": "alpha"},
                        {"url": "https://example.org/b", "title": "B", "content": "beta"},
                        {"url": "", "title": "no url"},
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "results": [
                    {"url": "https://example.org/b", "title": "B", "raw_content": "# B\nfull"}
                ],
                "failed_results": [{"url": "https://down.example.net"}],
            },
        )

    configure(tavily_api_key="tvly-test")
    tavily.use_transport(httpx.MockTransport(handler))
    yield calls
    tavily.use_transport(None)


def _runtime(session_id):
    events: list[dict] = []
    return SimpleNamespace(
        context={"session_id": session_id}, config={}, stream_writer=events.append
    ), events


def _session():
    return sessions.create(None, model="m", mode="plan", agent_id="researcher")


def test_search_numbers_sources_and_dedupes_across_calls(stub_tavily):
    session = _session()
    runtime, events = _runtime(session.id)

    out = research_search.func(runtime=runtime, query="alpha", time_range="week")
    assert "[1] A\nhttps://docs.example.com/a/" in out
    assert "[2] B" in out and "no url" not in out
    assert stub_tavily[0]["time_range"] == "week"
    assert [s["id"] for s in events[0]["sources"]] == [1, 2]

    again = research_search.func(runtime=runtime, query="alpha again")
    assert "[1] A" in again  # same page, same number
    assert len(events) == 1  # nothing new to announce
    assert [s.id for s in sources.all_for(session.id)] == [1, 2]


def test_extract_reuses_numbers_and_reports_failures(stub_tavily):
    session = _session()
    runtime, _ = _runtime(session.id)
    research_search.func(runtime=runtime, query="alpha")
    out = web_extract.func(runtime=runtime, urls=["https://example.org/b"], focus="pricing")
    assert out.startswith("[2] B")
    assert "Could not read https://down.example.net." in out
    assert stub_tavily[-1]["query"] == "pricing"


def test_extract_refuses_non_http_urls(stub_tavily):
    runtime, _ = _runtime(_session().id)
    assert "http(s)" in web_extract.func(runtime=runtime, urls=["file:///etc/passwd"])
    assert stub_tavily == []


def test_search_without_a_key_says_so(configure):
    configure(tavily_api_key="")
    runtime, _ = _runtime(_session().id)
    assert "TAVILY_API_KEY" in research_search.func(runtime=runtime, query="x")


def test_session_falls_back_to_the_run_context_var():
    session = _session()
    token = artifacts.set_current_session(session.id)
    try:
        assert artifacts.session_id_of(SimpleNamespace(context=None, config={})) == session.id
    finally:
        artifacts.reset_current_session(token)


def test_change_report_resolves_cited_sources(stub_tavily):
    session = _session()
    runtime, events = _runtime(session.id)
    research_search.func(runtime=runtime, query="alpha")
    out = reports.submit_change_report.func(
        runtime=runtime,
        summary="Uses the current API.",
        verdict="needs_attention",
        findings=[
            reports.ChangeFinding(
                severity="medium", title="Deprecated", detail="Use v2", sources=[2]
            )
        ],
        pr_title="Add thing",
        pr_description="## Why\n...",
    )
    assert "Report saved" in out
    saved = artifacts.load(session.id, "report")
    assert saved["verdict"] == "needs_attention"
    assert [s["id"] for s in saved["sources"]] == [2]
    assert events[-1]["type"] == "report"


def test_scorecard_requires_every_category_and_applies_caps():
    from polly_server.reviewer.scoring import CATEGORIES, CategoryScore

    session = _session()
    artifacts.save(
        session.id, "pr", {"url": "https://github.com/a/b/pull/1", "ci": {"state": "failing"}}
    )
    runtime, events = _runtime(session.id)
    cats = [CategoryScore(key=k, score=9, rationale="fine") for k in CATEGORIES]

    out = reports.submit_scorecard.func(
        runtime=runtime, summary="s", categories=cats[:3], findings=[]
    )
    assert out.startswith("Not saved") and artifacts.load(session.id, "scorecard") is None

    out = reports.submit_scorecard.func(
        runtime=runtime, summary="s", categories=[c.model_dump() for c in cats], findings=[]
    )
    card = artifacts.load(session.id, "scorecard")
    assert card["total"] <= 60 and "60" in out
    assert card["pr"]["url"] == "https://github.com/a/b/pull/1"
    assert events[-1] == {"type": "scorecard", "scorecard": card}
