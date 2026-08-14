from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.components.ingest.pdf import PdfIngestor, _clean, _lay_out
from kiwi.protocols import IngestError, Ingestor

CORPUS = Path("eval/corpus-heldout")


def test_ingestor_satisfies_protocol_shape() -> None:
    assert isinstance(PdfIngestor(), Ingestor)


def test_only_pdfs_are_supported(tmp_path: Path) -> None:
    ingestor = PdfIngestor()
    assert ingestor.supports(tmp_path / "paper.pdf")
    assert ingestor.supports(tmp_path / "paper.PDF")
    assert not ingestor.supports(tmp_path / "paper.txt")


def test_an_unsupported_file_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "notes.txt"
    source.write_text("text", encoding="utf-8")
    with pytest.raises(IngestError, match="unsupported"):
        PdfIngestor().ingest(source)


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(IngestError, match="not found"):
        PdfIngestor().ingest(tmp_path / "absent.pdf")


def test_each_page_becomes_a_section_spanning_its_own_text() -> None:
    text, sections = _lay_out(["First page.", "Second page."])
    assert text == "First page. Second page."
    assert [s.title for s in sections] == ["Page 1", "Page 2"]
    for section in sections:
        assert text[section.start : section.end]
    assert text[sections[0].start : sections[0].end] == "First page."
    assert text[sections[1].start : sections[1].end] == "Second page."


def test_a_page_with_no_text_is_skipped_without_shifting_the_rest() -> None:
    # A figure-only page contributes nothing, and the pages after it must
    # still span their own text.
    text, sections = _lay_out(["First page.", "   ", "Third page."])
    assert [s.title for s in sections] == ["Page 1", "Page 3"]
    assert text[sections[1].start : sections[1].end] == "Third page."


def test_line_breaks_inside_a_page_are_collapsed() -> None:
    text, sections = _lay_out(["A sentence\nbroken over\nlines."])
    assert text == "A sentence broken over lines."
    assert text[sections[0].start : sections[0].end] == text


@pytest.mark.skipif(not CORPUS.is_dir(), reason="needs the held-out corpus")
def test_a_paper_reads_without_grobid() -> None:
    pdf = sorted(CORPUS.glob("*.pdf"))[0]
    document = PdfIngestor().ingest(pdf)

    assert document.text
    assert document.sections
    assert document.parser.startswith("pypdf")
    # No section tree and no reference list is the cost of this path, and
    # is why it is not the default.
    assert document.references == ()
    for section in document.sections:
        assert document.text[section.start : section.end].strip()


@pytest.mark.skipif(not CORPUS.is_dir(), reason="needs the held-out corpus")
def test_a_paper_keeps_its_identity_across_parsers() -> None:
    # The identifier comes from the file, so a paper read here and parsed
    # by GROBID later is the same paper, and anchors relocate into it.
    from kiwi.workspace.format import document_id

    pdf = sorted(CORPUS.glob("*.pdf"))[0]
    assert PdfIngestor().ingest(pdf).document_id == document_id(pdf)


@pytest.mark.parametrize(
    ("declared", "expected"),
    [
        ("(anonymous)", ""),
        ("Untitled", ""),
        ("untitled document", ""),
        ("Microsoft Word - thesis-final.docx", "thesis-final"),
        ("manuscript.tex", ""),
        ("  ", ""),
        (
            "Working memory guidance of visual attention",
            "Working memory guidance of visual attention",
        ),
        ("A Study of Anonymous Networks", "A Study of Anonymous Networks"),
    ],
)
def test_a_tool_placeholder_is_not_treated_as_a_title(declared: str, expected: str) -> None:
    # A PDF's title field is written by whatever produced the file. A
    # library full of "(anonymous)" is worse than one showing filenames.
    from kiwi.components.ingest.pdf import _clean

    assert _clean(declared) == expected


@pytest.mark.skipif(not CORPUS.is_dir(), reason="needs the held-out corpus")
def test_a_paper_without_a_usable_title_falls_back_to_its_filename() -> None:
    pdf = sorted(CORPUS.glob("*.pdf"))[0]
    document = PdfIngestor().ingest(pdf)
    title = document.metadata["title"]
    assert title
    assert _clean(str(title)) == title or title == pdf.stem
