from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.components.ingest.grobid import GrobidIngestor

FIXTURE = Path(__file__).parent.parent / "fixtures" / "papers" / "sample.pdf"


@pytest.fixture
def ingestor() -> GrobidIngestor:
    inst = GrobidIngestor()
    if not inst.health().ok:
        pytest.skip("GROBID is not running at http://localhost:8070")
    return inst


@pytest.mark.requires_grobid
def test_supports_pdf(ingestor: GrobidIngestor) -> None:
    assert ingestor.supports(FIXTURE)
    assert not ingestor.supports(Path("notes.md"))


@pytest.mark.requires_grobid
def test_ingest_real_pdf_end_to_end(ingestor: GrobidIngestor) -> None:
    document = ingestor.ingest(FIXTURE)

    assert document.document_id.startswith("doc_")
    assert document.source_path == FIXTURE
    assert document.parser.startswith("grobid-")

    assert "Structure-Preserving Ingestion" in document.metadata.get("title", "")
    assert document.metadata.get("author")

    assert len(document.sections) >= 3
    section_paths = [s.path for s in document.sections]
    assert any("Method" in p for p in section_paths)

    for section in document.sections:
        assert document.text[section.start : section.end]

    assert len(document.references) >= 3
    assert any(r.doi or r.arxiv_id for r in document.references)

    assert len(document.text) > 500


@pytest.mark.requires_grobid
def test_ingest_unsupported_file_raises(ingestor: GrobidIngestor, tmp_path: Path) -> None:
    from kiwi.protocols import IngestError

    not_a_pdf = tmp_path / "notes.txt"
    not_a_pdf.write_text("not a pdf")
    with pytest.raises(IngestError):
        ingestor.ingest(not_a_pdf)
