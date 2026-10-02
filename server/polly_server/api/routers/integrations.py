"""Connecting accounts: GitHub (OAuth Device Flow, or a personal access
token) and the status of the search provider."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from polly_server.api.schemas import Integrations, Provider, TokenIn
from polly_server.config import settings
from polly_server.integrations import github
from polly_server.integrations.github import DevicePoll, DeviceStart, GitHubError, GitHubStatus

router = APIRouter(prefix="/integrations", tags=["integrations"])


def http_error(exc: GitHubError) -> HTTPException:
    code = exc.status if exc.status in (400, 401, 403, 404, 409, 422, 429) else 502
    return HTTPException(code, str(exc))


@router.get("", response_model=Integrations)
def list_integrations() -> Integrations:
    return Integrations(
        github=github.status().model_dump(),
        tavily=Provider(provider="Tavily", configured=bool(settings.tavily_api_key)),
    )


@router.post("/github/device", response_model=DeviceStart)
async def github_device_start() -> DeviceStart:
    """Start signing in: the app shows the code and opens GitHub."""
    try:
        return await run_in_threadpool(github.start_device_flow)
    except GitHubError as exc:
        raise http_error(exc) from None


@router.post("/github/device/{flow_id}/poll", response_model=DevicePoll)
async def github_device_poll(flow_id: str) -> DevicePoll:
    """Ask GitHub whether the user has entered the code yet. The app calls
    this every `interval` seconds."""
    try:
        return await run_in_threadpool(github.poll_device_flow, flow_id)
    except GitHubError as exc:
        raise http_error(exc) from None


@router.post("/github/token", response_model=GitHubStatus)
async def github_token(body: TokenIn) -> GitHubStatus:
    try:
        return await run_in_threadpool(github.connect_with_token, body.token)
    except GitHubError as exc:
        raise http_error(exc) from None


@router.delete("/github", response_model=GitHubStatus)
def github_disconnect() -> GitHubStatus:
    github.disconnect()
    return github.status()
