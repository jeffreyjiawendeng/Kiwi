from __future__ import annotations

import json
from pathlib import Path

from kiwi.workspace import (
    forget_all_projects,
    forget_project,
    list_known_projects,
    register_project,
    rename_project,
)


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


def test_forgetting_a_project_leaves_its_files_alone(tmp_path: Path) -> None:
    project = tmp_path / "Kept.kiwi"
    project.mkdir()
    (project / "kiwi.json").write_text("{}", encoding="utf-8")
    register_project(project)

    assert forget_project(project) is True
    assert list_known_projects() == []
    assert project.is_dir(), "forgetting must not touch the folder"
    assert forget_project(project) is False


def test_renaming_a_project_changes_the_registry_and_the_manifest(tmp_path: Path) -> None:
    project = tmp_path / "Old.kiwi"
    project.mkdir()
    (project / "kiwi.json").write_text('{"name": "Old"}', encoding="utf-8")
    register_project(project)

    entry = rename_project(project, "New name")
    assert entry["name"] == "New name"
    assert list_known_projects()[0]["name"] == "New name"
    assert json.loads((project / "kiwi.json").read_text(encoding="utf-8"))["name"] == "New name"
    # The folder is identified by where it is, not by what it is called.
    assert project.name == "Old.kiwi"


def test_opening_a_renamed_project_keeps_its_name(tmp_path: Path) -> None:
    """Opening a project is not a rename.

    The registry entry is rewritten on every open, so a name set through
    rename_project is lost unless it is carried across.
    """
    project = tmp_path / "Old.kiwi"
    project.mkdir()
    register_project(project)
    rename_project(project, "New name")

    assert register_project(project)["name"] == "New name"
    assert list_known_projects()[0]["name"] == "New name"


def test_forgetting_everything_empties_the_list(tmp_path: Path) -> None:
    for name in ("A.kiwi", "B.kiwi"):
        (tmp_path / name).mkdir()
        register_project(tmp_path / name)
    assert forget_all_projects() == 2
    assert list_known_projects() == []
