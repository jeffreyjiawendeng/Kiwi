"""Reading a paper's title off its first page.

Parsers do not always find one. GROBID returns an empty title for papers
whose front matter it cannot segment, and a PDF's own metadata is usually
blank or carries the LaTeX source of the title rather than the title.

A title is the largest horizontal text near the top of the first page,
and it is the only thing on that page set that large. That holds across
publishers because it is what makes a title legible as one.

Three things defeat a simpler rule, and are handled here:

    the arXiv identifier down the left margin is set larger than some
    titles, and is rotated

    a font size is meaningless on its own, because a PDF may set every
    glyph at size 1 and scale it through the text matrix instead

    a title is often several lines, and small capitals within it are set
    at a different size from the rest of the same line
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import replace
from pathlib import Path

from kiwi.types import Document

# Text that is set large but is never the title.
_NOT_A_TITLE = re.compile(
    r"^\s*(?:arxiv[:\s]|https?://|www\.|doi[:\s]|preprint\b|under review\b|"
    r"published as\b|to appear\b|proceedings\b|workshop\b|conference on\b|"
    r"technical report\b|\d{1,2}(?:st|nd|rd|th)\s+(?:international|annual)\b)",
    re.IGNORECASE,
)

# Two words or more. A lone run of digits or one word is a page number, a
# footnote marker, or a section number.
_HAS_WORDS = re.compile(r"[A-Za-z]{2,}\s+\S")

MIN_LENGTH = 12
MAX_LENGTH = 300

# Lines within this fraction of the largest line's size belong to the same
# heading, which is how a title that runs to three lines stays whole.
_SIZE_TOLERANCE = 0.12
_LINE_TOLERANCE = 1.5


def _tidy(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" \t\n\r-–—*†‡§")


def _lines(path: Path | str) -> list[tuple[float, float, str]]:
    """Every horizontal line of the first page as (size, top, text)."""
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - pypdf is a dependency
        return []

    try:
        page = PdfReader(str(path)).pages[0]
    except Exception:  # pragma: no cover - a PDF too broken to page through
        return []

    runs: list[tuple[float, float, str]] = []

    def visit(text: str, _cm: object, tm: list[float], _font: object, size: float) -> None:
        if not text.strip():
            return
        # A rotated run is a margin stamp, not a title.
        if abs(tm[1]) > 0.01 or abs(tm[2]) > 0.01:
            return
        # The matrix carries the scale. Some documents set every glyph at
        # size 1 and scale it here instead, and comparing the raw sizes
        # then makes every line identical.
        scale = abs(tm[0]) or abs(tm[3]) or 1.0
        runs.append((size * scale, tm[5], text))

    try:
        page.extract_text(visitor_text=visit)
    except Exception:  # pragma: no cover - extraction failure is not a title
        return []

    grouped: dict[float, list[tuple[float, str]]] = defaultdict(list)
    for size, top, text in runs:
        # A line is a band rather than an exact position: superscripts and
        # small capitals sit a fraction off their own baseline.
        key = next(
            (k for k in grouped if abs(k - top) <= _LINE_TOLERANCE),
            round(top, 1),
        )
        grouped[key].append((size, text))

    return [
        (max(size for size, _ in parts), top, _tidy("".join(text for _, text in parts)))
        for top, parts in grouped.items()
    ]


def title_from_pdf(path: Path | str) -> str:
    """The title read from the first page, or the empty string.

    Returns the empty string rather than guessing when nothing on the page
    qualifies, so a caller can fall back to something it trusts more.
    """
    lines = [line for line in _lines(path) if line[2]]
    if not lines:
        return ""

    tops = [top for _, top, _ in lines]
    span = max(tops) - min(tops)
    # The title sits in the upper part of the page. Body text set large,
    # such as a section opener, is below it.
    ceiling = max(tops) - span * 0.4 if span else min(tops)
    upper = sorted((line for line in lines if line[1] >= ceiling), key=lambda line: -line[1])
    if not upper:
        return ""

    for size, _, _ in sorted(upper, key=lambda line: -line[0]):
        # Every line of this heading, in reading order: the largest line
        # and its neighbours set within a fraction of the same size.
        block = [line for line in upper if abs(line[0] - size) <= size * _SIZE_TOLERANCE]
        # Keep only the run of them that is contiguous down the page.
        chosen: list[str] = []
        started = False
        for line in upper:
            if line in block:
                chosen.append(line[2])
                started = True
            elif started:
                break

        candidate = _tidy(" ".join(chosen))
        if len(candidate) < MIN_LENGTH or len(candidate) > MAX_LENGTH:
            continue
        if _NOT_A_TITLE.match(candidate) or not _HAS_WORDS.search(candidate):
            continue
        return candidate

    return ""


def with_title_from_page(document: Document, source: Path) -> Document:
    """``document`` with a title read from the page when it has none.

    A parser that finds no title leaves the paper indistinguishable from
    every other paper it also could not read.
    """
    if str(document.metadata.get("title") or "").strip():
        return document
    title = title_from_pdf(source)
    if not title:
        return document
    return replace(document, metadata={**document.metadata, "title": title})
