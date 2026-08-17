"""Local HTTP API.

Exposes ingestion, indexing, verification, retrieval, and workspace
operations over HTTP, and serves the bundled web interface.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.datastructures import Headers
from starlette.responses import Response
from starlette.types import Scope

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
from kiwi.permissions import Member, PermissionDenied
from kiwi.protocols import IngestError
from kiwi.registry import default_generator, default_ingestor
from kiwi.removal import NotFound, Removal, remove_draft, remove_note, remove_paper
from kiwi.review import (
    ReviewItem,
    UnknownDecision,
    blocking_reviews,
    process_record,
    propose_suggestion,
    read_decisions,
    record_decision,
    review_draft,
    review_satisfied,
    verify_cited_work,
)
from kiwi.setup import load_env
from kiwi.suggestions import SuggestionNotApplicable, SuggestionNotFound
from kiwi.types import AnnotationKind, Depth, Json, Suggestion
from kiwi.workspace import (
    PathOutsideProject,
    annotate,
    annotation_to_dict,
    authors,
    claim_to_dict,
    create_page_folder,
    delete_annotation,
    forget_project,
    init_project,
    list_known_projects,
    list_page_folders,
    list_pages,
    list_papers,
    read_annotations,
    read_claims,
    read_document,
    read_draft,
    read_note,
    read_settings,
    read_suggestions,
    read_verification,
    reference_to_dict,
    register_project,
    remove_page_folder,
    rename_page,
    rename_project,
    resolved_reference_to_dict,
    section_to_dict,
    suggestion_to_dict,
    write_document,
    write_draft,
    write_note,
    write_settings,
)

# Settings written by `kiwi setup` are read before the components are
# built, so the API and the CLI are configured the same way.
load_env()

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


class RemoveProjectRequest(BaseModel):
    path: str
    delete_files: bool = False


class RenameProjectRequest(BaseModel):
    path: str
    name: str


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


class ReviewDecisionRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    claim: str
    citation: str
    decision: str
    reviewer: str
    comment: str = ""


class ProposeRequest(BaseModel):
    project: str = "workspace.kiwi"
    draft: str
    claim: str
    proposed: str
    author: str


class MemberRequest(BaseModel):
    project: str = "workspace.kiwi"
    name: str
    role: str | None = None


class RenamePageRequest(BaseModel):
    project: str = "workspace.kiwi"
    kind: str  # "notes" or "drafts"
    relpath: str
    name: str


class PageFolderRequest(BaseModel):
    project: str = "workspace.kiwi"
    kind: str  # "notes" or "drafts"
    relpath: str


class PageWriteRequest(BaseModel):
    project: str = "workspace.kiwi"
    content: str
    visibility: str = "private"  # notes only; ignored for drafts
    # Who wrote it. Recorded once, on the note's first write: a later
    # writer does not become the author of a note whose visibility the
    # first author controls. Notes only; ignored for drafts.
    author: str = ""


@app.get("/health")
def health() -> Json:
    return {"ok": True, "version": __version__}


@app.get("/health/generator")
def generator_health() -> Json:
    """Whether a Generator is configured.

    Writing an answer and proposing a revision both need one. Without it
    they return nothing, which is indistinguishable from a failure unless
    the interface can ask.
    """
    model = os.environ.get("KIWI_GENERATOR_MODEL")
    if not model:
        return {
            "ok": False,
            "detail": "No generator is configured. Set KIWI_GENERATOR_MODEL to enable "
            "written answers and suggested revisions.",
        }
    return {"ok": True, "detail": model}


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


@app.get("/projects/default")
def default_project_path() -> Json:
    """Somewhere sensible to put a first project.

    A browser cannot report an absolute path from a folder picker, so the
    launcher asks for one to be typed. This supplies the answer for the
    common case, which is the first run.
    """
    return {"path": str(Path.home() / "Kiwi" / "MyProject.kiwi")}


@app.post("/projects")
def open_project(request: OpenProjectRequest) -> Json:
    """Open (creating if necessary) a project at ``path`` and register it."""
    root = Path(request.path)
    init_project(root, name=request.name or root.stem)
    return {"project": register_project(root)}


@app.delete("/projects")
def remove_project(request: RemoveProjectRequest) -> Json:
    """Forget a project, and delete its folder only when asked.

    Forgetting drops the entry from the list this installation keeps and
    leaves every file where it is. ``delete_files`` removes the folder
    and everything in it, including the source PDFs, which is the one
    operation here that cannot be undone from inside Kiwi.
    """
    root = Path(request.path)
    forgotten = forget_project(root)

    deleted = False
    if request.delete_files:
        if not (root / "kiwi.json").is_file():
            raise HTTPException(
                status_code=400,
                detail=f"{root} is not a Kiwi project; refusing to delete the folder",
            )
        shutil.rmtree(root)
        deleted = True

    return {"forgotten": forgotten, "deleted": deleted, "path": str(root)}


@app.put("/projects/name")
def put_project_name(request: RenameProjectRequest) -> Json:
    """Rename a project. The folder keeps its name on disk."""
    if not request.name.strip():
        raise HTTPException(status_code=400, detail="a project needs a name")
    return rename_project(Path(request.path), request.name.strip())


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
        # An empty folder holds no page to find it by, so it is reported
        # in its own right.
        "folders": {
            "notes": list_page_folders(root, "notes"),
            "drafts": list_page_folders(root, "drafts"),
        },
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
        return write_note(
            Path(request.project),
            relpath,
            request.content,
            request.visibility,
            author=request.author or None,
        )
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
async def ingest(
    file: UploadFile,
    project: str = Form("workspace.kiwi"),
    text_only: bool = Form(False),
) -> Json:
    """Parse an uploaded PDF and write it into ``project``.

    ``project`` must be declared as a Form field explicitly. A bare
    ``str`` parameter resolves from the query string, or from its
    default, even where a sibling parameter is an ``UploadFile``.

    ``text_only`` reads the PDF's own text layer instead of GROBID,
    finding no sections and no references. The paper keeps the same
    identifier either way, so parsing it again through GROBID later
    replaces it in place.
    """
    ingestor: object
    if text_only:
        from kiwi.components.ingest.pdf import PdfIngestor

        ingestor = PdfIngestor()
    else:
        ingestor = default_ingestor()
        health_check = ingestor.health()
        if not health_check.ok:
            raise HTTPException(
                status_code=503, detail=f"GROBID unavailable: {health_check.detail}"
            )

    # The upload is written under its own name: a parser with no title to
    # read falls back to the filename, and a temporary one is not a title.
    uploaded = Path(file.filename or "upload.pdf").name
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir) / (uploaded if uploaded.lower().endswith(".pdf") else "upload.pdf")
        tmp_path.write_bytes(await file.read())

        try:
            document = ingestor.ingest(tmp_path)
        except IngestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        project_root = init_project(Path(project), name=Path(project).stem)
        paper_dir = write_document(project_root, document, tmp_path)

    return {
        "document_id": document.document_id,
        "paper_dir": str(paper_dir),
        "parser": document.parser,
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
    sources: Json = {}
    for doc_id in doc_ids:
        try:
            document = read_document(project_root, doc_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"paper not found: {doc_id}") from exc
        results = verify_document(project_root, document)
        verified[doc_id] = [resolved_reference_to_dict(r) for r in results]
        sources[doc_id] = verify_cited_work(project_root, doc_id)

    return {"verified": verified, "sources": sources}


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


def _removed(call: Callable[[], Removal]) -> Json:
    """Run a removal, mapping its refusals onto status codes."""
    try:
        result = call()
    except NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"removed": list(result.removed), "citing_drafts": list(result.citing_drafts)}


@app.delete("/papers/{document_id}")
def delete_paper(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    project: str = "workspace.kiwi",
    actor: str | None = None,
) -> Json:
    """Delete a paper, its annotations, its verification, and its chunks.

    Drafts citing it keep their prose and are reported instead.
    """
    return _removed(lambda: remove_paper(Path(project), document_id, actor=actor))


@app.delete("/drafts/{relpath:path}")
def delete_draft(relpath: str, project: str = "workspace.kiwi", actor: str | None = None) -> Json:
    """Delete a draft and its sidecar, which holds its review decisions."""
    return _removed(lambda: remove_draft(Path(project), relpath, actor=actor))


@app.delete("/notes/{relpath:path}")
def delete_note(relpath: str, project: str = "workspace.kiwi", actor: str | None = None) -> Json:
    """Delete a note. Deleting anyone else's requires the permission that
    covers editing them."""
    return _removed(lambda: remove_note(Path(project), relpath, actor=actor))


@app.post("/pages/rename")
def post_page_rename(request: RenamePageRequest) -> Json:
    """Rename a note or a draft. A draft's sidecar moves with it."""
    try:
        return rename_page(Path(request.project), request.kind, request.relpath, request.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"not found: {request.relpath}") from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"already exists: {request.name}") from exc


