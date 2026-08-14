"""Ingestor that reads a PDF without a GROBID service.

GROBID recovers a paper's section tree and its reference list. This reads
the text layer and nothing else: sections are pages, and no references
are extracted. It exists so that a first run needs no Docker, and so that
a machine that cannot run GROBID is not left with nothing.

The document identifier is derived from the file's bytes, the same way
GROBID's is, so a paper read here and parsed properly later keeps its
identity. Annotations and citations made against it relocate into the
better parse through the quote selector rather than being orphaned.

``Document.parser`` records which of the two produced a document, so the
difference is visible wherever a document is.
"""

from __future__ import annotations

import re
from pathlib import Path

from kiwi.protocols import IngestError
from kiwi.types import Document, Health, Section
from kiwi.workspace.format import document_id as compute_document_id

_WHITESPACE = re.compile(r"\s+")

# A PDF's title field is written by whatever produced the file, and is as
# often the authoring tool's placeholder as the paper's title. These are
# treated as absent so that the filename stands in.
_PLACEHOLDER = re.compile(
    r"^\s*(?:\(?anonymous\)?|untitled(?:\s+document)?|unknown|none|document\d*|"
    r"microsoft\s+word|print(?:out)?|paper|manuscript|draft|no\s+title)\s*$",
    re.IGNORECASE,
)

# Word and LaTeX toolchains leave the source filename as the title.
_TOOL_PREFIX = re.compile(r"^\s*microsoft\s+word\s*-\s*", re.IGNORECASE)
_FILE_SUFFIX = re.compile(r"\.(?:docx?|pdf|tex|dvi|rtf|odt)\s*$", re.IGNORECASE)


def _clean(value: str) -> str:
    """A title or author, or the empty string where the file gives only
    the tool's placeholder."""
    text = _FILE_SUFFIX.sub("", _TOOL_PREFIX.sub("", value)).strip()
    return "" if not text or _PLACEHOLDER.match(text) else text


class PdfIngestor:
    """Text extraction from a PDF's own text layer."""

    name = "pypdf"

    def health(self) -> Health:
        try:
            import pypdf
        except ImportError as exc:  # pragma: no cover - pypdf is a dependency
            return Health(ok=False, detail=str(exc))
        return Health(ok=True, detail=f"pypdf {pypdf.__version__}, no section tree or references")

    def supports(self, source: Path) -> bool:
        return source.suffix.lower() == ".pdf"

    def ingest(self, source: Path) -> Document:
        if not self.supports(source):
            raise IngestError(f"unsupported file type: {source.suffix}")
        if not source.exists():
            raise IngestError(f"source file not found: {source}")

        import pypdf

        try:
            reader = pypdf.PdfReader(source)
            pages = [page.extract_text() or "" for page in reader.pages]
        except Exception as exc:
            raise IngestError(f"could not read {source.name}: {exc}") from exc

        text, sections = _lay_out(pages)
        if not text:
            raise IngestError(
                f"{source.name} has no text layer. It is probably a scan, "
                "which needs optical character recognition that Kiwi does not do."
            )

        return Document(
            document_id=compute_document_id(source),
            source_path=source,
            text=text,
            sections=sections,
            references=(),
            metadata=_metadata(reader, source),
            parser=f"{PdfIngestor.name}-{pypdf.__version__}",
        )


def _lay_out(pages: list[str]) -> tuple[str, tuple[Section, ...]]:
    """One page per section, with each section's span indexing into the
    text that is returned."""
    parts: list[str] = []
    sections: list[Section] = []
    offset = 0
    for number, raw in enumerate(pages, start=1):
        page = _WHITESPACE.sub(" ", raw).strip()
        if not page:
            continue
        if parts:
            parts.append(" ")
            offset += 1
        parts.append(page)
        sections.append(
            Section(
                path=f"p{number}",
                title=f"Page {number}",
                level=1,
                start=offset,
                end=offset + len(page),
            )
        )
        offset += len(page)
    return "".join(parts), tuple(sections)


def _metadata(reader: object, source: Path) -> dict[str, object]:
    """CSL-JSON for the paper, from whatever the file declares.

    A PDF's own metadata is frequently the authoring tool's rather than
    the paper's, so the filename stands in for a missing title.
    """
    info = getattr(reader, "metadata", None)
    title = _clean(getattr(info, "title", None) or "")
    author = _clean(getattr(info, "author", None) or "")
    return {
        "type": "article-journal",
        "title": title or source.stem,
        "author": [{"literal": author}] if author else [],
    }
