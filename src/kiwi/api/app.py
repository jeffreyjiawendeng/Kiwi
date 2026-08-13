"""Local HTTP API.

Exposes ingestion, indexing, verification, retrieval, and workspace
operations over HTTP, and serves the bundled web interface. See
docs/06-architecture.md and docs/12-stack.md, "Interface".
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kiwi import __version__
from kiwi.core import index_documents, retrieve, verify_document
from kiwi.protocols import IngestError
from kiwi.registry import default_generator, default_ingestor
from kiwi.types import Json
from kiwi.workspace import (
    PathOutsideProject,
    init_project,
    list_known_projects,
    list_pages,
    list_papers,
    read_document,
    read_draft,
    read_note,
    read_verification,
    reference_to_dict,
    register_project,
    resolved_reference_to_dict,
    section_to_dict,
    write_document,
    write_draft,
    write_note,
)

app = FastAPI(title="Kiwi", version=__version__)


class IndexRequest(BaseModel):
    project: str = "workspace.kiwi"
    document_id: str | None = None


class VerifyRequest(BaseModel):
    project: str = "workspace.kiwi"
    document_id: str | None = None


class AskRequest(BaseModel):
    project: str = "workspace.kiwi"
    question: str
    document_id: str | None = None
    k: int = 5


class OpenProjectRequest(BaseModel):
    path: str
    name: str | None = None


class PageWriteRequest(BaseModel):
    project: str = "workspace.kiwi"
    content: str
    visibility: str = "private"  # notes only; ignored for drafts


@app.get("/health")
def health() -> Json:
    return {"ok": True, "version": __version__}


@app.get("/health/ingestor")
def ingestor_health() -> Json:
    ingestor = default_ingestor()
    result = ingestor.health()
    return {"ok": result.ok, "detail": result.detail}


@app.get("/projects")
def list_projects() -> Json:
    """Known projects, most recently opened first. Entries whose folder no
    longer exists are pruned automatically."""
    return {"projects": list_known_projects()}


@app.post("/projects")
def open_project(request: OpenProjectRequest) -> Json:
    """Open (creating if necessary) a project at ``path`` and register it."""
    root = Path(request.path)
    init_project(root, name=request.name or root.stem)
    return {"project": register_project(root)}


@app.get("/projects/summary")
def project_summary(project: str = "workspace.kiwi") -> Json:
    """Everything an Explorer view needs for one project: papers, notes,
    and drafts."""
    root = Path(project)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="project not found")
    return {
        "papers": list_papers(root),
        "notes": list_pages(root, "notes"),
        "drafts": list_pages(root, "drafts"),
    }


@app.get("/notes/{relpath:path}")
def get_note(relpath: str, project: str = "workspace.kiwi") -> Json:
    try:
        return read_note(Path(project), relpath)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="note not found") from exc


@app.put("/notes/{relpath:path}")
def put_note(relpath: str, request: PageWriteRequest) -> Json:
    try:
        return write_note(Path(request.project), relpath, request.content, request.visibility)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/drafts/{relpath:path}")
def get_draft(relpath: str, project: str = "workspace.kiwi") -> Json:
    try:
        return read_draft(Path(project), relpath)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc


@app.put("/drafts/{relpath:path}")
def put_draft(relpath: str, request: PageWriteRequest) -> Json:
    try:
        return write_draft(Path(request.project), relpath, request.content)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/ingest")
async def ingest(file: UploadFile, project: str = Form("workspace.kiwi")) -> Json:
    """Parse an uploaded PDF and write it into ``project``.

    ``project`` must be declared as a Form field explicitly: FastAPI does
    not infer that a bare ``str`` parameter belongs to the multipart body
    just because a sibling parameter is an ``UploadFile``. Without this it
    silently resolves from the query string, or its default, instead.
    """
    ingestor = default_ingestor()
    health_check = ingestor.health()
    if not health_check.ok:
        raise HTTPException(status_code=503, detail=f"GROBID unavailable: {health_check.detail}")

    suffix = Path(file.filename or "upload.pdf").suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        try:
            document = ingestor.ingest(tmp_path)
        except IngestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        project_root = init_project(Path(project), name=Path(project).stem)
        paper_dir = write_document(project_root, document, tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    return {
        "document_id": document.document_id,
        "paper_dir": str(paper_dir),
        "metadata": document.metadata,
        "sections": [section_to_dict(s) for s in document.sections],
        "references": [reference_to_dict(r) for r in document.references],
        "text_length": len(document.text),
    }


@app.post("/index")
def index_papers(request: IndexRequest) -> Json:
    """Chunk and store papers so they can be queried with ``/ask``."""
    project_root = Path(request.project)
    papers_dir = project_root / "papers"
    if not papers_dir.is_dir():
        raise HTTPException(status_code=404, detail="project has no papers directory")

    doc_ids = (
        [request.document_id]
        if request.document_id
        else sorted(p.name for p in papers_dir.iterdir() if p.is_dir())
    )
    if not doc_ids:
        raise HTTPException(status_code=404, detail="no papers to index")

    documents = []
    for doc_id in doc_ids:
        try:
            documents.append(read_document(project_root, doc_id))
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"paper not found: {doc_id}") from exc

    return {"indexed": index_documents(project_root, documents)}


@app.post("/verify")
def verify_papers(request: VerifyRequest) -> Json:
    """Resolve extracted references against Crossref: existence, metadata,
    retraction status. A no-op per paper with no references."""
    project_root = Path(request.project)
    papers_dir = project_root / "papers"
    if not papers_dir.is_dir():
        raise HTTPException(status_code=404, detail="project has no papers directory")

    doc_ids = (
        [request.document_id]
        if request.document_id
        else sorted(p.name for p in papers_dir.iterdir() if p.is_dir())
    )
    if not doc_ids:
        raise HTTPException(status_code=404, detail="no papers to verify")

    verified: Json = {}
    for doc_id in doc_ids:
        try:
            document = read_document(project_root, doc_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"paper not found: {doc_id}") from exc
        results = verify_document(project_root, document)
        verified[doc_id] = [resolved_reference_to_dict(r) for r in results]

    return {"verified": verified}


@app.get("/papers/{document_id}/verification")
def get_verification(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    project: str = "workspace.kiwi",
) -> Json:
    """The last verification result for a paper, or an empty list if it
    has never been verified."""
    results = read_verification(Path(project), document_id)
    return {"document_id": document_id, "results": [resolved_reference_to_dict(r) for r in results]}


@app.post("/ask")
def ask(request: AskRequest) -> Json:
    """Query indexed papers. Returns ranked passages, plus a synthesised
    answer when a Generator is configured (``KIWI_GENERATOR_MODEL``)."""
    hits = retrieve(Path(request.project), request.question, request.k, request.document_id)
    passages = [
        {
            "score": hit.score,
            "document_id": hit.chunk.anchor.document_id,
            "section_path": hit.chunk.section_path,
            "text": hit.chunk.anchor.exact,
        }
        for hit in hits
    ]

    generator = default_generator()
    if generator is None or not hits:
        return {"answer": None, "citations": [], "passages": passages}

    answer = generator.generate(request.question, hits)
    return {
        "answer": answer.text,
        "citations": [
            {
                "document_id": c.anchor.document_id,
                "section_path": c.anchor.section_path,
                "quoted": c.quoted,
            }
            for c in answer.citations
        ],
        "passages": passages,
    }


@app.get("/papers/{document_id}")
def get_paper(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    project: str = "workspace.kiwi",
) -> Json:
    """Fetch a previously ingested paper. ``project`` is a query parameter,
    not a path segment: a filesystem path does not belong inside one."""
    try:
        document = read_document(Path(project), document_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="paper not found") from exc

    return {
        "document_id": document.document_id,
        "metadata": document.metadata,
        "sections": [section_to_dict(s) for s in document.sections],
        "references": [reference_to_dict(r) for r in document.references],
        "text": document.text,
    }


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse(url="/app/")


# The bundled web interface. Mounted last so it never shadows an API
# route above.
_STATIC_DIR = Path(__file__).parent / "static"
app.mount("/app", StaticFiles(directory=_STATIC_DIR, html=True), name="static")