@app.post("/pages/folder")
def post_page_folder(request: PageFolderRequest) -> Json:
    """Create a folder under ``notes/`` or ``drafts/``."""
    try:
        return create_page_folder(Path(request.project), request.kind, request.relpath)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"already exists: {request.relpath}") from exc


@app.delete("/pages/folder")
def delete_page_folder(request: PageFolderRequest) -> Json:
    """Remove an empty folder. One holding pages is refused."""
    try:
        return remove_page_folder(Path(request.project), request.kind, request.relpath)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"not found: {request.relpath}") from exc
    except OSError as exc:
        raise HTTPException(status_code=409, detail=f"{request.relpath} is not empty") from exc


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


@app.get("/review/{relpath:path}")
def get_review(relpath: str, project: str = "workspace.kiwi", actor: str | None = None) -> Json:
    """Every cited sentence in a draft, as a reviewer sees it."""
    try:
        items = review_draft(Path(project), relpath, actor=actor)
    except PermissionDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except PathOutsideProject as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "items": [_review_item_to_dict(item) for item in items],
        "blocking": blocking_reviews(Path(project), relpath),
        "satisfied": review_satisfied(Path(project), relpath),
        "decisions": [
            {
                "claim": d.claim,
                "citation": d.citation,
                "decision": d.decision,
                "reviewer": d.reviewer,
                "comment": d.comment,
                "recorded": d.recorded,
            }
            for d in read_decisions(Path(project), relpath)
        ],
    }


