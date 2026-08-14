"""Retrieval evaluation: Recall@k and MRR against a golden set of
query -> passage pairs.

Retrieval is evaluated separately from generation. This measures whether
the correct passage reached the model, not what the model did with it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from kiwi.anchor import resolve
from kiwi.types import Anchor, Document, Hit

DEFAULT_K_VALUES: tuple[int, ...] = (1, 3, 5, 10)


@dataclass(frozen=True)
class GoldenPair:
    query: str
    document_id: str
    start: int
    end: int
    exact: str
    prefix: str = ""
    suffix: str = ""


def load_golden_set(path: Path) -> list[GoldenPair]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        GoldenPair(
            query=pair["query"],
            document_id=pair["document_id"],
            start=pair["anchor"]["start"],
            end=pair["anchor"]["end"],
            exact=pair["anchor"]["exact"],
            prefix=pair["anchor"].get("prefix", ""),
            suffix=pair["anchor"].get("suffix", ""),
        )
        for pair in payload["pairs"]
    ]


def locate(pair: GoldenPair, document: Document) -> Anchor:
    """Relocate the golden passage in ``document``'s current text.

    The golden set stores offsets captured at build time, but re-ingesting
    a paper, whether under a different GROBID version or a different
    Ingestor entirely, can shift them even though the passage itself
    hasn't changed. Rather than trust stale offsets, this resolves the
    same quote selector every Anchor uses, so the golden set stays valid
    across re-parsing instead of being pinned to one ingestion run.
    """
    anchor = Anchor(
        document_id=pair.document_id,
        section_path="",
        start=pair.start,
        end=pair.end,
        exact=pair.exact,
        prefix=pair.prefix,
        suffix=pair.suffix,
    )
    return resolve(anchor, document.text).anchor


def _overlaps(golden_anchor: Anchor, hit: Hit) -> bool:
    anchor = hit.chunk.anchor
    if anchor.document_id != golden_anchor.document_id:
        return False
    return anchor.start < golden_anchor.end and anchor.end > golden_anchor.start


def rank_of_match(golden_anchor: Anchor, hits: list[Hit]) -> int | None:
    """1-based rank of the first hit whose chunk overlaps the golden
    passage's span, or ``None`` if no returned hit does.

    Overlap, not exact-offset equality: a retrieved chunk's boundaries
    depend on the chunker under test, so "did the right passage reach the
    model" is answered by span overlap against the same document, not by
    matching a chunk identifier that a different chunker would never
    reproduce.
    """
    for rank, hit in enumerate(hits, start=1):
        if _overlaps(golden_anchor, hit):
            return rank
    return None


@dataclass(frozen=True)
class Metrics:
    recall_at: dict[int, float]
    mrr: float
    n: int


def compute_metrics(
    ranks: list[int | None], k_values: tuple[int, ...] = DEFAULT_K_VALUES
) -> Metrics:
    n = len(ranks)
    recall_at = {
        k: (sum(1 for r in ranks if r is not None and r <= k) / n if n else 0.0) for k in k_values
    }
    mrr = (sum(1.0 / r if r is not None else 0.0 for r in ranks) / n) if n else 0.0
    return Metrics(recall_at=recall_at, mrr=mrr, n=n)
