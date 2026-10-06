"""Text to vectors, for knowledge bases and the copilot's recall.

Token Factory serves Qwen3-Embedding-8B behind its OpenAI-compatible
`/v1/embeddings`. The model is instruction-aware: a search query is matched
better with a one-line task in front of it, while the passages it is matched
against go in bare. Vectors come back L2-normalised, so cosine similarity is
a plain dot product.

When the service fails we stop asking for a short while (`COOLDOWN`), so a
search falls back to keywords at once instead of waiting on every call.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Literal

import httpx

from polly_server.config import settings

log = logging.getLogger(__name__)

QUERY_INSTRUCTION = (
    "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: "
)
# Inputs per request, and characters per input (about 6 000 tokens; the
# model reads up to 32K, but long passages blur into one vector anyway).
BATCH = 32
MAX_CHARS = 24_000
# Requests in flight at once for a long list.
CONCURRENCY = 4
TIMEOUT = 60.0
RETRIES = 2
COOLDOWN = 30.0

_down_until = 0.0


class EmbeddingError(RuntimeError):
    """Embeddings are unavailable: no key, or the service failed. `transient`
    when it is the service's trouble (unreachable, overloaded) and worth
    waiting out."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


def _prepare(text: str, kind: Literal["query", "document"]) -> str:
    text = text if kind == "document" else QUERY_INSTRUCTION + text
    # The endpoint refuses empty input.
    return text[:MAX_CHARS] or " "


def _normalised(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm else vector


async def _request(client: httpx.AsyncClient, inputs: list[str]) -> list[list[float]]:
    body = {"model": settings.embedding_model, "input": inputs, "encoding_format": "float"}
    for attempt in range(RETRIES + 1):
        try:
            res = await client.post("embeddings", json=body)
        except httpx.HTTPError as exc:
            if attempt == RETRIES:
                raise EmbeddingError(
                    f"Token Factory embeddings unreachable: {exc}", transient=True
                ) from exc
        else:
            if res.status_code == 429 or res.status_code >= 500:
                if attempt == RETRIES:
                    raise EmbeddingError(
                        f"Token Factory embeddings: HTTP {res.status_code}", transient=True
                    )
            elif res.is_error:
                raise EmbeddingError(
                    f"Token Factory embeddings: HTTP {res.status_code}: {res.text[:300]}"
                )
            else:
                data = sorted(res.json()["data"], key=lambda d: d["index"])
                if len(data) != len(inputs):
                    raise EmbeddingError("Token Factory returned the wrong number of vectors")
                return [_normalised(d["embedding"]) for d in data]
        await asyncio.sleep(0.5 * 2**attempt)
    raise AssertionError("unreachable")


async def embed(texts: list[str], *, kind: Literal["query", "document"]) -> list[list[float]]:
    """One unit vector per text, in order. `kind="query"` for what is searched
    with, `"document"` for what is searched. Raises `EmbeddingError`."""
    global _down_until
    if not texts:
        return []
    if not settings.nebius_api_key:
        raise EmbeddingError("NEBIUS_API_KEY is not set; embeddings need Token Factory")
    if time.monotonic() < _down_until:
        raise EmbeddingError("Token Factory embeddings failed moments ago; not retrying yet")

    inputs = [_prepare(t, kind) for t in texts]
    batches = [inputs[i : i + BATCH] for i in range(0, len(inputs), BATCH)]
    gate = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient(
        base_url=settings.nebius_base_url.rstrip("/") + "/",
        headers={"Authorization": f"Bearer {settings.nebius_api_key}"},
        timeout=TIMEOUT,
    ) as client:

        async def one(batch: list[str]) -> list[list[float]]:
            async with gate:
                return await _request(client, batch)

        try:
            results = await asyncio.gather(*(one(b) for b in batches))
        except EmbeddingError as exc:
            if exc.transient:
                _down_until = time.monotonic() + COOLDOWN
            log.warning("%s", exc)
            raise
    return [vector for batch in results for vector in batch]
