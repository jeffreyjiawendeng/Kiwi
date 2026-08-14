"""Project roles, members, ownership, and succession, in ``project.json``.

A project written before this file existed reads as a single-owner
project, so the file is written on first change rather than on open and
the workspace format version is unchanged.

Ownership is transferable and a project designates successors. A research
group turns over on a fixed cycle, and a workspace whose owner has left
and cannot be replaced is one nobody can administer.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path

from kiwi.permissions import (
    DEFAULT_ROLES,
    OWNER_ROLE,
    Member,
    Permission,
    PermissionDenied,
    Role,
    validate_ladder,
)
from kiwi.types import Json

DEFAULT_AUTHOR = "local"

_SETTINGS_FILE = "project.json"


@dataclass(frozen=True)
class ProjectSettings:
    owner: str
    roles: tuple[Role, ...] = DEFAULT_ROLES
    members: tuple[Member, ...] = ()
    successors: tuple[str, ...] = ()
    # Roles whose approval a draft needs before it moves on. Empty means
    # review is advisory, which is a configuration rather than a default
    # imposed on every project.
    required_reviews: tuple[str, ...] = ()

    def role_of(self, actor: str) -> Role | None:
        """The role assigned to ``actor``, or ``None`` where there is none.

        The owner always holds the owner role, so a project cannot reach a
        state where nobody can administer it.
        """
        if actor == self.owner:
            return next((r for r in self.roles if r.name == OWNER_ROLE), None)
        member = next((m for m in self.members if m.name == actor), None)
        if member is None or member.role is None:
            return None
        return next((r for r in self.roles if r.name == member.role), None)


class OwnershipError(ValueError):
    """Raised when a change would leave a project without an owner."""


def current_author() -> str:
    """The identity operations are recorded against."""
    return os.environ.get("KIWI_AUTHOR") or DEFAULT_AUTHOR


def settings_path(root: Path) -> Path:
    return root / _SETTINGS_FILE


def read_settings(root: Path) -> ProjectSettings:
    """Settings for a project, defaulting to a single-owner project."""
    path = settings_path(root)
    if not path.exists():
        return ProjectSettings(owner=current_author())

    payload = json.loads(path.read_text(encoding="utf-8"))
    roles = tuple(
        Role(
            name=r["name"],
            rank=r["rank"],
            permissions=frozenset(Permission(p) for p in r["permissions"]),
        )
        for r in payload.get("roles", [])
    )
    return ProjectSettings(
        owner=payload["owner"],
        roles=roles or DEFAULT_ROLES,
        members=tuple(
            Member(name=m["name"], role=m.get("role")) for m in payload.get("members", [])
        ),
        successors=tuple(payload.get("successors", [])),
        required_reviews=tuple(payload.get("required_reviews", [])),
    )


def write_settings(root: Path, settings: ProjectSettings) -> Path:
    """Persist settings, validating the role ladder first."""
    validate_ladder(settings.roles)
    if not settings.owner:
        raise OwnershipError("a project always has exactly one owner")

    payload: Json = {
        "owner": settings.owner,
        "successors": list(settings.successors),
        "required_reviews": list(settings.required_reviews),
        "roles": [
            {
                "name": role.name,
                "rank": role.rank,
                "permissions": sorted(p.value for p in role.permissions),
            }
            for role in sorted(settings.roles, key=lambda r: r.rank)
        ],
        "members": [{"name": m.name, "role": m.role} for m in settings.members],
    }
    path = settings_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def permits(settings: ProjectSettings, actor: str, permission: Permission) -> bool:
    """Whether the project's records grant ``actor`` this permission."""
    role = settings.role_of(actor)
    return role is not None and permission in role.permissions


def require(root: Path, permission: Permission, actor: str | None = None) -> str:
    """Confirm the acting identity holds ``permission``. Returns the actor.

    A project with no recorded settings has one owner holding everything,
    so a workspace used by one person is unaffected by these checks.
    """
    who = actor or current_author()
    if not permits(read_settings(root), who, permission):
        raise PermissionDenied(f"{who} may not {permission.value}")
    return who


def may_read_note(settings: ProjectSettings, actor: str, note: Json) -> bool:
    """Whether ``actor`` may read a note.

    Rank grants no access to an unshared note. No role, including Owner,
    reads a note its author has not shared: a scratchpad a supervisor can
    read is not a scratchpad. A note carrying no author predates authored
    notes and is readable by anyone holding the shared-notes permission.
    """
    author = str(note.get("author") or "")
    if author and author == actor:
        return True
    if str(note.get("visibility", "private")) != "shared":
        return not author
    return permits(settings, actor, Permission.VIEW_SHARED_NOTES)


def transfer_ownership(settings: ProjectSettings, to: str) -> ProjectSettings:
    """Hand ownership to a member. The former owner keeps a role.

    The outgoing owner is recorded as a Maintainer rather than dropped,
    because removing their access is a separate decision from handing over
    administration.
    """
    if not to:
        raise OwnershipError("a project always has exactly one owner")
    if to == settings.owner:
        return settings

    members = [m for m in settings.members if m.name != to]
    members.append(Member(name=settings.owner, role="Maintainer"))
    return replace(
        settings,
        owner=to,
        members=tuple(members),
        successors=tuple(s for s in settings.successors if s != to),
    )


def claim_ownership(settings: ProjectSettings, claimant: str) -> ProjectSettings:
    """Transfer ownership to a designated successor.

    A successor claims a project whose owner is unreachable. Anyone not
    designated is refused, so the claim is a recorded decision made at
    project creation rather than a race.
    """
    if claimant not in settings.successors:
        raise OwnershipError(f"{claimant} is not a designated successor")
    return transfer_ownership(settings, claimant)
