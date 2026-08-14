"""Default Retriever.

Fuses BM25 and vector Store search by weighted Reciprocal Rank Fusion
when an Embedder is configured, and falls back to BM25 alone otherwise.
BM25 is weighted higher than vector search (``HYBRID_WEIGHTS``): research
papers are dense with exact terminology, method names, metric names, and
identifiers, that BM25 matches directly and embeddings often only
approximate. See eval/README.md for the measured comparison.
"""

from __future__ import annotations

from collections.abc import Sequence

from kiwi.protocols import Embedder, Store
from kiwi.types import Filter, Health, Hit

_RRF_K = 60
_CANDIDATE_MULTIPLIER = 4
_MIN_CANDIDATES = 20

# (vector weight, text weight). See module docstring.
HYBRID_WEIGHTS = (1.0, 3.0)


class DefaultRetriever:
    name = "default"

    def __init__(self, store: Store, embedder: Embedder | None = None) -> None:
        self.store = store
        self.embedder = embedder

    def health(self) -> Health:
        return Health(ok=True, detail="default retriever")

    def retrieve(self, query: str, k: int, filter: Filter | None = None) -> list[Hit]:
        # An index built with no Embedder configured has no vector column,
        # so vector search is unavailable against it even when an Embedder
        # is configured now. Re-index to enable the hybrid path.
        if self.embedder is None or not self.store.has_vectors():
            return self.store.search_text(query, k, filter)
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
        return reciprocal_rank_fusion(vector_hits, text_hits, k=k, weights=HYBRID_WEIGHTS)


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
