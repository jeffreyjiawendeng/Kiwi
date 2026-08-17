"""Claims extracted from draft Markdown.

A claim is one sentence carrying one citation. A sentence citing several
works produces one claim per citation. The claim text ends at the first
citation marker, so the marker itself is context rather than part of the
claim being scored.

The score scales are defined here as well, because a score read on the
scale the claim was not judged against reports the opposite of what was
measured.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import pairwise

from kiwi.types import Alignment, Anchor, Intent

CITATION_RE = re.compile(r"\[@(doc_[0-9a-f]{16})\]")

_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
_CONTEXT_CHARS = 32

# A sentence also ends where the Markdown block does. A heading and a
# list item carry no full stop, so without these a heading joins the
# paragraph beneath it and the claim reads as though the heading were
# part of what was asserted.
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")
_BLOCK_LINE = re.compile(r"^[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t])", re.MULTILINE)

# Markers that introduce a clause rather than a list item.
_CLAUSE_BOUNDARY = re.compile(
    r";|,?\s+(?:though|although|however|whereas|while|but|yet)\s+",
    re.IGNORECASE,
)

# A comma followed by "and" joins predicates and noun phrases alike, so
# it separates assertions only where a predicate follows. Without this
# test, "and 6 Gb of RAM" becomes an assertion that was never made.
_COORDINATION = re.compile(r",\s+and\s+", re.IGNORECASE)
_AUXILIARIES = frozenset(
    {
        "was",
        "were",
        "is",
        "are",
        "has",
        "have",
        "had",
        "can",
        "could",
        "will",
        "would",
        "may",
        "might",
        "should",
        "must",
        "does",
        "do",
        "did",
    }
)
_MIN_CLAUSE_WORDS = 3

DETECTED = "detected"
MANUAL = "manual"

# Evidence runs 0 to 2 and attribution 0 to 1, so the score that reports
# support differs by intent. Zero is the lowest score on either scale:
# the cited work contradicts the claim, or is not its origin.
EVIDENCE_SUPPORTED = 2
EVIDENCE_RELEVANT = 1
ATTRIBUTED = 1
REJECTED = 0

# Intents scored against the cited work. A claim carrying any other
# intent records why the work is cited and is not scored.
SCORED_INTENTS = frozenset({Intent.EVIDENCE, Intent.ATTRIBUTION})


def supporting_score(intent: Intent) -> int:
    """The score reporting that the cited work carries the claim."""
    return ATTRIBUTED if intent is Intent.ATTRIBUTION else EVIDENCE_SUPPORTED


@dataclass(frozen=True)
class Claim:
    anchor: Anchor
    citation: str
    intent: Intent
    intent_source: str = DETECTED
    alignment: Alignment | None = None
    deep_alignment: Alignment | None = None
    deep_claim: str | None = None

    @property
    def deep_is_stale(self) -> bool:
        """Whether the deep result was computed from text that has changed.

        A stale result is still reported. Removing it would leave nothing
        where a judgement used to be, and showing it unmarked would
        present a verdict about text that no longer exists.
        """
        return self.deep_alignment is not None and self.deep_claim != self.anchor.exact


def decompose(claim: str) -> list[str]:
    """Split a claim into the assertions a reader would check separately.

    Returns the claim unchanged when it carries a single assertion, so a
    caller can always score the returned parts. Fragments shorter than
    ``_MIN_CLAUSE_WORDS`` are not assertions on their own and are kept
    with the claim rather than split out.
    """
    parts: list[str] = []
    for clause in _CLAUSE_BOUNDARY.split(claim):
        parts.extend(_split_coordination(clause))
    parts = [part.strip(" ,;:") for part in parts]
    parts = [part for part in parts if len(part.split()) >= _MIN_CLAUSE_WORDS]
    return parts if len(parts) > 1 else [claim]


def _starts_with_predicate(text: str) -> bool:
    first = text.split(maxsplit=1)[0].lower().strip(",.;:") if text.split() else ""
    return first in _AUXILIARIES or first.endswith(("ed", "es"))


def _split_coordination(clause: str) -> list[str]:
    parts = _COORDINATION.split(clause)
    if len(parts) == 1:
        return parts
    merged = [parts[0]]
    for part in parts[1:]:
        if _starts_with_predicate(part):
            merged.append(part)
        else:
            merged[-1] = f"{merged[-1]}, and {part}"
    return merged


def _block_spans(text: str) -> list[tuple[int, int]]:
    """Spans between paragraph breaks, with a heading or list item its own
    block.

    Splitting on terminal punctuation alone runs a heading into the
    paragraph after it, because a heading has no terminal punctuation to
    split on.
    """
    bounds = {0, len(text)}
    for match in _PARAGRAPH_BREAK.finditer(text):
        bounds.update((match.start(), match.end()))
    for match in _BLOCK_LINE.finditer(text):
        line_end = text.find("\n", match.start())
        # Both edges of the marker: what follows a bullet is the claim,
        # and the bullet itself is not part of what was asserted.
        bounds.update((match.start(), match.end(), len(text) if line_end == -1 else line_end))
    return list(pairwise(sorted(bounds)))


def _trimmed(text: str, start: int, end: int) -> tuple[int, int]:
    """The span without its surrounding whitespace, so a claim's offsets
    cover the claim rather than the blank line before it."""
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for block_start, block_end in _block_spans(text):
        block = text[block_start:block_end]
        cursor = 0
        for match in _SENTENCE_BOUNDARY.finditer(block):
            spans.append((block_start + cursor, block_start + match.start()))
            cursor = match.end()
        spans.append((block_start + cursor, block_end))
    return [_trimmed(text, s, e) for s, e in spans if text[s:e].strip()]


def extract_claims(text: str, page_id: str) -> list[Claim]:
    """Find every cited sentence in ``text``.

    Claims are returned in document order. Uncited sentences produce
    nothing, and a sentence with no citation marker is not a claim.
    """
    claims: list[Claim] = []
    for sentence_start, sentence_end in _sentence_spans(text):
        sentence = text[sentence_start:sentence_end]
        markers = list(CITATION_RE.finditer(sentence))
        if not markers:
            continue

        claim_text = sentence[: markers[0].start()].rstrip()
        if not claim_text:
            continue
        start = sentence_start
        end = sentence_start + len(claim_text)

        for marker in markers:
            claims.append(
                Claim(
                    anchor=Anchor(
                        document_id=page_id,
                        section_path="",
                        start=start,
                        end=end,
                        exact=claim_text,
                        prefix=text[max(0, start - _CONTEXT_CHARS) : start],
                        suffix=text[end : end + _CONTEXT_CHARS],
                    ),
                    citation=marker.group(1),
                    intent=Intent.EVIDENCE,
                )
            )
    return claims
