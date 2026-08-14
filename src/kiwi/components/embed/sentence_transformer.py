"""sentence-transformers Embedder.

Optional: only importable when the ``embed`` extra is installed. Absent, the
Store falls back to native BM25 keyword search.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import TYPE_CHECKING

from kiwi.device import describe_device, resolve_device
from kiwi.types import Health, Vector

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5"

# Asymmetric models want different instruction prefixes on documents and
# queries, which is why embed() and embed_query() are separate methods on
# the protocol rather than one. Prefixes are per model: applying one
# model's prefixes to another degrades its retrieval.
_PREFIXES: dict[str, tuple[str, str]] = {
    "nomic-ai/nomic-embed-text-v1.5": ("search_document: ", "search_query: "),
    "intfloat/e5-large-v2": ("passage: ", "query: "),
    "intfloat/e5-base-v2": ("passage: ", "query: "),
    "BAAI/bge-large-en-v1.5": ("", "Represent this sentence for searching relevant passages: "),
    "BAAI/bge-base-en-v1.5": ("", "Represent this sentence for searching relevant passages: "),
}
_NO_PREFIXES = ("", "")


class SentenceTransformerEmbedder:
    """Text embedding through a locally downloaded model. Requires no API key."""

    name = "sentence-transformers"

    def __init__(self, model_name: str | None = None, device: str | None = None) -> None:
        self.device = resolve_device(device)
        # The model is not chosen by device: stored vectors carry the
        # dimension of the model that produced them, so changing it means
        # rebuilding the index. See eval/README.md for the measured
        # alternatives.
        self.model_name = model_name or os.environ.get("KIWI_EMBED_MODEL") or DEFAULT_MODEL
        self.document_prefix, self.query_prefix = _PREFIXES.get(self.model_name, _NO_PREFIXES)
        self._model: SentenceTransformer | None = None

    def _load(self) -> SentenceTransformer:
        if self._model is None:
            from sentence_transformers import SentenceTransformer as _SentenceTransformer

            # trust_remote_code is required for nomic's custom architecture;
            # harmless for standard models, which ignore it.
            self._model = _SentenceTransformer(
                self.model_name, trust_remote_code=True, device=self.device
            )
        return self._model

    @property
    def dimensions(self) -> int:
        model = self._load()
        # get_embedding_dimension() replaced get_sentence_embedding_dimension()
        # in newer sentence-transformers; the older name still covers the
        # >=3.4 floor declared in pyproject.toml.
        fallback = model.get_sentence_embedding_dimension
        getter = getattr(model, "get_embedding_dimension", None) or fallback
        dim = getter()
        assert dim is not None
        return dim

    def health(self) -> Health:
        try:
            self._load()
        except Exception as exc:  # model download/load can fail many ways
            return Health(ok=False, detail=str(exc))
        return Health(ok=True, detail=f"{self.model_name} on {describe_device(self.device)}")

    def embed(self, texts: Sequence[str]) -> list[Vector]:
        model = self._load()
        prefixed = [f"{self.document_prefix}{t}" for t in texts]
        vectors = model.encode(prefixed, normalize_embeddings=True, convert_to_numpy=True)
        return [vector.tolist() for vector in vectors]

    def embed_query(self, text: str) -> Vector:
        model = self._load()
        vector = model.encode(
            f"{self.query_prefix}{text}", normalize_embeddings=True, convert_to_numpy=True
        )
        result: list[float] = vector.tolist()
        return result
