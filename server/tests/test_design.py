"""The design document: HTML edits by node id, and the canvas API."""

import pytest
from fastapi.testclient import TestClient

from polly_server import sessions
from polly_server.design import document
from polly_server.design.document import Artboard, DesignDoc


def board(html: str = "") -> Artboard:
    return Artboard(id="a1", name="Home", width=390, height=844, html=document.normalize(html))


def test_normalize_gives_every_element_an_id_and_drops_scripts():
    html = document.normalize(
        '<div class="p-4" onclick="x()"><script>alert(1)</script><p>Hi</p>'
        '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg></div>'
    )
    assert "script" not in html and "onclick" not in html
    ids = document.ids_in(html)
    assert len(ids) == 3 and len(set(ids)) == 3  # div, p, svg; not the path


def test_normalize_keeps_existing_ids_and_fixes_duplicates():
    html = document.normalize('<p data-id="keep">a</p><p data-id="keep">b</p>')
    ids = document.ids_in(html)
    assert ids[0] == "keep" and ids[1] != "keep"


def test_insert_positions():
    b = board('<div data-id="root"><p data-id="one">1</p></div>')
    document.insert(b, '<p data-id="two">2</p>', "root", "append")
    document.insert(b, '<p data-id="zero">0</p>', "one", "before")
    assert document.ids_in(b.html) == ["root", "zero", "one", "two"]
    document.insert(b, '<h1 data-id="one">new</h1>', "one", "replace")
    assert "<h1" in b.html and document.ids_in(b.html) == ["root", "zero", "one", "two"]
    top = document.insert(b, "<section>fresh</section>", None, "replace_children")
    assert document.ids_in(b.html) == top


def test_update_merges_style_and_sets_text():
    b = board('<p data-id="t" class="text-sm" style="color: red; left: 4px">old</p>')
    style = {"left": None, "top": "8px"}
    document.update(b, "t", classes="text-lg font-bold", style=style, text="new")
    assert 'class="text-lg font-bold"' in b.html
    assert document.parse_style("color: red; top: 8px") == {"color": "red", "top": "8px"}
    assert "left" not in b.html and "top: 8px" in b.html and ">new<" in b.html


def test_update_refuses_text_on_a_container_and_unknown_nodes():
    b = board('<div data-id="box"><p data-id="t">x</p></div>')
    with pytest.raises(ValueError):
        document.update(b, "box", text="nope")
    with pytest.raises(LookupError):
        document.update(b, "missing", classes="x")


def test_style_parsing_survives_data_urls():
    style = document.parse_style("background: url(data:image/png;base64,AAAA); color: red")
    assert style == {"background": "url(data:image/png;base64,AAAA)", "color": "red"}


def test_outline_and_summary():
    b = board('<div data-id="root" class="flex"><h1 data-id="h">Hello there</h1></div>')
    assert document.outline(b) == 'div #root .flex\n  h1 #h "Hello there"'
    doc = DesignDoc(artboards=[b], selection=[{"artboard_id": "a1", "node_id": "h"}])
    text = document.summary(doc)
    assert 'a1 "Home" 390x844' in text and 'h1 #h "Hello there"' in text


def test_place_next_goes_right_of_existing():
    doc = DesignDoc(artboards=[board()])
    assert document.place_next(doc, 390) == (390 + document.GAP, 0)


def test_design_api_round_trip_and_stale_save():
    from polly_server.api.app import app

    client = TestClient(app)
    session = sessions.create(None, model="m", mode="plan", agent_id="designer")
    url = f"/sessions/{session.id}/design"
    assert client.get(url).json()["artboards"] == []

    doc = {"rev": 0, "artboards": [board("<p>hi</p>").model_dump()]}
    saved = client.put(url, json=doc).json()
    assert saved["rev"] == 1 and "data-id" in saved["artboards"][0]["html"]
    assert client.put(url, json=doc).status_code == 409  # rev 0 is now stale

    up = client.post(
        f"{url}/assets?name=Hero Shot.png",
        content=b"\x89PNG",
        headers={"content-type": "image/png"},
    )
    assert up.status_code == 201 and up.json()["name"].startswith("hero-shot-")
    assert client.get(f"{url}/assets/{up.json()['name']}").content == b"\x89PNG"
    bad = client.post(f"{url}/assets", content=b"x", headers={"content-type": "text/html"})
    assert bad.status_code == 415


def _call(name, args, call_id):
    from langchain_core.messages import AIMessage

    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


@pytest.mark.usefixtures("memory_checkpointer")
def test_designer_draws_and_the_app_hears_about_it(monkeypatch, configure):
    import asyncio

    from polly_server.agents import builders
    from polly_server.coder.runs import RunManager
    from tests.conftest import scripted

    configure(nebius_api_key="test-key")
    session = sessions.create(None, model="m", mode="plan", agent_id="designer")
    doc = document.save(session.id, DesignDoc(artboards=[board()]))
    fake = scripted(
        _call("write_html", {"artboard_id": "a1", "html": "<h1>Hello</h1>"}, "c1"),
        _call("create_artboard", {"name": "Poster", "width": 1080, "height": 1080}, "c2"),
        "Done.",
    )
    real = builders.build_agent
    monkeypatch.setattr(
        builders, "build_agent", lambda s, **_: real(s, model=fake, use_cache=False)
    )

    async def go():
        run = await RunManager().start(None, session, "a hello screen")
        await run.task
        return run

    run = asyncio.run(go())
    assert run.events[-1]["status"] == "completed", run.events[-1]
    drawn = [e for e in run.events if e["type"] == "design.artboard"]
    assert [e["action"] for e in drawn] == ["write", "create"]
    assert "Hello" in drawn[0]["artboard"]["html"] and drawn[0]["focus"]
    streaming = [e for e in run.events if e["type"] == "tool.streaming"]
    assert streaming[0] == {**streaming[0], "name": "write_html", "artboard_id": "a1"}

    saved = document.load(session.id)
    assert saved.rev > doc.rev and len(saved.artboards) == 2
    assert saved.artboards[1].x == 390 + document.GAP
