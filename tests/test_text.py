from __future__ import annotations

import unicodedata

from kiwi.text import normalize_document_text


def test_collapses_whitespace() -> None:
    assert normalize_document_text("a   b\n\nc\td") == "a b c d"


def test_joins_line_break_hyphenation() -> None:
    assert normalize_document_text("infor-\nmation") == "information"


def test_normalises_to_nfc() -> None:
    decomposed = "e" + unicodedata.normalize("NFD", "é")[1:]  # "e" + combining acute
    result = normalize_document_text(decomposed)
    assert result == unicodedata.normalize("NFC", decomposed)


def test_strips_leading_and_trailing_whitespace() -> None:
    assert normalize_document_text("  hello world  ") == "hello world"


def test_deterministic() -> None:
    raw = "Section one.\n\nSection  two-\nfold approach."
    assert normalize_document_text(raw) == normalize_document_text(raw)
