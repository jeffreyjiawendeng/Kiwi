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


def read_note(root: Path, relpath: str) -> Json:
    path = resolve_within(root / "notes", relpath)
    frontmatter, body = _split_frontmatter(path.read_text(encoding="utf-8"))
    return {
        "path": relpath,
        "page_id": frontmatter.get("kiwi_id"),
        "created": frontmatter.get("created"),
        "visibility": frontmatter.get("visibility", "private"),
        "content": body,
    }


def write_note(root: Path, relpath: str, content: str, visibility: str = "private") -> Json:
    path = resolve_within(root / "notes", relpath)
    path.parent.mkdir(parents=True, exist_ok=True)

    page_id, created = _new_page_id(), _now()
    if path.exists():
        existing, _ = _split_frontmatter(path.read_text(encoding="utf-8"))
        page_id = existing.get("kiwi_id") or page_id
        created = existing.get("created") or created

    frontmatter = {"kiwi_id": page_id, "created": created, "visibility": visibility}
    path.write_text(_join_frontmatter(frontmatter, content), encoding="utf-8")
    return {
        "path": relpath,
        "page_id": page_id,
        "created": created,
        "visibility": visibility,
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
                "parse_status": kiwi_meta.get("parse_status", "unknown"),
                "verification": kiwi_meta.get("verification", "unresolved"),
            }
        )
    return summaries
