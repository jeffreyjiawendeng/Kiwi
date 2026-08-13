from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from kiwi.cli import app
from kiwi.components.ingest.grobid import GrobidIngestor
from kiwi.types import Document, Reference, Section
from kiwi.workspace import document_id, init_project, write_document

FIXTURE = Path(__file__).parent / "fixtures" / "papers" / "sample.pdf"
FIXTURE_2 = Path(__file__).parent / "fixtures" / "papers" / "sample2.pdf"

runner = CliRunner()


def _seeded_project(tmp_path: Path, references: tuple = ()) -> tuple[Path, str]:
    """A workspace with one ingested (but not yet indexed) paper, built
    without GROBID so index/ask tests don't need a live service."""
    project = tmp_path / "Demo.kiwi"
    init_project(project, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture bytes for index/ask tests")
    doc_id = document_id(source)
    document = Document(
        document_id=doc_id,
        source_path=None,
        text=(
            "Structure-preserving parsing improves retrieval quality. "
            "Section-aware chunking outperformed fixed-size splitting."
        ),
        sections=(Section(path="Results", title="Results", level=1, start=0, end=113),),
        references=references,
        metadata={"type": "article-journal", "title": "Demo Paper", "author": []},
        parser="test",
    )
    write_document(project, document, source)
    return project, doc_id


@pytest.mark.requires_grobid
def test_ingest_command_writes_workspace(tmp_path: Path) -> None:
    if not GrobidIngestor().health().ok:
        pytest.skip("GROBID is not running at http://localhost:8070")

    project = tmp_path / "Demo.kiwi"
    result = runner.invoke(app, ["ingest", str(FIXTURE), "--project", str(project)])

    assert result.exit_code == 0, result.output
    assert "document_id" in result.output
    papers = list((project / "papers").iterdir())
    assert len(papers) == 1
    assert (papers[0] / "text.txt").exists()
    assert (papers[0] / "structure.json").exists()
    assert (papers[0] / "metadata.json").exists()
    assert (papers[0] / "source.pdf").exists()


@pytest.mark.requires_grobid
def test_ingest_directory_batches_every_pdf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if not GrobidIngestor().health().ok:
        pytest.skip("GROBID is not running at http://localhost:8070")
    monkeypatch.setenv("KIWI_NO_EMBED", "1")

    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    (pdf_dir / "sample.pdf").write_bytes(FIXTURE.read_bytes())
    (pdf_dir / "sample2.pdf").write_bytes(FIXTURE_2.read_bytes())

    project = tmp_path / "Corpus.kiwi"
    result = runner.invoke(app, ["ingest", str(pdf_dir), "--project", str(project)])
    assert result.exit_code == 0, result.output
    assert "Ingested 2 paper(s)" in result.output

    papers = sorted((project / "papers").iterdir())
    assert len(papers) == 2

    index_result = runner.invoke(app, ["index", str(project)])
    assert index_result.exit_code == 0, index_result.output

    # A query that should only match content from the verification paper.
    ask_result = runner.invoke(app, ["ask", str(project), "How are retracted references detected?"])
    assert ask_result.exit_code == 0, ask_result.output
    assert "retract" in ask_result.output.lower() or "crossref" in ask_result.output.lower()


def test_health_command_reports_failure_when_unreachable() -> None:
    result = runner.invoke(app, ["health", "--grobid-url", "http://localhost:1"])
    assert result.exit_code == 1


def test_index_and_ask_without_generator(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_NO_EMBED", "1")  # force the BM25 path, no model download
    monkeypatch.delenv("KIWI_GENERATOR_MODEL", raising=False)
    project, doc_id = _seeded_project(tmp_path)

    index_result = runner.invoke(app, ["index", str(project)])
    assert index_result.exit_code == 0, index_result.output
    assert doc_id in index_result.output

    ask_result = runner.invoke(app, ["ask", str(project), "How does chunking affect retrieval?"])
    assert ask_result.exit_code == 0, ask_result.output
    assert "No Generator configured" in ask_result.output
    assert "chunking" in ask_result.output.lower()


def test_index_with_no_papers_fails_cleanly(tmp_path: Path) -> None:
    project = tmp_path / "Empty.kiwi"
    init_project(project, name="Empty")
    result = runner.invoke(app, ["index", str(project)])
    assert result.exit_code == 1
    assert "No papers found" in result.output


def test_ask_with_no_index_fails_cleanly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_NO_EMBED", "1")
    project, _ = _seeded_project(tmp_path)
    result = runner.invoke(app, ["ask", str(project), "anything"])
    assert result.exit_code == 1
    assert "No results" in result.output


def test_verify_with_no_papers_fails_cleanly(tmp_path: Path) -> None:
    project = tmp_path / "Empty.kiwi"
    init_project(project, name="Empty")
    result = runner.invoke(app, ["verify", str(project)])
    assert result.exit_code == 1
    assert "No papers found" in result.output


def test_verify_paper_with_no_references_is_a_noop(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path, references=())
    result = runner.invoke(app, ["verify", str(project)])
    assert result.exit_code == 0, result.output
    assert f"{doc_id}: no references extracted" in result.output


@pytest.mark.requires_network
def test_verify_resolves_a_real_reference_against_crossref(tmp_path: Path) -> None:
    reference = Reference(
        raw="Zhao et al. Vision-Guided Chunking.",
        title="Vision-Guided Chunking for Retrieval-Augmented Generation",
        authors=("Lin Zhao",),
        year=2025,
        doi=None,
        arxiv_id=None,
    )
    project, doc_id = _seeded_project(tmp_path, references=(reference,))

    result = runner.invoke(app, ["verify", str(project)])
    assert result.exit_code == 0, result.output
    assert doc_id in result.output


@pytest.mark.requires_network
def test_verify_flags_a_real_retracted_paper(tmp_path: Path) -> None:
    # The Wakefield 1998 Lancet paper, retracted 2010, a canonical
    # real-world retraction used to validate this exact check.
    reference = Reference(
        raw="Wakefield AJ et al. Ileal-lymphoid-nodular hyperplasia.",
        title="Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and "
        "pervasive developmental disorder in children",
        authors=("AJ Wakefield",),
        year=1998,
        doi="10.1016/S0140-6736(97)11096-0",
        arxiv_id=None,
    )
    project, doc_id = _seeded_project(tmp_path, references=(reference,))

    result = runner.invoke(app, ["verify", str(project)])
    assert result.exit_code == 0, result.output
    assert "retracted=1" in result.output
    assert doc_id in result.output
