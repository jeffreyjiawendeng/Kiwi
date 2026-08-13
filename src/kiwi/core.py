"""Shared index and query pipeline, used by both the CLI and the HTTP API
so the two consumers stay in sync. See docs/06-architecture.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from kiwi.protocols import Resolver
from kiwi.registry import (
    default_chunker,
    default_embedder,
    default_resolver,
    default_retriever,
    default_store,
)
from kiwi.types import Chunk, Document, Filter, Hit, ResolvedReference
from kiwi.workspace import write_chunk_count, write_verification


def index_documents(project: Path, documents: Sequence[Document]) -> dict[str, int]:
    """Chunk, optionally embed, and store many documents in one batch.

    Re-indexing is idempotent: any existing chunks for a given document are
    replaced rather than duplicated. All chunks across every document are
    added to the Store in a single call, and optimised in a single pass,
    rather than once per document. See docs/12-stack.md, "Store".
    """
    chunker = default_chunker()
    store = default_store(project)

    counts: dict[str, int] = {}
    all_chunks: list[Chunk] = []
    for document in documents:
        store.delete_document(document.document_id)
        chunks = chunker.chunk(document)
        counts[document.document_id] = len(chunks)
        all_chunks.extend(chunks)

    if all_chunks:
        embedder = default_embedder()
        vectors = embedder.embed([c.text for c in all_chunks]) if embedder is not None else None
        store.add(all_chunks, vectors)

    for document_id, count in counts.items():
        write_chunk_count(project, document_id, count)

    return counts


def index_document(project: Path, document: Document) -> int:
    """Chunk, optionally embed, and store a single document. Returns the chunk count."""
    return index_documents(project, [document])[document.document_id]


def retrieve(project: Path, query: str, k: int, document_id: str | None = None) -> list[Hit]:
    """Retrieve the top-``k`` chunks for ``query``.

    Scoped to one document when ``document_id`` is given. Unscoped, this
    searches across every document indexed in the project.
    """
    store = default_store(project)
    embedder = default_embedder()
    retriever = default_retriever(store, embedder)
    filter_ = Filter(document_ids=(document_id,)) if document_id else None
    return retriever.retrieve(query, k, filter_)


def verify_document(
    project: Path, document: Document, resolver: Resolver | None = None
) -> list[ResolvedReference]:
    """Resolve a document's extracted references against Crossref and
    persist the result. Returns an empty list, with nothing written, if no
    Resolver is configured (``KIWI_NO_VERIFY``) or the paper has none.

    Pass ``resolver`` explicitly to override the default (e.g. a contact
    email set from a CLI flag rather than the environment).
    """
    resolver = resolver if resolver is not None else default_resolver()
    if resolver is None or not document.references:
        return []
    results = resolver.resolve_batch(document.references)
    write_verification(project, document.document_id, results)
    return results
