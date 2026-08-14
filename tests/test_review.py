from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.claims import Claim
from kiwi.core import reject_suggestion
from kiwi.permissions import Member
from kiwi.review import (
    APPROVED,
    CHANGES_REQUESTED,
    UNVERIFIED,
    UnknownDecision,
    process_record,
    propose_suggestion,
    read_decisions,
    record_decision,
    review_draft,
)
from kiwi.types import Alignment, Anchor, Depth, Document, Intent, RefStatus, Section
from kiwi.workspace import (
    ProjectSettings,
    document_id,
    init_project,
    read_suggestions,
    write_claims,
    write_document,
    write_draft,
    write_settings,
)

CLAIM = "Accuracy exceeded 95 percent"


def _project(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "Demo.kiwi"
    init_project(root, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 review fixture")
    doc_id = document_id(source)
    text = "Accuracy reached 71 percent on the CS corpus."
    write_document(
        root,
        Document(
            document_id=doc_id,
            source_path=None,
            text=text,
            sections=(Section(path="Results", title="Results", level=1, start=0, end=len(text)),),
            references=(),
            metadata={"type": "article-journal", "title": "Retrieval Study", "author": []},
            parser="test",
        ),
        source,
    )
    write_draft(root, "intro.md", f"{CLAIM} [@{doc_id}].")

    claim = Claim(
        anchor=Anchor(
            document_id="pg_1",
            section_path="",
            start=0,
            end=len(CLAIM),
            exact=CLAIM,
            prefix="",
            suffix=f" [@{doc_id}].",
        ),
        citation=doc_id,
        intent=Intent.EVIDENCE,
        alignment=Alignment(
            score=0,
            intent=Intent.EVIDENCE,
            depth=Depth.QUICK,
            evidence=Anchor(
                document_id=doc_id,
                section_path="Results",
                start=0,
                end=27,
                exact="Accuracy reached 71 percent",
                prefix="",
                suffix="",
            ),
            model="test",
        ),
    )
    write_claims(root, "intro.md", "pg_1", [claim])
    write_settings(
        root,
        ProjectSettings(
            owner="wei",
            members=(Member(name="lee", role="Reviewer"), Member(name="sam")),
        ),
    )
    return root, doc_id


def test_the_review_page_shows_what_a_judgement_needs(tmp_path: Path) -> None:
    root, doc_id = _project(tmp_path)
    items = review_draft(root, "intro.md", actor="wei")

    assert len(items) == 1
    item = items[0]
    assert item.claim == CLAIM
    assert item.citation == doc_id
    assert item.source_title == "Retrieval Study"
    assert item.intent == "evidence"
    assert item.alignment is not None
    assert item.alignment.score == 0
    assert item.evidence is not None
    assert item.evidence.exact == "Accuracy reached 71 percent"


def test_an_unverified_source_is_reported_as_such(tmp_path: Path) -> None:
    root, _ = _project(tmp_path)
    assert review_draft(root, "intro.md", actor="wei")[0].source_status == UNVERIFIED


def test_a_draft_with_no_claims_reviews_empty(tmp_path: Path) -> None:
    root, _ = _project(tmp_path)
    write_draft(root, "empty.md", "Nothing cited here.")
    assert review_draft(root, "empty.md", actor="wei") == []


def test_decisions_accumulate_with_their_reviewer(tmp_path: Path) -> None:
    root, doc_id = _project(tmp_path)
    record_decision(root, "intro.md", CLAIM, doc_id, CHANGES_REQUESTED, "wei", "overstated")
    record_decision(root, "intro.md", CLAIM, doc_id, APPROVED, "lee")

    decisions = read_decisions(root, "intro.md")
    assert [d.decision for d in decisions] == [CHANGES_REQUESTED, APPROVED]
    assert [d.reviewer for d in decisions] == ["wei", "lee"]
    assert decisions[0].comment == "overstated"
    assert decisions[0].recorded


def test_an_unknown_decision_is_refused(tmp_path: Path) -> None:
    root, doc_id = _project(tmp_path)
    with pytest.raises(UnknownDecision):
        record_decision(root, "intro.md", CLAIM, doc_id, "looks-fine", "wei")


def test_review_decisions_do_not_disturb_the_claims(tmp_path: Path) -> None:
    from kiwi.workspace import read_claims

    root, doc_id = _project(tmp_path)
    record_decision(root, "intro.md", CLAIM, doc_id, APPROVED, "wei")
    assert len(read_claims(root, "intro.md")) == 1


def test_a_reviewer_proposes_a_suggestion_carrying_their_name(tmp_path: Path) -> None:
    root, _ = _project(tmp_path)
    suggestion = propose_suggestion(root, "intro.md", CLAIM, "Accuracy reached 71 percent", "wei")

    assert suggestion.origin == "wei"
    assert suggestion.anchor.exact == CLAIM
    assert read_suggestions(root, "intro.md")[0].suggestion_id == suggestion.suggestion_id


def test_proposing_against_an_unknown_claim_is_refused(tmp_path: Path) -> None:
    root, _ = _project(tmp_path)
    with pytest.raises(ValueError):
        propose_suggestion(root, "intro.md", "a sentence not in the draft", "x", "wei")


def test_the_process_record_keeps_what_was_declined(tmp_path: Path) -> None:
    root, doc_id = _project(tmp_path)
    suggestion = propose_suggestion(root, "intro.md", CLAIM, "Accuracy reached 71 percent", "wei")
    reject_suggestion(root, "intro.md", suggestion.suggestion_id, actor="wei")
    record_decision(root, "intro.md", CLAIM, doc_id, CHANGES_REQUESTED, "wei")

    record = process_record(root, "intro.md", actor="wei")
    assert len(record["rejected"]) == 1
    assert record["rejected"][0]["origin"] == "wei"
    assert record["rejected"][0]["proposed"] == "Accuracy reached 71 percent"
    assert record["pending"] == []
    assert len(record["decisions"]) == 1
    assert record["decisions"][0]["reviewer"] == "wei"


def test_a_member_with_no_role_may_not_open_the_review_page(tmp_path: Path) -> None:
    from kiwi.permissions import PermissionDenied

    root, _ = _project(tmp_path)
    with pytest.raises(PermissionDenied):
        review_draft(root, "intro.md", actor="sam")


def test_a_reviewer_opens_the_review_page(tmp_path: Path) -> None:
    root, _ = _project(tmp_path)
    assert len(review_draft(root, "intro.md", actor="lee")) == 1


def test_a_member_with_no_role_may_not_record_a_decision(tmp_path: Path) -> None:
    from kiwi.permissions import PermissionDenied

    root, doc_id = _project(tmp_path)
    with pytest.raises(PermissionDenied):
        record_decision(root, "intro.md", CLAIM, doc_id, APPROVED, "sam")


def test_the_declined_half_of_the_record_is_gated_separately(tmp_path: Path) -> None:
    # A Reviewer reads the process record but not what was declined:
    # reading a draft and reading everything proposed on it differ.
    root, doc_id = _project(tmp_path)
    suggestion = propose_suggestion(root, "intro.md", CLAIM, "Accuracy reached 71 percent", "lee")
    reject_suggestion(root, "intro.md", suggestion.suggestion_id, actor="wei")
    record_decision(root, "intro.md", CLAIM, doc_id, CHANGES_REQUESTED, "lee")

    reviewer_view = process_record(root, "intro.md", actor="lee")
    assert reviewer_view["rejected"] == []
    assert len(reviewer_view["decisions"]) == 1

    owner_view = process_record(root, "intro.md", actor="wei")
    assert len(owner_view["rejected"]) == 1


def test_review_is_advisory_unless_a_role_is_required(tmp_path: Path) -> None:
    from kiwi.review import review_satisfied

    root, _ = _project(tmp_path)
    assert review_satisfied(root, "intro.md") is True


def test_a_required_role_blocks_until_it_approves(tmp_path: Path) -> None:
    from kiwi.review import blocking_reviews, review_satisfied

    root, doc_id = _project(tmp_path)
    write_settings(
        root,
        ProjectSettings(
            owner="wei",
            members=(Member(name="lee", role="Reviewer"),),
            required_reviews=("Reviewer",),
        ),
    )

    assert review_satisfied(root, "intro.md") is False
    assert blocking_reviews(root, "intro.md") == ["Reviewer"]

    record_decision(root, "intro.md", CLAIM, doc_id, CHANGES_REQUESTED, "lee")
    assert review_satisfied(root, "intro.md") is False

    record_decision(root, "intro.md", CLAIM, doc_id, APPROVED, "lee")
    assert review_satisfied(root, "intro.md") is True
    assert blocking_reviews(root, "intro.md") == []


def test_approval_by_the_wrong_role_does_not_satisfy_a_requirement(tmp_path: Path) -> None:
    from kiwi.review import review_satisfied

    root, doc_id = _project(tmp_path)
    write_settings(
        root,
        ProjectSettings(
            owner="wei",
            members=(Member(name="lee", role="Reviewer"),),
            required_reviews=("Maintainer",),
        ),
    )
    record_decision(root, "intro.md", CLAIM, doc_id, APPROVED, "lee")
    assert review_satisfied(root, "intro.md") is False


def test_submitting_for_review_is_refused_without_edit_rights(tmp_path: Path) -> None:
    from kiwi.permissions import PermissionDenied
    from kiwi.review import submit_for_review

    root, _ = _project(tmp_path)
    with pytest.raises(PermissionDenied):
        submit_for_review(root, "intro.md", actor="lee")


class _StubResolver:
    """Resolves any reference to a fixed status."""

    name = "stub"

    def __init__(self, status: RefStatus, notice: str | None = None) -> None:
        self.status = status
        self.notice = notice
        self.seen: list[str] = []

    def health(self):  # type: ignore[no-untyped-def]
        from kiwi.types import Health

        return Health(ok=True, detail="stub")

    def resolve(self, reference):  # type: ignore[no-untyped-def]
        from kiwi.types import ResolvedReference

        self.seen.append(reference.title or "")
        return ResolvedReference(
            reference=reference,
            status=self.status,
            doi=reference.doi,
            metadata={},
            retraction_notice=self.notice,
            source="stub",
        )

    def resolve_batch(self, references):  # type: ignore[no-untyped-def]
        return [self.resolve(r) for r in references]


def test_verifying_a_cited_work_records_its_own_status(tmp_path: Path) -> None:
    from kiwi.review import verify_cited_work

    root, doc_id = _project(tmp_path)
    resolver = _StubResolver(RefStatus.RESOLVED)

    assert verify_cited_work(root, doc_id, resolver=resolver) == "resolved"
    # The paper's own title is what was resolved, not one of its references.
    assert resolver.seen == ["Retrieval Study"]
    assert review_draft(root, "intro.md", actor="wei")[0].source_status == "resolved"


def test_a_retracted_cited_work_surfaces_on_the_review_page(tmp_path: Path) -> None:
    from kiwi.review import verify_cited_work

    root, doc_id = _project(tmp_path)
    verify_cited_work(root, doc_id, resolver=_StubResolver(RefStatus.RETRACTED, "withdrawn"))

    item = review_draft(root, "intro.md", actor="wei")[0]
    assert item.source_status == "retracted"


def test_verification_without_a_resolver_records_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiwi.review import verify_cited_work

    root, doc_id = _project(tmp_path)
    monkeypatch.setenv("KIWI_NO_VERIFY", "1")
    assert verify_cited_work(root, doc_id) is None
    assert review_draft(root, "intro.md", actor="wei")[0].source_status == UNVERIFIED
