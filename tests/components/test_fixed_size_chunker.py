from __future__ import annotations

from kiwi.components.chunk.fixed_size import TARGET_TOKENS, FixedSizeChunker
from kiwi.protocols import Chunker
from kiwi.types import Document, Section


def _document(text: str) -> Document:
    return Document(
        document_id="doc_0000000000000000",
        source_path=None,
        text=text,
        sections=(Section(path="Results", title="Results", level=1, start=0, end=len(text)),),
        references=(),
        metadata={},
        parser="test",
    )


def test_fixed_size_chunker_satisfies_protocol_shape() -> None:
    chunker = FixedSizeChunker()
    assert isinstance(chunker, Chunker)


def test_every_chunk_anchor_resolves_in_document_text() -> None:
    text = "word " * 1500
    document = _document(text.strip())
    chunks = FixedSizeChunker().chunk(document)
    assert chunks
    for chunk in chunks:
        a = chunk.anchor
        assert document.text[a.start : a.end] == a.exact
        assert a.section_path == ""  # no section awareness, by design


def test_chunks_ignore_section_boundaries_entirely() -> None:
    # A single "word" repeated means section structure carries no signal
    # at all, since the fixed-size chunker doesn't need it and doesn't use it.
    text = " ".join(f"tok{i}" for i in range(TARGET_TOKENS * 2 + 10))
    document = _document(text)
    chunks = FixedSizeChunker().chunk(document)
    assert len(chunks) == 3  # two full windows plus a remainder
    for chunk in chunks[:-1]:
        assert len(chunk.anchor.exact.split()) == TARGET_TOKENS


def test_empty_document_produces_no_chunks() -> None:
    document = _document("")
    assert FixedSizeChunker().chunk(document) == []


def test_chunk_ids_are_ordered() -> None:
    text = " ".join(f"tok{i}" for i in range(TARGET_TOKENS * 3))
    document = _document(text)
    chunks = FixedSizeChunker().chunk(document)
    for i, chunk in enumerate(chunks):
        assert chunk.chunk_id == f"chk_0000000000000000_{i:04d}"
