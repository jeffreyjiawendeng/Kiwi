"""Build a project the interface can be exercised against.

The parsed papers are copied from ``eval/workspace.kiwi``, so no GROBID
service and no PDF parsing are needed. Drafts, notes, annotations, review
decisions, verification results, and recorded claims are then written
through the same functions the application writes them with.

The claims in ``every-signal.md`` are written, not computed. Their purpose
is to put every state of the severity ladder on screen at once, including
the ones a real corpus rarely produces: a retracted source, a claim its
cited work contradicts, and a score computed before its sentence was
edited. ``chapter.md`` is the opposite: ordinary prose with real citations
and no recorded claims, so that scoring it exercises the aligner.

    uv run python tests/frontend/fixture.py
    uv run kiwi serve --reload

The project is rebuilt from scratch on every run.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from kiwi.claims import Claim  # noqa: E402
from kiwi.types import (  # noqa: E402
    Alignment,
    Anchor,
    Annotation,
    AnnotationKind,
    Depth,
    Intent,
    Reference,
    RefStatus,
    ResolvedReference,
)
from kiwi.workspace import init_project, register_project, write_note  # noqa: E402
from kiwi.workspace.annotations import write_annotations  # noqa: E402
from kiwi.workspace.format import write_verification  # noqa: E402
from kiwi.workspace.pages import write_draft  # noqa: E402
from kiwi.workspace.sidecar import (  # noqa: E402
    _write_sidecar,
    read_sidecar,
    sidecar_path,
    write_claims,
)

SOURCE = ROOT / "eval" / "workspace.kiwi"
MODEL = "fixture (written, not computed)"


def copy_papers(target: Path) -> list[dict]:
    """Copy the parsed papers and the index built from them."""
    shutil.copytree(SOURCE / "papers", target / "papers", dirs_exist_ok=True)
    index = SOURCE / ".kiwi"
    if index.is_dir():
        shutil.copytree(index, target / ".kiwi", dirs_exist_ok=True)

    papers = []
    for directory in sorted((target / "papers").iterdir()):
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        papers.append(
            {
                "id": directory.name,
                "title": metadata.get("title", "(untitled)"),
                "text": (directory / "text.txt").read_text(encoding="utf-8"),
                "path": directory,
            }
        )
    return papers


def set_kiwi_field(directory: Path, **fields: str) -> None:
    path = directory / "metadata.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata.setdefault("kiwi", {}).update(fields)
    path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def passage(text: str, start: int, length: int = 220) -> str:
    """A readable run of text from a paper, ending on a word boundary."""
    window = " ".join(text[start : start + length].split())
    return window.rsplit(" ", 1)[0] if " " in window else window


def anchor(document_id: str, text: str, start: int, section: str = "") -> Anchor:
    exact = passage(text, start)
    return Anchor(
        document_id=document_id,
        section_path=section,
        start=start,
        end=start + len(exact),
        exact=exact,
        prefix="",
        suffix="",
    )


def claim_at(
    source: str,
    sentence: str,
    citation: str,
    intent: Intent,
    alignment: Alignment | None,
) -> Claim:
    start = source.index(sentence)
    return Claim(
        anchor=Anchor(
            document_id="",
            section_path="",
            start=start,
            end=start + len(sentence),
            exact=sentence,
            prefix="",
            suffix="",
        ),
        citation=citation,
        intent=intent,
        intent_source="detected",
        alignment=alignment,
    )


def build(target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    init_project(target, target.stem)
    papers = copy_papers(target)
    if len(papers) < 4:
        raise SystemExit(f"{SOURCE} holds {len(papers)} papers; the fixture needs at least four")

    # One paper's own record carries a retraction, which is the state that
    # changes what a reader should do with everything citing it.
    set_kiwi_field(
        papers[0]["path"],
        source_status="retracted",
        retraction_notice="Retracted 2026-02-11: the reported results could not be reproduced.",
    )
    set_kiwi_field(papers[1]["path"], source_status="resolved")
    set_kiwi_field(papers[2]["path"], source_status="resolved")

    # A second paper has a reference that does not resolve and one that
    # resolves to a retraction, so the References tab has both to show.
    structure = json.loads((papers[1]["path"] / "structure.json").read_text(encoding="utf-8"))
    references = structure.get("references", [])[:6]
    results = []
    for i, raw in enumerate(references):
        reference = Reference(
            raw=raw.get("raw", ""),
            title=raw.get("title"),
            authors=tuple(raw.get("authors", [])),
            year=raw.get("year"),
            doi=raw.get("doi"),
            arxiv_id=raw.get("arxiv_id"),
        )
        if i == 0:
            status, notice = RefStatus.RETRACTED, "Retracted 2025-08-01 by the publisher."
        elif i == 1:
            status, notice = RefStatus.MISMATCH, None
        elif i == 2:
            status, notice = RefStatus.UNRESOLVED, None
        else:
            status, notice = RefStatus.RESOLVED, None
        results.append(
            ResolvedReference(
                reference=reference,
                status=status,
                doi=reference.doi
                or (f"10.0000/fixture.{i}" if status is RefStatus.RESOLVED else None),
                metadata={},
                retraction_notice=notice,
                source="fixture",
            )
        )
    if results:
        write_verification(target, papers[1]["id"], results)

    # Notes, one of each visibility.
    write_note(
        target,
        "reading-log.md",
        "# Reading log\n\nThe edge-IoT paper's threat model is the one to compare against.\n"
        "Nothing here is shared.\n",
        visibility="private",
        author="local",
    )
    write_note(
        target,
        "shared/summary.md",
        "# Summary for the group\n\nThree of the five papers measure latency the same way.\n",
        visibility="shared",
        author="local",
    )

    # Annotations on a paper, so the Notes tab in the rail has entries.
    text = papers[2]["text"]
    write_annotations(
        target,
        papers[2]["id"],
        [
            Annotation(
                annotation_id="ann_fixture0000001",
                document_id=papers[2]["id"],
                anchor=anchor(papers[2]["id"], text, 400),
                kind=AnnotationKind.HIGHLIGHT,
                body="",
                color="yellow",
                author="local",
                created="2026-08-14T09:00:00Z",
            ),
            Annotation(
                annotation_id="ann_fixture0000002",
                document_id=papers[2]["id"],
                anchor=anchor(papers[2]["id"], text, 1200),
                kind=AnnotationKind.NOTE,
                body="Compare this against the intrusion detection baseline.",
                color="yellow",
                author="local",
                created="2026-08-14T09:04:00Z",
            ),
        ],
    )

    write_drafts(target, papers)
    register_project(target)


def write_drafts(target: Path, papers: list[dict]) -> None:
    retracted, issues, annotated, fourth = papers[0], papers[1], papers[2], papers[3]

    # Ordinary prose. No claims are recorded, so Score claims runs the
    # aligner over real citations.
    chapter = f"""# Latency under load

