"""Answering from a knowledge base, with citations.

Nemotron 3 Ultra reads a million tokens, so a base small enough (up to
`LONG_CONTEXT_TOKENS`) is given whole: every chunk, in file order. Nothing a
retriever might miss is left out, and questions about the files as a whole
("what do these contracts disagree on?") work. A bigger base is searched,
and the best `RETRIEVE` chunks are given instead.

Either way the model sees numbered passages and cites them as `[n]`, so a
citation always points at a real passage with its file and page. The stream
starts with every passage it may cite (`sources`), then the answer as it is
written (`delta`), then, when it is done, the passages it did cite (a second
`sources`, which replaces the first) and the whole text (`done`).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel

from polly_server import models
from polly_server.config import settings
from polly_server.knowledge import ingest, store
from polly_server.knowledge.chunking import chunk_pages

log = logging.getLogger(__name__)

LONG_CONTEXT_TOKENS = 150_000
RETRIEVE = 12
EXCERPT = 300
HISTORY_TURNS = 20


class KnowledgeHit(BaseModel):
    chunk_id: str
    file_id: str
    file_name: str
    page: int | None = None
    text: str
    score: float


class KnowledgeSource(BaseModel):
    """A passage an answer cites as `[n]`."""

    n: int
    file_id: str
    file_name: str
    page: int | None = None
    excerpt: str


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


@dataclass
class _Passage:
    file_id: str
    file_name: str
    page: int | None
    text: str


SYSTEM = """\
You answer the user's questions from their own files, in the knowledge \
{bases_label} {names}.

The files are below as numbered passages. {coverage} Base what you say on \
them, and cite the passage each statement comes from with its number in \
square brackets right after it, like [3] or [2][5]. Cite only numbers that \
are in the list. If the passages do not contain the answer, say so plainly; \
if you add anything from general knowledge, say that it is not from the \
files. Answer in the language of the question, in Markdown, as briefly as \
the question allows.

<passages>
{passages}
</passages>"""

WHOLE = "They are all of the files, in order."
SOME = (
    "They are the parts of the files that best match the question; the rest "
    "of the files is not shown."
)


async def search(kb_ids: list[str], query: str, k: int = 8) -> list[KnowledgeHit]:
    """The chunks of these bases that best match `query`."""
    known = [kb_id for kb_id in kb_ids if store.get_base(kb_id) is not None]
    if not known or not query.strip():
        return []
    ingest.retry_pending()
    hits = await store.index().search(query, k, where={"kb_id": known})
    return [
        KnowledgeHit(
            chunk_id=h.id,
            file_id=str(h.meta.get("file_id", "")),
            file_name=str(h.meta.get("file_name", "")),
            page=h.meta.get("page"),
            text=h.text,
            score=h.score,
        )
        for h in hits
    ]


def _excerpt(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= EXCERPT else text[: EXCERPT - 1].rstrip() + "…"


def _whole(kb_ids: list[str]) -> list[_Passage]:
    passages: list[_Passage] = []
    for file in store.files_of(kb_ids):
        if file.status != "ready":
            continue
        for chunk in chunk_pages(store.load_text(file.id)):
            passages.append(_Passage(file.id, file.name, chunk.page, chunk.text))
    return passages


def _render(passages: list[_Passage]) -> str:
    def attr(value: str) -> str:
        return value.replace('"', "'")

    return "\n".join(
        f'<passage n="{n}" file="{attr(p.file_name)}"'
        + (f' page="{p.page}"' if p.page is not None else "")
        + f">\n{p.text}\n</passage>"
        for n, p in enumerate(passages, start=1)
    )


def _history(turns: Sequence[Mapping[str, Any] | ChatTurn]) -> list[BaseMessage]:
    messages: list[BaseMessage] = []
    for raw in list(turns)[-HISTORY_TURNS:]:
        turn = ChatTurn.model_validate(raw)
        if turn.text.strip():
            cls = HumanMessage if turn.role == "user" else AIMessage
            messages.append(cls(content=turn.text))
    return messages


def cited(text: str, count: int) -> list[int]:
    """Passage numbers the answer cites, `[3]`, `[2, 5]` or `[4-6]`, in order."""
    found: dict[int, None] = {}
    for group in re.findall(r"\[(\d+(?:\s*[,–-]\s*\d+)*)\]", text):
        for part in re.split(r"\s*,\s*", group):
            ends = [int(x) for x in re.split(r"\s*[–-]\s*", part)]
            for n in range(ends[0], ends[-1] + 1) if len(ends) == 2 else ends[:1]:
                if 1 <= n <= count:
                    found.setdefault(n, None)
    return list(found)


def _content(chunk: BaseMessage) -> str:
    content = chunk.content
    if isinstance(content, str):
        return content
    return "".join(
        b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
    )


async def answer(
    kb_ids: list[str],
    question: str,
    history: Sequence[Mapping[str, Any] | ChatTurn],
    *,
    context: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Answer `question` from these bases, as KnowledgeEvent dicts.
    `context` describes what is on the user's screen, for the copilot."""
    try:
        bases = [b for b in (store.get_base(i) for i in kb_ids) if b is not None]
        if not bases:
            yield {"type": "error", "message": "No knowledge base to answer from."}
            return
        ids = [b.id for b in bases]
        files = store.files_of(ids)
        ready = [f for f in files if f.status == "ready"]
        if not ready:
            yield {"type": "sources", "sources": []}
            text = (
                "The files are still being read; ask again in a moment."
                if any(f.status == "processing" for f in files)
                else "There are no readable files here yet. Add some, then ask again."
            )
            yield {"type": "done", "text": text}
            return

        if sum(f.tokens for f in ready) <= LONG_CONTEXT_TOKENS:
            passages = await asyncio.to_thread(_whole, ids)
            coverage = WHOLE
        else:
            last_question = next(
                (t for t in reversed(_history(history)) if isinstance(t, HumanMessage)), None
            )
            # A follow-up ("and in 2024?") is searched with the question before it.
            query = f"{last_question.content}\n{question}" if last_question else question
            hits = await search(ids, query, k=RETRIEVE)
            passages = [_Passage(h.file_id, h.file_name, h.page, h.text) for h in hits]
            coverage = SOME

        sources = [
            KnowledgeSource(
                n=n, file_id=p.file_id, file_name=p.file_name, page=p.page, excerpt=_excerpt(p.text)
            )
            for n, p in enumerate(passages, start=1)
        ]
        yield {"type": "sources", "sources": [s.model_dump() for s in sources]}

        system = SYSTEM.format(
            bases_label="base" if len(bases) == 1 else "bases",
            names=", ".join(f"“{b.name}”" for b in bases),
            coverage=coverage,
            passages=_render(passages) or "(no passage matches the question)",
        )
        ask = question
        if context and context.strip():
            screen = f"<screen>\n{context.strip()}\n</screen>"
            ask = f"What is on my screen right now:\n{screen}\n\n{question}"
        messages = [SystemMessage(content=system), *_history(history), HumanMessage(content=ask)]

        model = models.chat_model(model=settings.strong_model, reasoning_effort="medium")
        text = ""
        async for chunk in model.astream(messages):
            piece = _content(chunk)
            if piece:
                text += piece
                yield {"type": "delta", "text": piece}

        used = set(cited(text, len(sources)))
        yield {"type": "sources", "sources": [s.model_dump() for s in sources if s.n in used]}
        yield {"type": "done", "text": text}
    except Exception as exc:  # noqa: BLE001 - the stream ends with the reason
        log.exception("knowledge: answer failed")
        yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
