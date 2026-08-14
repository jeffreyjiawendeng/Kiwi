"""Revision evaluation: whether a suggested rewrite repairs the claim.

A claim scored 0 is one its citation contradicts. The suggestion proposed
for it is a repair when the rewritten claim scores as supported against
the same evidence, and the rewrite still asserts something.

The aligner is both the source of the flag and the judge of the repair,
so a rewrite that games the aligner counts as a repair here. Three guards
narrow that. A rewrite that drops most of the claim is counted apart from
a repair, as is one that only negates it, and hedging into a score of 1 is
reported separately from reaching support.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from kiwi.claims import REJECTED, supporting_score
from kiwi.protocols import Aligner, Generator
from kiwi.types import Chunk, Depth, Intent

# A rewrite shorter than this share of the original has cut the assertion
# out rather than corrected it.
RETENTION_FLOOR = 0.5

# Inserting one of these into a claim satisfies the evidence without
# saying anything the claim did not already say. It is less work than a
# correction and scores the same, so it is counted apart from one.
_NEGATIONS = frozenset({"not", "no", "never", "cannot", "nor", "none", "n't"})


@dataclass(frozen=True)
class RevisionMetrics:
    repaired: float  # share of flagged claims whose rewrite reaches support
    hedged: float  # share whose rewrite lands on the middle score
    unrepaired: float  # share still contradicted after rewriting
    gutted: float  # share whose rewrite dropped the assertion
    negated: float  # share whose rewrite only reversed the claim
    n: int


def _retained(original: str, proposed: str) -> bool:
    return len(proposed.split()) >= RETENTION_FLOOR * len(original.split())


def _only_negates(original: str, proposed: str) -> bool:
    """Whether the rewrite differs from the claim only by a negation."""
    difference = set(original.lower().split()) ^ set(proposed.lower().split())
    return bool(difference) and difference <= _NEGATIONS


def evaluate_revisions(
    claims: Sequence[str],
    evidence: Sequence[Sequence[Chunk]],
    generator: Generator,
    aligner: Aligner,
    instructions: Sequence[str],
    intent: Intent = Intent.EVIDENCE,
) -> RevisionMetrics:
    """Rewrite each claim against its evidence and re-score the result.

    ``claims``, ``evidence``, and ``instructions`` are parallel. Each claim
    is rewritten under an instruction carrying its own evidence passage and
    re-scored against the passages retrieved for it, so a repair is
    measured against the evidence that produced the flag rather than
    against another claim's.
    """
    if not claims:
        return RevisionMetrics(0.0, 0.0, 0.0, 0.0, 0.0, 0)

    supported = supporting_score(intent)
    repaired = hedged = unrepaired = gutted = negated = 0

    for claim, passages, instruction in zip(claims, evidence, instructions, strict=True):
        proposals = generator.suggest(claim, instruction)
        proposal = proposals[0] if proposals else ""
        if not proposal or not _retained(claim, proposal):
            gutted += 1
            continue
        if _only_negates(claim, proposal):
            negated += 1
            continue

        score = aligner.align(proposal, intent, list(passages), Depth.QUICK).score
        if score == supported:
            repaired += 1
        elif score == REJECTED:
            unrepaired += 1
        else:
            hedged += 1

    n = len(claims)
    return RevisionMetrics(
        repaired=repaired / n,
        hedged=hedged / n,
        unrepaired=unrepaired / n,
        gutted=gutted / n,
        negated=negated / n,
        n=n,
    )


__all__ = ["RETENTION_FLOOR", "RevisionMetrics", "evaluate_revisions"]
