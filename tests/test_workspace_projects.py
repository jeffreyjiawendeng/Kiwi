from __future__ import annotations

from pathlib import Path

from kiwi.workspace import list_known_projects, register_project


def test_register_and_list_projects(tmp_path: Path) -> None:
    project = tmp_path / "Demo.kiwi"
    project.mkdir()

    entry = register_project(project)
    assert entry["path"] == str(project.resolve())
    assert entry["name"] == "Demo"

    known = list_known_projects()
    assert len(known) == 1
    assert known[0]["path"] == str(project.resolve())


def test_registering_again_moves_it_to_front_without_duplicating(tmp_path: Path) -> None:
    a = tmp_path / "A.kiwi"
    b = tmp_path / "B.kiwi"
    a.mkdir()
    b.mkdir()

    register_project(a)
    register_project(b)
    register_project(a)

    known = list_known_projects()
    assert [e["path"] for e in known] == [str(a.resolve()), str(b.resolve())]


def test_deleted_projects_are_pruned_on_read(tmp_path: Path) -> None:
    project = tmp_path / "Gone.kiwi"
    project.mkdir()
    register_project(project)
    assert len(list_known_projects()) == 1

    project.rmdir()
    assert list_known_projects() == []


def test_no_registry_file_yet_returns_empty_list() -> None:
    assert list_known_projects() == []
