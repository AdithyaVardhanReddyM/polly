"""The hybrid index: keyword and vector search fused, filters, deletes, and
keyword search carrying on when embeddings fail. Embeddings are faked with
hashed bags of words, with a few synonyms sharing a word's slot so that a
match by meaning alone can be told apart from a keyword match."""

import asyncio
import hashlib
import math
import re
from types import SimpleNamespace

import pytest

from polly_server import embeddings, retrieval
from polly_server.retrieval import Doc, HybridIndex

DIM = 64
SYNONYMS = {"automobile": "car", "vehicle": "car", "earnings": "revenue"}


def fake_vector(text):
    vector = [0.0] * DIM
    for word in re.findall(r"\w+", text.casefold()):
        word = SYNONYMS.get(word, word)
        vector[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM] += 1
    norm = math.sqrt(sum(x * x for x in vector)) or 1
    return [x / norm for x in vector]


@pytest.fixture
def fake_embed(monkeypatch):
    state = SimpleNamespace(down=False, calls=[])

    async def embed(texts, *, kind):
        state.calls.append((kind, list(texts)))
        if state.down:
            raise embeddings.EmbeddingError("Token Factory is down")
        return [fake_vector(t) for t in texts]

    monkeypatch.setattr(embeddings, "embed", embed)
    return state


@pytest.fixture
def index(tmp_path):
    made = HybridIndex(tmp_path / "index.db", "notes")
    yield made
    made.close()


DOCS = [
    Doc("d1", "The car would not start this morning.", {"kb": "a", "page": 1}, at=100),
    Doc(
        "d2", "Quarterly revenue grew 12 percent on strong demand.", {"kb": "a", "page": 2}, at=200
    ),
    Doc("d3", "The automobile insurance renewal is due in March.", {"kb": "b"}, at=300),
    Doc("d4", "Lunch menu: soup, bread and a salad.", {"kb": "b"}, at=400),
]


def search(index, query, **kwargs):
    return asyncio.run(index.search(query, **kwargs))


def ids(hits):
    return [h.id for h in hits]


def test_keyword_and_meaning_are_fused(index, fake_embed):
    asyncio.run(index.upsert(DOCS))
    assert index.count() == 4 and index.pending() == 0

    hits = search(index, "revenue", k=2)
    assert hits[0].id == "d2" and hits[0].meta == {"kb": "a", "page": 2} and hits[0].at == 200
    assert hits[0].score == pytest.approx(1.0)

    # No document says "vehicle"; two mean it.
    assert set(ids(search(index, "vehicle", k=2))) == {"d1", "d3"}
    # The query was embedded as a query, the docs as documents.
    assert {kind for kind, _ in fake_embed.calls} == {"document", "query"}


def test_filters_on_meta(index, fake_embed):
    asyncio.run(index.upsert(DOCS))
    assert set(ids(search(index, "car automobile", where={"kb": "b"}))) == {"d3", "d4"}
    assert set(ids(search(index, "car", where={"kb": ["a", "b"]}, k=10))) == {
        "d1",
        "d2",
        "d3",
        "d4",
    }
    assert search(index, "car", where={"kb": []}) == []
    # Meta compares as text, numbers included.
    assert ids(search(index, "car revenue", where={"page": "2"})) == ["d2"]
    assert index.count({"kb": "a"}) == 2
    with pytest.raises(ValueError):
        index.count({"kb') or 1=1 --": "a"})


def test_a_wide_filter_goes_through_the_vector_index(index, fake_embed, monkeypatch):
    asyncio.run(index.upsert(DOCS))
    exact = ids(search(index, "vehicle", where={"kb": "b"}))
    monkeypatch.setattr(retrieval, "EXACT_LIMIT", 0)
    assert ids(search(index, "vehicle", where={"kb": "b"})) == exact
    assert exact[0] == "d3"


def test_delete_delete_where_and_prune(index, fake_embed):
    asyncio.run(index.upsert(DOCS))
    index.delete(["d4", "missing"])
    assert index.count() == 3
    index.delete_where("kb", "b")
    assert index.count() == 2 and "d3" not in ids(search(index, "automobile insurance", k=5))
    assert index.prune(150) == 1
    assert ids(search(index, "car revenue", k=5)) == ["d2"]
    # Vectors go with their documents.
    with index._lock:
        assert index._conn.execute("select count(*) from notes_vec").fetchone()[0] == 1


def test_keywords_carry_on_when_embedding_fails(index, fake_embed):
    fake_embed.down = True
    asyncio.run(index.upsert(DOCS))
    assert index.count() == 4 and index.pending() == 4
    assert ids(search(index, "revenue", k=1)) == ["d2"]
    assert search(index, "vehicle") == []

    fake_embed.down = False
    assert asyncio.run(index.embed_pending(limit=3)) == 3
    assert asyncio.run(index.embed_pending()) == 1
    assert index.pending() == 0
    assert set(ids(search(index, "vehicle", k=2))) == {"d1", "d3"}

    # The query cannot be embedded: keywords still answer.
    fake_embed.down = True
    assert ids(search(index, "revenue", k=1)) == ["d2"]


def test_unchanged_text_keeps_its_vector(index, fake_embed):
    asyncio.run(index.upsert(DOCS))
    fake_embed.calls.clear()
    asyncio.run(index.upsert([Doc("d1", DOCS[0].text, {"kb": "z"}, at=999)]))
    assert fake_embed.calls == []
    (hit,) = search(index, "car", where={"kb": "z"})
    assert hit.id == "d1" and hit.at == 999

    fake_embed.calls.clear()
    asyncio.run(index.upsert([Doc("d1", "Bicycles only now.", {"kb": "z"})]))
    assert fake_embed.calls == [("document", ["Bicycles only now."])]
    assert index.count() == 4 and ids(search(index, "bicycles", k=1)) == ["d1"]


def test_queries_cannot_break_fts(index, fake_embed):
    asyncio.run(index.upsert(DOCS))
    query = retrieval.fts_query('"car" AND (start* NEAR/2 OR')
    assert query == '"car" OR "and" OR "start" OR "near" OR "2" OR "or"'
    assert ids(search(index, '"car" AND (start* NEAR/2 OR', k=1)) == ["d1"]
    assert search(index, "   ") == []
    assert retrieval.fts_query("?!") == ""


def test_namespaces_share_a_file(tmp_path, fake_embed):
    first = HybridIndex(tmp_path / "shared.db", "first")
    second = HybridIndex(tmp_path / "shared.db", "second")
    asyncio.run(first.upsert(DOCS[:2]))
    asyncio.run(second.upsert(DOCS[2:]))
    assert first.count() == 2 and second.count() == 2
    assert set(ids(search(second, "revenue car", k=5))) == {"d3", "d4"}
    assert set(ids(search(first, "revenue car", k=5))) == {"d1", "d2"}
    with pytest.raises(ValueError):
        HybridIndex(tmp_path / "shared.db", "Bad-Name")
    first.close()
    second.close()


def test_a_new_embedding_model_starts_the_vectors_over(tmp_path, fake_embed, configure):
    path = tmp_path / "index.db"
    made = HybridIndex(path, "notes")
    asyncio.run(made.upsert(DOCS))
    made.close()

    configure(embedding_model="another/model")
    again = HybridIndex(path, "notes")
    assert again.count() == 4 and again.pending() == 4
    assert asyncio.run(again.embed_pending()) == 4
    assert set(ids(search(again, "vehicle", k=2))) == {"d1", "d3"}
    again.close()
