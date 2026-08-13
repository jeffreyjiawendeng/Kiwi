"""sentence-transformers Embedder. See docs/12-stack.md, "Embedder".

Optional: only importable when the ``embed`` extra is installed. Absent, the
Store falls back to native BM25 keyword search. See docs/11-components.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kiwi.types import Health, Vector

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5"

# nomic-embed-text-v1.5 is asymmetric: documents and queries need different
# instruction prefixes, which is why embed() and embed_query() are
# separate methods on the protocol rather than one.
_DOCUMENT_PREFIX = "search_document: "
_QUERY_PREFIX = "search_query: "


class SentenceTransformerEmbedder:
    """Local, CPU-friendly text embedding. No API key required."""

    name = "sentence-transformers"

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._model: SentenceTransformer | None = None

    def _load(self) -> SentenceTransformer:
        if self._model is None:
            from sentence_transformers import SentenceTransformer as _SentenceTransformer

            # trust_remote_code is required for nomic's custom architecture;
            # harmless for standard models, which ignore it.
            self._model = _SentenceTransformer(self.model_name, trust_remote_code=True)
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
        return Health(ok=True, detail=f"{self.model_name} loaded")

    def embed(self, texts: Sequence[str]) -> list[Vector]:
        model = self._load()
        prefixed = [f"{_DOCUMENT_PREFIX}{t}" for t in texts]
        vectors = model.encode(prefixed, normalize_embeddings=True, convert_to_numpy=True)
        return [vector.tolist() for vector in vectors]

    def embed_query(self, text: str) -> Vector:
        model = self._load()
        vector = model.encode(
            f"{_QUERY_PREFIX}{text}", normalize_embeddings=True, convert_to_numpy=True
        )
        result: list[float] = vector.tolist()
        return result
