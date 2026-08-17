from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kiwi.api import app
from kiwi.components.ingest.grobid import GrobidIngestor
from kiwi.types import Document, Reference, Section
from kiwi.workspace import document_id, init_project, write_document

FIXTURE = Path(__file__).parent / "fixtures" / "papers" / "sample.pdf"

client = TestClient(app)


def _seeded_project(tmp_path: Path, references: tuple = ()) -> tuple[Path, str]:
    project = tmp_path / "Demo.kiwi"
    init_project(project, name="Demo")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 fixture bytes for index/ask tests")
    doc_id = document_id(source)
    document = Document(
        document_id=doc_id,
        source_path=None,
        text=(
            "Structure-preserving parsing improves retrieval quality. "
            "Section-aware chunking outperformed fixed-size splitting."
        ),
        sections=(Section(path="Results", title="Results", level=1, start=0, end=113),),
        references=references,
        metadata={"type": "article-journal", "title": "Demo Paper", "author": []},
        parser="test",
    )
    write_document(project, document, source)
    return project, doc_id


def test_health_endpoint() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert "version" in body


def test_ingestor_health_endpoint_reports_shape() -> None:
    response = client.get("/health/ingestor")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ok", "detail"}


@pytest.mark.requires_grobid
def test_ingest_endpoint_end_to_end(tmp_path: Path) -> None:
    if not GrobidIngestor().health().ok:
        pytest.skip("GROBID is not running at http://localhost:8070")

    project = tmp_path / "Demo.kiwi"
    with FIXTURE.open("rb") as fh:
        response = client.post(
            "/ingest",
            files={"file": ("sample.pdf", fh, "application/pdf")},
            data={"project": str(project)},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["document_id"].startswith("doc_")
    assert body["sections"]
    assert body["references"]

    fetched = client.get(f"/papers/{body['document_id']}", params={"project": str(project)})
    assert fetched.status_code == 200
    assert fetched.json()["document_id"] == body["document_id"]


def test_index_and_ask_without_generator(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_NO_EMBED", "1")
    monkeypatch.delenv("KIWI_GENERATOR_MODEL", raising=False)
    project, doc_id = _seeded_project(tmp_path)

    index_response = client.post("/index", json={"project": str(project)})
    assert index_response.status_code == 200, index_response.text
    assert index_response.json()["indexed"][doc_id] > 0

    ask_response = client.post(
        "/ask",
        json={"project": str(project), "question": "How does chunking affect retrieval?"},
    )
    assert ask_response.status_code == 200, ask_response.text
    body = ask_response.json()
    assert body["answer"] is None  # no Generator configured
    assert body["citations"] == []
    assert body["passages"]
    assert "chunking" in body["passages"][0]["text"].lower()


def test_index_missing_project_returns_404(tmp_path: Path) -> None:
    response = client.post("/index", json={"project": str(tmp_path / "NoSuchProject.kiwi")})
    assert response.status_code == 404


def test_ask_with_no_index_returns_empty_passages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KIWI_NO_EMBED", "1")
    project, _ = _seeded_project(tmp_path)
    response = client.post("/ask", json={"project": str(project), "question": "anything"})
    assert response.status_code == 200
    assert response.json()["passages"] == []


def test_verify_missing_project_returns_404(tmp_path: Path) -> None:
    response = client.post("/verify", json={"project": str(tmp_path / "NoSuchProject.kiwi")})
    assert response.status_code == 404


def test_verify_paper_with_no_references_returns_empty(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path, references=())
    response = client.post("/verify", json={"project": str(project)})
    assert response.status_code == 200
    assert response.json()["verified"][doc_id] == []


@pytest.mark.requires_network
def test_verify_and_fetch_verification_end_to_end(tmp_path: Path) -> None:
    # The Wakefield 1998 Lancet paper, retracted 2010.
    reference = Reference(
        raw="Wakefield AJ et al. Ileal-lymphoid-nodular hyperplasia.",
        title="Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and "
        "pervasive developmental disorder in children",
        authors=("AJ Wakefield",),
        year=1998,
        doi="10.1016/S0140-6736(97)11096-0",
        arxiv_id=None,
    )
    project, doc_id = _seeded_project(tmp_path, references=(reference,))

    verify_response = client.post("/verify", json={"project": str(project)})
    assert verify_response.status_code == 200, verify_response.text
    results = verify_response.json()["verified"][doc_id]
    assert len(results) == 1
    assert results[0]["status"] == "retracted"
    assert results[0]["retraction_notice"] is not None

    fetched = client.get(f"/papers/{doc_id}/verification", params={"project": str(project)})
    assert fetched.status_code == 200
    assert fetched.json()["results"][0]["status"] == "retracted"


def test_open_and_list_projects(tmp_path: Path) -> None:
    project = tmp_path / "Demo.kiwi"

    response = client.post("/projects", json={"path": str(project), "name": "Demo"})
    assert response.status_code == 200, response.text
    assert response.json()["project"]["name"] == "Demo"
    assert project.is_dir()  # created, since it didn't exist yet

    listed = client.get("/projects")
    assert listed.status_code == 200
    paths = [p["path"] for p in listed.json()["projects"]]
    assert str(project.resolve()) in paths


def test_project_summary_lists_papers_notes_and_drafts(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    client.put(
        "/notes/log.md",
        json={"project": str(project), "content": "hi", "visibility": "private"},
    )
    client.put("/drafts/intro.md", json={"project": str(project), "content": "draft text"})

    response = client.get("/projects/summary", params={"project": str(project)})
    assert response.status_code == 200
    body = response.json()
    assert body["papers"][0]["document_id"] == doc_id
    assert body["notes"] == ["log.md"]
    assert body["drafts"] == ["intro.md"]


def test_project_summary_missing_project_returns_404(tmp_path: Path) -> None:
    response = client.get(
        "/projects/summary", params={"project": str(tmp_path / "NoSuchProject.kiwi")}
    )
    assert response.status_code == 404


def test_note_write_and_read_round_trip(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)

    put_response = client.put(
        "/notes/reading-log.md",
        json={"project": str(project), "content": "Some **notes**.", "visibility": "shared"},
    )
    assert put_response.status_code == 200, put_response.text
    assert put_response.json()["visibility"] == "shared"

    get_response = client.get("/notes/reading-log.md", params={"project": str(project)})
    assert get_response.status_code == 200
    assert "Some **notes**." in get_response.json()["content"]


def test_note_in_a_subfolder_round_trips(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    client.put(
        "/notes/methods/sampling.md",
        json={"project": str(project), "content": "Sampling notes."},
    )
    response = client.get("/notes/methods/sampling.md", params={"project": str(project)})
    assert response.status_code == 200
    assert "Sampling notes." in response.json()["content"]


def test_get_missing_note_returns_404(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    response = client.get("/notes/does-not-exist.md", params={"project": str(project)})
    assert response.status_code == 404


def test_draft_write_and_read_round_trip(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)

    put_response = client.put(
        "/drafts/intro.md",
        json={"project": str(project), "content": f"Citing [@{doc_id}]."},
    )
    assert put_response.status_code == 200, put_response.text

    get_response = client.get("/drafts/intro.md", params={"project": str(project)})
    assert get_response.status_code == 200
    assert f"[@{doc_id}]" in get_response.json()["content"]


def test_get_missing_draft_returns_404(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    response = client.get("/drafts/does-not-exist.md", params={"project": str(project)})
    assert response.status_code == 404


def test_page_path_escaping_the_project_is_rejected(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    outside = tmp_path / "escaped.md"
    escaping = f"/notes/{outside}"

    put_response = client.put(escaping, json={"project": str(project), "content": "escaped"})
    assert put_response.status_code == 400
    assert not outside.exists()

    get_response = client.get(escaping, params={"project": str(project)})
    assert get_response.status_code == 400


def test_web_interface_is_served_and_root_redirects() -> None:
    index_response = client.get("/app/")
    assert index_response.status_code == 200
    assert "Kiwi" in index_response.text

    js_response = client.get("/app/app.js")
    assert js_response.status_code == 200

    root_response = client.get("/", follow_redirects=False)
    assert root_response.status_code in (307, 308)
    assert root_response.headers["location"] == "/app/"


def _draft_with_a_contradicted_claim(tmp_path: Path) -> tuple[Path, str]:
    from kiwi.claims import Claim
    from kiwi.types import Alignment, Anchor, Depth, Intent
    from kiwi.workspace import write_claims, write_draft

    project = tmp_path / "Demo.kiwi"
    init_project(project, name="Demo")
    citation = "doc_aaaaaaaaaaaaaaaa"
    claim_text = "Accuracy exceeded 95 percent"
    write_draft(project, "intro.md", f"{claim_text} [@{citation}].")
    claim = Claim(
        anchor=Anchor(
            document_id="pg_1",
            section_path="",
            start=0,
            end=len(claim_text),
            exact=claim_text,
            prefix="",
            suffix=f" [@{citation}].",
        ),
        citation=citation,
        intent=Intent.EVIDENCE,
        alignment=Alignment(
            score=0,
            intent=Intent.EVIDENCE,
            depth=Depth.QUICK,
            evidence=Anchor(
                document_id=citation,
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
    write_claims(project, "intro.md", "pg_1", [claim])
    return project, claim_text


def test_suggest_without_a_generator_proposes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, _ = _draft_with_a_contradicted_claim(tmp_path)
    monkeypatch.delenv("KIWI_GENERATOR_MODEL", raising=False)

    response = client.post("/suggest", json={"project": str(project), "draft": "intro.md"})
    assert response.status_code == 200
    assert response.json()["suggestions"] == []


def test_suggestions_accept_applies_the_change_to_the_draft(tmp_path: Path) -> None:
    from kiwi.suggestions import ALIGNMENT, new_suggestion
    from kiwi.types import Anchor
    from kiwi.workspace import write_suggestions

    project, claim_text = _draft_with_a_contradicted_claim(tmp_path)
    suggestion = new_suggestion(
        Anchor(
            document_id="pg_1",
            section_path="",
            start=0,
            end=len(claim_text),
            exact=claim_text,
            prefix="",
            suffix="",
        ),
        "Accuracy reached 71 percent",
        ALIGNMENT,
    )
    write_suggestions(project, "intro.md", "pg_1", [suggestion])

    listed = client.get(f"/suggestions/intro.md?project={project}")
    assert listed.status_code == 200
    assert len(listed.json()["suggestions"]) == 1

    accepted = client.post(
        "/suggestions/accept",
        json={
            "project": str(project),
            "draft": "intro.md",
            "suggestion_id": suggestion.suggestion_id,
        },
    )
    assert accepted.status_code == 200
    assert accepted.json()["suggestions"][0]["state"] == "accepted"

    draft = client.get(f"/drafts/intro.md?project={project}")
    assert "Accuracy reached 71 percent" in draft.json()["content"]


def test_resolving_a_suggestion_twice_returns_409(tmp_path: Path) -> None:
    from kiwi.suggestions import ALIGNMENT, new_suggestion
    from kiwi.types import Anchor
    from kiwi.workspace import write_suggestions

    project, claim_text = _draft_with_a_contradicted_claim(tmp_path)
    suggestion = new_suggestion(
        Anchor(
            document_id="pg_1",
            section_path="",
            start=0,
            end=len(claim_text),
            exact=claim_text,
            prefix="",
            suffix="",
        ),
        "Accuracy reached 71 percent",
        ALIGNMENT,
    )
    write_suggestions(project, "intro.md", "pg_1", [suggestion])
    body = {
        "project": str(project),
        "draft": "intro.md",
        "suggestion_id": suggestion.suggestion_id,
    }
    assert client.post("/suggestions/reject", json=body).status_code == 200
    assert client.post("/suggestions/reject", json=body).status_code == 409


def test_unknown_suggestion_returns_404(tmp_path: Path) -> None:
    project, _ = _draft_with_a_contradicted_claim(tmp_path)
    response = client.post(
        "/suggestions/accept",
        json={"project": str(project), "draft": "intro.md", "suggestion_id": "sug_missing"},
    )
    assert response.status_code == 404


def test_annotate_and_list_with_an_author_filter(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    passage = "Section-aware chunking outperformed fixed-size splitting"

    created = client.post(
        "/annotations",
        json={
            "project": str(project),
            "document_id": doc_id,
            "exact": passage,
            "kind": "note",
            "body": "check the 512 baseline",
            "author": "wei",
        },
    )
    assert created.status_code == 200
    assert created.json()["annotation"]["target"]["selector"]["exact"] == passage

    client.post(
        "/annotations",
        json={
            "project": str(project),
            "document_id": doc_id,
            "exact": "Structure-preserving parsing",
            "author": "lee",
        },
    )

    everyone = client.get(f"/annotations/{doc_id}?project={project}")
    assert len(everyone.json()["annotations"]) == 2
    assert everyone.json()["authors"] == ["lee", "wei"]

    filtered = client.get(f"/annotations/{doc_id}?project={project}&author=wei")
    assert len(filtered.json()["annotations"]) == 1
    assert filtered.json()["annotations"][0]["author"] == "wei"


def test_annotating_a_passage_that_is_absent_returns_422(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    response = client.post(
        "/annotations",
        json={"project": str(project), "document_id": doc_id, "exact": "not in this paper"},
    )
    assert response.status_code == 422


def test_annotation_can_be_deleted(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    created = client.post(
        "/annotations",
        json={
            "project": str(project),
            "document_id": doc_id,
            "exact": "Structure-preserving parsing",
        },
    )
    annotation_id = created.json()["annotation"]["id"]

    deleted = client.delete(f"/annotations/{doc_id}/{annotation_id}?project={project}")
    assert deleted.status_code == 200
    assert deleted.json()["annotations"] == []


def test_cite_in_draft_appends_a_citation_marker(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    client.put(
        "/drafts/intro.md",
        json={"project": str(project), "content": "Opening sentence."},
    )

    response = client.post(
        "/drafts/cite",
        json={
            "project": str(project),
            "draft": "intro.md",
            "document_id": doc_id,
            "quoted": "Section-aware chunking outperformed fixed-size splitting",
        },
    )
    assert response.status_code == 200
    content = response.json()["content"]
    assert "Opening sentence." in content
    assert f"[@{doc_id}]." in content
    assert "Section-aware chunking" in content


def _review_project(tmp_path: Path) -> tuple[Path, str]:
    from kiwi.claims import Claim
    from kiwi.permissions import Member
    from kiwi.types import Alignment, Anchor, Depth, Intent
    from kiwi.workspace import ProjectSettings, write_claims, write_draft, write_settings

    project, doc_id = _seeded_project(tmp_path)
    claim_text = "Section-aware chunking outperformed fixed-size splitting"
    write_draft(project, "intro.md", f"{claim_text} [@{doc_id}].")
    write_claims(
        project,
        "intro.md",
        "pg_1",
        [
            Claim(
                anchor=Anchor(
                    document_id="pg_1",
                    section_path="",
                    start=0,
                    end=len(claim_text),
                    exact=claim_text,
                    prefix="",
                    suffix="",
                ),
                citation=doc_id,
                intent=Intent.EVIDENCE,
                alignment=Alignment(
                    score=2,
                    intent=Intent.EVIDENCE,
                    depth=Depth.QUICK,
                    evidence=Anchor(
                        document_id=doc_id,
                        section_path="Results",
                        start=0,
                        end=20,
                        exact="a supporting passage",
                        prefix="",
                        suffix="",
                    ),
                    model="test",
                ),
            )
        ],
    )
    write_settings(
        project,
        ProjectSettings(
            owner="wei",
            members=(Member(name="lee", role="Reviewer"), Member(name="sam")),
            required_reviews=("Reviewer",),
        ),
    )
    return project, doc_id


def test_review_endpoint_reports_items_and_blocking_roles(tmp_path: Path) -> None:
    project, doc_id = _review_project(tmp_path)
    response = client.get(f"/review/intro.md?project={project}&actor=lee")

    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["citation"] == doc_id
    assert body["items"][0]["score"] == 2
    assert body["items"][0]["evidence"] == "a supporting passage"
    assert body["items"][0]["source_status"] == "unverified"
    assert body["blocking"] == ["Reviewer"]
    assert body["satisfied"] is False


def test_review_endpoint_refuses_someone_with_no_role(tmp_path: Path) -> None:
    project, _ = _review_project(tmp_path)
    assert client.get(f"/review/intro.md?project={project}&actor=sam").status_code == 403


def test_recording_a_decision_clears_the_block(tmp_path: Path) -> None:
    project, doc_id = _review_project(tmp_path)
    claim_text = "Section-aware chunking outperformed fixed-size splitting"

    recorded = client.post(
        "/review/decision",
        json={
            "project": str(project),
            "draft": "intro.md",
            "claim": claim_text,
            "citation": doc_id,
            "decision": "approved",
            "reviewer": "lee",
        },
    )
    assert recorded.status_code == 200

    body = client.get(f"/review/intro.md?project={project}&actor=lee").json()
    assert body["blocking"] == []
    assert body["satisfied"] is True


def test_an_unknown_decision_returns_400(tmp_path: Path) -> None:
    project, doc_id = _review_project(tmp_path)
    response = client.post(
        "/review/decision",
        json={
            "project": str(project),
            "draft": "intro.md",
            "claim": "x",
            "citation": doc_id,
            "decision": "looks-fine",
            "reviewer": "lee",
        },
    )
    assert response.status_code == 400


def test_a_reviewer_proposes_wording_through_the_api(tmp_path: Path) -> None:
    project, _ = _review_project(tmp_path)
    claim_text = "Section-aware chunking outperformed fixed-size splitting"
    response = client.post(
        "/review/propose",
        json={
            "project": str(project),
            "draft": "intro.md",
            "claim": claim_text,
            "proposed": "Section-aware chunking outperformed fixed-size splitting on MRR",
            "author": "lee",
        },
    )
    assert response.status_code == 200
    assert response.json()["suggestion"]["origin"] == "lee"


def test_the_process_record_is_refused_without_the_permission(tmp_path: Path) -> None:
    project, _ = _review_project(tmp_path)
    assert client.get(f"/process-record/intro.md?project={project}&actor=sam").status_code == 403


def test_project_settings_are_reported(tmp_path: Path) -> None:
    project, _ = _review_project(tmp_path)
    body = client.get(f"/projects/settings?project={project}").json()

    assert body["owner"] == "wei"
    assert body["required_reviews"] == ["Reviewer"]
    assert {m["name"]: m["role"] for m in body["members"]} == {"lee": "Reviewer", "sam": None}


def test_a_member_role_can_be_assigned(tmp_path: Path) -> None:
    project, _ = _review_project(tmp_path)
    response = client.put(
        "/projects/members",
        json={"project": str(project), "name": "sam", "role": "Contributor"},
    )
    assert response.status_code == 200
    assert {m["name"]: m["role"] for m in response.json()["members"]}["sam"] == "Contributor"


def test_ingest_without_grobid_reads_the_text_layer(tmp_path: Path) -> None:
    # The path the web interface offers when GROBID is not running. It
    # needs no service, so this runs everywhere.
    project = tmp_path / "Demo.kiwi"
    with FIXTURE.open("rb") as fh:
        response = client.post(
            "/ingest",
            files={"file": ("sample.pdf", fh, "application/pdf")},
            data={"project": str(project), "text_only": "true"},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["document_id"] == document_id(FIXTURE)
    assert body["parser"].startswith("pypdf")
    assert body["text_length"] > 0
    # No section tree and no reference list is the cost of this path.
    assert body["references"] == []


def test_a_paper_keeps_its_identity_whichever_parser_read_it(tmp_path: Path) -> None:
    # A paper added without GROBID and parsed properly later is the same
    # paper, so annotations and citations made against it are not orphaned.
    project = tmp_path / "Demo.kiwi"
    with FIXTURE.open("rb") as fh:
        first = client.post(
            "/ingest",
            files={"file": ("sample.pdf", fh, "application/pdf")},
            data={"project": str(project), "text_only": "true"},
        )
    assert first.status_code == 200, first.text

    if not GrobidIngestor().health().ok:
        pytest.skip("GROBID is not running at http://localhost:8070")

    with FIXTURE.open("rb") as fh:
        second = client.post(
            "/ingest",
            files={"file": ("sample.pdf", fh, "application/pdf")},
            data={"project": str(project)},
        )
    assert second.status_code == 200, second.text
    assert second.json()["document_id"] == first.json()["document_id"]
    assert second.json()["references"]


def test_a_default_project_path_is_suggested() -> None:
    # A browser cannot report an absolute path from a folder picker, so
    # the launcher has to be given one to start from.
    response = client.get("/projects/default")
    assert response.status_code == 200
    suggested = Path(response.json()["path"])
    assert suggested.is_absolute()
    assert suggested.suffix == ".kiwi"


def test_deleting_a_paper_removes_it_and_its_chunks(tmp_path: Path) -> None:
    project, doc_id = _seeded_project(tmp_path)
    client.post("/index", json={"project": str(project)})

    response = client.delete(f"/papers/{doc_id}", params={"project": str(project)})

    assert response.status_code == 200, response.text
    assert response.json()["removed"] == [f"papers/{doc_id}"]
    assert not (project / "papers" / doc_id).exists()
    assert client.get(f"/papers/{doc_id}", params={"project": str(project)}).status_code == 404


def test_deleting_a_draft_removes_its_sidecar(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    client.put("/drafts/chapter.md", json={"project": str(project), "content": "Some prose."})

    response = client.delete("/drafts/chapter.md", params={"project": str(project)})

    assert response.status_code == 200, response.text
    assert not (project / "drafts" / "chapter.md").exists()
    assert not (project / "drafts" / "chapter.md.kiwi.json").exists()


def test_deleting_something_absent_is_a_404(tmp_path: Path) -> None:
    project, _ = _seeded_project(tmp_path)
    assert client.delete("/drafts/absent.md", params={"project": str(project)}).status_code == 404
    assert (
        client.delete("/papers/doc_0000000000000000", params={"project": str(project)}).status_code
        == 404
    )


def test_the_source_pdf_is_served_for_the_viewer(tmp_path: Path) -> None:
    # The interface reads the PDF with the browser's own viewer, so the
    # file has to be reachable over the API rather than only on disk.
    root = tmp_path / "P.kiwi"
    init_project(root, "P")
    doc_id = "doc_00000000000000aa"
    paper = root / "papers" / doc_id
    paper.mkdir(parents=True)
    (paper / "source.pdf").write_bytes(b"%PDF-1.4\ntest\n")

    response = client.get(f"/papers/{doc_id}/source.pdf", params={"project": str(root)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")
    # Sent as an attachment, the browser downloads it instead of drawing
    # it in the frame the viewer puts it in.
    assert response.headers["content-disposition"].startswith("inline")

    missing = client.get("/papers/doc_00000000000000bb/source.pdf", params={"project": str(root)})
    assert missing.status_code == 404


def test_a_project_is_forgotten_without_its_files_being_touched(tmp_path: Path) -> None:
    root = tmp_path / "Forget.kiwi"
    init_project(root, "Forget")
    client.post("/projects", json={"path": str(root)})

    body = client.request("DELETE", "/projects", json={"path": str(root)}).json()
    assert body == {"forgotten": True, "deleted": False, "path": str(root)}
    assert root.is_dir()
    assert all(e["path"] != str(root.resolve()) for e in client.get("/projects").json()["projects"])


def test_deleting_a_project_removes_the_folder_only_when_asked(tmp_path: Path) -> None:
    root = tmp_path / "Gone.kiwi"
    init_project(root, "Gone")
    (root / "papers" / "doc_1").mkdir(parents=True)

    body = client.request(
        "DELETE", "/projects", json={"path": str(root), "delete_files": True}
    ).json()
    assert body["deleted"] is True
    assert not root.exists()


def test_a_folder_that_is_not_a_project_is_not_deleted(tmp_path: Path) -> None:
    # The path comes from the interface, and deleting a folder recursively
    # on the strength of a typed string is not acceptable.
    ordinary = tmp_path / "Documents"
    ordinary.mkdir()
    (ordinary / "thesis.docx").write_text("mine", encoding="utf-8")

    response = client.request(
        "DELETE", "/projects", json={"path": str(ordinary), "delete_files": True}
    )
    assert response.status_code == 400
    assert ordinary.is_dir()
    assert (ordinary / "thesis.docx").exists()


def test_renaming_a_draft_takes_its_record_with_it(tmp_path: Path) -> None:
    root = tmp_path / "R.kiwi"
    init_project(root, "R")
    client.put("/drafts/one.md", json={"project": str(root), "content": "A claim."})
    sidecar = root / "drafts" / "one.md.kiwi.json"
    sidecar.write_text('{"claims": []}', encoding="utf-8")

    body = client.post(
        "/pages/rename",
        json={"project": str(root), "kind": "drafts", "relpath": "one.md", "name": "two.md"},
    )
    assert body.status_code == 200
    assert (root / "drafts" / "two.md").is_file()
    assert not (root / "drafts" / "one.md").exists()
    assert (root / "drafts" / "two.md.kiwi.json").is_file()
    assert not sidecar.exists()


def test_a_note_records_who_wrote_it(tmp_path: Path) -> None:
    """Authorship is what a note's visibility rests on.

    Dropped on the way through the route, every note belongs to nobody
    and the permission that covers editing someone else's cannot apply.
    """
    project, _ = _seeded_project(tmp_path)
    client.put(
        "/notes/mine.md",
        json={
            "project": str(project),
            "content": "first",
            "author": "Ada",
            "visibility": "private",
        },
    )
    assert client.get(f"/notes/mine.md?project={project}").json()["author"] == "Ada"

    # Set once: a later writer does not take it over.
    client.put(
        "/notes/mine.md",
        json={"project": str(project), "content": "second", "author": "Grace"},
    )
    assert client.get(f"/notes/mine.md?project={project}").json()["author"] == "Ada"
