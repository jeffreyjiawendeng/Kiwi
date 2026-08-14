"""LanceDB Store.

Embedded, in-process, no server to operate: files on local disk. Provides
native BM25 keyword search, which is what makes the no-Embedder fallback
free: removing the Embedder switches the query path rather than removing a
component.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from kiwi.types import Anchor, Chunk, Filter, Health, Hit, Vector

_TEXT_FIELD = "text"
_VECTOR_FIELD = "vector"


def _sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class LanceDBStore:
    """Durable local storage and similarity search over Chunks."""

    name = "lancedb"

    def __init__(self, db_path: Path | str, table_name: str = "chunks") -> None:
        import lancedb

        self.db_path = str(db_path)
        self.table_name = table_name
        self._db = lancedb.connect(self.db_path)
        self._table = (
            self._db.open_table(table_name) if table_name in self._db.table_names() else None
        )
        self._fts_stale = not self._fts_index_exists()

    def health(self) -> Health:
        return Health(ok=True, detail=f"lancedb at {self.db_path}")

    def add(self, chunks: Sequence[Chunk], vectors: Sequence[Vector] | None) -> None:
        if not chunks:
            return
        rows = [
            self._to_row(chunk, vectors[i] if vectors is not None else None)
            for i, chunk in enumerate(chunks)
        ]
        if self._table is None:
            self._table = self._db.create_table(self.table_name, data=rows)
        else:
            self._table.add(rows)
        self._fts_stale = True
        self.optimize()

    def search_vector(self, vector: Vector, k: int, filter: Filter | None = None) -> list[Hit]:
        if self._table is None:
            return []
        query = self._apply_filter(self._table.search(list(vector)).limit(k), filter)
        rows = query.to_list()
        return [self._to_hit(row, row.get("_distance"), is_distance=True) for row in rows]

    def search_text(self, query: str, k: int, filter: Filter | None = None) -> list[Hit]:
        if self._table is None:
            return []
        self._ensure_fts_index()
        result = self._apply_filter(self._table.search(query, query_type="fts").limit(k), filter)
        return [self._to_hit(row, row.get("_score"), is_distance=False) for row in result.to_list()]

    def has_vectors(self) -> bool:
        """Whether the stored table carries a vector column.

        False when every chunk was added with ``vectors=None``, which is
        what an index built with no Embedder configured looks like.
        """
        if self._table is None:
            return False
        return _VECTOR_FIELD in self._table.schema.names

    def delete_document(self, document_id: str) -> None:
        if self._table is None:
            return
        self._table.delete(f"document_id = {_sql_quote(document_id)}")

    def optimize(self) -> None:
        if self._table is not None:
            self._table.optimize()

    def count(self) -> int:
        return self._table.count_rows() if self._table is not None else 0

    def _fts_index_exists(self) -> bool:
        """Whether a full-text index is already built on the text column.

        A persisted index survives across processes, so rebuilding one on
        open costs a pass over the whole table for nothing. Any failure to
        introspect reports False, which rebuilds: slower, never stale.
        """
        if self._table is None:
            return False
        try:
            return any(
                "FTS" in str(getattr(index, "index_type", "")).upper()
                for index in self._table.list_indices()
            )
        except Exception:
            return False

    def _ensure_fts_index(self) -> None:
        if self._table is None or not self._fts_stale:
            return
        self._table.create_fts_index(_TEXT_FIELD, replace=True)
        self._fts_stale = False

    def _apply_filter(self, query: Any, filter: Filter | None) -> Any:
        if filter is None:
            return query
        clauses = []
        if filter.document_ids:
            ids = ", ".join(_sql_quote(d) for d in filter.document_ids)
            clauses.append(f"document_id IN ({ids})")
        if filter.section_paths:
            paths = ", ".join(_sql_quote(p) for p in filter.section_paths)
            clauses.append(f"section_path IN ({paths})")
        if clauses:
            query = query.where(" AND ".join(clauses))
        return query

    def _to_row(self, chunk: Chunk, vector: Vector | None) -> dict[str, Any]:
        row: dict[str, Any] = {
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.anchor.document_id,
            "section_path": chunk.anchor.section_path,
            "start": chunk.anchor.start,
            "end": chunk.anchor.end,
            "exact": chunk.anchor.exact,
            "prefix": chunk.anchor.prefix,
            "suffix": chunk.anchor.suffix,
            "text": chunk.text,
        }
        if vector is not None:
            row["vector"] = list(vector)
        return row

    def _to_hit(self, row: dict[str, Any], raw_score: Any, *, is_distance: bool) -> Hit:
        chunk = Chunk(
            chunk_id=row["chunk_id"],
            anchor=Anchor(
                document_id=row["document_id"],
                section_path=row["section_path"],
                start=row["start"],
                end=row["end"],
                exact=row["exact"],
                prefix=row["prefix"],
                suffix=row["suffix"],
            ),
            text=row["text"],
            section_path=row["section_path"],
        )
        if raw_score is None:
            score = 0.0
        elif is_distance:
            score = 1.0 / (1.0 + float(raw_score))
        else:
            score = float(raw_score)
        return Hit(chunk=chunk, score=score, retriever=self.name)
