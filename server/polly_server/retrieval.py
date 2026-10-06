"""A hybrid search index in one SQLite file: keywords and meaning.

Keyword search (FTS5, ranked by bm25) finds the exact names, numbers and
error codes that embeddings blur; vector search (sqlite-vec, cosine) finds
passages that say the same thing in other words. `search` runs both and fuses
the two rankings by reciprocal rank, which needs no score calibration between
them. Knowledge bases use it for their chunks and the copilot for what it saw
on screen, each in its own namespace (one file may hold several).

Embedding is the part that can fail (no key, Token Factory down), so a
document is searchable by keyword the moment it is written and gains its
vector when embedding succeeds; the ones still waiting are retried by
`embed_pending`, and `search` falls back to keywords alone.

Per namespace `ns`: `ns_docs` holds the documents (meta as JSON, `embedded`
marks those with a vector), `ns_fts` indexes their text (kept in step by
triggers), and `ns_vec` (vec0) holds the vectors under the same rowid, made
when the first vector shows its size. `index_info` records each namespace's
dimension and embedding model; a different model starts the vectors over.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import sqlite3
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import sqlite_vec

from polly_server import embeddings
from polly_server.config import settings

log = logging.getLogger(__name__)

# Reciprocal-rank fusion: score = sum of 1 / (RRF_K + rank) over rankers.
RRF_K = 60
# Documents per embedding call, so one failure loses little work.
EMBED_GROUP = 128
# Candidates each ranker hands to the fusion, at least.
MIN_CANDIDATES = 40
# A filter matching at most this many documents is searched exactly; a wider
# one goes through the vector index and is filtered after.
EXACT_LIMIT = 2_000
# The most neighbours sqlite-vec returns in one query.
KNN_MAX = 4_096
MAX_TERMS = 32

_NAMESPACE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

Where = dict[str, str | Sequence[str]]


@dataclass
class Doc:
    id: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)
    # Epoch seconds; `prune` drops what is older.
    at: float = 0.0


@dataclass
class Hit:
    id: str
    text: str
    meta: dict[str, Any]
    at: float
    # Fused rank score, 1.0 for a document both rankers put first.
    score: float


def fts_query(text: str) -> str:
    """Words of `text` as an FTS5 OR-query, each quoted so no character of
    the user's input is read as FTS syntax."""
    seen: dict[str, None] = {}
    for word in re.findall(r"\w+", text.casefold()):
        if len(word) > 1 or word.isdigit():
            seen.setdefault(word, None)
    return " OR ".join(f'"{w}"' for w in list(seen)[:MAX_TERMS])


def _filters(where: Where | None, alias: str = "d") -> tuple[str, list[Any]]:
    """SQL conditions on meta keys, as text: a value, or any of a list."""
    clauses: list[str] = []
    params: list[Any] = []
    for key, value in (where or {}).items():
        if not _KEY.match(key):
            raise ValueError(f"not a meta key: {key!r}")
        column = f"cast(json_extract({alias}.meta, '$.{key}') as text)"
        if isinstance(value, str):
            clauses.append(f"{column} = ?")
            params.append(value)
            continue
        values = [str(v) for v in value]
        if not values:
            clauses.append("0")
            continue
        clauses.append(f"{column} in ({', '.join('?' * len(values))})")
        params.extend(values)
    return " and ".join(clauses) or "1", params


