"""The notch copilot: lenses, prompts, parsing the brain's replies, the HTTP streams."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from polly_server.api.app import app
from polly_server.copilot import brain, lenses, replies
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot, describe, visible_text

client = TestClient(app)


def snap(**over) -> Snapshot:
    data = {
        "app": {"name": "Google Chrome", "bundleId": "com.google.Chrome", "pid": 1},
        "window": {"title": "URGENT: Meeting with Maria - trevor@gmail.com - Gmail"},
        "url": "https://mail.google.com/mail/u/0/#inbox/abc",
        "focused": {
            "role": "AXTextArea",
            "label": "Message Body",
            "value": "10am",
            "editable": True,
            "token": "f1",
        },
        "ax": [{"text": "Can you send me a 1-hour slot?"}, {"text": "Best, Alexi"}],
        "ocr": [{"text": "Can you send me a 1-hour slot?", "source": "ocr"}, {"text": "Nov 5th"}],
    }
    data.update(over)
    return Snapshot.model_validate(data)


def test_lens_and_label_from_url():
    s = snap()
    assert lenses.detect(s).id == "email"
    assert lenses.label(s) == "Gmail · URGENT: Meeting with Maria"


def test_lens_from_bundle_and_pdf_in_preview():
    excel = snap(app={"name": "Microsoft Excel", "bundleId": "com.microsoft.Excel"}, url=None)
    assert lenses.detect(excel).id == "spreadsheet"
    pdf = snap(
        app={"name": "Preview", "bundleId": "com.apple.Preview"},
        url=None,
        window={"title": "W-9.pdf"},
    )
    assert lenses.detect(pdf).id == "pdf"
    other = snap(app={"name": "Maps", "bundleId": "com.apple.Maps"}, url=None)
    assert lenses.detect(other).id == "generic"


def test_visible_text_adds_only_what_ocr_found_beyond_ax():
    text = visible_text(snap())
    assert text.count("1-hour slot") == 1
    assert "[read from the screenshot]\nNov 5th" in text


def test_describe_skips_secure_fields_and_lists_form_fields():
    s = snap(
        focused={"role": "AXTextField", "secure": True, "value": None, "token": "x"},
        fields=[{"label": "Full name", "role": "AXTextField", "value": "", "token": "a"}],
    )
    text = describe(s, "An email thread.")
    assert "Focused" not in text
    assert "[1] Full name · TextField · (empty)" in text
    assert "vision model): An email thread." in text


def test_parse_json_handles_fences_and_chatter():
    assert replies.parse_json('Sure!\n```json\n{"a": 1}\n```') == {"a": 1}
    assert replies.parse_json('{"a": {"b": 2}} trailing') == {"a": {"b": 2}}
    assert replies.parse_json("no json here") is None


def test_split_apply_reads_the_cell():
    rest, body, cell = brain.split_apply("```apply cell=$I$4\n=H4*0.12\n```\nFill it down.")
    assert (rest, body, cell) == ("Fill it down.", "=H4*0.12", "I4")


def test_apply_plan_targets():
    s = snap()
    shown, suggestion, plan = brain.apply_plan("reply_draft", "Hi Alexi,\n10am works.", s)
    assert shown == "" and suggestion.startswith("Hi Alexi")
    assert plan == {"kind": "replace_field", "text": "Hi Alexi,\n10am works.", "token": "f1"}

    _, _, plan = brain.apply_plan("formula", "```apply cell=C4\n=STDEV.P(D7:D20)\n```", s)
    assert plan["kind"] == "cell" and plan["cell"] == "C4"

    read_only = snap(focused={"role": "AXWebArea", "editable": False, "token": "w"})
    shown, suggestion, plan = brain.apply_plan("answer", "Just an answer.", read_only)
    assert (shown, suggestion, plan) == ("Just an answer.", None, None)


def test_clean_chips_limits_and_normalises():
    chips = brain.clean_chips(
        [{"id": "Draft Reply!", "label": "Draft reply", "agentic": 1}, {"label": ""}] * 3
    )
    assert chips[0] == {"id": "draft_reply", "label": "Draft reply", "agentic": True}
    assert len(chips) == 3


def test_todo_proposals_filter_and_never_repeat():
    s = snap()
    raw = [
        {
            "title": "Send Alexi a 1-hour slot",
            "due": "2026-11-04T18:00",
            "evidence": ["slot"],
            "confidence": 0.9,
        },
        {"title": "Maybe something", "confidence": 0.3},
    ]
    found = brain.todo_proposals(raw, s)
    assert [t["title"] for t in found] == ["Send Alexi a 1-hour slot"]
    assert found[0]["due_at"] and found[0]["source"]["app"] == "Google Chrome"
    assert brain.todo_proposals(raw, s) == []


def test_hint_is_dropped_when_muted_or_unsure():
    s = snap(window={"title": "Another thread"})
    hint = {"kind": "reply_draft", "title": "Reply", "brief": "b", "confidence": 0.9}
    assert brain.pick_hint({"hint": hint}, s, "email")["kind"] == "reply_draft"
    assert brain.pick_hint({"hint": {**hint, "confidence": 0.2}}, s, "email") is None
    copilot_settings.mute("email", "reply_draft")
    try:
        assert brain.pick_hint({"hint": hint}, s, "email") is None
    finally:
        copilot_settings.update({"muted": []})


def test_settings_patch_merges_nested_and_keeps_password_managers():
    res = client.patch("/copilot/settings", json={"suggest": {"todos": False}})
    assert res.status_code == 200
    body = res.json()
    assert body["suggest"] == {"hints": True, "chips": True, "todos": False, "writing": True}
    assert any(a["bundle_id"] == "com.1password.1password" for a in body["exclusions"]["apps"])
    client.patch("/copilot/settings", json={"suggest": {"todos": True}})


def _frames(res) -> list[dict]:
    return [
        json.loads(line[5:].strip()) for line in res.text.splitlines() if line.startswith("data:")
    ]


def test_observe_streams_context_chips_todo_and_hint(monkeypatch):
    from polly_server.api.routers import copilot as route
    from polly_server.config import settings

    async def triage(trigger, snapshot, scene):
        return {
            "label": "Gmail · Meeting with Maria",
            "chips": [{"id": "draft_reply", "label": "Draft reply", "agentic": True}],
            "hint": {
                "kind": "completion",
                "title": "Reply to Alexi",
                "brief": "x",
                "confidence": 0.9,
            },
            "todos": [
                {"title": "Confirm the slot with Alexi", "evidence": ["slot"], "confidence": 0.8}
            ],
        }

    async def write_hint(hint, snapshot, scene):
        yield {
            "type": "card.start",
            "id": "c1",
            "kind": hint["kind"],
            "title": hint["title"],
            "proactive": True,
        }
        yield {
            "type": "card.done",
            "id": "c1",
            "text": "",
            "suggestion": "10am works.",
            "apply": None,
        }

    async def glance(snapshot):
        return None

    monkeypatch.setattr(route.brain, "triage", triage)
    monkeypatch.setattr(route.brain, "write_hint", write_hint)
    monkeypatch.setattr(route.vision, "glance", glance)
    monkeypatch.setattr(route.recall, "remember", lambda *a: None)
    monkeypatch.setattr(type(settings), "model_configured", property(lambda self: True))

    body = {"trigger": "typing", "snapshot": snap(window={"title": "Fresh"}).model_dump()}
    res = client.post("/copilot/observe", json=body)
    assert res.status_code == 200
    types = [f["type"] for f in _frames(res)]
    assert types == ["context", "context", "chips", "todo", "card.start", "card.done", "done"]

    log = client.get("/copilot/log").json()["entries"]
    assert log[0]["outcome"].startswith("chips, to-do, hint")


def test_observe_without_a_key_is_503(monkeypatch):
    from polly_server.config import settings

    monkeypatch.setattr(type(settings), "model_configured", property(lambda self: False))
    body = {"trigger": "switch", "snapshot": snap().model_dump()}
    assert client.post("/copilot/observe", json=body).status_code == 503
