"""Annotations on papers, stored in ``papers/<doc_id>/annotations.json``.

The source PDF is never modified. Writing into it would rewrite the whole
file on every change, and two readers annotating one paper would produce
a conflict with no correct resolution.

Each annotation carries an Anchor into the paper's normalised text, which
is the same shape used for citation targets and evidence passages, so an
annotation relocates through ``kiwi.anchor`` when the paper is parsed
again.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from kiwi.permissions import Permission
from kiwi.types import Anchor, Annotation, AnnotationKind, Json

DEFAULT_COLOR = "yellow"
DEFAULT_AUTHOR = "local"

_CONTEXT_CHARS = 32


def annotations_path(root: Path, document_id: str) -> Path:
    return root / "papers" / document_id / "annotations.json"


def annotation_to_dict(annotation: Annotation) -> Json:
    return {
        "id": annotation.annotation_id,
        "kind": annotation.kind.value,
        "body": annotation.body,
        "color": annotation.color,
        "author": annotation.author,
        "created": annotation.created,
        "target": {
            "source": annotation.document_id,
            "selector": {
                "start": annotation.anchor.start,
                "end": annotation.anchor.end,
                "exact": annotation.anchor.exact,
                "prefix": annotation.anchor.prefix,
                "suffix": annotation.anchor.suffix,
                "section_path": annotation.anchor.section_path,
            },
        },
    }


def annotation_from_dict(data: Json) -> Annotation:
    target = data["target"]
    selector = target["selector"]
    return Annotation(
        annotation_id=data["id"],
        document_id=target["source"],
        anchor=Anchor(
            document_id=target["source"],
            section_path=selector.get("section_path", ""),
            start=selector["start"],
            end=selector["end"],
            exact=selector["exact"],
            prefix=selector.get("prefix", ""),
            suffix=selector.get("suffix", ""),
        ),
        kind=AnnotationKind(data["kind"]),
        body=data.get("body", ""),
        color=data.get("color", DEFAULT_COLOR),
        author=data.get("author", DEFAULT_AUTHOR),
        created=data["created"],
    )


def read_annotations(root: Path, document_id: str) -> list[Annotation]:
    """Annotations on a paper, in the order they were added."""
    path = annotations_path(root, document_id)
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [annotation_from_dict(item) for item in payload.get("annotations", [])]


def write_annotations(root: Path, document_id: str, annotations: list[Annotation]) -> Path:
    path = annotations_path(root, document_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"annotations": [annotation_to_dict(a) for a in annotations]}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def annotate(
    root: Path,
    document_id: str,
    exact: str,
    kind: AnnotationKind = AnnotationKind.HIGHLIGHT,
    body: str = "",
    color: str = DEFAULT_COLOR,
    author: str = DEFAULT_AUTHOR,
    section_path: str = "",
    actor: str | None = None,
) -> Annotation:
    """Record an annotation over the first occurrence of ``exact``.

    The offsets and surrounding context are read from the paper's stored
    text, so the annotation carries what it needs to relocate later.
    Raises ``ValueError`` when the passage is not in the paper.

    ``actor`` is who performs the operation and is what the permission is
    checked against. ``author`` is the name recorded on the annotation and
    is what the panel filters by.
    """
    from kiwi.workspace.settings import require

    require(root, Permission.ANNOTATE_PAPERS, actor)
    text = (root / "papers" / document_id / "text.txt").read_text(encoding="utf-8")
    start = text.find(exact)
    if start == -1:
        raise ValueError(f"passage not found in {document_id}")
    end = start + len(exact)

    annotation = Annotation(
        annotation_id=f"ann_{uuid.uuid4().hex[:16]}",
        document_id=document_id,
        anchor=Anchor(
            document_id=document_id,
            section_path=section_path,
            start=start,
            end=end,
            exact=exact,
            prefix=text[max(0, start - _CONTEXT_CHARS) : start],
            suffix=text[end : end + _CONTEXT_CHARS],
        ),
        kind=kind,
        body=body,
        color=color,
        author=author,
        created=_now(),
    )
    write_annotations(root, document_id, [*read_annotations(root, document_id), annotation])
    return annotation


def delete_annotation(root: Path, document_id: str, annotation_id: str) -> list[Annotation]:
    """Remove one annotation. Returns what remains."""
    remaining = [a for a in read_annotations(root, document_id) if a.annotation_id != annotation_id]
    write_annotations(root, document_id, remaining)
    return remaining


def authors(annotations: list[Annotation]) -> list[str]:
    """The distinct authors present, for filtering a listing."""
    return sorted({a.author for a in annotations})


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