class HybridIndex:
    """Thread-safe: one connection per index, used under a lock; the slow
    calls run in a worker thread so the event loop stays free."""

    def __init__(self, path: Path, namespace: str) -> None:
        if not _NAMESPACE.match(namespace):
            raise ValueError(f"namespace must be lowercase letters, digits and _: {namespace!r}")
        self.path = Path(path)
        self.ns = namespace
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)
        self._setup()

    # ---------- schema ----------

    def _setup(self) -> None:
        ns = self.ns
        with self._lock, self._conn as c:
            c.execute("pragma journal_mode = wal")
            c.execute(
                "create table if not exists index_info "
                "(ns text primary key, dim integer not null, model text not null)"
            )
            c.execute(
                f"create table if not exists {ns}_docs ("
                "rowid integer primary key autoincrement, id text not null unique, "
                "text text not null, meta text not null default '{}', "
                "at real not null default 0, embedded integer not null default 0)"
            )
            c.execute(f"create index if not exists {ns}_docs_at on {ns}_docs(at)")
            c.execute(
                f"create index if not exists {ns}_docs_pending on {ns}_docs(rowid) "
                "where embedded = 0"
            )
            c.execute(
                f"create virtual table if not exists {ns}_fts using fts5(text, "
                f"content='{ns}_docs', content_rowid='rowid', "
                "tokenize='porter unicode61 remove_diacritics 2')"
            )
            c.execute(
                f"create trigger if not exists {ns}_fts_add after insert on {ns}_docs begin "
                f"insert into {ns}_fts(rowid, text) values (new.rowid, new.text); end"
            )
            c.execute(
                f"create trigger if not exists {ns}_fts_drop after delete on {ns}_docs begin "
                f"insert into {ns}_fts({ns}_fts, rowid, text) "
                "values ('delete', old.rowid, old.text); end"
            )
            info = c.execute("select model from index_info where ns = ?", (ns,)).fetchone()
            if info and info[0] != settings.embedding_model:
                # Vectors from another model mean nothing next to the new ones.
                self._reset_vectors(c)

    def _reset_vectors(self, c: sqlite3.Connection) -> None:
        c.execute(f"drop trigger if exists {self.ns}_vec_drop")
        c.execute(f"drop table if exists {self.ns}_vec")
        c.execute("delete from index_info where ns = ?", (self.ns,))
        c.execute(f"update {self.ns}_docs set embedded = 0")

    def _dim(self, c: sqlite3.Connection) -> int | None:
        row = c.execute(
            "select dim from index_info where ns = ? and model = ?",
            (self.ns, settings.embedding_model),
        ).fetchone()
        return row[0] if row else None

    def _ensure_vectors(self, c: sqlite3.Connection, dim: int) -> None:
        known = self._dim(c)
        if known == dim:
            return
        if known is not None:
            self._reset_vectors(c)
        ns = self.ns
        c.execute(
            f"create virtual table if not exists {ns}_vec using vec0("
            f"embedding float[{dim}] distance_metric=cosine)"
        )
        c.execute(
            f"create trigger if not exists {ns}_vec_drop after delete on {ns}_docs begin "
            f"delete from {ns}_vec where rowid = old.rowid; end"
        )
        c.execute(
            "insert or replace into index_info (ns, dim, model) values (?, ?, ?)",
            (ns, dim, settings.embedding_model),
        )

    # ---------- writing ----------

    def _write(self, docs: list[Doc]) -> list[tuple[int, str]]:
        """Store the docs; returns (rowid, text) of those that need a vector.
        A doc whose text did not change keeps its vector."""
        ns = self.ns
        unembedded: list[tuple[int, str]] = []
        with self._lock, self._conn as c:
            for doc in docs:
                meta = json.dumps(doc.meta, default=str)
                row = c.execute(
                    f"select rowid, text, embedded from {ns}_docs where id = ?", (doc.id,)
                ).fetchone()
                if row and row[1] == doc.text:
                    c.execute(
                        f"update {ns}_docs set meta = ?, at = ? where rowid = ?",
                        (meta, doc.at, row[0]),
                    )
                    if not row[2]:
                        unembedded.append((row[0], doc.text))
                    continue
                if row:
                    c.execute(f"delete from {ns}_docs where rowid = ?", (row[0],))
                cur = c.execute(
                    f"insert into {ns}_docs (id, text, meta, at) values (?, ?, ?, ?)",
                    (doc.id, doc.text, meta, doc.at),
                )
                unembedded.append((cur.lastrowid or 0, doc.text))
        return unembedded

    def _store_vectors(self, rowids: list[int], vectors: list[list[float]]) -> int:
        ns = self.ns
        stored = 0
        with self._lock, self._conn as c:
            self._ensure_vectors(c, len(vectors[0]))
            for rowid, vector in zip(rowids, vectors, strict=True):
                # Skip a doc deleted or rewritten while it was being embedded.
                if not c.execute(
                    f"select 1 from {ns}_docs where rowid = ? and embedded = 0", (rowid,)
                ).fetchone():
                    continue
                c.execute(
                    f"insert into {ns}_vec (rowid, embedding) values (?, ?)",
                    (rowid, sqlite_vec.serialize_float32(vector)),
                )
                c.execute(f"update {ns}_docs set embedded = 1 where rowid = ?", (rowid,))
                stored += 1
        return stored

    async def _embed_rows(self, rows: list[tuple[int, str]]) -> int:
        done = 0
        for start in range(0, len(rows), EMBED_GROUP):
            group = rows[start : start + EMBED_GROUP]
            try:
                vectors = await embeddings.embed([text for _, text in group], kind="document")
            except Exception as exc:  # noqa: BLE001 - keyword search still works without
                waiting = len(rows) - start
                log.warning("%s: %d documents wait for vectors (%s)", self.ns, waiting, exc)
                break
            done += await asyncio.to_thread(
                self._store_vectors, [rowid for rowid, _ in group], vectors
            )
        return done

    async def upsert(self, docs: Sequence[Doc]) -> None:
        """Add or replace docs by id. Searchable by keyword at once; their
        vectors follow, or wait for `embed_pending` if embedding fails."""
        latest = {doc.id: doc for doc in docs}
        if not latest:
            return
        rows = await asyncio.to_thread(self._write, list(latest.values()))
        await self._embed_rows(rows)

    async def embed_pending(self, limit: int = 256) -> int:
        """Embed docs written while embedding was failing; how many got one."""

        def pending() -> list[tuple[int, str]]:
            with self._lock:
                return self._conn.execute(
                    f"select rowid, text from {self.ns}_docs where embedded = 0 "
                    "order by rowid limit ?",
                    (limit,),
                ).fetchall()

        rows = await asyncio.to_thread(pending)
        return await self._embed_rows(rows) if rows else 0

    def _delete(self, condition: str, params: Sequence[Any]) -> int:
        with self._lock, self._conn as c:
            return c.execute(f"delete from {self.ns}_docs where {condition}", params).rowcount

    def delete(self, ids: Iterable[str]) -> None:
        ids = list(ids)
        for start in range(0, len(ids), 500):
            batch = ids[start : start + 500]
            self._delete(f"id in ({', '.join('?' * len(batch))})", batch)

    def delete_where(self, key: str, value: str) -> None:
        """Delete every doc whose meta `key` equals `value` (compared as text)."""
        condition, params = _filters({key: value}, alias=f"{self.ns}_docs")
        self._delete(condition, params)

    def prune(self, before: float) -> int:
        """Delete docs with `at` before this time; returns how many."""
        return self._delete("at < ?", (before,))

    def count(self, where: Where | None = None) -> int:
        condition, params = _filters(where)
        with self._lock:
            row = self._conn.execute(
                f"select count(*) from {self.ns}_docs d where {condition}", params
            ).fetchone()
        return int(row[0])

    def pending(self) -> int:
        """Docs still waiting for a vector."""
        with self._lock:
            row = self._conn.execute(
                f"select count(*) from {self.ns}_docs where embedded = 0"
            ).fetchone()
        return int(row[0])

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------- searching ----------

    def _by_keyword(self, query: str, n: int, where: Where | None) -> list[int]:
        match = fts_query(query)
        if not match:
            return []
        ns = self.ns
        condition, params = _filters(where)
        with self._lock:
            rows = self._conn.execute(
                f"select d.rowid from {ns}_fts join {ns}_docs d on d.rowid = {ns}_fts.rowid "
                f"where {ns}_fts match ? and {condition} order by {ns}_fts.rank limit ?",
                (match, *params, n),
            ).fetchall()
        return [r[0] for r in rows]

    def _vector_dim(self) -> int | None:
        with self._lock:
            return self._dim(self._conn)

    def _by_meaning(self, vector: list[float], n: int, where: Where | None) -> list[int]:
        ns = self.ns
        blob = sqlite_vec.serialize_float32(vector)
        condition, params = _filters(where)
        with self._lock:
            c = self._conn
            if self._dim(c) != len(vector):
                return []
            if not where:
                rows = c.execute(
                    f"select rowid from {ns}_vec where embedding match ? and k = ? "
                    "order by distance",
                    (blob, min(n, KNN_MAX)),
                ).fetchall()
                return [r[0] for r in rows]

            matching = c.execute(
                f"select count(*) from {ns}_docs d where embedded = 1 and {condition}", params
            ).fetchone()[0]
            if not matching:
                return []
            if matching <= EXACT_LIMIT:
                # Few enough to measure each one: walk the filtered docs and
                # look their vectors up by rowid.
                rows = c.execute(
                    f"select d.rowid from {ns}_docs d cross join {ns}_vec v "
                    f"on v.rowid = d.rowid where d.embedded = 1 and {condition} "
                    "order by vec_distance_cosine(v.embedding, ?) limit ?",
                    (*params, blob, n),
                ).fetchall()
                return [r[0] for r in rows]

            # Many match: ask the vector index for enough neighbours that
            # about n of them pass the filter, then filter.
            total = c.execute(f"select count(*) from {ns}_docs where embedded = 1").fetchone()[0]
            k = min(KNN_MAX, n * 2 * math.ceil(total / matching))
            near = [
                r[0]
                for r in c.execute(
                    f"select rowid from {ns}_vec where embedding match ? and k = ? "
                    "order by distance",
                    (blob, k),
                ).fetchall()
            ]
            kept: set[int] = set()
            for start in range(0, len(near), 500):
                batch = near[start : start + 500]
                kept.update(
                    r[0]
                    for r in c.execute(
                        f"select d.rowid from {ns}_docs d where d.rowid in "
                        f"({', '.join('?' * len(batch))}) and {condition}",
                        (*batch, *params),
                    ).fetchall()
                )
        return [rowid for rowid in near if rowid in kept][:n]

    def _rows(self, rowids: list[int]) -> dict[int, tuple[str, str, str, float]]:
        if not rowids:
            return {}
        with self._lock:
            rows = self._conn.execute(
                f"select rowid, id, text, meta, at from {self.ns}_docs "
                f"where rowid in ({', '.join('?' * len(rowids))})",
                rowids,
            ).fetchall()
        return {r[0]: r[1:] for r in rows}

    async def search(self, query: str, k: int = 8, where: Where | None = None) -> list[Hit]:
        """The k best docs for `query`, by keywords and meaning together.
        `where` keeps docs whose meta keys equal a value (or any of a list)."""
        if not query.strip() or k <= 0:
            return []
        n = max(k * 4, MIN_CANDIDATES)
        rankings = [await asyncio.to_thread(self._by_keyword, query, n, where)]

        # Embed the query only when there are vectors to compare it with.
        if await asyncio.to_thread(self._vector_dim):
            try:
                (vector,) = await embeddings.embed([query], kind="query")
            except Exception as exc:  # noqa: BLE001 - keywords alone still answer
                log.warning("%s: searching by keyword only (%s)", self.ns, exc)
            else:
                rankings.append(await asyncio.to_thread(self._by_meaning, vector, n, where))

        scores: dict[int, float] = {}
        for ranking in rankings:
            for rank, rowid in enumerate(ranking, start=1):
                scores[rowid] = scores.get(rowid, 0.0) + 1 / (RRF_K + rank)
        best = sorted(scores, key=lambda r: scores[r], reverse=True)[:k]
        rows = await asyncio.to_thread(self._rows, best)
        top = len(rankings) / (RRF_K + 1)
        return [
            Hit(
                id=rows[r][0],
                text=rows[r][1],
                meta=json.loads(rows[r][2]),
                at=rows[r][3],
                score=round(scores[r] / top, 4),
            )
            for r in best
            if r in rows
        ]
