"""Alignment evaluation against a labelled set of claim-citation pairs.

Measured separately from retrieval. A pair records the score a reader
would assign, and the aligner is scored on how often it agrees.

Accuracy alone hides the error that matters. A claim the cited work does
not support, scored 2, is a false endorsement, and it is reported on its
own.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from kiwi.claims import EVIDENCE_SUPPORTED


@dataclass(frozen=True)
class AlignmentPair:
    claim: str
    citation: str
    label: int


@dataclass(frozen=True)
class AlignmentMetrics:
    accuracy: float
    per_label: dict[int, float]
    false_endorsement: float
    missed_support: float
    n: int


def load_alignment_set(path: Path) -> list[AlignmentPair]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        AlignmentPair(claim=p["claim"], citation=p["citation"], label=p["label"])
        for p in payload["pairs"]
    ]


def compute_alignment_metrics(
    labels: list[int], predictions: list[int], supported: int = EVIDENCE_SUPPORTED
) -> AlignmentMetrics:
    """Agreement between predicted and labelled scores.

    ``false_endorsement`` is the share of unsupported claims given the
    supporting score, and ``missed_support`` the share of supported claims
    given anything else. ``supported`` is 2 on the evidence scale and 1 on
    the binary attribution scale, where the supporting score is 1.
    """
    n = len(labels)
    if n == 0:
        return AlignmentMetrics(0.0, {}, 0.0, 0.0, 0)

    paired = list(zip(labels, predictions, strict=True))
    correct = sum(1 for label, predicted in paired if label == predicted)

    per_label: dict[int, float] = {}
    for value in (0, 1, 2):
        total = sum(1 for label in labels if label == value)
        hits = sum(
            1
            for label, predicted in zip(labels, predictions, strict=True)
            if label == value and predicted == value
        )
        per_label[value] = hits / total if total else 0.0

    unsupported_preds = [p for label, p in paired if label != supported]
    supported_preds = [p for label, p in paired if label == supported]

    return AlignmentMetrics(
        accuracy=correct / n,
        per_label=per_label,
        false_endorsement=(
            sum(1 for p in unsupported_preds if p == supported) / len(unsupported_preds)
            if unsupported_preds
            else 0.0
        ),
        missed_support=(
            sum(1 for p in supported_preds if p != supported) / len(supported_preds)
            if supported_preds
            else 0.0
        ),
        n=n,
    )
