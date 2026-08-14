from __future__ import annotations

import json
from pathlib import Path

import pytest

from kiwi.core import index_document, index_documents, retrieve, verify_document
from kiwi.types import Document, Health, Reference, RefStatus, ResolvedReference, Section
from kiwi.workspace import document_id, init_project, read_verification, write_document


class _StubResolver:
    name = "stub"

    def health(self) -> Health:
        return Health(ok=True, detail="stub")

    def resolve(self, reference):
        return self.resolve_batch([reference])[0]

    def resolve_batch(self, references):
        return [
            ResolvedReference(
                reference=r,
                status=RefStatus.RETRACTED if "retracted" in r.raw else RefStatus.RESOLVED,
                doi=r.doi,
                metadata={"title": r.title},
                retraction_notice="Retracted (test)" if "retracted" in r.raw else None,
                source=self.name,
            )
            for r in references
        ]


def _make_document(
    tmp_path: Path, name: str, text: str, title: str, references: tuple = ()
) -> tuple[Document, Path]:
    source = tmp_path / f"{name}.pdf"
    source.write_bytes(f"%PDF-1.4 fixture bytes for {name}".encode())
    doc_id = document_id(source)
    document = Document(
        document_id=doc_id,
        source_path=None,
        text=text,
        sections=(Section(path="Results", title="Results", level=1, start=0, end=len(text)),),
        references=references,
        metadata={"type": "article-journal", "title": title, "author": []},
        parser="test",
    )
    return document, source


@pytest.fixture(autouse=True)
def _no_embed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_NO_EMBED", "1")


