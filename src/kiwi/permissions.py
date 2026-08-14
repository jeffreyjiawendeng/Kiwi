"""Roles and permissions for a project.

Roles are strictly nested: each role holds every permission of the role
beneath it plus its own, so access can be read off rank without consulting
a matrix. Inserting a role validates that it is a superset of the role
below and a subset of the one above.

A member with no assigned role has no access. Defaulting an unassigned
member to the lowest role would grant access by omission.

Identity is recorded rather than authenticated. A workspace is a folder,
so these checks report what a project's records permit, and an actor is a
name carried by the operation.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Permission(Enum):
    VIEW_PROJECT = "view_project"
    VIEW_PROJECT_SETTINGS = "view_project_settings"
    MANAGE_PROJECT_SETTINGS = "manage_project_settings"
    DEFINE_ROLES = "define_roles"
    ADD_REMOVE_MEMBERS = "add_remove_members"
    ASSIGN_ROLES = "assign_roles"
    CONFIGURE_CROSS_PROJECT_REFERENCES = "configure_cross_project_references"
    DELETE_PROJECT = "delete_project"

    VIEW_PAPERS = "view_papers"
    ADD_PAPERS = "add_papers"
    ANNOTATE_PAPERS = "annotate_papers"
    EDIT_PAPER_METADATA = "edit_paper_metadata"
    REMOVE_PAPERS = "remove_papers"

    VIEW_SHARED_NOTES = "view_shared_notes"
    CREATE_NOTES = "create_notes"
    EDIT_OWN_NOTES = "edit_own_notes"
    EDIT_OTHERS_NOTES = "edit_others_notes"
    SHARE_OWN_NOTES = "share_own_notes"

    VIEW_DRAFTS = "view_drafts"
    CREATE_DRAFTS = "create_drafts"
    EDIT_DRAFTS = "edit_drafts"
    ATTACH_CITATIONS = "attach_citations"
    OVERRIDE_CITATION_INTENT = "override_citation_intent"
    PROPOSE_SUGGESTIONS = "propose_suggestions"
    RESOLVE_SUGGESTIONS = "resolve_suggestions"
    DELETE_DRAFTS = "delete_drafts"

    RUN_REFERENCE_VERIFICATION = "run_reference_verification"
    RUN_QUICK_ALIGNMENT = "run_quick_alignment"
    RUN_DEEP_ALIGNMENT = "run_deep_alignment"
    OPEN_REVIEW_PAGE = "open_review_page"
    RECORD_REVIEW_DECISIONS = "record_review_decisions"
    RESOLVE_REVIEW = "resolve_review"
    REQUIRE_REVIEW = "require_review"

    EXPORT_DOCUMENTS = "export_documents"
    EXPORT_BIBLIOGRAPHY = "export_bibliography"

    # Reading a draft and reading everything ever proposed and declined on
    # it are different things, so they are different permissions.
    VIEW_PROCESS_RECORD = "view_process_record"
    VIEW_REJECTED_SUGGESTIONS = "view_rejected_suggestions"


@dataclass(frozen=True)
class Role:
    name: str
    rank: int
    permissions: frozenset[Permission]


@dataclass(frozen=True)
class Member:
    name: str
    role: str | None = None  # None until a role is assigned


class LadderError(ValueError):
    """Raised when a set of roles is not strictly nested by rank."""


class PermissionDenied(PermissionError):
    """Raised when a project's records do not grant an operation."""


_VIEWER = frozenset({Permission.VIEW_PROJECT, Permission.VIEW_PAPERS, Permission.VIEW_DRAFTS})

_COMMENTER = _VIEWER | {
    Permission.VIEW_SHARED_NOTES,
    Permission.ANNOTATE_PAPERS,
    Permission.CREATE_NOTES,
    Permission.EDIT_OWN_NOTES,
    Permission.SHARE_OWN_NOTES,
}

# Reviewer sits below Contributor so that an external reviewer reads
# drafts and records judgements without gaining the ability to edit them.
_REVIEWER = _COMMENTER | {
    Permission.OPEN_REVIEW_PAGE,
    Permission.RECORD_REVIEW_DECISIONS,
    Permission.PROPOSE_SUGGESTIONS,
    Permission.VIEW_PROCESS_RECORD,
    Permission.EXPORT_BIBLIOGRAPHY,
    Permission.EXPORT_DOCUMENTS,
}

_CONTRIBUTOR = _REVIEWER | {
    Permission.CREATE_DRAFTS,
    Permission.EDIT_DRAFTS,
    Permission.ATTACH_CITATIONS,
    Permission.OVERRIDE_CITATION_INTENT,
    Permission.RESOLVE_SUGGESTIONS,
    Permission.RUN_QUICK_ALIGNMENT,
    Permission.RUN_DEEP_ALIGNMENT,
    Permission.RUN_REFERENCE_VERIFICATION,
    Permission.ADD_PAPERS,
    Permission.VIEW_REJECTED_SUGGESTIONS,
}

_MAINTAINER = _CONTRIBUTOR | {
    Permission.ADD_REMOVE_MEMBERS,
    Permission.ASSIGN_ROLES,
    Permission.EDIT_PAPER_METADATA,
    Permission.REMOVE_PAPERS,
    Permission.EDIT_OTHERS_NOTES,
    Permission.DELETE_DRAFTS,
    Permission.RESOLVE_REVIEW,
    Permission.VIEW_PROJECT_SETTINGS,
    Permission.MANAGE_PROJECT_SETTINGS,
}

_OWNER = _MAINTAINER | {
    Permission.DEFINE_ROLES,
    Permission.CONFIGURE_CROSS_PROJECT_REFERENCES,
    Permission.DELETE_PROJECT,
    Permission.REQUIRE_REVIEW,
}

OWNER_ROLE = "Owner"

DEFAULT_ROLES: tuple[Role, ...] = (
    Role("Viewer", 1, frozenset(_VIEWER)),
    Role("Commenter", 2, frozenset(_COMMENTER)),
    Role("Reviewer", 3, frozenset(_REVIEWER)),
    Role("Contributor", 4, frozenset(_CONTRIBUTOR)),
    Role("Maintainer", 5, frozenset(_MAINTAINER)),
    Role(OWNER_ROLE, 6, frozenset(_OWNER)),
)


def validate_ladder(roles: tuple[Role, ...]) -> None:
    """Confirm every role holds every permission of the role beneath it.

    Raises ``LadderError`` naming the first pair that breaks the rule.
    Ranks must also be distinct, because two roles at one rank have no
    defined order and the superset test would be ambiguous.
    """
    ordered = sorted(roles, key=lambda role: role.rank)
    ranks = [role.rank for role in ordered]
    if len(set(ranks)) != len(ranks):
        raise LadderError("two roles share a rank")

    for lower, higher in zip(ordered, ordered[1:], strict=False):
        missing = lower.permissions - higher.permissions
        if missing:
            names = ", ".join(sorted(p.value for p in missing))
            raise LadderError(f"{higher.name} lacks permissions held by {lower.name}: {names}")


def insert_role(roles: tuple[Role, ...], role: Role) -> tuple[Role, ...]:
    """Add ``role`` at its rank, validating the ladder still holds.

    Ranks at or above the new role shift up by one, so a role can be
    inserted between two existing ones without recomputing any other
    role's permissions.
    """
    shifted = tuple(
        Role(r.name, r.rank + 1 if r.rank >= role.rank else r.rank, r.permissions) for r in roles
    )
    combined = (*shifted, role)
    validate_ladder(combined)
    return tuple(sorted(combined, key=lambda r: r.rank))
