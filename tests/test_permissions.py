from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.permissions import (
    DEFAULT_ROLES,
    LadderError,
    Member,
    Permission,
    Role,
    insert_role,
    validate_ladder,
)
from kiwi.workspace import (
    ProjectSettings,
    init_project,
    may_read_note,
    permits,
    read_settings,
    write_draft,
    write_note,
    write_settings,
)
from kiwi.workspace.settings import (
    OwnershipError,
    claim_ownership,
    transfer_ownership,
)


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    return root


def test_the_default_ladder_is_strictly_nested() -> None:
    validate_ladder(DEFAULT_ROLES)


def test_every_role_holds_everything_the_role_below_holds() -> None:
    ordered = sorted(DEFAULT_ROLES, key=lambda role: role.rank)
    for lower, higher in zip(ordered, ordered[1:], strict=False):
        assert lower.permissions <= higher.permissions, f"{higher.name} is not a superset"


def test_reviewer_reads_and_judges_without_editing() -> None:
    # Reviewer sits below Contributor so an external reviewer never has to
    # be an editor to record a judgement.
    reviewer = next(r for r in DEFAULT_ROLES if r.name == "Reviewer")
    assert Permission.OPEN_REVIEW_PAGE in reviewer.permissions
    assert Permission.RECORD_REVIEW_DECISIONS in reviewer.permissions
    assert Permission.PROPOSE_SUGGESTIONS in reviewer.permissions
    assert Permission.EDIT_DRAFTS not in reviewer.permissions
    assert Permission.RESOLVE_SUGGESTIONS not in reviewer.permissions


def test_a_role_missing_a_lower_role_permission_is_rejected() -> None:
    broken = (
        Role("Low", 1, frozenset({Permission.VIEW_PROJECT, Permission.VIEW_PAPERS})),
        Role("High", 2, frozenset({Permission.VIEW_PROJECT})),
    )
    with pytest.raises(LadderError) as exc:
        validate_ladder(broken)
    assert "view_papers" in str(exc.value)


def test_two_roles_at_one_rank_are_rejected() -> None:
    clashing = (
        Role("A", 1, frozenset({Permission.VIEW_PROJECT})),
        Role("B", 1, frozenset({Permission.VIEW_PROJECT})),
    )
    with pytest.raises(LadderError):
        validate_ladder(clashing)


def test_a_role_can_be_inserted_between_two_existing_ones() -> None:
    # A superset of the role below and a subset of the one above.
    viewer = next(r for r in DEFAULT_ROLES if r.name == "Viewer")
    inserted = Role("Reader", 2, frozenset(viewer.permissions | {Permission.VIEW_SHARED_NOTES}))
    updated = insert_role(DEFAULT_ROLES, inserted)

    validate_ladder(updated)
    assert [r.name for r in updated][:3] == ["Viewer", "Reader", "Commenter"]
    assert len(updated) == len(DEFAULT_ROLES) + 1


def test_a_role_holding_what_the_role_above_lacks_is_rejected() -> None:
    # Inserting below Commenter a role that may read the process record
    # would leave Commenter holding less than the role beneath it.
    viewer = next(r for r in DEFAULT_ROLES if r.name == "Viewer")
    with pytest.raises(LadderError):
        insert_role(
            DEFAULT_ROLES,
            Role("Auditor", 2, frozenset(viewer.permissions | {Permission.VIEW_PROCESS_RECORD})),
        )


def test_inserting_a_role_that_drops_lower_permissions_is_rejected() -> None:
    with pytest.raises(LadderError):
        insert_role(DEFAULT_ROLES, Role("Broken", 3, frozenset()))


def test_a_member_with_no_role_has_no_access(tmp_path: Path) -> None:
    # Not Viewer. Defaulting to read access would grant it by omission.
    settings = ProjectSettings(owner="wei", members=(Member(name="lee"),))
    assert settings.role_of("lee") is None
    assert permits(settings, "lee", Permission.VIEW_PROJECT) is False


def test_someone_who_is_not_a_member_has_no_access() -> None:
    settings = ProjectSettings(owner="wei")
    assert permits(settings, "stranger", Permission.VIEW_PROJECT) is False


def test_the_owner_holds_every_permission() -> None:
    settings = ProjectSettings(owner="wei")
    assert all(permits(settings, "wei", permission) for permission in Permission)


def test_settings_round_trip(tmp_path: Path) -> None:
    root = _project(tmp_path)
    settings = ProjectSettings(
        owner="wei",
        members=(Member(name="lee", role="Reviewer"), Member(name="sam")),
        successors=("lee",),
    )
    write_settings(root, settings)

    restored = read_settings(root)
    assert restored.owner == "wei"
    assert restored.successors == ("lee",)
    assert permits(restored, "lee", Permission.OPEN_REVIEW_PAGE)
    assert not permits(restored, "lee", Permission.EDIT_DRAFTS)
    assert restored.role_of("sam") is None


def test_a_project_without_settings_reads_as_single_owner(tmp_path: Path) -> None:
    root = _project(tmp_path)
    settings = read_settings(root)
    assert settings.owner
    assert settings.members == ()
    assert permits(settings, settings.owner, Permission.DELETE_PROJECT)


def test_writing_a_broken_ladder_is_refused(tmp_path: Path) -> None:
    root = _project(tmp_path)
    broken = ProjectSettings(
        owner="wei",
        roles=(
            Role("Low", 1, frozenset({Permission.VIEW_PROJECT, Permission.VIEW_PAPERS})),
            Role("High", 2, frozenset({Permission.VIEW_PROJECT})),
        ),
    )
    with pytest.raises(LadderError):
        write_settings(root, broken)