def test_index_documents_indexes_a_whole_corpus_in_one_batch(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")

    doc_a, source_a = _make_document(
        tmp_path, "a", "Retrieval grounded in a corpus of papers.", "Paper A"
    )
    doc_b, source_b = _make_document(
        tmp_path, "b", "Citations are verified against Crossref.", "Paper B"
    )
    write_document(project, doc_a, source_a)
    write_document(project, doc_b, source_b)

    counts = index_documents(project, [doc_a, doc_b])
    assert counts[doc_a.document_id] == 1
    assert counts[doc_b.document_id] == 1


class _StubAligner:
    name = "stub"

    def __init__(self, score: int = 2) -> None:
        self.score = score

    def health(self) -> Health:
        return Health(ok=True, detail="stub")

    def detect_intent(self, claim, context):  # type: ignore[no-untyped-def]
        from kiwi.types import Intent

        return Intent.EVIDENCE

    def align(self, claim, intent, evidence, depth):  # type: ignore[no-untyped-def]
        from kiwi.types import Alignment

        return Alignment(score=self.score, intent=intent, depth=depth, evidence=None, model="stub")


def _draft_project(tmp_path: Path, text: str) -> tuple[Path, str]:
    from kiwi.workspace import write_draft

    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")
    document, source = _make_document(tmp_path, "a", "Some indexed content here.", "Paper A")
    write_document(project, document, source)
    index_documents(project, [document])
    write_draft(project, "d.md", text.format(doc=document.document_id))
    return project, document.document_id


def test_rewording_a_claim_keeps_its_deep_result_and_marks_it_stale(tmp_path: Path) -> None:
    from kiwi.core import align_draft
    from kiwi.types import Depth
    from kiwi.workspace import write_draft

    project, doc_id = _draft_project(
        tmp_path, "The approach accelerates computation greatly [@{doc}]."
    )
    aligner = _StubAligner()

    align_draft(project, "d.md", aligner=aligner, depth=Depth.DEEP)
    assert align_draft(project, "d.md", aligner=aligner)[0].deep_is_stale is False

    write_draft(project, "d.md", f"The approach accelerates computation substantially [@{doc_id}].")
    claims = align_draft(project, "d.md", aligner=aligner)

    assert len(claims) == 1
    assert claims[0].deep_alignment is not None, "a reworded claim must keep its deep result"
    assert claims[0].deep_is_stale is True


def test_an_unrelated_claim_does_not_inherit_a_deep_result(tmp_path: Path) -> None:
    from kiwi.core import align_draft
    from kiwi.types import Depth
    from kiwi.workspace import write_draft

    project, doc_id = _draft_project(tmp_path, "Retrieval quality improved markedly [@{doc}].")
    aligner = _StubAligner()
    align_draft(project, "d.md", aligner=aligner, depth=Depth.DEEP)

    write_draft(project, "d.md", f"Entirely different subject matter about zebras [@{doc_id}].")
    claims = align_draft(project, "d.md", aligner=aligner)
    assert claims[0].deep_alignment is None


def test_indexing_records_the_chunk_count_in_metadata(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")

    long_text = " ".join(f"sentence number {i} about retrieval." for i in range(400))
    document, source = _make_document(tmp_path, "a", long_text, "Paper A")
    write_document(project, document, source)

    metadata_path = project / "papers" / document.document_id / "metadata.json"
    assert json.loads(metadata_path.read_text(encoding="utf-8"))["kiwi"]["chunk_count"] == 0

    counts = index_documents(project, [document])

    recorded = json.loads(metadata_path.read_text(encoding="utf-8"))["kiwi"]["chunk_count"]
    assert recorded == counts[document.document_id]
    assert recorded > 0


def test_cross_document_retrieval_finds_the_right_document(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")

    doc_a, source_a = _make_document(
        tmp_path,
        "a",
        "Section-aware chunking improved retrieval quality substantially.",
        "Chunking Paper",
    )
    doc_b, source_b = _make_document(
        tmp_path,
        "b",
        "Retracted references were flagged by the Crossref resolver.",
        "Verification Paper",
    )
    write_document(project, doc_a, source_a)
    write_document(project, doc_b, source_b)
    index_documents(project, [doc_a, doc_b])

    chunking_hits = retrieve(project, "chunking retrieval quality", k=5)
    assert chunking_hits[0].chunk.anchor.document_id == doc_a.document_id

    verification_hits = retrieve(project, "retracted references Crossref", k=5)
    assert verification_hits[0].chunk.anchor.document_id == doc_b.document_id


def test_retrieve_can_be_scoped_to_one_document_among_many(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")

    doc_a, source_a = _make_document(tmp_path, "a", "shared keyword in paper A", "Paper A")
    doc_b, source_b = _make_document(tmp_path, "b", "shared keyword in paper B", "Paper B")
    write_document(project, doc_a, source_a)
    write_document(project, doc_b, source_b)
    index_documents(project, [doc_a, doc_b])

    all_hits = retrieve(project, "shared keyword", k=10)
    assert len(all_hits) == 2

    scoped_hits = retrieve(project, "shared keyword", k=10, document_id=doc_a.document_id)
    assert len(scoped_hits) == 1
    assert scoped_hits[0].chunk.anchor.document_id == doc_a.document_id


def test_reindexing_one_document_does_not_disturb_its_siblings(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")

    doc_a, source_a = _make_document(tmp_path, "a", "alpha content here", "Paper A")
    doc_b, source_b = _make_document(tmp_path, "b", "beta content here", "Paper B")
    write_document(project, doc_a, source_a)
    write_document(project, doc_b, source_b)
    index_documents(project, [doc_a, doc_b])

    # Re-index only doc_a.
    index_document(project, doc_a)

    hits = retrieve(project, "beta content", k=5)
    assert hits and hits[0].chunk.anchor.document_id == doc_b.document_id


def _reference(raw: str) -> Reference:
    return Reference(
        raw=raw, title="A Paper", authors=("Someone",), year=2024, doi=None, arxiv_id=None
    )


def test_verify_document_resolves_and_persists(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")
    doc, source = _make_document(
        tmp_path, "a", "alpha content", "Paper A", references=(_reference("a normal reference"),)
    )
    write_document(project, doc, source)

    results = verify_document(project, doc, resolver=_StubResolver())
    assert len(results) == 1
    assert results[0].status is RefStatus.RESOLVED

    assert read_verification(project, doc.document_id) == results


def test_verify_document_flags_retracted_references(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")
    doc, source = _make_document(
        tmp_path, "a", "alpha content", "Paper A", references=(_reference("a retracted reference"),)
    )
    write_document(project, doc, source)

    results = verify_document(project, doc, resolver=_StubResolver())
    assert results[0].status is RefStatus.RETRACTED
    assert results[0].retraction_notice is not None


def test_verify_document_with_no_references_is_a_noop(tmp_path: Path) -> None:
    project = tmp_path / "Corpus.kiwi"
    init_project(project, name="Corpus")
    doc, source = _make_document(tmp_path, "a", "alpha content", "Paper A", references=())
    write_document(project, doc, source)

    results = verify_document(project, doc, resolver=_StubResolver())
    assert results == []
    assert read_verification(project, doc.document_id) == []
