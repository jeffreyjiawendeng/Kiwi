"""Runs one Chunker configuration through indexing and retrieval for
every golden query, then scores it. One component changes at a time, and
each configuration is measured against a frozen corpus and golden set.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from kiwi.components.retrieve.default import (
    HYBRID_WEIGHTS,
    promote_captions,
    reciprocal_rank_fusion,
)
from kiwi.components.store.lancedb_store import LanceDBStore
from kiwi.evaluation.metrics import (
    DEFAULT_K_VALUES,
    GoldenPair,
    Metrics,
    compute_metrics,
    locate,
    rank_of_match,
)
from kiwi.protocols import Chunker, Embedder, Reranker
from kiwi.types import Document, Hit

RetrievalMode = Literal["bm25", "vector", "hybrid"]

_CANDIDATE_MULTIPLIER = 4
_MIN_CANDIDATES = 20


@dataclass(frozen=True)
class ConfigResult:
    name: str
    metrics: Metrics


def evaluate_configuration(
    name: str,
    chunker: Chunker,
    documents: list[Document],
    golden: list[GoldenPair],
    store_path: Path,
    embedder: Embedder | None,
    retrieval_mode: RetrievalMode = "bm25",
    k_values: tuple[int, ...] = DEFAULT_K_VALUES,
    weights: Sequence[float] | None = None,
    reranker: Reranker | None = None,
) -> ConfigResult:
    """Chunk and index every document with ``chunker``, then retrieve for
    every golden query under ``retrieval_mode`` and score the ranks. A
    fresh Store at ``store_path`` per call keeps configurations from
    contaminating each other.

    ``retrieval_mode`` is independent of ``embedder`` so the same indexed
    corpus can be scored under bm25/vector/hybrid without re-chunking.
    "vector" and "hybrid" require ``embedder`` to be given.

    ``weights`` sets the hybrid fusion weighting for this run, defaulting
    to the shipped one, so a weighting can be measured without rebuilding
    the retriever.

    ``reranker`` reorders the retrieved passages, as the shipped
    Retriever does when one is configured. Absent, retrieval is fusion
    alone.
    """
    if retrieval_mode != "bm25" and embedder is None:
        raise ValueError(f"retrieval_mode={retrieval_mode!r} requires an embedder")

    store = LanceDBStore(store_path)

    all_chunks = []
    for document in documents:
        all_chunks.extend(chunker.chunk(document))

    vectors = None
    if retrieval_mode != "bm25" and all_chunks:
        assert embedder is not None
        vectors = embedder.embed([chunk.text for chunk in all_chunks])
    store.add(all_chunks, vectors)

    documents_by_id = {document.document_id: document for document in documents}
    ranks: list[int | None] = []
    for pair in golden:
        k = max(k_values)
        hits = _retrieve(store, embedder, pair.query, k, retrieval_mode, weights, reranker)
        golden_anchor = locate(pair, documents_by_id[pair.document_id])
        ranks.append(rank_of_match(golden_anchor, hits))

    return ConfigResult(name=name, metrics=compute_metrics(ranks, k_values))


def _retrieve(
    store: LanceDBStore,
    embedder: Embedder | None,
    query: str,
    k: int,
    mode: RetrievalMode,
    weights: Sequence[float] | None = None,
    reranker: Reranker | None = None,
) -> list[Hit]:
    def ordered(hits: list[Hit]) -> list[Hit]:
        """Rerank when one is configured, cut to ``k`` otherwise, then
        promote captions. The shipped Retriever does the same, in the same
        order."""
        chosen = hits[:k] if reranker is None else reranker.rerank(query, hits, k)
        return promote_captions(query, chosen)

    candidates = max(k * _CANDIDATE_MULTIPLIER, _MIN_CANDIDATES)
    if mode == "bm25":
        return ordered(store.search_text(query, k=candidates if reranker else k))
    assert embedder is not None
    if mode == "vector":
        return ordered(
            store.search_vector(embedder.embed_query(query), k=candidates if reranker else k)
        )
    vector_hits = store.search_vector(embedder.embed_query(query), k=candidates)
    text_hits = store.search_text(query, k=candidates)
    fusion_weights = HYBRID_WEIGHTS if weights is None else weights
    fused = reciprocal_rank_fusion(vector_hits, text_hits, k=candidates, weights=fusion_weights)
    return ordered(fused)
