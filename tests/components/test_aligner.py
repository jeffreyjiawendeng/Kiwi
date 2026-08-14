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


def _novel() -> Chunk:
    text = "In this paper we propose the virtual node algorithm for betweenness centrality."
    return Chunk(
        chunk_id="chk_aaaaaaaaaaaaaaaa_0001",
        anchor=Anchor(
            document_id="doc_aaaaaaaaaaaaaaaa",
            section_path="Introduction",
            start=0,
            end=len(text),
            exact=text,
            prefix="",
            suffix="",
        ),
        text=text,
        section_path="Introduction",
    )


def test_attribution_is_refused_when_no_passage_claims_authorship() -> None:
    # A passage describing a method in use entails a claim about that
    # method, which is how a work gets credited for what it applied.
    aligner = _StubAligner({"we applied Brandes' algorithm to the graph": _entail()})
    alignment = aligner.align(
        "Brandes' algorithm was introduced by the cited authors.",
        Intent.ATTRIBUTION,
        [_chunk("we applied Brandes' algorithm to the graph")],
        Depth.QUICK,
    )
    assert alignment.score == 0
    # The passage that was read is still reported, so the score is checkable.
    assert alignment.evidence is not None


def test_attribution_is_scored_against_a_passage_claiming_authorship() -> None:
    novel = _novel()
    aligner = _StubAligner({novel.anchor.exact: _entail()})
    alignment = aligner.align(
        "The virtual node algorithm was introduced by the cited authors.",
        Intent.ATTRIBUTION,
        [novel],
        Depth.QUICK,
    )
    assert alignment.score == 1


def test_the_novelty_filter_does_not_apply_to_the_evidence_scale() -> None:
    aligner = _StubAligner({"accuracy reached 71 percent": _entail()})
    alignment = aligner.align(
        "Accuracy reached 71 percent.",
        Intent.EVIDENCE,
        [_chunk("accuracy reached 71 percent")],
        Depth.QUICK,
    )
    assert alignment.score == 2


def test_the_scales_use_the_models_measured_better_for_each() -> None:
    from kiwi.components.align.nli import ATTRIBUTION_MODEL, DEFAULT_GPU_MODEL

    aligner = NLIAligner(device="cuda")
    assert aligner.model_name == DEFAULT_GPU_MODEL
    assert aligner.attribution_model_name == ATTRIBUTION_MODEL
    assert aligner.model_name != aligner.attribution_model_name


def test_one_configured_model_serves_both_scales() -> None:
    # A reader who names a model gets that model for everything, and it is
    # held once rather than twice.
    aligner = NLIAligner(model_name="some/model", device="cuda")
    assert aligner.model_name == "some/model"
    assert aligner.attribution_model_name == "some/model"


def test_a_cpu_device_holds_one_model() -> None:
    from kiwi.components.align.nli import DEFAULT_MODEL

    aligner = NLIAligner(device="cpu")
    assert aligner.model_name == DEFAULT_MODEL
    assert aligner.attribution_model_name == DEFAULT_MODEL


@pytest.mark.parametrize(
    ("claim", "expected"),
    [
        (
            "The virtual node algorithm was introduced by the cited authors.",
            "In this paper, we introduce the virtual node algorithm.",
        ),
        (
            "The comparison framework is due to the cited authors.",
            "In this paper, we introduce the comparison framework.",
        ),
        (
            "An empirical model of cat populations was developed by the cited authors.",
            "In this paper, we develop an empirical model of cat populations.",
        ),
        (
            "The ECC-based scheme is proposed in the cited work.",
            "In this paper, we propose the ECC-based scheme.",
        ),
    ],
)
def test_an_attribution_claim_is_restated_in_the_cited_authors_voice(
    claim: str, expected: str
) -> None:
    from kiwi.components.align.nli import reframe_attribution

    assert reframe_attribution(claim) == expected


def test_a_subject_opening_with_a_name_keeps_its_capital() -> None:
    from kiwi.components.align.nli import reframe_attribution

    restated = reframe_attribution("Brandes' algorithm was introduced by the cited authors.")
    assert restated == "In this paper, we introduce Brandes' algorithm."


@pytest.mark.parametrize(
    "claim",
    [
        "Transformers are widely used in vision.",
        "The cited work reports a 3 percent improvement.",
        "Accuracy reached 71 percent.",
    ],
)
def test_a_claim_outside_the_pattern_is_left_alone(claim: str) -> None:
    # Rewriting a claim the pattern does not recognise would score
    # something the reader did not write.
    from kiwi.components.align.nli import reframe_attribution

    assert reframe_attribution(claim) == claim


@pytest.mark.parametrize(
    "claim",
    [
        "Breadth-first search was first described in the cited work.",
        "The desert locust was first described by the cited authors.",
        "Lyme disease was first characterised by the cited authors.",
        "Borrelia burgdorferi was first identified by the cited authors.",
    ],
)
def test_a_claim_about_priority_is_not_restated(claim: str) -> None:
    # "First described in the cited work" is a claim about who was first.
    # Restated as "we describe it", it becomes a claim that every paper
    # mentioning the thing satisfies, and the wrong work gets credited.
    from kiwi.components.align.nli import reframe_attribution

    assert reframe_attribution(claim) == claim


def test_a_description_verb_is_restated_when_no_priority_is_claimed() -> None:
    # "Described by the cited authors" is a claim about them describing
    # it, which restates cleanly. Only the priority form does not.
    from kiwi.components.align.nli import reframe_attribution

    restated = reframe_attribution("The desert locust was described by the cited authors.")
    assert restated == "In this paper, we describe the desert locust."


def test_a_verb_outside_the_map_is_never_restated() -> None:
    # The pattern is built from the map, so a verb can only be matched if
    # it has a restatement.
    from kiwi.components.align.nli import _PRESENT_TENSE, reframe_attribution

    for verb in ("observed", "characterised", "identified", "studied"):
        assert verb not in _PRESENT_TENSE
        claim = f"Lyme disease was {verb} by the cited authors."
        assert reframe_attribution(claim) == claim


class _RecordingAligner(_StubAligner):
    """Records the hypothesis each passage was judged against."""

    def __init__(self, distributions: dict[str, dict[str, float]]) -> None:
        super().__init__(distributions)
        self.hypotheses: list[str] = []

    def _distribution(self, model, tokenizer, text, pair):  # type: ignore[no-untyped-def]
        self.hypotheses.append(pair)
        return self._distributions[text]


def test_only_the_attribution_scale_restates_the_claim() -> None:
    claim = "The virtual node algorithm was introduced by the cited authors."
    novel = _novel()

    attribution = _RecordingAligner({novel.anchor.exact: _entail()})
    attribution.align(claim, Intent.ATTRIBUTION, [novel], Depth.QUICK)
    assert attribution.hypotheses == ["In this paper, we introduce the virtual node algorithm."]

    evidence = _RecordingAligner({novel.anchor.exact: _entail()})
    evidence.align(claim, Intent.EVIDENCE, [novel], Depth.QUICK)
    assert evidence.hypotheses == [claim]
