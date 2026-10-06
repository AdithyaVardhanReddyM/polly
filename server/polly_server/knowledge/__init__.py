"""Knowledge bases: the user's own files, to search and to ask questions of.

A base is a named set of files (PDFs, scans and images, Word, Excel, web
pages, text). Each file is read into text in the background, cut into
chunks and indexed by keyword and meaning (`retrieval.py`); answers cite the
passages they rest on.

The app reaches this through `/knowledge`; the notch copilot calls the three
functions below directly:

- `list_bases()`: every base, newest updated first;
- `search(kb_ids, query, k)`: the best-matching chunks across bases;
- `answer(kb_ids, question, history, context=...)`: a cited answer as a
  stream of KnowledgeEvent dicts (`sources`, `delta`…, `sources`, `done`, or
  `error`).
"""

from __future__ import annotations

from polly_server.knowledge.answering import (
    ChatTurn,
    KnowledgeHit,
    KnowledgeSource,
    answer,
    search,
)
from polly_server.knowledge.store import (
    KnowledgeBase,
    KnowledgeDetail,
    KnowledgeFile,
    list_bases,
)

__all__ = [
    "ChatTurn",
    "KnowledgeBase",
    "KnowledgeDetail",
    "KnowledgeFile",
    "KnowledgeHit",
    "KnowledgeSource",
    "answer",
    "list_bases",
    "search",
]
