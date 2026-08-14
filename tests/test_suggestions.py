from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from kiwi.claims import Claim
from kiwi.core import accept_suggestion, reject_suggestion, suggest_draft
from kiwi.suggestions import (
    ALIGNMENT,
    GENERATED,
    SuggestionNotApplicable,
    SuggestionNotFound,
    apply_to,
    new_suggestion,
    pending,
    resolved,
)
from kiwi.types import (
    Alignment,
    Anchor,
    Answer,
    Depth,
    Health,
    Hit,
    Intent,
    SuggestionState,
)
from kiwi.workspace import (
    init_project,
    read_claims,
    read_draft,
    read_suggestions,
    write_claims,
    write_draft,
    write_suggestions,
)

DOC = "doc_aaaaaaaaaaaaaaaa"
PAGE = "pg_0000000000000001"
CLAIM = "Chunking changes retrieval quality"


def _anchor(text: str, body: str) -> Anchor:
    start = body.index(text)
    return Anchor(
        document_id=PAGE,
        section_path="",
        start=start,
        end=start + len(text),
        exact=text,
        prefix=body[max(0, start - 32) : start],
        suffix=body[start + len(text) : start + len(text) + 32],
    )


class _StubGenerator:
    """Returns a fixed proposal, recording the instructions it was given."""

    name = "stub"

    def __init__(self, proposals: list[str] | None = None) -> None:
        self.proposals = ["Chunking changes retrieval quality on this corpus"]
        if proposals is not None:
            self.proposals = proposals
        self.instructions: list[str] = []

    def health(self) -> Health:
        return Health(ok=True, detail="stub")

    def generate(self, query: str, passages: Sequence[Hit]) -> Answer:
        return Answer(text="", citations=(), generator=self.name)

    def suggest(self, text: str, instruction: str) -> list[str]:
        self.instructions.append(instruction)
        return self.proposals


def _project(tmp_path: Path, body: str) -> Path:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_draft(root, "intro.md", body)
    return root


def _claim(body: str, score: int) -> Claim:
    return Claim(
        anchor=_anchor(CLAIM, body),
        citation=DOC,
        intent=Intent.EVIDENCE,
        alignment=Alignment(
            score=score,
            intent=Intent.EVIDENCE,
            depth=Depth.QUICK,
            evidence=Anchor(
                document_id=DOC,
                section_path="Results",
                start=0,
                end=20,
                exact="the measured passage",
                prefix="",
                suffix="",
            ),
            model="test-model",
        ),
    )


def test_a_new_suggestion_is_pending() -> None:
    body = f"{CLAIM} [@{DOC}]."
    suggestion = new_suggestion(_anchor(CLAIM, body), "Revised text", GENERATED)
    assert suggestion.state is SuggestionState.PENDING
    assert suggestion.resolved is None
    assert suggestion.suggestion_id.startswith("sug_")


def test_applying_a_suggestion_replaces_the_span() -> None:
    body = f"{CLAIM} [@{DOC}]."
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", GENERATED)
    assert apply_to(suggestion, body) == f"Chunking matters [@{DOC}]."


def test_a_suggestion_survives_an_edit_elsewhere_in_the_draft() -> None:
    # The stored offsets are stale after text is inserted ahead of the
    # span. The anchor is re-resolved rather than trusted.
    body = f"{CLAIM} [@{DOC}]."
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", GENERATED)
    edited = f"An added opening sentence. {body}"
    assert apply_to(suggestion, edited) == f"An added opening sentence. Chunking matters [@{DOC}]."


def test_a_suggestion_whose_span_is_gone_cannot_be_applied() -> None:
    body = f"{CLAIM} [@{DOC}]."
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", GENERATED)
    with pytest.raises(SuggestionNotApplicable):
        apply_to(suggestion, "The author replaced this paragraph entirely.")


def test_pending_filters_out_resolved_suggestions() -> None:
    body = f"{CLAIM} [@{DOC}]."
    one = new_suggestion(_anchor(CLAIM, body), "A", GENERATED)
    two = resolved(new_suggestion(_anchor(CLAIM, body), "B", GENERATED), SuggestionState.REJECTED)
    assert pending([one, two]) == [one]


