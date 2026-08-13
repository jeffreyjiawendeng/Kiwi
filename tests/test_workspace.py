from __future__ import annotations

import json
from pathlib import Path

from kiwi.types import Document, Reference, RefStatus, ResolvedReference, Section
from kiwi.workspace import (
    document_id,
    init_project,
    read_document,
    read_verification,
    write_document,
    write_verification,
)


def _sample_document(doc_id: str) -> Document:
    return Document(
        document_id=doc_id,
        source_path=None,
        text="Introduction text. Methods text. Results: p < 0.05.",
        sections=(
            Section(path="Introduction", title="Introduction", level=1, start=0, end=19),
            Section(path="Methods", title="Methods", level=1, start=20, end=33),
        ),
        references=(
            Reference(
                raw="Doe, J. (2024). A study. Journal of Examples.",
                title="A study",
                authors=("J. Doe",),
                year=2024,
                doi="10.1000/example",
                arxiv_id=None,
            ),
        ),
        metadata={
            "type": "article-journal",
            "title": "A Study",
            "author": [{"family": "Doe", "given": "J."}],
        },
        parser="grobid-0.8.1",
    )


def test_document_id_is_content_derived(tmp_path: Path) -> None:
    pdf_a = tmp_path / "a.pdf"
    pdf_b = tmp_path / "b.pdf"
    pdf_a.write_bytes(b"%PDF-1.4 same content")
    pdf_b.write_bytes(b"%PDF-1.4 same content")
    assert document_id(pdf_a) == document_id(pdf_b)
    assert document_id(pdf_a).startswith("doc_")

    pdf_c = tmp_path / "c.pdf"
    pdf_c.write_bytes(b"%PDF-1.4 different content")
    assert document_id(pdf_a) != document_id(pdf_c)


def test_init_project_creates_layout_and_is_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    assert (root / "kiwi.json").exists()
    assert (root / "papers").is_dir()
    assert (root / "notes").is_dir()
    assert (root / "drafts").is_dir()
    assert (root / ".kiwi").is_dir()
    assert (root / ".gitignore").read_text(encoding="utf-8").strip() == ".kiwi/"

    manifest_before = (root / "kiwi.json").read_text(encoding="utf-8")
    init_project(root, name="Demo")  # calling again must not disturb the manifest
    assert (root / "kiwi.json").read_text(encoding="utf-8") == manifest_before


def test_write_then_read_document_round_trips(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")

    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture bytes")
    doc_id = document_id(source)

    document = _sample_document(doc_id)
    paper_dir = write_document(root, document, source)

    assert paper_dir == root / "papers" / doc_id
    assert (paper_dir / "source.pdf").read_bytes() == source.read_bytes()
    assert (paper_dir / "text.txt").read_text(encoding="utf-8") == document.text

    round_tripped = read_document(root, doc_id)
    assert round_tripped.document_id == document.document_id
    assert round_tripped.text == document.text
    assert round_tripped.sections == document.sections
    assert round_tripped.references == document.references
    assert round_tripped.parser == document.parser
    assert round_tripped.metadata["title"] == document.metadata["title"]
    assert round_tripped.metadata["kiwi"]["parse_status"] == "ok"


def test_verification_round_trips_and_defaults_to_unresolved(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture bytes")
    doc_id = document_id(source)
    document = _sample_document(doc_id)
    write_document(root, document, source)

    assert read_verification(root, doc_id) == []
    metadata = json.loads((root / "papers" / doc_id / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["kiwi"]["verification"] == "unresolved"

    results = [
        ResolvedReference(
            reference=document.references[0],
            status=RefStatus.RESOLVED,
            doi="10.1000/example",
            metadata={"type": "article-journal", "title": "A study"},
            retraction_notice=None,
            source="crossref",
        )
    ]
    write_verification(root, doc_id, results)

    round_tripped = read_verification(root, doc_id)
    assert round_tripped == results

    metadata = json.loads((root / "papers" / doc_id / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["kiwi"]["verification"] == "resolved"


def test_verification_rollup_flags_retracted_and_mismatch(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture bytes")
    doc_id = document_id(source)
    document = _sample_document(doc_id)
    write_document(root, document, source)

    retracted = ResolvedReference(
        reference=document.references[0],
        status=RefStatus.RETRACTED,
        doi="10.1000/example",
        metadata={},
        retraction_notice="Retracted (2020-1-1)",
        source="crossref",
    )
    write_verification(root, doc_id, [retracted])

    metadata = json.loads((root / "papers" / doc_id / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["kiwi"]["verification"] == "issues"
