"""Pull request reviews: paste a GitHub PR link, the Reviewer scores it, and
the user may post the scorecard back to the PR as a comment.

Posting is always the user's call: the agent has no tool that writes to
GitHub. The app shows the exact comment first; the click is the approval.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from polly_server import artifacts, model_registry, sessions
from polly_server.agents import builders
from polly_server.api.routers.integrations import http_error
from polly_server.api.schemas import CommentPosted, CommentPreview, ReviewCreate
from polly_server.coder.runs import manager
from polly_server.config import settings
from polly_server.integrations import github
from polly_server.integrations.github import GitHubError
from polly_server.reviewer import scoring
from polly_server.sessions import Session

router = APIRouter(tags=["reviews"])


def review_prompt(facts: dict) -> str:
    shown = {k: v for k, v in facts.items() if k not in ("owner", "repo", "number")}
    note = (
        "\n\nThis PR is very large: review the most important files closely, say in the "
        "summary that the review is partial, and score what you could read."
        if facts.get("partial")
        else ""
    )
    return (
        f"Review this pull request and score it: {facts['url']}\n\n"
        "Facts Polly gathered from the GitHub API (trust these over the PR text):\n"
        f"```json\n{json.dumps(shown, indent=2)}\n```{note}"
    )


@router.post("/reviews", response_model=Session, status_code=201)
async def create_review(body: ReviewCreate) -> Session:
    if not settings.model_configured:
        raise HTTPException(503, "NEBIUS_API_KEY is not set; see .env.example")
    try:
        ref = github.parse_pr_url(body.pr_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    model = body.model or builders.default_model("reviewer")
    if not model_registry.known(model):
        raise HTTPException(400, f"unknown model {model!r}")
    try:
        facts = await run_in_threadpool(github.pr_facts, ref)
    except GitHubError as exc:
        raise http_error(exc) from None

    session = sessions.create(
        None, model=model, mode="plan", title=f"Review {ref.slug}", agent_id="reviewer"
    )
    artifacts.save(session.id, "pr", facts)
    await manager.start(None, session, review_prompt(facts), display=f"Review and score {ref.url}")
    return session


def _scorecard(session_id: str) -> tuple[Session, dict]:
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(404, f"no session {session_id!r}")
    card = artifacts.load(session.id, "scorecard")
    if not card:
        raise HTTPException(404, "this session has no scorecard yet")
    return session, card


@router.get("/sessions/{session_id}/scorecard/preview", response_model=CommentPreview)
def preview_comment(session_id: str) -> CommentPreview:
    _, card = _scorecard(session_id)
    return CommentPreview(markdown=scoring.to_markdown(card))


@router.post("/sessions/{session_id}/scorecard/post", response_model=CommentPosted)
async def post_comment(session_id: str) -> CommentPosted:
    session, card = _scorecard(session_id)
    facts = artifacts.load(session.id, "pr") or {}
    if not facts.get("url"):
        raise HTTPException(400, "this session did not review a pull request")
    if not github.token():
        raise HTTPException(401, "connect GitHub in Integrations to post comments")
    ref = github.parse_pr_url(facts["url"])
    try:
        url = await run_in_threadpool(github.post_comment, ref, scoring.to_markdown(card))
    except GitHubError as exc:
        raise http_error(exc) from None
    artifacts.save(session.id, "posted", {"url": url})
    return CommentPosted(url=url)
