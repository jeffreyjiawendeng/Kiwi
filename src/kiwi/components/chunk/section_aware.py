"""Section-aware chunker.

Chunk boundaries follow the smallest structural division the Ingestor
identified. A section that exceeds the token budget is split further, on
sentence boundaries: the Ingestor's normalised text collapses paragraph
breaks to single spaces, so paragraphs cannot be recovered here.
"""

from __future__ import annotations

import os
import re
from collections.abc import Sequence

from kiwi.types import Anchor, Chunk, Document, Health, Section

# The band a chunk aims for. A section under the target is left whole; one
# over it is packed sentence by sentence until each span reaches the
# minimum. ``KIWI_CHUNK_TOKENS`` sets the target, and the minimum tracks it
# at half, which keeps the band's shape when the target moves. Changing
# either requires re-indexing, since chunk boundaries move with them. See
# eval/README.md for the measured settings.
TARGET_TOKENS = 768
MIN_TOKENS = 384
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
_CONTEXT_CHARS = 32


def _approx_tokens(text: str) -> int:
    # A word-count approximation. Exact tokenisation is embedder-specific
    # and the Chunker protocol takes no Embedder, so precise counts aren't
    # available here. The target band is tuned against measured retrieval
    # quality rather than token exactness. See eval/README.md.
    return len(text.split())


def _direct_children(section: Section, sections: Sequence[Section]) -> list[Section]:
    return [
        s
        for s in sections
        if s is not section
        and s.level == section.level + 1
        and s.start >= section.start
        and s.end <= section.end
    ]


def _own_content_spans(start: int, end: int, children: Sequence[Section]) -> list[tuple[int, int]]:
    """Gaps in ``[start, end)`` not covered by any direct child section."""
    spans: list[tuple[int, int]] = []
    cursor = start
    for child in sorted(children, key=lambda c: c.start):
        if child.start > cursor:
            spans.append((cursor, child.start))
        cursor = max(cursor, child.end)
    if cursor < end:
        spans.append((cursor, end))
    return spans


def _split_oversized(text_start: int, text: str, min_tokens: int) -> list[tuple[int, int]]:
    """Greedily pack sentences into spans within the target token band."""
    sentence_bounds: list[tuple[int, int]] = []
    cursor = 0
    for match in _SENTENCE_BOUNDARY.finditer(text):
        sentence_bounds.append((cursor, match.start()))
        cursor = match.end()
    sentence_bounds.append((cursor, len(text)))

    spans: list[tuple[int, int]] = []
    span_start: int | None = None
    span_end: int | None = None
    token_count = 0
    for s_start, s_end in sentence_bounds:
        sentence = text[s_start:s_end]
        if not sentence.strip():
            continue
        if span_start is None:
            span_start = s_start
        span_end = s_end
        token_count += _approx_tokens(sentence)
        if token_count >= min_tokens:
            spans.append((text_start + span_start, text_start + span_end))
            span_start, span_end, token_count = None, None, 0
    if span_start is not None and span_end is not None:
        spans.append((text_start + span_start, text_start + span_end))
    return spans


def _split_if_needed(
    text: str, start: int, end: int, target_tokens: int, min_tokens: int
) -> list[tuple[int, int]]:
    raw = text[start:end]
    stripped = raw.strip()
    if not stripped:
        return []
    offset = raw.index(stripped)
    span_start = start + offset
    span_end = span_start + len(stripped)
    if _approx_tokens(stripped) <= target_tokens:
        return [(span_start, span_end)]
    return _split_oversized(span_start, stripped, min_tokens)


class SectionAwareChunker:
    """Splits a Document along its section tree rather than fixed windows."""

    name = "section-aware"

    def __init__(self, target_tokens: int | None = None, min_tokens: int | None = None) -> None:
        configured = target_tokens or int(os.environ.get("KIWI_CHUNK_TOKENS") or TARGET_TOKENS)
        self.target_tokens = configured
        self.min_tokens = min_tokens if min_tokens is not None else configured // 2

    def health(self) -> Health:
        return Health(ok=True, detail="section-aware chunker")

    def chunk(self, document: Document) -> list[Chunk]:
        text = document.text
        sections = document.sections

        raw_spans: list[tuple[int, int, str]] = []

        top_level = [s for s in sections if s.level == 1]
        for gap_start, gap_end in _own_content_spans(0, len(text), top_level):
            raw_spans += [
                (s, e, "")
                for s, e in _split_if_needed(
                    text, gap_start, gap_end, self.target_tokens, self.min_tokens
                )
            ]

        for section in sections:
            children = _direct_children(section, sections)
            for gap_start, gap_end in _own_content_spans(section.start, section.end, children):
                # A section with children but no intro text of its own has a
                # first gap that is exactly its heading (the Ingestor writes
                # the heading into the flow ahead of any content, see
                # tei.py's _walk). That gap carries nothing a chunk needs:
                # the heading already prefixes every chunk under this path.
                if children and text[gap_start:gap_end].strip() == section.title:
                    continue
                spans = _split_if_needed(
                    text, gap_start, gap_end, self.target_tokens, self.min_tokens
                )
                raw_spans += [(s, e, section.path) for s, e in spans]

        raw_spans.sort(key=lambda span: span[0])

        doc_suffix = document.document_id.removeprefix("doc_")
        chunks: list[Chunk] = []
        for ordinal, (start, end, section_path) in enumerate(raw_spans):
            content = text[start:end]
            anchor = Anchor(
                document_id=document.document_id,
                section_path=section_path,
                start=start,
                end=end,
                exact=content,
                prefix=text[max(0, start - _CONTEXT_CHARS) : start],
                suffix=text[end : end + _CONTEXT_CHARS],
            )
            chunk_text = f"{section_path}\n\n{content}" if section_path else content
            chunks.append(
                Chunk(
                    chunk_id=f"chk_{doc_suffix}_{ordinal:04d}",
                    anchor=anchor,
                    text=chunk_text,
                    section_path=section_path,
                )
            )
        return chunks
