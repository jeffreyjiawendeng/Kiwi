"""The review surface and the process record.

A reviewer examines the citation work in a draft: what each claim cites,
the passage the score was computed from, and the state of the cited work.
Scores and statuses are inputs to a judgement rather than a verdict, so
every decision recorded here is made by a person and carries their name.

The process record keeps what was proposed and declined alongside what
was decided. It is a disclosure surface as well as a history, which is
why reading it is a separate permission from reading the draft.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from kiwi.claims import Claim
from kiwi.permissions import Permission
from kiwi.protocols import Resolver
from kiwi.suggestions import new_suggestion
from kiwi.types import Alignment, Anchor, Json, Reference, Suggestion, SuggestionState
from kiwi.workspace import read_claims, read_suggestions, require, write_suggestions
from kiwi.workspace.settings import permits, read_settings
from kiwi.workspace.sidecar import read_sidecar, sidecar_path

APPROVED = "approved"
CHANGES_REQUESTED = "changes_requested"
RESOLVED = "resolved"

DECISIONS = frozenset({APPROVED, CHANGES_REQUESTED, RESOLVED})

UNVERIFIED = "unverified"


class UnknownDecision(ValueError):
    """Raised when a review decision is not one the project records."""


@dataclass(frozen=True)
class ReviewItem:
    """One claim as a reviewer sees it."""

    claim: str
    citation: str
    source_title: str
    intent: str
    alignment: Alignment | None
    evidence: Anchor | None
    stale: bool
    source_status: str


@dataclass(frozen=True)
class ReviewDecision:
    claim: str
    citation: str
    decision: str
    reviewer: str
    comment: str
    recorded: str


def _reference_for(metadata: Json) -> Reference:
    """The cited work stated as a reference, for resolving it externally."""
    issued = metadata.get("issued") or {}
    parts = issued.get("date-parts") or [[]]
    year = parts[0][0] if parts and parts[0] else None
    authors = tuple(
        str(a.get("family") or a.get("literal") or "").strip()
        for a in metadata.get("author") or []
        if a.get("family") or a.get("literal")
    )
    return Reference(
        raw=str(metadata.get("title") or ""),
        title=metadata.get("title") or None,
        authors=authors,
        year=year,
        doi=metadata.get("DOI"),
        arxiv_id=None,
    )


def verify_cited_work(
    project: Path, document_id: str, resolver: Resolver | None = None
) -> str | None:
    """Resolve a paper against Crossref and record the status on it.

    ``verify_document`` checks the references a paper cites. This checks
    the paper itself, which is what a reviewer needs: a citation can
    resolve while the work it points at has been retracted. Returns the
    recorded status, or ``None`` when no Resolver is configured.
    """
    from kiwi.registry import default_resolver

    resolver = resolver if resolver is not None else default_resolver()
    if resolver is None:
        return None

    metadata_path = project / "papers" / document_id / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    result = resolver.resolve(_reference_for(metadata))

    metadata.setdefault("kiwi", {})["source_status"] = result.status.value
    if result.retraction_notice:
        metadata["kiwi"]["retraction_notice"] = result.retraction_notice
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return result.status.value


def _source(project: Path, citation: str) -> tuple[str, str]:
    """The cited paper's title and recorded verification status."""
    metadata_path = project / "papers" / citation / "metadata.json"
    if not metadata_path.exists():
        return citation, UNVERIFIED
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    kiwi = metadata.get("kiwi") or {}
    return metadata.get("title") or citation, kiwi.get("source_status") or UNVERIFIED


def _item(project: Path, claim: Claim) -> ReviewItem:
    shown = claim.deep_alignment or claim.alignment
    title, status = _source(project, claim.citation)
    return ReviewItem(
        claim=claim.anchor.exact,
        citation=claim.citation,
        source_title=title,
        intent=claim.intent.value,
        alignment=shown,
        evidence=shown.evidence if shown is not None else None,
        stale=claim.deep_is_stale,
        source_status=status,
    )


def review_draft(project: Path, relpath: str, actor: str | None = None) -> list[ReviewItem]:
    """Every cited sentence in a draft, with what a reviewer needs to judge it.

    The evidence passage is always included. A score whose passage is not
    shown cannot be checked against what was read.
    """
    require(project, Permission.OPEN_REVIEW_PAGE, actor)
    return [_item(project, claim) for claim in read_claims(project, relpath)]


def read_decisions(project: Path, relpath: str) -> list[ReviewDecision]:
    payload = read_sidecar(project, relpath)
    return [
        ReviewDecision(
            claim=d["claim"],
            citation=d["citation"],
            decision=d["decision"],
            reviewer=d["reviewer"],
            comment=d.get("comment", ""),
            recorded=d["recorded"],
        )
        for d in payload.get("review", [])
    ]


