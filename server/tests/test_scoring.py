from polly_server.reviewer import scoring
from polly_server.reviewer.scoring import CATEGORIES, CategoryScore, ReviewFinding


def _cats(score=8.0, **over):
    return [
        CategoryScore(key=k, score=over.get(k, score), rationale=f"{k} ok", evidence=["a.py:1"])
        for k in CATEGORIES
    ]


def _finding(severity):
    return ReviewFinding(severity=severity, title="t", detail="d", file="a.py", line=3)


GOOD = {"ci": {"state": "passing"}, "code_files": 2, "tests_touched": ["tests/test_a.py"]}


def test_weights_add_up_and_an_even_score_maps_straight_through():
    card = scoring.compute(_cats(8), [], GOOD)
    assert card["total"] == 80
    assert card["grade"] == "B"
    assert card["verdict"] == "approve"
    assert card["adjustments"] == []
    assert [c["key"] for c in card["categories"]] == list(CATEGORIES)


def test_failing_ci_limits_tests_and_caps_the_total():
    card = scoring.compute(_cats(10), [], {**GOOD, "ci": {"state": "failing"}})
    tests = next(c for c in card["categories"] if c["key"] == "tests")
    assert tests["score"] == 3 and tests["model_score"] == 10
    assert card["total"] == 60
    assert any("CI is failing" in a for a in card["adjustments"])


def test_code_without_tests_limits_the_tests_category():
    card = scoring.compute(_cats(10), [], {**GOOD, "tests_touched": []})
    tests = next(c for c in card["categories"] if c["key"] == "tests")
    assert tests["score"] == 5
    assert card["total"] == 90


def test_findings_cap_and_force_request_changes():
    critical = scoring.compute(_cats(10), [_finding("critical")], GOOD)
    assert critical["total"] == 40 and critical["grade"] == "F"
    assert critical["verdict"] == "request_changes"
    high = scoring.compute(_cats(10), [_finding("high")], GOOD)
    assert high["total"] == 79 and high["verdict"] == "request_changes"
    medium = scoring.compute(_cats(7), [_finding("medium")], GOOD)
    assert medium["total"] == 70 and medium["verdict"] == "comment"


def test_missing_categories_are_reported():
    assert scoring.missing_categories(_cats()[:-1]) == ["docs"]


def test_markdown_comment_has_score_table_findings_and_cited_sources():
    card = scoring.compute(_cats(8), [_finding("medium")], GOOD)
    card["summary"] = "Adds a | pipe."
    card["findings"] = [
        {**_finding("medium").model_dump(), "sources": [2]},
    ]
    card["sources"] = [{"id": 2, "url": "https://example.com/a", "title": "Doc"}]
    md = scoring.to_markdown(card)
    assert md.startswith("## Polly review: 80/100 (B)")
    assert "| Correctness | 25 | 8/10 |" in md
    assert "`a.py:3`" in md
    assert "2. [Doc](https://example.com/a)" in md
    assert "Nemotron" in md
