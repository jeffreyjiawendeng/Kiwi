"""The eight component protocols. No implementations.

Every component boundary is a ``typing.Protocol``, never an ABC: a
third-party replacement must not have to import a Kiwi base class. This
module must not import anything from ``kiwi.components``. A lint rule in
pyproject.toml enforces it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Protocol, runtime_checkable

from kiwi.types import (
    Alignment,
    Answer,
    Chunk,
    Depth,
    Document,
    Filter,
    Health,
    Hit,
    Intent,
    Reference,
    ResolvedReference,
    Vector,
)


class IngestError(Exception):
    """Raised by an Ingestor on failure. Never returns a partial Document."""


@runtime_checkable
class Component(Protocol):
    name: str

    def health(self) -> Health: ...


@runtime_checkable
class Ingestor(Component, Protocol):
    def supports(self, source: Path) -> bool: ...

    def ingest(self, source: Path) -> Document: ...


@runtime_checkable
class Chunker(Component, Protocol):
    def chunk(self, document: Document) -> list[Chunk]: ...


@runtime_checkable
class Embedder(Component, Protocol):
    @property
    def dimensions(self) -> int: ...

    def embed(self, texts: Sequence[str]) -> list[Vector]: ...

    def embed_query(self, text: str) -> Vector: ...


@runtime_checkable
class Store(Protocol):
    name: str

    def health(self) -> Health: ...

    def add(self, chunks: Sequence[Chunk], vectors: Sequence[Vector] | None) -> None: ...

    def search_vector(self, vector: Vector, k: int, filter: Filter | None = None) -> list[Hit]: ...

    def search_text(self, query: str, k: int, filter: Filter | None = None) -> list[Hit]: ...

    def has_vectors(self) -> bool: ...

    def delete_document(self, document_id: str) -> None: ...

    def optimize(self) -> None: ...

    def count(self) -> int: ...


@runtime_checkable
class Retriever(Component, Protocol):
    def retrieve(self, query: str, k: int, filter: Filter | None = None) -> list[Hit]: ...


@runtime_checkable
class Reranker(Component, Protocol):
    def rerank(self, query: str, hits: Sequence[Hit], k: int) -> list[Hit]: ...


@runtime_checkable
class Generator(Component, Protocol):
    def generate(self, query: str, passages: Sequence[Hit]) -> Answer: ...

    def suggest(self, text: str, instruction: str) -> list[str]: ...


@runtime_checkable
class Resolver(Component, Protocol):
    def resolve(self, reference: Reference) -> ResolvedReference: ...

    def resolve_batch(self, references: Sequence[Reference]) -> list[ResolvedReference]: ...


@runtime_checkable
class Aligner(Component, Protocol):
    def detect_intent(self, claim: str, context: str) -> Intent: ...

    def align(
        self, claim: str, intent: Intent, evidence: Sequence[Chunk], depth: Depth
    ) -> Alignment: ...