def test_ownership_transfers_and_the_former_owner_keeps_a_role() -> None:
    settings = ProjectSettings(owner="wei", members=(Member(name="lee", role="Contributor"),))
    updated = transfer_ownership(settings, "lee")

    assert updated.owner == "lee"
    assert permits(updated, "lee", Permission.DELETE_PROJECT)
    assert updated.role_of("wei") is not None
    assert not permits(updated, "wei", Permission.DELETE_PROJECT)


def test_a_designated_successor_can_claim_ownership() -> None:
    settings = ProjectSettings(owner="wei", successors=("lee",))
    assert claim_ownership(settings, "lee").owner == "lee"


def test_someone_who_is_not_a_successor_cannot_claim_ownership() -> None:
    settings = ProjectSettings(owner="wei", successors=("lee",))
    with pytest.raises(OwnershipError):
        claim_ownership(settings, "sam")


def test_a_project_always_has_an_owner() -> None:
    with pytest.raises(OwnershipError):
        transfer_ownership(ProjectSettings(owner="wei"), "")


def test_no_role_reads_an_unshared_note(tmp_path: Path) -> None:
    # Including Owner. Sharing is the author's toggle and nobody else's.
    root = _project(tmp_path)
    note = write_note(root, "private.md", "thinking out loud", "private", author="lee")
    settings = ProjectSettings(owner="wei", members=(Member(name="lee", role="Contributor"),))

    assert may_read_note(settings, "lee", note) is True
    assert may_read_note(settings, "wei", note) is False


def test_a_shared_note_is_readable_by_a_member_who_may_read_shared_notes(tmp_path: Path) -> None:
    root = _project(tmp_path)
    note = write_note(root, "shared.md", "worth circulating", "shared", author="lee")
    settings = ProjectSettings(owner="wei", members=(Member(name="sam", role="Commenter"),))

    assert may_read_note(settings, "wei", note) is True
    assert may_read_note(settings, "sam", note) is True


def test_a_shared_note_stays_closed_to_a_member_with_no_role(tmp_path: Path) -> None:
    root = _project(tmp_path)
    note = write_note(root, "shared.md", "worth circulating", "shared", author="lee")
    settings = ProjectSettings(owner="wei", members=(Member(name="sam"),))
    assert may_read_note(settings, "sam", note) is False


def test_a_note_records_its_author_once(tmp_path: Path) -> None:
    root = _project(tmp_path)
    write_note(root, "n.md", "first", "private", author="lee")
    rewritten = write_note(root, "n.md", "edited by someone else", "private", author="wei")
    assert rewritten["author"] == "lee"


def _shared_project(tmp_path: Path) -> Path:
    """A project with an owner, a reviewer, and an unassigned member."""
    root = _project(tmp_path)
    write_settings(
        root,
        ProjectSettings(
            owner="wei",
            members=(Member(name="lee", role="Reviewer"), Member(name="sam")),
        ),
    )
    return root


def test_a_reviewer_may_not_edit_a_draft(tmp_path: Path) -> None:
    from kiwi.core import set_claim_intent
    from kiwi.permissions import PermissionDenied

    root = _shared_project(tmp_path)
    write_draft(root, "intro.md", "text")
    with pytest.raises(PermissionDenied):
        set_claim_intent(root, "intro.md", "a claim", "background", actor="lee")


def test_a_reviewer_may_not_resolve_a_suggestion(tmp_path: Path) -> None:
    from kiwi.core import accept_suggestion
    from kiwi.permissions import PermissionDenied

    root = _shared_project(tmp_path)
    write_draft(root, "intro.md", "text")
    with pytest.raises(PermissionDenied):
        accept_suggestion(root, "intro.md", "sug_whatever", actor="lee")


def test_a_member_with_no_role_may_not_align(tmp_path: Path) -> None:
    from kiwi.core import align_draft
    from kiwi.permissions import PermissionDenied

    root = _shared_project(tmp_path)
    write_draft(root, "intro.md", "text")
    with pytest.raises(PermissionDenied):
        align_draft(root, "intro.md", actor="sam")


def test_the_owner_may_do_all_of_it(tmp_path: Path) -> None:
    from kiwi.core import align_draft

    root = _shared_project(tmp_path)
    write_draft(root, "intro.md", "Nothing cited here.")
    assert align_draft(root, "intro.md", actor="wei") == []


def test_a_single_user_project_is_unaffected_by_permission_checks(tmp_path: Path) -> None:
    # No project.json means one owner holding everything, so a workspace
    # used by one person behaves as it did before roles existed.
    from kiwi.core import align_draft

    root = _project(tmp_path)
    write_draft(root, "intro.md", "Nothing cited here.")
    assert align_draft(root, "intro.md") == []


def test_annotating_is_refused_without_the_permission(tmp_path: Path) -> None:
    from kiwi.permissions import PermissionDenied
    from kiwi.types import Document, Section
    from kiwi.workspace import annotate, document_id, write_document

    root = _shared_project(tmp_path)
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture")
    doc_id = document_id(source)
    text = "A sentence worth marking."
    write_document(
        root,
        Document(
            document_id=doc_id,
            source_path=None,
            text=text,
            sections=(Section(path="Results", title="Results", level=1, start=0, end=len(text)),),
            references=(),
            metadata={"type": "article-journal", "title": "Demo", "author": []},
            parser="test",
        ),
        source,
    )

    # A Reviewer may annotate; a member with no role may not.
    assert annotate(root, doc_id, text, author="lee", actor="lee").author == "lee"
    with pytest.raises(PermissionDenied):
        annotate(root, doc_id, text, author="sam", actor="sam")