def record_decision(
    project: Path,
    relpath: str,
    claim: str,
    citation: str,
    decision: str,
    reviewer: str,
    comment: str = "",
) -> list[ReviewDecision]:
    """Record one reviewer's judgement of one claim.

    Decisions accumulate rather than replace each other, so a draft
    retains who reviewed what and in what order.
    """
    require(project, Permission.RECORD_REVIEW_DECISIONS, reviewer)
    if decision not in DECISIONS:
        raise UnknownDecision(f"unknown decision: {decision}")

    payload = read_sidecar(project, relpath)
    entry: Json = {
        "claim": claim,
        "citation": citation,
        "decision": decision,
        "reviewer": reviewer,
        "comment": comment,
        "recorded": _now(),
    }
    payload["review"] = [*payload.get("review", []), entry]

    path = sidecar_path(project, relpath)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return read_decisions(project, relpath)


def propose_suggestion(
    project: Path, relpath: str, claim: str, proposed: str, author: str
) -> Suggestion:
    """Attach a suggestion to a claim on someone's behalf.

    A reviewer's suggestion is the same record as a generated one and
    carries the same weight: neither applies itself. Only the origin
    differs, and it is displayed on every suggestion.
    """
    require(project, Permission.PROPOSE_SUGGESTIONS, author)
    target = next((c for c in read_claims(project, relpath) if c.anchor.exact == claim), None)
    if target is None:
        raise ValueError(f"no claim matching that text in {relpath}")

    suggestion = new_suggestion(target.anchor, proposed, author)
    existing = read_suggestions(project, relpath)
    page_id = str(read_sidecar(project, relpath).get("page_id") or "")
    write_suggestions(project, relpath, page_id, [*existing, suggestion])
    return suggestion


def submit_for_review(project: Path, relpath: str, actor: str | None = None) -> list[ReviewItem]:
    """Run a deep check, then present the draft for review.

    The check runs first so a reviewer never opens a draft whose alignment
    state is unknown.
    """
    from kiwi.core import align_draft
    from kiwi.types import Depth

    who = require(project, Permission.EDIT_DRAFTS, actor)
    align_draft(project, relpath, depth=Depth.DEEP, actor=who)
    return [_item(project, claim) for claim in read_claims(project, relpath)]


def review_satisfied(project: Path, relpath: str) -> bool:
    """Whether every role whose review is required has approved.

    A project that requires no role's review reports satisfied, so review
    is advisory unless the owner configures otherwise.
    """
    settings = read_settings(project)
    if not settings.required_reviews:
        return True

    approved = {
        settings.role_of(d.reviewer).name  # type: ignore[union-attr]
        for d in read_decisions(project, relpath)
        if d.decision == APPROVED and settings.role_of(d.reviewer) is not None
    }
    return set(settings.required_reviews) <= approved


def blocking_reviews(project: Path, relpath: str) -> list[str]:
    """Roles whose approval a draft still needs."""
    settings = read_settings(project)
    approved = {
        settings.role_of(d.reviewer).name  # type: ignore[union-attr]
        for d in read_decisions(project, relpath)
        if d.decision == APPROVED and settings.role_of(d.reviewer) is not None
    }
    return sorted(set(settings.required_reviews) - approved)


def process_record(project: Path, relpath: str, actor: str | None = None) -> Json:
    """What was proposed, what was declined, and what was decided.

    Rejected suggestions are retained here rather than deleted, so the
    record holds the proposals a draft does not show.
    """
    who = require(project, Permission.VIEW_PROCESS_RECORD, actor)
    # Reading a draft and reading everything ever proposed and declined on
    # it are different things, so the declined half is gated separately.
    may_see_declined = permits(read_settings(project), who, Permission.VIEW_REJECTED_SUGGESTIONS)
    suggestions = read_suggestions(project, relpath)
    return {
        "decisions": [
            {
                "claim": d.claim,
                "citation": d.citation,
                "decision": d.decision,
                "reviewer": d.reviewer,
                "comment": d.comment,
                "recorded": d.recorded,
            }
            for d in read_decisions(project, relpath)
        ],
        "accepted": [
            _suggestion_entry(s) for s in suggestions if s.state is SuggestionState.ACCEPTED
        ],
        "rejected": (
            [_suggestion_entry(s) for s in suggestions if s.state is SuggestionState.REJECTED]
            if may_see_declined
            else []
        ),
        "pending": [
            _suggestion_entry(s) for s in suggestions if s.state is SuggestionState.PENDING
        ],
    }


def _suggestion_entry(suggestion: Suggestion) -> Json:
    return {
        "suggestion_id": suggestion.suggestion_id,
        "current": suggestion.anchor.exact,
        "proposed": suggestion.proposed,
        "origin": suggestion.origin,
        "created": suggestion.created,
        "resolved": suggestion.resolved,
    }


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
