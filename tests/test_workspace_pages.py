from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.workspace import (
    PathOutsideProject,
    init_project,
    list_pages,
    list_papers,
    read_draft,
    read_note,
    write_document,
    write_draft,
    write_note,
)


def test_write_then_read_note_round_trips_and_assigns_a_stable_id(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")

    written = write_note(root, "reading-log.md", "Some **notes**.", visibility="shared")
    assert written["page_id"].startswith("pg_")
    assert written["visibility"] == "shared"

    read = read_note(root, "reading-log.md")
    assert read["page_id"] == written["page_id"]
    assert read["created"] == written["created"]
    assert read["visibility"] == "shared"
    assert read["content"].strip() == "Some **notes**."

    # Re-saving preserves identity and creation time.
    again = write_note(root, "reading-log.md", "Updated content.", visibility="private")
    assert again["page_id"] == written["page_id"]
    assert again["created"] == written["created"]
    assert again["visibility"] == "private"


def test_note_visibility_defaults_to_private(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_note(root, "n.md", "content")
    assert read_note(root, "n.md")["visibility"] == "private"


def test_write_then_read_draft_round_trips(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")

    written = write_draft(root, "intro.md", "Citing [@doc_a1b2c3d4e5f6a7b8].")
    read = read_draft(root, "intro.md")
    assert read["page_id"] == written["page_id"]
    assert "[@doc_a1b2c3d4e5f6a7b8]" in read["content"]


def test_pages_can_nest_in_folders(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_note(root, "methods/sampling.md", "Sampling notes.")
    assert list_pages(root, "notes") == ["methods/sampling.md"]


def test_page_paths_cannot_escape_the_project(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    outside = tmp_path / "escaped.md"

    for relpath in ("../../escaped.md", "methods/../../../escaped.md", str(outside)):
        with pytest.raises(PathOutsideProject):
            write_note(root, relpath, "content")
        with pytest.raises(PathOutsideProject):
            write_draft(root, relpath, "content")
        with pytest.raises(PathOutsideProject):
            read_note(root, relpath)
        with pytest.raises(PathOutsideProject):
            read_draft(root, relpath)

    assert not outside.exists()


def test_page_path_cannot_be_the_directory_itself(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    for relpath in ("", "."):
        with pytest.raises(PathOutsideProject):
            write_note(root, relpath, "content")


def test_nested_paths_below_the_project_are_allowed(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    write_note(root, "a/b/c/deep.md", "Deep note.")
    assert read_note(root, "a/b/c/deep.md")["content"].strip() == "Deep note."


def test_list_pages_on_missing_or_empty_root(tmp_path: Path) -> None:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    assert list_pages(root, "notes") == []
    assert list_pages(root, "drafts") == []


def test_list_papers_summarises_every_ingested_paper(tmp_path: Path) -> None:
    from kiwi.types import Document, Section
    from kiwi.workspace import document_id

    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    assert list_papers(root) == []

    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture")
    doc_id = document_id(source)
    document = Document(
        document_id=doc_id,
        source_path=None,
        text="Some text.",
        sections=(Section(path="Intro", title="Intro", level=1, start=0, end=10),),
        references=(),
        metadata={"type": "article-journal", "title": "A Paper", "author": []},
        parser="test",
    )
    write_document(root, document, source)

    summaries = list_papers(root)
    assert len(summaries) == 1
    assert summaries[0]["document_id"] == doc_id
    assert summaries[0]["title"] == "A Paper"
    assert summaries[0]["sections"] == 1
    assert summaries[0]["references"] == 0
    assert summaries[0]["verification"] == "unresolved"