Edge deployments trade a round trip for a colder cache, and the size of
that trade is what this chapter measures.

Authentication at the edge can be made to fit inside the power budget of
a constrained device [@{retracted["id"]}].

Graph convolution over flow records detects intrusions that a per-packet
classifier misses [@{annotated["id"]}].

The protocol comparison for desktop-as-a-service workloads reports median
latency rather than the tail [@{fourth["id"]}].

## Open questions

Nothing here has been checked against the sources yet. Press Score claims.
"""
    write_draft(target, "chapter.md", chapter)

    # Written claims, one per state of the ladder.
    sentences = [
        (
            "The cited work reports a complete elimination of key exchange overhead "
            f"[@{retracted['id']}].",
            retracted["id"],
            Intent.EVIDENCE,
            0,
            retracted,
        ),
        (
            f"Betweenness centrality on virtual nodes runs in linear time [@{issues['id']}].",
            issues["id"],
            Intent.EVIDENCE,
            0,
            issues,
        ),
        (
            f"Graph convolution improves detection on encrypted traffic [@{annotated['id']}].",
            annotated["id"],
            Intent.EVIDENCE,
            1,
            annotated,
        ),
        (
            "The pooling method used throughout this chapter was introduced by the "
            f"cited authors [@{annotated['id']}].",
            annotated["id"],
            Intent.ATTRIBUTION,
            1,
            annotated,
        ),
        (
            f"Remote desktop protocols are compared under a fixed bandwidth cap [@{fourth['id']}].",
            fourth["id"],
            Intent.EVIDENCE,
            2,
            fourth,
        ),
        (
            "This sentence cites a paper that is no longer in the project [@doc_0000000000000000].",
            "doc_0000000000000000",
            Intent.EVIDENCE,
            1,
            None,
        ),
    ]

    body = "# Every signal\n\nOne sentence for each state the ladder can be in.\n\n"
    body += "\n\n".join(sentence for sentence, *_ in sentences) + "\n"
    page = write_draft(target, "every-signal.md", body)
    source = body

    claims = []
    for offset, (sentence, citation, intent, score, paper) in enumerate(sentences):
        evidence = (
            anchor(paper["id"], paper["text"], 800 + offset * 400, section="2. Method")
            if paper is not None
            else None
        )
        claims.append(
            claim_at(
                source,
                sentence,
                citation,
                intent,
                Alignment(
                    score=score,
                    intent=intent,
                    depth=Depth.QUICK,
                    evidence=evidence,
                    model=MODEL,
                ),
            )
        )
    write_claims(target, "every-signal.md", str(page["page_id"]), claims)

    # One claim carries a deep score computed before its sentence changed,
    # which is the only way to see the stale state.
    payload = read_sidecar(target, "every-signal.md")
    first = payload["claims"][0]
    first["deep_alignment"] = {
        **first["alignment"],
        "depth": "deep",
        "claim": "Key exchange overhead is eliminated.",
        "stale": True,
        "computed": "2026-08-01T12:00:00Z",
    }
    # A pending suggestion, so the inspector shows Accept and Reject.
    payload["suggestions"] = [
        {
            "suggestion_id": "sug_fixture00000001",
            "anchor": {
                "start": first["anchor"]["start"],
                "end": first["anchor"]["end"],
                "exact": first["anchor"]["exact"],
                "prefix": "",
                "suffix": "",
            },
            "proposed": (
                f"The cited work reports a reduction in key exchange overhead [@{sentences[0][1]}]."
            ),
            "origin": "fixture",
            "state": "pending",
            "created": "2026-08-14T10:00:00Z",
            "resolved": None,
        }
    ]
    # One decision already recorded, so the process record is not empty.
    payload["review"] = [
        {
            "claim": sentences[2][0],
            "citation": sentences[2][1],
            "decision": "changes_requested",
            "reviewer": "reviewer",
            "comment": "State the traffic conditions this holds under.",
            "recorded": "2026-08-14T11:30:00Z",
        }
    ]
    _write_sidecar(sidecar_path(target, "every-signal.md"), payload)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        type=Path,
        default=ROOT / "Test.kiwi",
        help="where to build the project (default: Test.kiwi in the repository root)",
    )
    args = parser.parse_args()

    if not (SOURCE / "papers").is_dir():
        raise SystemExit(
            f"{SOURCE} has no papers. Build it first:\n"
            "  uv run kiwi ingest eval/corpus --project eval/workspace.kiwi\n"
            "  uv run kiwi index --project eval/workspace.kiwi"
        )

    build(args.project)
    print(f"built {args.project}")
    print("  papers   ", len(list((args.project / "papers").iterdir())))
    print("  drafts    chapter.md (unscored), every-signal.md (every ladder state)")
    print("  notes     reading-log.md (private), shared/summary.md (shared)")
    print()
    print("  uv run kiwi serve --reload")
    print(f"  open http://127.0.0.1:8000/app/ and enter {args.project}")


if __name__ == "__main__":
    main()
