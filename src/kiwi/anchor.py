"""Anchor resolution.

Relocates a passage inside a document after the underlying text changes,
for example after a re-parse by a different Ingestor. Used to resolve
citations, annotations, evidence passages, and suggestions. See
docs/01-identifiers.md, "Resolution".

Resolution order:

1. Position selector: does ``text[start:end]`` still equal ``exact``?
2. Quote selector, exact search: is ``exact`` found once, or several times
   disambiguated by ``prefix``/``suffix``?
3. Quote selector, tolerant search: same, but whitespace runs, quotation
   mark variants, and line-break hyphenation are matched loosely.
4. Quote selector, fuzzy search: best window within 5% edit distance.
5. Otherwise: unanchored. ``exact`` is preserved, never discarded.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, replace
from enum import Enum

from kiwi.types import Anchor

_QUOTE_CHARS = "\"'‘’“”«»"
_QUOTE_CLASS = "[" + re.escape(_QUOTE_CHARS) + "]"


class AnchorState(Enum):
    ANCHORED = "anchored"
    SHIFTED = "shifted"
    AMBIGUOUS = "ambiguous"
    UNANCHORED = "unanchored"


@dataclass(frozen=True)
class Resolution:
    state: AnchorState
    anchor: Anchor


def resolve(anchor: Anchor, text: str) -> Resolution:
    """Relocate ``anchor`` inside ``text``, following the five-step order."""
    if _at_position(anchor, text):
        return Resolution(AnchorState.ANCHORED, anchor)

    outcome = _resolve_matches(anchor, _plain_matches(anchor.exact, text), text)
    if outcome is not None:
        return outcome

    pattern = _tolerant_pattern(anchor.exact)
    if pattern is not None:
        matches = [m.span() for m in pattern.finditer(text)]
        outcome = _resolve_matches(anchor, matches, text)
        if outcome is not None:
            return outcome

    span = _fuzzy_find(text, anchor.exact)
    if span is not None:
        start, end = span
        return Resolution(
            AnchorState.SHIFTED,
            replace(anchor, start=start, end=end, exact=text[start:end]),
        )

    return Resolution(AnchorState.UNANCHORED, anchor)


def _at_position(anchor: Anchor, text: str) -> bool:
    if anchor.start < 0 or anchor.end < anchor.start or anchor.end > len(text):
        return False
    return text[anchor.start : anchor.end] == anchor.exact


def _plain_matches(needle: str, text: str) -> list[tuple[int, int]]:
    if not needle:
        return []
    matches: list[tuple[int, int]] = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        matches.append((idx, idx + len(needle)))
        start = idx + len(needle)
    return matches


def _resolve_matches(
    anchor: Anchor, matches: list[tuple[int, int]], text: str
) -> Resolution | None:
    """Resolve a list of candidate match spans to a single Resolution.

    One match resolves directly. Several matches are disambiguated by
    comparing each one's surrounding text to ``anchor.prefix`` and
    ``anchor.suffix``; if exactly one candidate matches, that one
    resolves, otherwise the result is AMBIGUOUS. Returns None for zero
    matches, so the caller can fall through to a more permissive search.
    """
    if len(matches) == 1:
        start, end = matches[0]
        return Resolution(
            AnchorState.SHIFTED, replace(anchor, start=start, end=end, exact=text[start:end])
        )
    if len(matches) > 1:
        survivors = [m for m in matches if _context_matches(anchor, m, text)]
        if len(survivors) == 1:
            start, end = survivors[0]
            return Resolution(
                AnchorState.SHIFTED,
                replace(anchor, start=start, end=end, exact=text[start:end]),
            )
        return Resolution(AnchorState.AMBIGUOUS, anchor)
    return None


def _context_matches(anchor: Anchor, span: tuple[int, int], text: str) -> bool:
    start, end = span
    pre_len = len(anchor.prefix)
    suf_len = len(anchor.suffix)
    actual_prefix = text[max(0, start - pre_len) : start]
    actual_suffix = text[end : end + suf_len]
    return actual_prefix == anchor.prefix and actual_suffix == anchor.suffix


def _tolerant_pattern(needle: str) -> re.Pattern[str] | None:
    """Build a regex matching ``needle`` up to whitespace, quote, and
    line-break-hyphenation variation."""
    if not needle:
        return None
    normalized = unicodedata.normalize("NFC", needle)
    parts: list[str] = []
    i, n = 0, len(normalized)
    while i < n:
        ch = normalized[i]
        if ch == "-":
            j = i + 1
            while j < n and normalized[j].isspace():
                j += 1
            if j > i + 1:
                parts.append(r"(?:-\s*)?")
            else:
                parts.append(r"-?")
            i = j if j > i + 1 else i + 1
            continue
        if ch.isspace():
            j = i + 1
            while j < n and normalized[j].isspace():
                j += 1
            parts.append(r"\s+")
            i = j
            continue
        if ch in _QUOTE_CHARS:
            parts.append(_QUOTE_CLASS)
            i += 1
            continue
        decomposed = unicodedata.normalize("NFD", ch)
        if decomposed != ch:
            # Tolerate a precomposed character (e.g. U+00E9 'e') matching its
            # decomposed form (U+0065 U+0301) without touching document text,
            # which would otherwise require remapping every offset downstream.
            parts.append("(?:" + re.escape(ch) + "|" + re.escape(decomposed) + ")")
        else:
            parts.append(re.escape(ch))
        i += 1
    try:
        return re.compile("".join(parts))
    except re.error:
        return None


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def _fuzzy_find(text: str, needle: str, max_edit_ratio: float = 0.05) -> tuple[int, int] | None:
    if not needle or not text:
        return None
    matcher = difflib.SequenceMatcher(None, text, needle, autojunk=False)
    anchor_block = matcher.find_longest_match(0, len(text), 0, len(needle))
    if anchor_block.size == 0:
        return None

    needle_len = len(needle)
    tolerance = max(1, round(needle_len * max_edit_ratio))
    approx_start = anchor_block.a - anchor_block.b

    best: tuple[int, int, int] | None = None
    lo = max(0, approx_start - tolerance)
    hi = min(len(text), approx_start + tolerance)
    for start in range(lo, hi + 1):
        for length in range(max(1, needle_len - tolerance), needle_len + tolerance + 1):
            end = start + length
            if end > len(text):
                continue
            distance = _levenshtein(text[start:end], needle)
            if distance <= tolerance and (best is None or distance < best[2]):
                best = (start, end, distance)
    if best is None:
        return None
    return best[0], best[1]
