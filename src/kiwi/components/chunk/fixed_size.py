"""Fixed-size chunker, no section awareness.

The evaluation harness's baseline. See docs/14-evaluation.md, "Method":
"Establish a baseline using fixed-size chunking with no section
awareness." Also a simple, standalone Chunker implementation.
"""

from __future__ import annotations

import re

from kiwi.types import Anchor, Chunk, Document, Health

TARGET_TOKENS = 512
_CONTEXT_CHARS = 32
_TOKEN_RE = re.compile(r"\S+")


class FixedSizeChunker:
    """Splits normalised text into fixed-size windows by word count,
    ignoring section boundaries entirely."""

    name = "fixed-size"

    def health(self) -> Health:
        return Health(ok=True, detail="fixed-size chunker, no section awareness")

    def chunk(self, document: Document) -> list[Chunk]:
        text = document.text
        tokens = list(_TOKEN_RE.finditer(text))
        if not tokens:
            return []

        doc_suffix = document.document_id.removeprefix("doc_")
        chunks: list[Chunk] = []
        for ordinal, i in enumerate(range(0, len(tokens), TARGET_TOKENS)):
            window = tokens[i : i + TARGET_TOKENS]
            start, end = window[0].start(), window[-1].end()
            content = text[start:end]
            anchor = Anchor(
                document_id=document.document_id,
                section_path="",
                start=start,
                end=end,
                exact=content,
                prefix=text[max(0, start - _CONTEXT_CHARS) : start],
                suffix=text[end : end + _CONTEXT_CHARS],
            )
            chunks.append(
                Chunk(
                    chunk_id=f"chk_{doc_suffix}_{ordinal:04d}",
                    anchor=anchor,
                    text=content,
                    section_path="",
                )
            )
        return chunks
