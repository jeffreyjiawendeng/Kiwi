"""Component registry.

Required components are non-optional in the type; optional ones are
``| None``, so a configuration with no Generator or no Aligner is
expressible in the type system rather than enforced by convention alone.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from kiwi.components.chunk.section_aware import SectionAwareChunker
from kiwi.components.generate.litellm_generator import LiteLLMGenerator
from kiwi.components.ingest.grobid import DEFAULT_GROBID_URL, GrobidIngestor
from kiwi.components.resolve.crossref import CrossrefResolver
from kiwi.components.retrieve.default import DefaultRetriever
from kiwi.components.store.lancedb_store import LanceDBStore
from kiwi.protocols import (
    Aligner,
    Chunker,
    Embedder,
    Generator,
    Ingestor,
    Resolver,
    Retriever,
    Store,
)

__all__ = [
    "DEFAULT_GROBID_URL",
    "ComponentSet",
    "default_aligner",
    "default_embedder",
    "default_generator",
    "default_ingestor",
    "default_resolver",
    "default_retriever",
    "default_store",
    "index_dir",
]


_embedder: Embedder | None = None
_aligner: Aligner | None = None


@dataclass(frozen=True)
class ComponentSet:
    ingestor: Ingestor
    chunker: Chunker
    store: Store
    embedder: Embedder | None = None
    retriever: Retriever | None = None
    generator: Generator | None = None
    resolver: Resolver | None = None
    aligner: Aligner | None = None


def default_ingestor() -> GrobidIngestor:
    """Build the default GROBID Ingestor, reading its URL from ``KIWI_GROBID_URL``."""
    return GrobidIngestor(base_url=os.environ.get("KIWI_GROBID_URL", DEFAULT_GROBID_URL))


def default_chunker() -> SectionAwareChunker:
    return SectionAwareChunker()


def index_dir(project_root: Path) -> Path:
    """Where the Store persists. Derived and rebuildable."""
    return project_root / ".kiwi" / "index.lance"


def default_store(project_root: Path) -> LanceDBStore:
    return LanceDBStore(index_dir(project_root))


def default_embedder() -> Embedder | None:
    """``None`` when the ``embed`` extra isn't installed, or when
    ``KIWI_NO_EMBED`` is set. The no-Embedder fallback (BM25 keyword
    search) then applies automatically.

    The instance is reused across calls. Building a new one per query
    reloads the model and re-checks it against the model host, which
    dominates the cost of any operation that retrieves more than once.
    """
    global _embedder
    if os.environ.get("KIWI_NO_EMBED"):
        return None
    try:
        import sentence_transformers  # noqa: F401
    except ImportError:
        return None
    if _embedder is None:
        from kiwi.components.embed.sentence_transformer import SentenceTransformerEmbedder

        _embedder = SentenceTransformerEmbedder()
    return _embedder


def default_retriever(store: Store, embedder: Embedder | None) -> DefaultRetriever:
    return DefaultRetriever(store, embedder=embedder)


def default_generator() -> Generator | None:
    """``None`` unless a model is explicitly configured via
    ``KIWI_GENERATOR_MODEL``. No outbound API call is made otherwise."""
    model = os.environ.get("KIWI_GENERATOR_MODEL")
    if not model:
        return None
    return LiteLLMGenerator(model=model)


def default_aligner() -> Aligner | None:
    """``None`` when the ``align`` extra isn't installed, or when
    ``KIWI_NO_ALIGN`` is set. Citations are then shown without a score.

    The instance is reused across calls, for the same reason as
    :func:`default_embedder`.
    """
    global _aligner
    if os.environ.get("KIWI_NO_ALIGN"):
        return None
    try:
        import transformers  # noqa: F401
    except ImportError:
        return None
    if _aligner is None:
        from kiwi.components.align.nli import NLIAligner

        _aligner = NLIAligner()
    return _aligner


def default_resolver() -> Resolver | None:
    """A CrossrefResolver by default. Unlike the Generator, Crossref is
    free and needs no key, so verification is on unless explicitly turned
    off with ``KIWI_NO_VERIFY``, for fully offline operation."""
    if os.environ.get("KIWI_NO_VERIFY"):
        return None
    return CrossrefResolver(contact_email=os.environ.get("KIWI_CONTACT_EMAIL"))
