"""Local HTTP API.

Exposes ingestion, indexing, verification, retrieval, and workspace
operations over HTTP, and serves the bundled web interface.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kiwi import __version__
from kiwi.core import (
    accept_suggestion,
    align_draft,
    index_documents,
    reject_suggestion,
    retrieve,
    set_claim_intent,
    suggest_draft,
    verify_document,
)
from kiwi.protocols import IngestError
from kiwi.registry import default_generator, default_ingestor
from kiwi.suggestions import SuggestionNotApplicable, SuggestionNotFound
from kiwi.types import AnnotationKind, Depth, Json, Suggestion
from kiwi.workspace import (
    PathOutsideProject,
    annotate,
    annotation_to_dict,
    authors,
    claim_to_dict,
    delete_annotation,
    init_project,
    list_known_projects,
    list_pages,
    list_papers,
    read_annotations,
    read_claims,
    read_document,
    read_draft,
    read_note,
    read_suggestions,
    read_verification,
    reference_to_dict,
    register_project,
    resolved_reference_to_dict,
    section_to_dict,
    suggestion_to_dict,
    write_document,
    write_draft,
    write_note,
)

app = FastAPI(title="Kiwi", version=__version__)


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


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


class AlignRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    depth: str = "quick"


class ClaimIntentRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    claim: str
    intent: str
    citation: str | None = None


class SuggestRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str


class SuggestionActionRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    suggestion_id: str


class AnnotateRequest(BaseModel):
    project: str = "workspace.kiwi"
    document_id: str
    exact: str
    kind: str = "highlight"
    body: str = ""
    color: str = "yellow"
    author: str = "local"
    section_path: str = ""


class CiteInDraftRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    document_id: str
    quoted: str = ""


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

    ``project`` must be declared as a Form field explicitly. A bare
    ``str`` parameter resolves from the query string, or from its
    default, even where a sibling parameter is an ``UploadFile``.
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


@app.post("/align")
def align_claims(request: AlignRequest) -> Json:
    """Score each cited sentence in a draft against the work it cites.

    ``depth`` is ``quick`` or ``deep``. A deep run splits compound claims
    and scores each assertion against evidence retrieved for it.
    """
    try:
        depth = Depth(request.depth)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"unknown depth: {request.depth}") from exc
    try:
        claims = align_draft(Path(request.project), request.draft, depth=depth)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc
    return {"claims": [claim_to_dict(claim, _now()) for claim in claims]}


@app.get("/align/{relpath:path}")
def get_claims(relpath: str, project: str = "workspace.kiwi") -> Json:
    """Claims recorded for a draft, or an empty list if never scored."""
    try:
        claims = read_claims(Path(project), relpath)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"claims": [claim_to_dict(claim, _now()) for claim in claims]}


@app.put("/align/intent")
def put_claim_intent(request: ClaimIntentRequest) -> Json:
    """Override the detected intent for one claim."""
    try:
        claims = set_claim_intent(
            Path(request.project),
            request.draft,
            request.claim,
            request.intent,
            citation=request.citation,
        )
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"unknown intent: {request.intent}") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc
    return {"claims": [claim_to_dict(claim, _now()) for claim in claims]}


@app.post("/suggest")
def create_suggestions(request: SuggestRequest) -> Json:
    """Propose a revision for each claim its citation does not support.

    Returns an empty list when no Generator is configured, when no claim
    scores 0, or when every such claim already carries a pending
    suggestion. The draft is unchanged either way.
    """
    try:
        created = suggest_draft(Path(request.project), request.draft)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc
    return {"suggestions": [suggestion_to_dict(s) for s in created]}


@app.post("/suggestions/accept")
def post_accept_suggestion(request: SuggestionActionRequest) -> Json:
    """Apply a pending suggestion to the draft."""
    return _resolve_suggestion(request, accept_suggestion)


@app.post("/suggestions/reject")
def post_reject_suggestion(request: SuggestionActionRequest) -> Json:
    """Record a pending suggestion as rejected. The draft is unchanged."""
    return _resolve_suggestion(request, reject_suggestion)


def _resolve_suggestion(
    request: SuggestionActionRequest,
    operation: Callable[[Path, str, str], list[Suggestion]],
) -> Json:
    try:
        suggestions = operation(Path(request.project), request.draft, request.suggestion_id)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SuggestionNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SuggestionNotApplicable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc
    return {"suggestions": [suggestion_to_dict(s) for s in suggestions]}


@app.get("/suggestions/{relpath:path}")
def get_suggestions(relpath: str, project: str = "workspace.kiwi") -> Json:
    """Suggestions recorded for a draft, whatever their state."""
    try:
        suggestions = read_suggestions(Path(project), relpath)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"suggestions": [suggestion_to_dict(s) for s in suggestions]}


@app.get("/annotations/{document_id}")
def get_annotations(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    project: str = "workspace.kiwi",
    author: str | None = None,
) -> Json:
    """Annotations on a paper, optionally narrowed to one author."""
    recorded = read_annotations(Path(project), document_id)
    shown = [a for a in recorded if author is None or a.author == author]
    return {
        "annotations": [annotation_to_dict(a) for a in shown],
        "authors": authors(recorded),
    }


@app.post("/annotations")
def post_annotation(request: AnnotateRequest) -> Json:
    """Record a highlight or a note over a passage in a paper."""
    try:
        kind = AnnotationKind(request.kind)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"unknown kind: {request.kind}") from exc
    try:
        annotation = annotate(
            Path(request.project),
            request.document_id,
            request.exact,
            kind=kind,
            body=request.body,
            color=request.color,
            author=request.author,
            section_path=request.section_path,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="paper not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"annotation": annotation_to_dict(annotation)}


@app.delete("/annotations/{document_id}/{annotation_id}")
def remove_annotation(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    annotation_id: str = PathParam(...),
    project: str = "workspace.kiwi",
) -> Json:
    """Delete one annotation. Returns what remains on the paper."""
    remaining = delete_annotation(Path(project), document_id, annotation_id)
    return {"annotations": [annotation_to_dict(a) for a in remaining]}


@app.post("/drafts/cite")
def cite_in_draft(request: CiteInDraftRequest) -> Json:
    """Append a citation to a draft, quoting the passage where given.

    This is the path from reading a paper to writing about it, so the
    citation marker is written in the same form the aligner reads.
    """
    try:
        draft = read_draft(Path(request.project), request.draft)
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="draft not found") from exc

    quoted = request.quoted.strip().rstrip(".")
    # A quoted passage is written as a full sentence so the claim extractor
    # reads it the same way as anything else the author types.
    addition = f"{quoted} [@{request.document_id}]." if quoted else f"[@{request.document_id}]"
    content = str(draft["content"]).rstrip()
    updated = f"{content}\n\n{addition}" if content else addition
    return write_draft(Path(request.project), request.draft, updated)


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
