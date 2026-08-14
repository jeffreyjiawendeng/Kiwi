"""Measure whether a generated answer stays inside its passages.

An answer is synthesised from retrieved passages and is told to end every
factual sentence with the passage number supporting it. Three things can
go wrong, and each is reported here:

    uncited     a sentence asserts something and cites nothing, so a
                reader has nothing to check it against
    ungrounded  a sentence cites a passage that does not support it
    dangling    a bracketed number refers to a passage that was never
                supplied, which the reader still sees in the text

Groundedness is judged by the same Aligner that scores claims, against
the passage the sentence itself cites.

    KIWI_GENERATOR_MODEL=ollama/qwen2.5:7b-instruct \
        uv run python eval/_answers.py --project eval/workspace.kiwi \
            --golden eval/golden.json
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from kiwi.claims import EVIDENCE_SUPPORTED, REJECTED
from kiwi.core import retrieve
from kiwi.evaluation import load_golden_set
from kiwi.registry import default_aligner, default_generator
from kiwi.types import Depth, Intent

_MARKER = re.compile(r"\[(\d+)\]")
# A sentence boundary or a line break. An answer is written in markdown,
# and a list item is an assertion whether or not it ends in a full stop.
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")
_MIN_WORDS = 5


@dataclass(frozen=True)
class AnswerMetrics:
    sentences: int
    uncited: float
    grounded: float
    ungrounded: float
    contradicted: float
    dangling: int
    refused: int
    n: int


@dataclass(frozen=True)
class SentenceCheck:
    cited: tuple[int, ...]
    dangling: tuple[int, ...]
    plain: str


def _sentences(text: str) -> list[str]:
    """Substantive sentences. A short fragment carries no claim to check."""
    return [s.strip() for s in _SENTENCE.split(text) if len(s.split()) >= _MIN_WORDS]


def check_sentence(sentence: str, passages: int) -> SentenceCheck:
    """Split a sentence's bracketed references into those that name a
    supplied passage and those that name one that was never supplied.

    A dangling reference is reported rather than dropped. The reader sees
    the bracket in the answer either way, so a reference to a passage
    that does not exist is a reference that cannot be checked.
    """
    numbers = [int(n) for n in _MARKER.findall(sentence)]
    return SentenceCheck(
        cited=tuple(n for n in numbers if 1 <= n <= passages),
        dangling=tuple(n for n in numbers if not 1 <= n <= passages),
        plain=_MARKER.sub("", sentence).strip(),
    )


def evaluate(
    project: Path, golden: Path, passages: int, show: int = 0
) -> tuple[AnswerMetrics, list[str]]:
    generator = default_generator()
    if generator is None:
        raise SystemExit("No Generator configured. Set KIWI_GENERATOR_MODEL.")
    aligner = default_aligner()
    if aligner is None:
        raise SystemExit("No Aligner configured.")

    queries = sorted({pair.query for pair in load_golden_set(golden)})
    total = uncited = grounded = ungrounded = contradicted = dangling = refused = 0
    without_citation: list[str] = []

    for index, query in enumerate(queries, start=1):
        hits = retrieve(project, query, passages)
        answer = generator.generate(query, hits)
        chunks = [hit.chunk for hit in hits]

        if not answer.citations and "do not" in answer.text.lower()[:200]:
            # A refusal to answer is the intended response to passages
            # that do not address the question, not an ungrounded answer.
            refused += 1

        for sentence in _sentences(answer.text):
            total += 1
            check = check_sentence(sentence, len(chunks))
            dangling += len(check.dangling)
            if not check.cited and not check.dangling:
                uncited += 1
                if len(without_citation) < show:
                    without_citation.append(sentence)
                continue
            if not check.cited:
                continue
            scores = [
                aligner.align(check.plain, Intent.EVIDENCE, [chunks[n - 1]], Depth.QUICK).score
                for n in check.cited
            ]
            if EVIDENCE_SUPPORTED in scores:
                grounded += 1
            elif all(score == REJECTED for score in scores):
                contradicted += 1
                ungrounded += 1
            else:
                ungrounded += 1
        if index % 10 == 0:
            # Progress goes to stderr so that stdout carries results
            # alone. A carriage return on stdout runs the next line into
            # the counter.
            print(f"  answered {index}/{len(queries)}", end="\r", file=sys.stderr)

    n = max(total, 1)
    return AnswerMetrics(
        sentences=total,
        uncited=uncited / n,
        grounded=grounded / n,
        ungrounded=ungrounded / n,
        contradicted=contradicted / n,
        dangling=dangling,
        refused=refused,
        n=len(queries),
    ), without_citation


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path("eval/workspace.kiwi"))
    parser.add_argument("--golden", type=Path, default=Path("eval/golden.json"))
    parser.add_argument("--passages", type=int, default=5)
    parser.add_argument("--show", type=int, default=0, help="Print N uncited sentences.")
    args = parser.parse_args()

    metrics, uncited_examples = evaluate(args.project, args.golden, args.passages, args.show)
    print(f"\n{metrics.n} questions, {metrics.sentences} answer sentences\n")
    print(f"grounded     : {metrics.grounded:.3f}")
    print(f"uncited      : {metrics.uncited:.3f}")
    print(f"ungrounded   : {metrics.ungrounded:.3f}")
    print(f"  contradicted by the passage it cites : {metrics.contradicted:.3f}")
    print(f"dangling references : {metrics.dangling}")
    print(f"questions refused   : {metrics.refused}")
    if uncited_examples:
        print("\nuncited sentences:")
        for sentence in uncited_examples:
            print(f"  {sentence}")
