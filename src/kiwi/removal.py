"""Removing a paper, a draft, or a note, and everything it owns.

What an object owns is deleted with it. What merely refers to it is not,
because a reference is another object's content and deleting it would
edit that object on a reader's behalf:

    a paper owns its parsed text, its structure, its annotations, its
    verification results, and its chunks in the index

    a draft owns its sidecar, which holds the scored claims, the
    suggestions raised against it, and the review decisions recorded on it

    a note owns nothing else

A draft citing a removed paper keeps its prose and its decisions. The
citation is reported rather than rewritten, so the reader decides what
their own sentence should say.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from kiwi.permissions import Permission
from kiwi.workspace import list_pages, read_claims, read_note
from kiwi.workspace.pages import resolve_within
from kiwi.workspace.settings import (
    current_author,
    is_governed,
    may_read_note,
    read_settings,
    require,
)
from kiwi.workspace.sidecar import sidecar_path


class NotFound(Exception):
    """The object asked for is not in this project."""


@dataclass(frozen=True)
class Removal:
    """What was deleted, and what still refers to it."""

    removed: tuple[str, ...]
    citing_drafts: tuple[str, ...] = ()


def citing_drafts(project: Path, document_id: str) -> tuple[str, ...]:
    """Drafts holding a scored claim that cites ``document_id``."""
    found = []
    for relpath in list_pages(project, "drafts"):
        if any(claim.citation == document_id for claim in read_claims(project, relpath)):
            found.append(relpath)
    return tuple(found)


def remove_paper(project: Path, document_id: str, actor: str | None = None) -> Removal:
    """Delete a paper, its annotations, its verification, and its chunks."""
    require(project, Permission.REMOVE_PAPERS, actor)

    paper_dir = project / "papers" / document_id
    if not paper_dir.is_dir():
        raise NotFound(f"no paper {document_id} in this project")

    citing = citing_drafts(project, document_id)

    from kiwi.registry import default_store

    # The index is separate from the paper's folder, so a paper deleted
    # from disk alone would keep answering questions.
    default_store(project).delete_document(document_id)
    shutil.rmtree(paper_dir)

    return Removal(removed=(f"papers/{document_id}",), citing_drafts=citing)


def remove_draft(project: Path, relpath: str, actor: str | None = None) -> Removal:
    """Delete a draft and its sidecar.

    The sidecar holds the review decisions recorded on this draft, and
    they go with it. Deleting a draft is the deliberate discarding of the
    work and the record of judging it.
    """
    require(project, Permission.DELETE_DRAFTS, actor)

    draft = resolve_within(project / "drafts", relpath)
    if not draft.is_file():
        raise NotFound(f"no draft {relpath} in this project")

    removed = [f"drafts/{relpath}"]
    sidecar = sidecar_path(project, relpath)
    draft.unlink()
    if sidecar.is_file():
        sidecar.unlink()
        removed.append(f"drafts/{sidecar.name}")

    return Removal(removed=tuple(removed))


def remove_note(project: Path, relpath: str, actor: str | None = None) -> Removal:
    """Delete a note.

    An author deletes their own note. Deleting anyone else's needs the
    permission that covers editing them, and a note the actor may not
    read is reported as absent rather than as forbidden, which would
    confirm that it exists.
    """
    who = actor or current_author()
    note = project / "notes" / relpath
    if not resolve_within(project / "notes", relpath).is_file():
        raise NotFound(f"no note {relpath} in this project")

    payload = read_note(project, relpath)
    settings = read_settings(project)
    if is_governed(project) and not may_read_note(settings, who, payload):
        raise NotFound(f"no note {relpath} in this project")

    if str(payload.get("author") or "") != who:
        require(project, Permission.EDIT_OTHERS_NOTES, actor)

    resolve_within(project / "notes", relpath).unlink()
    sidecar = note.with_name(note.name + ".kiwi.json")
    removed = [f"notes/{relpath}"]
    if sidecar.is_file():
        sidecar.unlink()
        removed.append(f"notes/{sidecar.name}")
    return Removal(removed=tuple(removed))
