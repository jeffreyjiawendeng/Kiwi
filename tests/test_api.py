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
