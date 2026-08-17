"""Reading a title off the page when the parser did not find one.

The cases here are the ones that defeated a simpler rule, taken from real
papers: an arXiv identifier set larger than the title it sits beside, a
document that scales every glyph through the text matrix, and a title
whose small capitals are set at a different size from the rest of its own
line.
"""

from __future__ import annotations

from pathlib import Path

from kiwi.components.ingest.title import title_from_pdf, with_title_from_page
from kiwi.types import Document

CORPUS = Path(__file__).parent.parent / "eval" / "corpus"


def test_a_title_is_read_from_the_largest_text_on_the_page() -> None:
    pdf = CORPUS / "intrusion-detection.pdf"
    if not pdf.is_file():
        return
    assert title_from_pdf(pdf).startswith("Network intrusion detection")


def test_a_document_that_scales_through_the_text_matrix_still_reads() -> None:
    # Every glyph in this one is set at size 1 and scaled by the matrix,
    # so comparing raw font sizes makes every line identical.
    pdf = CORPUS / "betweenness-centrality.pdf"
    if not pdf.is_file():
        return
    assert "Betweenness Centrality" in title_from_pdf(pdf)


def test_nothing_is_returned_for_a_file_that_is_not_a_pdf(tmp_path: Path) -> None:
    broken = tmp_path / "not.pdf"
    broken.write_bytes(b"not a pdf at all")
    assert title_from_pdf(broken) == ""


def test_a_document_that_has_a_title_keeps_it(tmp_path: Path) -> None:
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4\n")
    document = Document(
        document_id="doc_00000000000000ab",
        source_path=source,
        metadata={"title": "What the parser found"},
        sections=(),
        references=(),
        text="",
        parser="grobid-0.8.1",
    )
    assert with_title_from_page(document, source).metadata["title"] == "What the parser found"


def test_a_document_with_no_title_and_no_readable_page_is_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4\n")
    document = Document(
        document_id="doc_00000000000000ac",
        source_path=source,
        metadata={"title": ""},
        sections=(),
        references=(),
        text="",
        parser="grobid-0.8.1",
    )
    assert with_title_from_page(document, source).metadata["title"] == ""
