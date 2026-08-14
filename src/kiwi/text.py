"""Document text normalisation.

Produces the normalised text an Ingestor stores as ``text.txt`` and that
every Anchor's offsets index into.
"""

from __future__ import annotations

import re
import unicodedata

_HYPHEN_LINEBREAK_RE = re.compile(r"-\s*\n\s*")
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_document_text(raw: str) -> str:
    """NFC-normalise, join line-break hyphenation, and collapse whitespace.

    Deterministic: the same input always yields the same output. Headers,
    footers, and page numbers are excluded upstream by the Ingestor before
    this runs; this function only normalises the text it is given.
    """
    text = unicodedata.normalize("NFC", raw)
    text = _HYPHEN_LINEBREAK_RE.sub("", text)
    text = _WHITESPACE_RE.sub(" ", text)
    return text.strip()
