from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.anchor import AnchorState, resolve
from kiwi.types import AnnotationKind, Document, Section
from kiwi.workspace import (
    annotate,
    authors,
    delete_annotation,
    document_id,
    init_project,
    read_annotations,
    write_document,
)

TEXT = (
    "Structure-preserving parsing improves retrieval quality. "
    "Section-aware chunking outperformed fixed-size splitting on every metric."
)
PASSAGE = "Section-aware chunking outperformed fixed-size splitting"


def _paper(tmp_path: Path, text: str = TEXT) -> tuple[Path, str]:
    project = tmp_path / "Demo.kiwi"
    init_project(project, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 annotation fixture")
    doc_id = document_id(source)
    write_document(
        project,
        Document(
            document_id=doc_id,
            source_path=None,
            text=text,
            sections=(Section(path="Results", title="Results", level=1, start=0, end=len(text)),),
            references=(),
            metadata={"type": "article-journal", "title": "Demo Paper", "author": []},
            parser="test",
        ),
        source,
    )
    return project, doc_id


def test_a_highlight_records_offsets_and_context(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    annotation = annotate(project, doc_id, PASSAGE)

    assert annotation.kind is AnnotationKind.HIGHLIGHT
    assert annotation.annotation_id.startswith("ann_")
    assert annotation.anchor.exact == PASSAGE
    assert TEXT[annotation.anchor.start : annotation.anchor.end] == PASSAGE
    assert annotation.anchor.prefix
    assert annotation.body == ""


def test_a_note_carries_commentary(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    annotation = annotate(
        project, doc_id, PASSAGE, kind=AnnotationKind.NOTE, body="Compare against the 512 baseline."
    )
    assert annotation.kind is AnnotationKind.NOTE
    assert annotation.body == "Compare against the 512 baseline."


def test_annotations_round_trip(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    annotate(project, doc_id, PASSAGE, color="green", author="wei")

    restored = read_annotations(project, doc_id)
    assert len(restored) == 1
    assert restored[0].color == "green"
    assert restored[0].author == "wei"
    assert restored[0].document_id == doc_id


def test_annotations_accumulate_in_order(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    annotate(project, doc_id, "Structure-preserving parsing")
    annotate(project, doc_id, PASSAGE)
    assert [a.anchor.exact for a in read_annotations(project, doc_id)] == [
        "Structure-preserving parsing",
        PASSAGE,
    ]


def test_a_passage_absent_from_the_paper_is_rejected(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    with pytest.raises(ValueError):
        annotate(project, doc_id, "a sentence that is not in this paper")


def test_deleting_leaves_the_rest(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    first = annotate(project, doc_id, "Structure-preserving parsing")
    annotate(project, doc_id, PASSAGE)

    remaining = delete_annotation(project, doc_id, first.annotation_id)
    assert [a.anchor.exact for a in remaining] == [PASSAGE]
    assert len(read_annotations(project, doc_id)) == 1


def test_a_paper_with_no_annotations_reads_empty(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    assert read_annotations(project, doc_id) == []


def test_authors_are_reported_for_filtering(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    annotate(project, doc_id, PASSAGE, author="wei")
    annotate(project, doc_id, "Structure-preserving parsing", author="lee")
    assert authors(read_annotations(project, doc_id)) == ["lee", "wei"]


def test_an_annotation_relocates_after_the_paper_is_parsed_again(tmp_path: Path) -> None:
    # A re-parse can shift every offset. The quote selector is what keeps
    # the annotation pointing at its passage.
    project, doc_id = _paper(tmp_path)
    annotation = annotate(project, doc_id, PASSAGE)

    reparsed = f"Added abstract sentence from a newer parser. {TEXT}"
    resolution = resolve(annotation.anchor, reparsed)

    assert resolution.state is AnchorState.SHIFTED
    assert reparsed[resolution.anchor.start : resolution.anchor.end] == PASSAGE


def test_the_source_pdf_is_never_modified(tmp_path: Path) -> None:
    project, doc_id = _paper(tmp_path)
    source = project / "papers" / doc_id / "source.pdf"
    before = source.read_bytes()

    annotate(project, doc_id, PASSAGE, kind=AnnotationKind.NOTE, body="a note")
    assert source.read_bytes() == before
    assert (project / "papers" / doc_id / "annotations.json").exists()
