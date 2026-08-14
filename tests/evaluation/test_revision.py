from __future__ import annotations

from collections.abc import Sequence

from kiwi.evaluation import evaluate_revisions
from kiwi.types import Alignment, Anchor, Answer, Chunk, Depth, Health, Hit, Intent

CLAIM = "Accuracy exceeded 95 percent on every corpus"
PASSAGE = "Accuracy reached 71 percent on the CS corpus"


def _chunk() -> Chunk:
    return Chunk(
        chunk_id="chk_aaaaaaaaaaaaaaaa_0000",
        anchor=Anchor(
            document_id="doc_aaaaaaaaaaaaaaaa",
            section_path="Results",
            start=0,
            end=len(PASSAGE),
            exact=PASSAGE,
            prefix="",
            suffix="",
        ),
        text=PASSAGE,
        section_path="Results",
    )


class _Generator:
    name = "stub"

    def __init__(self, proposal: str) -> None:
        self.proposal = proposal

    def health(self) -> Health:
        return Health(ok=True, detail="stub")

    def generate(self, query: str, passages: Sequence[Hit]) -> Answer:
        return Answer(text="", citations=(), generator=self.name)

    def suggest(self, text: str, instruction: str) -> list[str]:
        return [self.proposal] if self.proposal else []


class _Aligner:
    name = "stub"

    def __init__(self, score: int) -> None:
        self.score = score
        self.scored: list[str] = []

    def health(self) -> Health:
        return Health(ok=True, detail="stub")

    def detect_intent(self, claim: str, context: str) -> Intent:
        return Intent.EVIDENCE

    def align(
        self, claim: str, intent: Intent, evidence: Sequence[Chunk], depth: Depth
    ) -> Alignment:
        self.scored.append(claim)
        return Alignment(score=self.score, intent=intent, depth=depth, evidence=None, model="stub")


def _run(proposal: str, rescored: int):
    return evaluate_revisions(
        claims=[CLAIM],
        evidence=[[_chunk()]],
        generator=_Generator(proposal),
        aligner=_Aligner(rescored),
        instruction="revise against the passage",
    )


def test_a_rewrite_that_reaches_support_counts_as_a_repair() -> None:
    metrics = _run("Accuracy reached 71 percent on the CS corpus", rescored=2)
    assert metrics.repaired == 1.0
    assert metrics.hedged == 0.0
    assert metrics.unrepaired == 0.0
    assert metrics.n == 1


def test_a_rewrite_that_only_hedges_is_reported_separately() -> None:
    # Landing on the middle score is not a repair. Counting it as one
    # would report hedging as a fix.
    metrics = _run("Accuracy was high on the corpora studied here", rescored=1)
    assert metrics.repaired == 0.0
    assert metrics.hedged == 1.0


def test_a_rewrite_the_evidence_still_contradicts_is_unrepaired() -> None:
    metrics = _run("Accuracy exceeded 90 percent on every corpus", rescored=0)
    assert metrics.unrepaired == 1.0
    assert metrics.repaired == 0.0


def test_a_rewrite_that_drops_the_assertion_is_not_a_repair() -> None:
    # Deleting the claim satisfies any judge, so a rewrite that keeps too
    # little of the original is counted apart from a repair.
    metrics = _run("Accuracy varied", rescored=2)
    assert metrics.gutted == 1.0
    assert metrics.repaired == 0.0


def test_an_empty_proposal_is_not_a_repair() -> None:
    metrics = _run("", rescored=2)
    assert metrics.gutted == 1.0


def test_the_rewrite_is_what_gets_rescored_not_the_original() -> None:
    aligner = _Aligner(2)
    proposal = "Accuracy reached 71 percent on the CS corpus"
    evaluate_revisions(
        claims=[CLAIM],
        evidence=[[_chunk()]],
        generator=_Generator(proposal),
        aligner=aligner,
        instruction="revise",
    )
    assert aligner.scored == [proposal]


def test_an_empty_set_reports_zeroes() -> None:
    metrics = evaluate_revisions([], [], _Generator("x"), _Aligner(2), "revise")
    assert metrics.n == 0
    assert metrics.repaired == 0.0
