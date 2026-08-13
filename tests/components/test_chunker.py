from __future__ import annotations

from pathlib import Path

from kiwi.components.chunk.section_aware import SectionAwareChunker
from kiwi.components.ingest.tei import parse_tei
from kiwi.types import Document, Section

FIXTURE = Path(__file__).parent.parent / "fixtures" / "tei" / "sample.tei.xml"


def _sample_document() -> Document:
    return parse_tei(
        FIXTURE.read_bytes(),
        document_id="doc_0000000000000000",
        source_path=None,
        parser_version="grobid-0.8.1",
    )


def test_every_chunk_anchor_resolves_in_document_text() -> None:
    document = _sample_document()
    chunks = SectionAwareChunker().chunk(document)
    assert chunks
    for chunk in chunks:
        a = chunk.anchor
        assert document.text[a.start : a.end] == a.exact
        assert a.document_id == document.document_id


def test_chunk_ids_are_ordered_and_well_formed() -> None:
    document = _sample_document()
    chunks = SectionAwareChunker().chunk(document)
    for i, chunk in enumerate(chunks):
        assert chunk.chunk_id == f"chk_0000000000000000_{i:04d}"
    starts = [c.anchor.start for c in chunks]
    assert starts == sorted(starts)


def test_chunk_text_carries_section_path_as_prefix() -> None:
    document = _sample_document()
    chunks = SectionAwareChunker().chunk(document)
    sectioned = [c for c in chunks if c.section_path]
    assert sectioned
    for chunk in sectioned:
        assert chunk.text.startswith(chunk.section_path)
        assert chunk.anchor.exact not in (chunk.section_path,)


def test_nested_sections_produce_distinct_chunks() -> None:
    document = _sample_document()
    chunks = SectionAwareChunker().chunk(document)
    paths = {c.section_path for c in chunks}
    assert "Methods/Participants" in paths
    assert "Methods" in paths or any(p.startswith("Methods") for p in paths)


def test_chunks_do_not_duplicate_text() -> None:
    document = _sample_document()
    chunks = SectionAwareChunker().chunk(document)
    spans = sorted((c.anchor.start, c.anchor.end) for c in chunks)
    for (_s1, e1), (s2, _e2) in zip(spans, spans[1:], strict=False):
        assert e1 <= s2  # no overlap


def test_oversized_section_is_split_into_multiple_chunks() -> None:
    # One long section built from many short, distinct sentences so a
    # naive single chunk would exceed the target token band.
    sentence = "Participant {i} completed the reading comprehension task."
    long_text = " ".join(sentence.format(i=i) for i in range(400))
    document = Document(
        document_id="doc_1111111111111111",
        source_path=None,
        text=long_text,
        sections=(Section(path="Results", title="Results", level=1, start=0, end=len(long_text)),),
        references=(),
        metadata={},
        parser="test",
    )
    chunks = SectionAwareChunker().chunk(document)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk.anchor.exact.split()) <= 512 + 50  # target band, generous slack
