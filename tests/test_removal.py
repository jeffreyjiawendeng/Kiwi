from __future__ import annotations

import json
from pathlib import Path

import pytest

from kiwi.removal import NotFound, remove_draft, remove_note, remove_paper
from kiwi.types import Document, Section
from kiwi.workspace import init_project, write_document, write_draft, write_note


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "Demo.kiwi"
    init_project(project, name="Demo")
    return project


def _paper(project: Path, tmp_path: Path, name: str = "paper.pdf") -> str:
    source = tmp_path / name
    source.write_bytes(b"%PDF-1.4 " + name.encode())
    text = "A passage that says something. A second passage."
    document = Document(
        document_id="",
        source_path=None,
        text=text,
        sections=(Section(path="Body", title="Body", level=1, start=0, end=len(text)),),
        references=(),
        metadata={"type": "article-journal", "title": name, "author": []},
        parser="test",
    )
    from kiwi.workspace import document_id

    doc_id = document_id(source)
    write_document(project, Document(**{**document.__dict__, "document_id": doc_id}), source)
    return doc_id


def test_removing_a_paper_takes_its_folder(tmp_path: Path) -> None:
    project = _project(tmp_path)
    doc_id = _paper(project, tmp_path)
    assert (project / "papers" / doc_id).is_dir()

    result = remove_paper(project, doc_id)

    assert not (project / "papers" / doc_id).exists()
    assert result.removed == (f"papers/{doc_id}",)


def test_removing_a_paper_takes_its_annotations_and_verification(tmp_path: Path) -> None:
    # These live inside the paper's folder, so they must not survive it.
    project = _project(tmp_path)
    doc_id = _paper(project, tmp_path)
    paper_dir = project / "papers" / doc_id
    (paper_dir / "annotations.json").write_text('{"annotations": []}', encoding="utf-8")
    (paper_dir / "verification.json").write_text('{"results": []}', encoding="utf-8")

    remove_paper(project, doc_id)

    assert not (paper_dir / "annotations.json").exists()
    assert not (paper_dir / "verification.json").exists()


def test_removing_a_paper_takes_its_chunks_out_of_the_index(tmp_path: Path) -> None:
    # A paper deleted from disk alone would keep answering questions.
    from kiwi.core import index_documents
    from kiwi.registry import default_store
    from kiwi.workspace import read_document

    project = _project(tmp_path)
    doc_id = _paper(project, tmp_path)
    index_documents(project, [read_document(project, doc_id)])
    assert default_store(project).count() > 0

    remove_paper(project, doc_id)

    assert default_store(project).count() == 0


def test_a_draft_citing_a_removed_paper_keeps_its_prose(tmp_path: Path) -> None:
    # The sentence is the reader's. Removing a paper reports the drafts
    # that cite it rather than editing them.
    project = _project(tmp_path)
    doc_id = _paper(project, tmp_path)
    write_draft(project, "chapter.md", f"A claim [@{doc_id}].")

    result = remove_paper(project, doc_id)

    assert (project / "drafts" / "chapter.md").is_file()
    assert f"[@{doc_id}]" in (project / "drafts" / "chapter.md").read_text(encoding="utf-8")
    assert result.citing_drafts in ((), ("chapter.md",))


def test_removing_a_draft_takes_its_sidecar(tmp_path: Path) -> None:
    # Claims, suggestions, and review decisions all live there.
    project = _project(tmp_path)
    write_draft(project, "chapter.md", "Some prose.")
    sidecar = project / "drafts" / "chapter.md.kiwi.json"
    sidecar.write_text(json.dumps({"claims": [], "review": [{"decision": "accepted"}]}), "utf-8")

    result = remove_draft(project, "chapter.md")

    assert not (project / "drafts" / "chapter.md").exists()
    assert not sidecar.exists()
    assert len(result.removed) == 2


def test_removing_a_note_takes_the_note(tmp_path: Path) -> None:
    project = _project(tmp_path)
    write_note(project, "reading.md", "Some notes.", "private", author="local")

    remove_note(project, "reading.md", actor="local")

    assert not (project / "notes" / "reading.md").exists()


def test_removing_something_absent_says_so(tmp_path: Path) -> None:
    project = _project(tmp_path)
    with pytest.raises(NotFound):
        remove_paper(project, "doc_0000000000000000")
    with pytest.raises(NotFound):
        remove_draft(project, "absent.md")
    with pytest.raises(NotFound):
        remove_note(project, "absent.md")


def test_a_path_outside_the_project_is_refused(tmp_path: Path) -> None:
    # relpath comes from a request, so it must not escape the folder.
    from kiwi.workspace import PathOutsideProject

    project = _project(tmp_path)
    (tmp_path / "outside.md").write_text("not yours", encoding="utf-8")

    with pytest.raises((PathOutsideProject, NotFound)):
        remove_draft(project, "../outside.md")
    assert (tmp_path / "outside.md").is_file()


def test_a_draft_survives_the_paper_it_cites_being_removed(tmp_path: Path) -> None:
    # Deleting a paper makes every path that reads a cited work reachable
    # with that work absent. None of them may fail.
    from kiwi.core import align_draft, index_documents
    from kiwi.review import process_record, review_draft
    from kiwi.types import Depth
    from kiwi.workspace import read_document

    project = _project(tmp_path)
    doc_id = _paper(project, tmp_path)
    index_documents(project, [read_document(project, doc_id)])
    write_draft(project, "chapter.md", f"A passage that says something [@{doc_id}].")
    align_draft(project, "chapter.md", depth=Depth.QUICK)

    remove_paper(project, doc_id)

    # The title falls back to the identifier rather than raising.
    items = review_draft(project, "chapter.md")
    assert all(item.source_title == doc_id for item in items)

    record = process_record(project, "chapter.md")
    assert "decisions" in record

    # Re-scoring finds no passages and says so rather than crediting one.
    claims = align_draft(project, "chapter.md", depth=Depth.QUICK)
    for claim in claims:
        shown = claim.deep_alignment or claim.alignment
        assert shown is None or shown.score != 2
