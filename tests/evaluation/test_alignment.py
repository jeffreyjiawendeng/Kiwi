from __future__ import annotations

import json
from pathlib import Path

from kiwi.evaluation import compute_alignment_metrics, load_alignment_set


def test_load_alignment_set(tmp_path: Path) -> None:
    path = tmp_path / "alignment.json"
    path.write_text(
        json.dumps(
            {"pairs": [{"claim": "A claim.", "citation": "doc_aaaaaaaaaaaaaaaa", "label": 2}]}
        ),
        encoding="utf-8",
    )
    pairs = load_alignment_set(path)
    assert len(pairs) == 1
    assert pairs[0].claim == "A claim."
    assert pairs[0].label == 2


def test_perfect_agreement_scores_one() -> None:
    metrics = compute_alignment_metrics([2, 1, 0], [2, 1, 0])
    assert metrics.accuracy == 1.0
    assert metrics.per_label == {0: 1.0, 1: 1.0, 2: 1.0}
    assert metrics.false_endorsement == 0.0
    assert metrics.missed_support == 0.0


def test_false_endorsement_counts_unsupported_claims_scored_two() -> None:
    # Two unsupported claims (labels 0 and 1); one of them is scored 2.
    metrics = compute_alignment_metrics([0, 1, 2], [2, 1, 2])
    assert metrics.false_endorsement == 0.5
    assert metrics.missed_support == 0.0


def test_missed_support_counts_supported_claims_scored_below_two() -> None:
    metrics = compute_alignment_metrics([2, 2, 0], [1, 2, 0])
    assert metrics.missed_support == 0.5
    assert metrics.false_endorsement == 0.0


def test_per_label_recall_is_reported_for_absent_labels() -> None:
    metrics = compute_alignment_metrics([2, 2], [2, 2])
    assert metrics.per_label[0] == 0.0
    assert metrics.per_label[1] == 0.0
    assert metrics.per_label[2] == 1.0


def test_empty_set_reports_zeroes() -> None:
    metrics = compute_alignment_metrics([], [])
    assert metrics.n == 0
    assert metrics.accuracy == 0.0


def test_attribution_metrics_use_one_as_the_supporting_score() -> None:
    # On the binary scale a score of 1 is the credit, so crediting a claim
    # labelled 0 is the silent error, not a score of 2 that never occurs.
    metrics = compute_alignment_metrics([0, 0, 1], [1, 0, 1], supported=1)
    assert metrics.false_endorsement == 0.5
    assert metrics.missed_support == 0.0


def test_evidence_metrics_are_unchanged_by_the_default() -> None:
    metrics = compute_alignment_metrics([0, 1, 2], [2, 1, 2])
    assert metrics.false_endorsement == 0.5
    assert metrics.missed_support == 0.0


def test_shipped_attribution_set_is_well_formed() -> None:
    pairs = load_alignment_set(Path("eval/attribution.json"))
    assert len(pairs) >= 15
    assert {p.label for p in pairs} == {0, 1}


def test_shipped_alignment_set_is_well_formed() -> None:
    pairs = load_alignment_set(Path("eval/alignment.json"))
    assert len(pairs) >= 40
    assert {p.label for p in pairs} == {0, 1, 2}
    assert all(p.citation.startswith("doc_") for p in pairs)
    assert all(p.claim.strip() for p in pairs)
