"""On-disk workspace format.

Everything under ``.kiwi/`` is derived and rebuildable. Everything outside
it is source of truth; no code reconciles the two.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

from kiwi.types import Document, Json, Reference, RefStatus, ResolvedReference, Section

FORMAT_VERSION = 1


def section_to_dict(section: Section) -> Json:
    return {
        "path": section.path,
        "title": section.title,
        "level": section.level,
        "start": section.start,
        "end": section.end,
    }


def reference_to_dict(reference: Reference) -> Json:
    return {
        "raw": reference.raw,
        "title": reference.title,
        "authors": list(reference.authors),
        "year": reference.year,
        "doi": reference.doi,
        "arxiv_id": reference.arxiv_id,
    }


def resolved_reference_to_dict(resolved: ResolvedReference) -> Json:
    return {
        "reference": reference_to_dict(resolved.reference),
        "status": resolved.status.value,
        "doi": resolved.doi,
        "metadata": resolved.metadata,
        "retraction_notice": resolved.retraction_notice,
        "source": resolved.source,
        "error": resolved.error,
    }


def resolved_reference_from_dict(data: Json) -> ResolvedReference:
    r = data["reference"]
    return ResolvedReference(
        reference=Reference(
            raw=r["raw"],
            title=r["title"],
            authors=tuple(r["authors"]),
            year=r["year"],
            doi=r["doi"],
            arxiv_id=r["arxiv_id"],
        ),
        status=RefStatus(data["status"]),
        doi=data["doi"],
        metadata=data["metadata"],
        retraction_notice=data["retraction_notice"],
        source=data["source"],
        error=data.get("error"),
    )


def document_id(source: Path) -> str:
    """``doc_<first 16 hex chars of sha256(source file bytes)>``.

    Content-derived: the same PDF has the same ID on any machine, survives
    renaming, and survives re-parsing under a different Ingestor.
    """
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return f"doc_{digest[:16]}"


def init_project(root: Path, name: str) -> Path:
    """Create a project folder at ``root`` (conventionally named ``<Name>.kiwi``).

    Idempotent: calling it again on an existing project leaves the manifest
    untouched.
    """
    root.mkdir(parents=True, exist_ok=True)
    (root / "papers").mkdir(exist_ok=True)
    (root / "notes").mkdir(exist_ok=True)
    (root / "drafts").mkdir(exist_ok=True)
    (root / ".kiwi").mkdir(exist_ok=True)

    manifest_path = root / "kiwi.json"
    if not manifest_path.exists():
        manifest = {
            "format_version": FORMAT_VERSION,
            "project_id": f"prj_{hashlib.sha256(str(root).encode()).hexdigest()[:8]}",
            "name": name,
            "created": _now(),
            "components": {
                "ingestor": "grobid",
                "chunker": "section-aware",
                "embedder": None,
                "store": "lancedb",
                "generator": None,
                "resolver": "crossref",
                "aligner": None,
            },
            "settings": {
                "chunk_target_tokens": 512,
                "citation_style": "apa",
                "cross_project_references": True,
            },
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    gitignore_path = root / ".gitignore"
    if not gitignore_path.exists():
        gitignore_path.write_text(".kiwi/\n", encoding="utf-8")

    return root


def write_document(root: Path, document: Document, source: Path) -> Path:
    """Write ``document`` and a copy of ``source`` into ``papers/<doc_id>/``."""
    paper_dir = root / "papers" / document.document_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    dest_pdf = paper_dir / "source.pdf"
    if source.resolve() != dest_pdf.resolve():
        shutil.copyfile(source, dest_pdf)

    (paper_dir / "text.txt").write_text(document.text, encoding="utf-8")

    structure = {
        "parser": document.parser,
        "sections": [section_to_dict(s) for s in document.sections],
        "references": [reference_to_dict(r) for r in document.references],
    }
    (paper_dir / "structure.json").write_text(
        json.dumps(structure, indent=2) + "\n", encoding="utf-8"
    )

    metadata = dict(document.metadata)
    metadata["id"] = document.document_id
    # A parser that finds no title leaves one behind for every reader to
    # work around: the file appears as "(untitled)" in every list and
    # cites as nothing. The file it came from is the only other name it
    # has, so that is what it takes.
    if not str(metadata.get("title") or "").strip():
        metadata["title"] = source.stem
    metadata["kiwi"] = {
        "ingested": _now(),
        "parser": document.parser,
        "parse_status": "ok",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "chunk_count": 0,
        "verification": "unresolved",
    }
    (paper_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )

    return paper_dir


def read_document(root: Path, doc_id: str) -> Document:
    """Read back what :func:`write_document` wrote."""
    paper_dir = root / "papers" / doc_id
    text = (paper_dir / "text.txt").read_text(encoding="utf-8")
    structure = json.loads((paper_dir / "structure.json").read_text(encoding="utf-8"))
    metadata = json.loads((paper_dir / "metadata.json").read_text(encoding="utf-8"))

    sections = tuple(
        Section(path=s["path"], title=s["title"], level=s["level"], start=s["start"], end=s["end"])
        for s in structure["sections"]
    )
    references = tuple(
        Reference(
            raw=r["raw"],
            title=r["title"],
            authors=tuple(r["authors"]),
            year=r["year"],
            doi=r["doi"],
            arxiv_id=r["arxiv_id"],
        )
        for r in structure["references"]
    )
    source_pdf = paper_dir / "source.pdf"

    return Document(
        document_id=doc_id,
        source_path=source_pdf if source_pdf.exists() else None,
        text=text,
        sections=sections,
        references=references,
        metadata=metadata,
        parser=structure["parser"],
    )


def write_chunk_count(root: Path, doc_id: str, count: int) -> None:
    """Record the number of chunks a document produced in ``metadata.json``.

    Does nothing when the document has no metadata file, which is the case
    for a Document that was never written through :func:`write_document`.
    """
    metadata_path = root / "papers" / doc_id / "metadata.json"
    if not metadata_path.exists():
        return
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.setdefault("kiwi", {})["chunk_count"] = count
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def _verification_rollup(results: list[ResolvedReference]) -> str:
    """A single-word summary for ``metadata.json``'s ``kiwi.verification``
    field: the per-reference detail lives in ``verification.json``."""
    if not results:
        return "unresolved"
    if any(r.status in (RefStatus.RETRACTED, RefStatus.MISMATCH) for r in results):
        return "issues"
    if all(r.status == RefStatus.RESOLVED for r in results):
        return "resolved"
    # A run that could not reach the resolver has not established
    # anything about the paper, so it does not roll up as though it had.
    if any(r.status == RefStatus.UNCHECKED for r in results):
        return "incomplete"
    return "unresolved"


def write_verification(root: Path, doc_id: str, results: list[ResolvedReference]) -> Path:
    """Write per-reference verification results and roll up a summary
    status into ``metadata.json``."""
    paper_dir = root / "papers" / doc_id
    verification_path = paper_dir / "verification.json"
    payload = {
        "checked": _now(),
        "results": [resolved_reference_to_dict(r) for r in results],
    }
    verification_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    metadata_path = paper_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["kiwi"]["verification"] = _verification_rollup(results)
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    return verification_path


def read_verification(root: Path, doc_id: str) -> list[ResolvedReference]:
    """Read back what :func:`write_verification` wrote. Empty if the
    document has never been verified."""
    verification_path = root / "papers" / doc_id / "verification.json"
    if not verification_path.exists():
        return []
    payload = json.loads(verification_path.read_text(encoding="utf-8"))
    return [resolved_reference_from_dict(r) for r in payload["results"]]


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
