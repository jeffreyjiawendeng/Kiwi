from __future__ import annotations

import pytest

from kiwi.claims import SCORED_INTENTS
from kiwi.components.align.nli import NLIAligner, _score_for
from kiwi.protocols import Aligner
from kiwi.types import Anchor, Chunk, Depth, Intent


def _chunk(text: str) -> Chunk:
    return Chunk(
        chunk_id="chk_aaaaaaaaaaaaaaaa_0000",
        anchor=Anchor(
            document_id="doc_aaaaaaaaaaaaaaaa",
            section_path="Results",
            start=0,
            end=len(text),
            exact=text,
            prefix="",
            suffix="",
        ),
        text=text,
        section_path="Results",
    )


def test_aligner_satisfies_protocol_shape() -> None:
    assert isinstance(NLIAligner(), Aligner)


def test_only_evidence_and_attribution_are_scored() -> None:
    assert set(SCORED_INTENTS) == {Intent.EVIDENCE, Intent.ATTRIBUTION}


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("entailment", 2),
        ("SUPPORT", 2),
        ("supports", 2),
        ("neutral", 1),
        ("NEI", 1),
        ("NO_EVIDENCE", 1),
        ("contradiction", 0),
        ("REFUTE", 0),
        ("contradicts", 0),
    ],
)
def test_evidence_scores_read_the_label_name_not_its_index(label: str, expected: int) -> None:
    assert _score_for(label, Intent.EVIDENCE) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [("entailment", 1), ("SUPPORT", 1), ("neutral", 0), ("contradiction", 0)],
)
def test_attribution_scores_are_binary(label: str, expected: int) -> None:
    assert _score_for(label, Intent.ATTRIBUTION) == expected


def test_unrecognised_label_scores_as_relevant() -> None:
    assert _score_for("something-else", Intent.EVIDENCE) == 1


def test_align_without_evidence_reports_relevant_and_no_anchor() -> None:
    alignment = NLIAligner().align("A claim.", Intent.EVIDENCE, [], Depth.QUICK)
    assert alignment.score == 1
    assert alignment.evidence is None
    assert alignment.depth is Depth.QUICK


def test_attribution_without_evidence_is_not_credited() -> None:
    # A score of 1 credits the work on the binary scale, so the score for
    # an unread claim differs from the evidence scale's middle.
    alignment = NLIAligner().align("A claim.", Intent.ATTRIBUTION, [], Depth.QUICK)
    assert alignment.score == 0


def test_intent_detection_defaults_to_evidence_without_a_model() -> None:
    aligner = NLIAligner(intent_model_name="")
    assert aligner.detect_intent("Some claim.", "") is Intent.EVIDENCE


class _StubAligner(NLIAligner):
    """Returns a prepared distribution per passage, keyed by passage text."""

    def __init__(self, distributions: dict[str, dict[str, float]]) -> None:
        super().__init__(intent_model_name="")
        self._distributions = distributions

    def _load(self):  # type: ignore[no-untyped-def]
        return object(), object()

    def _distribution(self, model, tokenizer, text, pair):  # type: ignore[no-untyped-def]
        return self._distributions[text]


def _entail() -> dict[str, float]:
    return {"entailment": 0.90, "neutral": 0.05, "contradiction": 0.05}


def _contradict() -> dict[str, float]:
    return {"entailment": 0.05, "neutral": 0.05, "contradiction": 0.90}


def _neutral() -> dict[str, float]:
    return {"entailment": 0.10, "neutral": 0.80, "contradiction": 0.10}


def test_least_neutral_passage_is_scored_not_the_highest_ranked() -> None:
    # The highest-ranked passage says nothing about the claim; a lower
    # ranked one contradicts it. The contradiction is what gets reported.
    aligner = _StubAligner({"ranked first": _neutral(), "ranked second": _contradict()})
    alignment = aligner.align(
        "A claim.",
        Intent.EVIDENCE,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 0
    assert alignment.evidence is not None
    assert alignment.evidence.exact == "ranked second"


def test_support_requires_the_highest_ranked_passage_to_agree() -> None:
    # A lower ranked passage entails the claim, but the highest ranked one
    # does not. Support carries no warning, so it is not reported.
    aligner = _StubAligner({"ranked first": _neutral(), "ranked second": _entail()})
    alignment = aligner.align(
        "A claim.",
        Intent.EVIDENCE,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 1
    assert alignment.evidence is not None
    assert alignment.evidence.exact == "ranked first"


def test_support_is_reported_when_the_highest_ranked_passage_agrees() -> None:
    aligner = _StubAligner({"ranked first": _entail(), "ranked second": _neutral()})
    alignment = aligner.align(
        "A claim.",
        Intent.EVIDENCE,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 2


def test_weakly_supported_claims_are_not_reported_as_supported() -> None:
    # Both passages call it entailment, but neither confidently. Support
    # is the score shown without a warning, so it is withheld.
    weak = {"entailment": 0.45, "neutral": 0.35, "contradiction": 0.20}
    aligner = _StubAligner({"ranked first": weak, "ranked second": weak})
    alignment = aligner.align(
        "A claim.",
        Intent.EVIDENCE,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 1


def test_confident_support_from_both_passages_is_reported() -> None:
    aligner = _StubAligner({"ranked first": _entail(), "ranked second": _entail()})
    alignment = aligner.align(
        "A claim.",
        Intent.EVIDENCE,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 2


def test_attribution_support_is_guarded_the_same_way() -> None:
    aligner = _StubAligner({"ranked first": _neutral(), "ranked second": _entail()})
    alignment = aligner.align(
        "A claim.",
        Intent.ATTRIBUTION,
        [_chunk("ranked first"), _chunk("ranked second")],
        Depth.QUICK,
    )
    assert alignment.score == 0