def _review_item_to_dict(item: ReviewItem) -> Json:
    alignment = item.alignment
    return {
        "claim": item.claim,
        "citation": item.citation,
        "source_title": item.source_title,
        "source_status": item.source_status,
        "intent": item.intent,
        "score": alignment.score if alignment is not None else None,
        "depth": alignment.depth.value if alignment is not None else None,
        "evidence": item.evidence.exact if item.evidence is not None else None,
        "stale": item.stale,
    }


@app.post("/review/decision")
def post_review_decision(request: ReviewDecisionRequest) -> Json:
    """Record one reviewer's judgement of one claim."""
    try:
        decisions = record_decision(
            Path(request.project),
            request.draft,
            request.claim,
            request.citation,
            request.decision,
            request.reviewer,
            request.comment,
        )
    except PermissionDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except UnknownDecision as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"decisions": [{"decision": d.decision, "reviewer": d.reviewer} for d in decisions]}


@app.post("/review/propose")
def post_proposal(request: ProposeRequest) -> Json:
    """Attach a suggestion to a claim on a person's behalf."""
    try:
        suggestion = propose_suggestion(
            Path(request.project), request.draft, request.claim, request.proposed, request.author
        )
    except PermissionDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"suggestion": suggestion_to_dict(suggestion)}


@app.get("/process-record/{relpath:path}")
def get_process_record(
    relpath: str, project: str = "workspace.kiwi", actor: str | None = None
) -> Json:
    """What was proposed, what was declined, and what was decided."""
    try:
        return process_record(Path(project), relpath, actor=actor)
    except PermissionDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.get("/projects/settings")
def get_project_settings(project: str = "workspace.kiwi") -> Json:
    """Roles, members, ownership, and which reviews are required."""
    settings = read_settings(Path(project))
    return {
        "owner": settings.owner,
        "successors": list(settings.successors),
        "required_reviews": list(settings.required_reviews),
        "roles": [
            {"name": r.name, "rank": r.rank, "permissions": sorted(p.value for p in r.permissions)}
            for r in sorted(settings.roles, key=lambda r: r.rank)
        ],
        "members": [{"name": m.name, "role": m.role} for m in settings.members],
    }


@app.put("/projects/members")
def put_member(request: MemberRequest) -> Json:
    """Add a member or change the role assigned to one."""
    root = Path(request.project)
    settings = read_settings(root)
    members = [m for m in settings.members if m.name != request.name]
    members.append(Member(name=request.name, role=request.role))
    write_settings(root, replace(settings, members=tuple(members)))
    return {"members": [{"name": m.name, "role": m.role} for m in members]}


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


@app.get("/papers/{document_id}/source.pdf", include_in_schema=False)
def paper_source(
    document_id: str = PathParam(..., pattern=r"^doc_[0-9a-f]{16}$"),
    project: str = "workspace.kiwi",
) -> FileResponse:
    """The PDF as it was imported.

    The parsed text carries the words and the section tree. It does not
    carry the figures, the tables, the columns, or the page numbering,
    and a reader judging a paper needs those. The interface reads this
    with the browser's own viewer.
    """
    path = Path(project) / "papers" / document_id / "source.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no source PDF for this paper")
    # Naming the file without this sends it as an attachment, and the
    # browser downloads it instead of drawing it in the frame.
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{document_id}.pdf",
        content_disposition_type="inline",
    )


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse(url="/app/")


_STATIC_DIR = Path(__file__).parent / "static"


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    """A browser requests this from the origin root, not from /app."""
    return FileResponse(_STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


class _Uncached(StaticFiles):
    """Serves the interface without letting a browser hold on to it.

    The files are read from disk on each request, so an edit shows on the
    next reload. A cached copy defeats that, and caching buys nothing
    across a loopback connection.
    """

    def is_not_modified(self, response_headers: Headers, request_headers: Headers) -> bool:
        return False

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


# The bundled web interface. Mounted last so it never shadows an API
# route above.
app.mount("/app", _Uncached(directory=_STATIC_DIR, html=True), name="static")
