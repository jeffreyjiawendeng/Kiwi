from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.claims import DETECTED, MANUAL, Claim
from kiwi.types import Alignment, Anchor, Depth, Intent
from kiwi.workspace import (
    PathOutsideProject,
    init_project,
    read_claims,
    sidecar_path,
    write_claims,
    write_draft,
)

PAGE = "pg_0000000000000001"
DOC = "doc_aaaaaaaaaaaaaaaa"


def _claim(alignment: Alignment | None = None, source: str = DETECTED) -> Claim:
    text = "Chunking changes retrieval quality"
    return Claim(
        anchor=Anchor(
            document_id=PAGE,
            section_path="",
            start=0,
            end=len(text),
            exact=text,
            prefix="",
            suffix=f" [@{DOC}]",
        ),
        citation=DOC,
        intent=Intent.EVIDENCE,
        intent_source=source,
        alignment=alignment,
    )


def _alignment() -> Alignment:
    return Alignment(
        score=2,
        intent=Intent.EVIDENCE,
        depth=Depth.QUICK,
        evidence=Anchor(
            document_id=DOC,
            section_path="Results",
            start=10,
            end=30,
            exact="supporting passage",
            prefix="",
            suffix="",
        ),
        model="test-model",
    )


def test_sidecar_sits_beside_the_draft(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    assert sidecar_path(root, "intro.md").name == "intro.md.kiwi.json"


def test_claims_round_trip_with_an_alignment(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", f"Chunking changes retrieval quality [@{DOC}].")
    write_claims(root, "intro.md", PAGE, [_claim(_alignment())])

    restored = read_claims(root, "intro.md")
    assert len(restored) == 1
    assert restored[0].citation == DOC
    assert restored[0].intent is Intent.EVIDENCE
    assert restored[0].alignment is not None
    assert restored[0].alignment.score == 2
    assert restored[0].alignment.depth is Depth.QUICK
    assert restored[0].alignment.evidence is not None
    assert restored[0].alignment.evidence.document_id == DOC


def test_claim_without_an_alignment_round_trips(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    write_claims(root, "intro.md", PAGE, [_claim()])

    restored = read_claims(root, "intro.md")
    assert restored[0].alignment is None


def test_manual_intent_source_survives_a_round_trip(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    write_claims(root, "intro.md", PAGE, [_claim(source=MANUAL)])
    assert read_claims(root, "intro.md")[0].intent_source == MANUAL


def test_reading_a_draft_with_no_sidecar_returns_no_claims(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    assert read_claims(root, "never-scored.md") == []


def _deep_alignment() -> Alignment:
    return Alignment(
        score=0,
        intent=Intent.EVIDENCE,
        depth=Depth.DEEP,
        evidence=None,
        model="test-model",
    )


def test_quick_and_deep_results_are_stored_side_by_side(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")

    claim = _claim(_alignment())
    both = Claim(
        anchor=claim.anchor,
        citation=claim.citation,
        intent=claim.intent,
        alignment=claim.alignment,
        deep_alignment=_deep_alignment(),
        deep_claim=claim.anchor.exact,
    )
    write_claims(root, "intro.md", PAGE, [both])

    restored = read_claims(root, "intro.md")[0]
    assert restored.alignment is not None
    assert restored.alignment.depth is Depth.QUICK
    assert restored.alignment.score == 2
    assert restored.deep_alignment is not None
    assert restored.deep_alignment.depth is Depth.DEEP
    assert restored.deep_alignment.score == 0


def test_deep_result_is_stale_when_the_claim_text_changed() -> None:
    claim = _claim()
    current = Claim(
        anchor=claim.anchor,
        citation=claim.citation,
        intent=claim.intent,
        deep_alignment=_deep_alignment(),
        deep_claim="an earlier wording of the claim",
    )
    assert current.deep_is_stale is True


def test_deep_result_is_not_stale_when_the_claim_is_unchanged() -> None:
    claim = _claim()
    current = Claim(
        anchor=claim.anchor,
        citation=claim.citation,
        intent=claim.intent,
        deep_alignment=_deep_alignment(),
        deep_claim=claim.anchor.exact,
    )
    assert current.deep_is_stale is False


def test_a_claim_with_no_deep_result_is_not_stale() -> None:
    assert _claim(_alignment()).deep_is_stale is False


def test_staleness_survives_a_round_trip(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")

    claim = _claim()
    stale = Claim(
        anchor=claim.anchor,
        citation=claim.citation,
        intent=claim.intent,
        deep_alignment=_deep_alignment(),
        deep_claim="an earlier wording",
    )
    write_claims(root, "intro.md", PAGE, [stale])
    assert read_claims(root, "intro.md")[0].deep_is_stale is True


DOC_B = "doc_bbbbbbbbbbbbbbbb"


def _claim_citing(citation: str) -> Claim:
    base = _claim()
    return Claim(anchor=base.anchor, citation=citation, intent=Intent.EVIDENCE)


def test_two_citations_on_one_sentence_keep_separate_records(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    write_claims(root, "intro.md", PAGE, [_claim_citing(DOC), _claim_citing(DOC_B)])

    restored = read_claims(root, "intro.md")
    assert len(restored) == 2
    assert {c.citation for c in restored} == {DOC, DOC_B}
    assert restored[0].anchor.exact == restored[1].anchor.exact


def test_intent_override_can_single_out_one_citation(tmp_path: Path) -> None:
    from kiwi.core import set_claim_intent

    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    claim_text = _claim().anchor.exact
    write_claims(root, "intro.md", PAGE, [_claim_citing(DOC), _claim_citing(DOC_B)])

    updated = set_claim_intent(root, "intro.md", claim_text, "background", citation=DOC_B)
    by_citation = {c.citation: c for c in updated}
    assert by_citation[DOC_B].intent is Intent.BACKGROUND
    assert by_citation[DOC_B].intent_source == MANUAL
    assert by_citation[DOC].intent is Intent.EVIDENCE
    assert by_citation[DOC].intent_source == DETECTED


def test_changing_intent_drops_a_score_from_the_other_scale(tmp_path: Path) -> None:
    from kiwi.core import set_claim_intent

    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    write_claims(root, "intro.md", PAGE, [_claim(_alignment())])

    # Scored 2 on the evidence scale, where attribution runs 0 to 1.
    updated = set_claim_intent(root, "intro.md", _claim().anchor.exact, "attribution")
    assert updated[0].intent is Intent.ATTRIBUTION
    assert updated[0].alignment is None, "a score from the other scale must not be kept"


def test_reasserting_the_same_intent_keeps_the_score(tmp_path: Path) -> None:
    from kiwi.core import set_claim_intent

    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    write_claims(root, "intro.md", PAGE, [_claim(_alignment())])

    updated = set_claim_intent(root, "intro.md", _claim().anchor.exact, "evidence")
    assert updated[0].alignment is not None
    assert updated[0].intent_source == MANUAL


def test_intent_override_without_a_citation_applies_to_every_match(tmp_path: Path) -> None:
    from kiwi.core import set_claim_intent

    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", "text")
    claim_text = _claim().anchor.exact
    write_claims(root, "intro.md", PAGE, [_claim_citing(DOC), _claim_citing(DOC_B)])

    updated = set_claim_intent(root, "intro.md", claim_text, "methods")
    assert all(c.intent is Intent.METHODS for c in updated)


def test_sidecar_path_cannot_escape_the_project(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    with pytest.raises(PathOutsideProject):
        sidecar_path(root, "../../escaped.md")
