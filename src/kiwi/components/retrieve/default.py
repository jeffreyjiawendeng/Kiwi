"""Default Retriever.

Fuses BM25 and vector Store search by weighted Reciprocal Rank Fusion
when an Embedder is configured, and falls back to BM25 alone otherwise.
BM25 is weighted higher than vector search (``HYBRID_WEIGHTS``): research
papers are dense with exact terminology, method names, metric names, and
identifiers, that BM25 matches directly and embeddings often only
approximate. The weighting is measured against two corpora. It is not
only a retrieval setting: alignment scores against retrieved passages, and
a lower weighting costs attribution accuracy. See eval/README.md.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from kiwi.protocols import Embedder, Reranker, Store
from kiwi.types import Filter, Health, Hit

_RRF_K = 60
_CANDIDATE_MULTIPLIER = 4
_MIN_CANDIDATES = 20

# (vector weight, text weight). See module docstring.
HYBRID_WEIGHTS = (1.0, 5.0)

# A question naming a figure or a table is answered by the caption, but
# the section discussing that figure matches the same words and
# outranks it. Captions are promoted for such a question. The vocabulary
# is deliberately short: adding "graph" or "plot" moves questions about
# graph algorithms and plotted results, which cost more than they gain.
# See eval/README.md.
_ASKS_FOR_COMPONENT = re.compile(r"\b(?:figure|fig|table)\b", re.IGNORECASE)
_CAPTION = re.compile(r"(?:Figure|Table): ")


class DefaultRetriever:
    name = "default"

    def __init__(
        self,
        store: Store,
        embedder: Embedder | None = None,
        reranker: Reranker | None = None,
    ) -> None:
        self.store = store
        self.embedder = embedder
        self.reranker = reranker

    def health(self) -> Health:
        return Health(ok=True, detail="default retriever")

    def retrieve(self, query: str, k: int, filter: Filter | None = None) -> list[Hit]:
        # An index built with no Embedder configured has no vector column,
        # so vector search is unavailable against it even when an Embedder
        # is configured now. Re-index to enable the hybrid path.
        if self.embedder is None or not self.store.has_vectors():
            return promote_captions(
                query, self._rerank(query, self.store.search_text(query, k, filter), k)
            )
        candidates = max(k * _CANDIDATE_MULTIPLIER, _MIN_CANDIDATES)
        try:
            vector_hits = self.store.search_vector(
                self.embedder.embed_query(query), candidates, filter
            )
        except ValueError:
            # Vectors stored by one Embedder cannot be searched with the
            # query vectors of another, because the two disagree on
            # dimension. Re-index to use the configured Embedder.
            return self.store.search_text(query, k, filter)
        text_hits = self.store.search_text(query, candidates, filter)
        # Fusion keeps the candidate pool rather than cutting to k, so the
        # reranker chooses from everything both searches found.
        fused = reciprocal_rank_fusion(vector_hits, text_hits, k=candidates, weights=HYBRID_WEIGHTS)
        return promote_captions(query, self._rerank(query, fused, k))

    def _rerank(self, query: str, hits: list[Hit], k: int) -> list[Hit]:
        """Reorder by cross-encoder when one is configured, cut to ``k``
        otherwise. Caption promotion runs afterwards either way, so a
        question naming a figure is answered the same way with or without
        a Reranker."""
        if self.reranker is None:
            return hits[:k]
        return self.reranker.rerank(query, hits, k)


def promote_captions(query: str, hits: list[Hit]) -> list[Hit]:
    """Move captioned passages ahead of the rest for a question about a
    figure or a table. Order within each group is unchanged, and a query
    that names neither is returned untouched."""
    if not _ASKS_FOR_COMPONENT.search(query):
        return hits
    captioned = [hit for hit in hits if _CAPTION.search(hit.chunk.text)]
    if not captioned:
        return hits
    return captioned + [hit for hit in hits if not _CAPTION.search(hit.chunk.text)]


def reciprocal_rank_fusion(
    *rankings: list[Hit],
    k: int,
    rrf_k: int = _RRF_K,
    weights: Sequence[float] | None = None,
) -> list[Hit]:
    """Merge ranked Hit lists by (optionally weighted) Reciprocal Rank Fusion.

    Each hit's fused score is the sum of ``weight / (rrf_k + rank)`` across
    every ranking it appears in (``weight`` defaults to 1.0 per ranking).
    Rank, not raw score, is what gets fused: BM25 scores and
    vector-distance-derived scores live on unrelated scales with no shared
    zero point, so position within each ranking is the only signal the two
    retrieval paths have in common.
    """
    if weights is not None and len(weights) != len(rankings):
        raise ValueError("weights must have one entry per ranking")
    scored: dict[str, float] = {}
    representative: dict[str, Hit] = {}
    for i, ranking in enumerate(rankings):
        weight = weights[i] if weights is not None else 1.0
        for rank, hit in enumerate(ranking, start=1):
            chunk_id = hit.chunk.chunk_id
            scored[chunk_id] = scored.get(chunk_id, 0.0) + weight / (rrf_k + rank)
            representative.setdefault(chunk_id, hit)
    fused = [
        Hit(chunk=representative[chunk_id].chunk, score=score, retriever="hybrid")
        for chunk_id, score in scored.items()
    ]
    fused.sort(key=lambda hit: hit.score, reverse=True)
    return fused[:k]
