"""Notes and Drafts: plain Markdown with YAML frontmatter, editable in any
editor.

Kiwi's state (page id, created timestamp, a note's visibility) lives in the
frontmatter; the body is exactly what a plain Markdown viewer would show.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import yaml

from kiwi.types import Json

_FRONTMATTER_DELIM = "---"


class PathOutsideProject(ValueError):
    """Raised when a page path resolves outside its project directory."""


def resolve_within(base: Path, relpath: str) -> Path:
    """Resolve ``relpath`` against ``base`` and confirm it stays inside.

    Rejects parent-directory segments and absolute paths, both of which
    otherwise resolve to a location the project does not own.
    """
    root = base.resolve()
    target = (base / relpath).resolve()
    if target == root or not target.is_relative_to(root):
        raise PathOutsideProject(f"path resolves outside the project: {relpath}")
    return target


def _new_page_id() -> str:
    return f"pg_{uuid.uuid4().hex[:16]}"


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _split_frontmatter(raw: str) -> tuple[Json, str]:
    if not raw.startswith(f"{_FRONTMATTER_DELIM}\n"):
        return {}, raw
    end = raw.find(f"\n{_FRONTMATTER_DELIM}\n", len(_FRONTMATTER_DELIM) + 1)
    if end == -1:
        return {}, raw
    frontmatter = yaml.safe_load(raw[len(_FRONTMATTER_DELIM) + 1 : end]) or {}
    body = raw[end + len(_FRONTMATTER_DELIM) + 2 :].lstrip("\n")
    return frontmatter, body


def _join_frontmatter(frontmatter: Json, body: str) -> str:
    header = yaml.safe_dump(frontmatter, sort_keys=False).strip()
    return f"{_FRONTMATTER_DELIM}\n{header}\n{_FRONTMATTER_DELIM}\n\n{body.strip()}\n"


def list_pages(root: Path, kind: str) -> list[str]:
    """Relative paths (POSIX-style, for use in URLs) of every page under
    ``notes/`` or ``drafts/``."""
    base = root / kind
    if not base.is_dir():
        return []
    return sorted(p.relative_to(base).as_posix() for p in base.rglob("*.md"))


def list_page_folders(root: Path, kind: str) -> list[str]:
    """Relative paths of every folder under ``notes/`` or ``drafts/``.

    Folders are reported separately from pages because an empty one holds
    no file to find it by, and a folder someone made is not gone until
    they remove it.
    """
    base = root / kind
    if not base.is_dir():
        return []
    return sorted(p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_dir())


def create_page_folder(root: Path, kind: str, relpath: str) -> Json:
    """Create a folder under ``notes/`` or ``drafts/``."""
    if kind not in ("notes", "drafts"):
        raise ValueError(f"unknown page kind: {kind}")
    path = resolve_within(root / kind, relpath)
    if path.exists():
        raise FileExistsError(relpath)
    path.mkdir(parents=True)
    return {"path": relpath}


def remove_page_folder(root: Path, kind: str, relpath: str) -> Json:
    """Remove an empty folder under ``notes/`` or ``drafts/``.

    A folder holding pages is refused rather than emptied. Deleting a note
    is checked against who may edit it, and a recursive delete here would
    step around that check.
    """
    if kind not in ("notes", "drafts"):
        raise ValueError(f"unknown page kind: {kind}")
    path = resolve_within(root / kind, relpath)
    if not path.is_dir():
        raise FileNotFoundError(relpath)
    path.rmdir()
    return {"path": relpath}


def read_note(root: Path, relpath: str) -> Json:
    path = resolve_within(root / "notes", relpath)
    frontmatter, body = _split_frontmatter(path.read_text(encoding="utf-8"))
    return {
        "path": relpath,
        "page_id": frontmatter.get("kiwi_id"),
        "created": frontmatter.get("created"),
        "visibility": frontmatter.get("visibility", "private"),
        "author": frontmatter.get("author", ""),
        "content": body,
    }


def write_note(
    root: Path,
    relpath: str,
    content: str,
    visibility: str = "private",
    author: str | None = None,
) -> Json:
    path = resolve_within(root / "notes", relpath)
    path.parent.mkdir(parents=True, exist_ok=True)

    page_id, created = _new_page_id(), _now()
    recorded_author = author or ""
    if path.exists():
        existing, _ = _split_frontmatter(path.read_text(encoding="utf-8"))
        page_id = existing.get("kiwi_id") or page_id
        created = existing.get("created") or created
        # Authorship is set once. A later writer does not become the author
        # of a note whose visibility the first author controls.
        recorded_author = existing.get("author") or recorded_author

    frontmatter = {
        "kiwi_id": page_id,
        "created": created,
        "visibility": visibility,
        "author": recorded_author,
    }
    path.write_text(_join_frontmatter(frontmatter, content), encoding="utf-8")
    return {
        "path": relpath,
        "page_id": page_id,
        "created": created,
        "visibility": visibility,
        "author": recorded_author,
        "content": content,
    }


def read_draft(root: Path, relpath: str) -> Json:
    path = resolve_within(root / "drafts", relpath)
    frontmatter, body = _split_frontmatter(path.read_text(encoding="utf-8"))
    return {
        "path": relpath,
        "page_id": frontmatter.get("kiwi_id"),
        "created": frontmatter.get("created"),
        "content": body,
    }


def write_draft(root: Path, relpath: str, content: str) -> Json:
    path = resolve_within(root / "drafts", relpath)
    path.parent.mkdir(parents=True, exist_ok=True)

    page_id, created = _new_page_id(), _now()
    if path.exists():
        existing, _ = _split_frontmatter(path.read_text(encoding="utf-8"))
        page_id = existing.get("kiwi_id") or page_id
        created = existing.get("created") or created

    frontmatter = {"kiwi_id": page_id, "created": created}
    path.write_text(_join_frontmatter(frontmatter, content), encoding="utf-8")
    return {"path": relpath, "page_id": page_id, "created": created, "content": content}


def rename_page(root: Path, kind: str, relpath: str, new_relpath: str) -> Json:
    """Move a note or a draft to a new name within its own folder.

    A draft's sidecar holds its scored claims, its suggestions, and the
    decisions recorded on it, and is found by the draft's name. It moves
    with the draft, or the record would be orphaned by a rename.
    """
    if kind not in ("notes", "drafts"):
        raise ValueError(f"unknown page kind: {kind}")

    source = resolve_within(root / kind, relpath)
    target = resolve_within(root / kind, new_relpath)
    if not source.is_file():
        raise FileNotFoundError(relpath)
    if target.exists():
        raise FileExistsError(new_relpath)

    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)

    if kind == "drafts":
        from kiwi.workspace.sidecar import sidecar_path

        old_sidecar = sidecar_path(root, relpath)
        if old_sidecar.is_file():
            old_sidecar.rename(sidecar_path(root, new_relpath))

    return {"path": new_relpath, "previous": relpath}


def _issued_year(metadata: Json) -> int | None:
    """The publication year from the CSL date, where the parser found one."""
    parts = (metadata.get("issued") or {}).get("date-parts") or []
    if parts and parts[0] and isinstance(parts[0][0], int):
        return int(parts[0][0])
    return None


def list_papers(root: Path) -> list[Json]:
    """Summary of every paper in the project: enough for an Explorer
    listing without reading each full Document."""
    papers_dir = root / "papers"
    if not papers_dir.is_dir():
        return []

    summaries: list[Json] = []
    for doc_dir in sorted(papers_dir.iterdir()):
        metadata_path = doc_dir / "metadata.json"
        structure_path = doc_dir / "structure.json"
        if not (doc_dir.is_dir() and metadata_path.exists() and structure_path.exists()):
            continue
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        structure = json.loads(structure_path.read_text(encoding="utf-8"))
        kiwi_meta = metadata.get("kiwi", {})
        summaries.append(
            {
                "document_id": doc_dir.name,
                "title": metadata.get("title") or "(untitled)",
                "authors": metadata.get("author", []),
                "sections": len(structure.get("sections", [])),
                "references": len(structure.get("references", [])),
                "year": _issued_year(metadata),
                "parse_status": kiwi_meta.get("parse_status", "unknown"),
                # Two different facts. ``verification`` is the state of the
                # references inside this paper; ``source_status`` is the
                # state of this paper's own record, which is where a
                # retraction is recorded.
                "verification": kiwi_meta.get("verification", "unresolved"),
                "source_status": kiwi_meta.get("source_status", "unverified"),
            }
        )
    return summaries
