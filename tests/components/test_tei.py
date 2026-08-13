from __future__ import annotations

from pathlib import Path

from kiwi.components.ingest.tei import parse_tei

FIXTURE = Path(__file__).parent.parent / "fixtures" / "tei" / "sample.tei.xml"


def _parse():
    xml_bytes = FIXTURE.read_bytes()
    return parse_tei(
        xml_bytes,
        document_id="doc_0000000000000000",
        source_path=None,
        parser_version="grobid-0.8.1",
    )


def test_metadata_extracted() -> None:
    document = _parse()
    assert document.metadata["title"] == "Structure Fidelity in Academic Retrieval"
    assert document.metadata["DOI"] == "10.1000/example.tei"
    assert document.metadata["issued"]["date-parts"] == [[2026]]
    assert {"family": "Chen", "given": "Alice"} in document.metadata["author"]
    assert {"family": "Daniels", "given": "Bob"} in document.metadata["author"]


def test_sections_preserve_nesting_and_reading_order() -> None:
    document = _parse()
    paths = [s.path for s in document.sections]
    assert "Introduction" in paths
    assert "Methods" in paths
    assert "Methods/Participants" in paths
    assert "Results" in paths

    methods = next(s for s in document.sections if s.path == "Methods")
    participants = next(s for s in document.sections if s.path == "Methods/Participants")
    # The parent section's span encloses its subsection's span.
    assert methods.start <= participants.start
    assert methods.end >= participants.end


def test_section_anchors_are_substrings_of_document_text() -> None:
    document = _parse()
    for section in document.sections:
        assert document.text[section.start : section.end]  # non-empty
        # Every section's own title appears within its own span.
        assert section.title in document.text[section.start : section.end]


def test_figures_and_tables_included_in_flow() -> None:
    document = _parse()
    assert "Pipeline overview from ingestion to retrieval." in document.text
    assert "Recall at k for each chunking strategy." in document.text
    # Table captions are distinguished from figure captions.
    assert "Table: Recall at k" in document.text
    assert "Figure: Pipeline overview" in document.text


def test_references_extracted_with_identifiers() -> None:
    document = _parse()
    assert len(document.references) == 2

    vgc = next(r for r in document.references if r.doi == "10.1000/example.vgc")
    assert vgc.title == "Vision-Guided Chunking"
    assert vgc.authors == ("Lin Zhao",)
    assert vgc.year == 2025

    sf_rag = next(r for r in document.references if r.arxiv_id == "2602.13647")
    assert sf_rag.title == "SF-RAG: Structure Fidelity for Academic QA"
    assert sf_rag.year == 2026


def test_parser_version_recorded() -> None:
    document = _parse()
    assert document.parser == "grobid-0.8.1"
