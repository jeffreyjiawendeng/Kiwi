"""Cross-encoder Reranker.

Fusing BM25 and vector rankings decides order from two views of a query
that never see it and the passage together. A cross-encoder reads both at
once and scores the pair directly, which is more accurate and too slow to
run over a whole corpus. It runs over the fused candidates instead.

Off unless ``KIWI_RERANK_MODEL`` names a model, because it is a further
model download on top of the embedder. See eval/README.md for what it is
worth on both corpora.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import TYPE_CHECKING

from kiwi.device import describe_device, resolve_device
from kiwi.types import Health, Hit

if TYPE_CHECKING:
    from sentence_transformers import CrossEncoder

DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3"

# How many fused candidates are read. Every candidate costs a model pass,
# and a passage the reranker never reads cannot be promoted, so the depth
# is a cost against a ceiling. Measured against both corpora. See
# eval/README.md.
DEFAULT_DEPTH = 20

_MAX_TOKENS = 512


class CrossEncoderReranker:
    """Reorders retrieved passages by scoring each against the query."""

    name = "cross-encoder"

    def __init__(
        self,
        model_name: str | None = None,
        device: str | None = None,
        depth: int | None = None,
    ) -> None:
        self.device = resolve_device(device)
        self.model_name = model_name or os.environ.get("KIWI_RERANK_MODEL") or DEFAULT_MODEL
        self.depth = depth or int(os.environ.get("KIWI_RERANK_DEPTH", DEFAULT_DEPTH))
        self._model: CrossEncoder | None = None

    def _load(self) -> CrossEncoder:
        if self._model is None:
            from sentence_transformers import CrossEncoder as _CrossEncoder

            self._model = _CrossEncoder(self.model_name, max_length=_MAX_TOKENS, device=self.device)
        return self._model

    def health(self) -> Health:
        try:
            self._load()
        except Exception as exc:  # model download/load can fail many ways
            return Health(ok=False, detail=str(exc))
        return Health(ok=True, detail=f"{self.model_name} on {describe_device(self.device)}")

    def rerank(self, query: str, hits: Sequence[Hit], k: int) -> list[Hit]:
        """Return the top ``k`` of ``hits``, reordered.

        Only the first ``depth`` are read. Anything below that keeps its
        fused order and follows, so a passage is never dropped by the
        reranker declining to look at it.
        """
        if not hits:
            return []
        read, rest = list(hits[: self.depth]), list(hits[self.depth :])
        model = self._load()
        scores = model.predict([(query, hit.chunk.text) for hit in read], show_progress_bar=False)
        ordered = [
            Hit(chunk=hit.chunk, score=float(score), retriever=self.name)
            for hit, score in sorted(
                zip(read, scores, strict=True), key=lambda pair: pair[1], reverse=True
            )
        ]
        return (ordered + rest)[:k]
