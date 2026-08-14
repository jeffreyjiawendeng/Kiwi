"""Shared types crossing component boundaries.

Every dataclass here is frozen: data crossing a component boundary is a
value, never a dict, and never mutated in place after construction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

Vector = Sequence[float]
Json = dict[str, Any]


@dataclass(frozen=True)
class Anchor:
    """Locates a passage inside a document.

    The same shape is used for annotations, citation targets, evidence
    passages, suggestion spans, and chunk provenance. ``kiwi.anchor``
    resolves it against text that has changed.
    """

    document_id: str
    section_path: str
    start: int
    end: int
    exact: str
    prefix: str
    suffix: str


@dataclass(frozen=True)
class Section:
    path: str  # "Methods/Participants"
    title: str
    level: int
    start: int  # offset into normalised text
    end: int


@dataclass(frozen=True)
class Reference:
    raw: str
    title: str | None
    authors: tuple[str, ...]
    year: int | None
    doi: str | None
    arxiv_id: str | None


@dataclass(frozen=True)
class Document:
    document_id: str
    source_path: Path | None
    text: str  # normalised, offsets index into this
    sections: tuple[Section, ...]
    references: tuple[Reference, ...]
    metadata: Json  # CSL-JSON
    parser: str  # implementation name and version


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    anchor: Anchor
    text: str  # section path prefix + content
    section_path: str


@dataclass(frozen=True)
class Hit:
    chunk: Chunk
    score: float
    retriever: str


@dataclass(frozen=True)
class Citation:
    anchor: Anchor  # where in the source
    quoted: str


@dataclass(frozen=True)
class Answer:
    text: str
    citations: tuple[Citation, ...]
    generator: str


class RefStatus(Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    RETRACTED = "retracted"
    MISMATCH = "mismatch"


@dataclass(frozen=True)
class ResolvedReference:
    reference: Reference
    status: RefStatus
    doi: str | None
    metadata: Json  # CSL-JSON
    retraction_notice: str | None
    source: str  # "crossref", "openalex"


class Intent(Enum):
    EVIDENCE = "evidence"
    ATTRIBUTION = "attribution"
    BACKGROUND = "background"
    METHODS = "methods"
    CONTRAST = "contrast"


class Depth(Enum):
    QUICK = "quick"
    DEEP = "deep"


@dataclass(frozen=True)
class Alignment:
    score: int  # 0, 1, 2 for evidence; 0, 1 for attribution
    intent: Intent
    depth: Depth
    evidence: Anchor | None  # never None when score is set
    model: str


class AnnotationKind(Enum):
    HIGHLIGHT = "highlight"
    NOTE = "note"


@dataclass(frozen=True)
class Annotation:
    """A marked passage in a paper, with optional commentary.

    ``anchor`` indexes the paper's normalised text, so an annotation
    relocates with the passage when the paper is parsed again. The source
    PDF is never modified.
    """

    annotation_id: str
    document_id: str
    anchor: Anchor
    kind: AnnotationKind
    body: str  # commentary; empty for a highlight
    color: str
    author: str
    created: str


class SuggestionState(Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


@dataclass(frozen=True)
class Suggestion:
    """A proposed change to a draft.

    ``anchor.exact`` is the text the change would replace, so the current
    and proposed wording are both available without storing either twice.
    A pending suggestion leaves the draft unchanged.
    """

    suggestion_id: str
    anchor: Anchor
    proposed: str
    origin: str  # "generated", "alignment", or a person
    state: SuggestionState
    created: str
    resolved: str | None = None


@dataclass(frozen=True)
class Filter:
    document_ids: tuple[str, ...] | None = None
    section_paths: tuple[str, ...] | None = None


@dataclass(frozen=True)
class Health:
    ok: bool
    detail: str