def test_suggestions_round_trip_through_the_sidecar(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])

    restored = read_suggestions(root, "intro.md")
    assert len(restored) == 1
    assert restored[0].suggestion_id == suggestion.suggestion_id
    assert restored[0].proposed == "Chunking matters"
    assert restored[0].origin == ALIGNMENT
    assert restored[0].state is SuggestionState.PENDING


def test_claims_and_suggestions_share_one_sidecar(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])
    suggestion = new_suggestion(_anchor(CLAIM, body), "A", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])

    assert len(read_claims(root, "intro.md")) == 1
    assert len(read_suggestions(root, "intro.md")) == 1

    # Rewriting one must not drop the other.
    write_claims(root, "intro.md", PAGE, [_claim(body, 2)])
    assert len(read_suggestions(root, "intro.md")) == 1


def test_accepting_applies_the_change_and_records_it(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])

    updated = accept_suggestion(root, "intro.md", suggestion.suggestion_id)
    assert updated[0].state is SuggestionState.ACCEPTED
    assert updated[0].resolved is not None
    assert str(read_draft(root, "intro.md")["content"]).strip() == f"Chunking matters [@{DOC}]."


def test_rejecting_records_the_decision_and_leaves_the_draft_alone(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])

    updated = reject_suggestion(root, "intro.md", suggestion.suggestion_id)
    assert updated[0].state is SuggestionState.REJECTED
    assert str(read_draft(root, "intro.md")["content"]).strip() == body


def test_a_rejected_suggestion_is_kept_in_the_record(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])
    reject_suggestion(root, "intro.md", suggestion.suggestion_id)

    recorded = read_suggestions(root, "intro.md")
    assert len(recorded) == 1
    assert recorded[0].state is SuggestionState.REJECTED
    assert pending(recorded) == []


def test_a_suggestion_cannot_be_resolved_twice(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    suggestion = new_suggestion(_anchor(CLAIM, body), "Chunking matters", ALIGNMENT)
    write_suggestions(root, "intro.md", PAGE, [suggestion])
    accept_suggestion(root, "intro.md", suggestion.suggestion_id)

    with pytest.raises(SuggestionNotApplicable):
        accept_suggestion(root, "intro.md", suggestion.suggestion_id)


def test_an_unknown_suggestion_id_is_reported(tmp_path: Path) -> None:
    root = _project(tmp_path, f"{CLAIM} [@{DOC}].")
    with pytest.raises(SuggestionNotFound):
        accept_suggestion(root, "intro.md", "sug_doesnotexist00")


def test_only_claims_the_citation_contradicts_get_a_suggestion(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 2)])
    assert suggest_draft(root, "intro.md", _StubGenerator()) == []

    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])
    created = suggest_draft(root, "intro.md", _StubGenerator())
    assert len(created) == 1
    assert created[0].origin == ALIGNMENT
    assert created[0].anchor.exact == CLAIM


def test_the_evidence_passage_is_given_to_the_generator(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])

    generator = _StubGenerator()
    suggest_draft(root, "intro.md", generator)
    assert "the measured passage" in generator.instructions[0]


def test_running_twice_does_not_stack_suggestions_on_one_claim(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])

    suggest_draft(root, "intro.md", _StubGenerator())
    assert suggest_draft(root, "intro.md", _StubGenerator()) == []
    assert len(read_suggestions(root, "intro.md")) == 1


def test_a_proposal_identical_to_the_claim_is_not_recorded(tmp_path: Path) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])
    assert suggest_draft(root, "intro.md", _StubGenerator([CLAIM])) == []


def test_no_generator_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    body = f"{CLAIM} [@{DOC}]."
    root = _project(tmp_path, body)
    write_claims(root, "intro.md", PAGE, [_claim(body, 0)])
    monkeypatch.delenv("KIWI_GENERATOR_MODEL", raising=False)

    assert suggest_draft(root, "intro.md") == []
    assert read_suggestions(root, "intro.md") == []
