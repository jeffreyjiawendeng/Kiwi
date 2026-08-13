from __future__ import annotations

from pathlib import Path

from kiwi.components.store import LanceDBStore
from kiwi.protocols import Store
from kiwi.types import Anchor, Chunk, Filter


def _chunk(doc_id: str, ordinal: int, section_path: str, text: str) -> Chunk:
    return Chunk(
        chunk_id=f"chk_{doc_id[4:]}_{ordinal:04d}",
        anchor=Anchor(
            document_id=doc_id,
            section_path=section_path,
            start=ordinal * 100,
            end=ordinal * 100 + len(text),
            exact=text,
            prefix="",
            suffix="",
        ),
        text=f"{section_path}\n\n{text}" if section_path else text,
        section_path=section_path,
    )


def test_store_satisfies_protocol_shape(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    assert isinstance(store, Store)


def test_add_and_search_text_via_bm25(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    chunks = [
        _chunk("doc_aaaaaaaaaaaaaaaa", 0, "Introduction", "Retrieval grounded in a corpus."),
        _chunk("doc_aaaaaaaaaaaaaaaa", 1, "Methods", "We evaluated forty papers."),
    ]
    store.add(chunks, vectors=None)  # the no-Embedder path
    assert store.count() == 2

    hits = store.search_text("retrieval corpus", k=5)
    assert hits
    assert hits[0].chunk.chunk_id == chunks[0].chunk_id
    assert hits[0].retriever == "lancedb"


def test_add_and_search_vector(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    chunks = [
        _chunk("doc_bbbbbbbbbbbbbbbb", 0, "", "close vector"),
        _chunk("doc_bbbbbbbbbbbbbbbb", 1, "", "far vector"),
    ]
    vectors = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    store.add(chunks, vectors=vectors)

    hits = store.search_vector([0.9, 0.1, 0.0], k=2)
    assert hits[0].chunk.chunk_id == chunks[0].chunk_id
    assert hits[0].score >= hits[1].score


def test_filter_by_document_id(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    store.add(
        [
            _chunk("doc_cccccccccccccccc", 0, "", "shared keyword alpha"),
            _chunk("doc_dddddddddddddddd", 0, "", "shared keyword beta"),
        ],
        vectors=None,
    )
    doc_filter = Filter(document_ids=("doc_cccccccccccccccc",))
    hits = store.search_text("shared keyword", k=10, filter=doc_filter)
    assert all(h.chunk.anchor.document_id == "doc_cccccccccccccccc" for h in hits)
    assert len(hits) == 1


def test_delete_document(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    store.add([_chunk("doc_eeeeeeeeeeeeeeee", 0, "", "to be deleted")], vectors=None)
    assert store.count() == 1
    store.delete_document("doc_eeeeeeeeeeeeeeee")
    assert store.count() == 0


def test_reopening_existing_table_preserves_data(tmp_path: Path) -> None:
    db_path = tmp_path / "db"
    store1 = LanceDBStore(db_path)
    store1.add([_chunk("doc_ffffffffffffffff", 0, "", "persisted content")], vectors=None)

    store2 = LanceDBStore(db_path)
    assert store2.count() == 1


def test_empty_store_returns_no_hits(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    assert store.search_text("anything", k=5) == []
    assert store.count() == 0


def test_has_vectors_reflects_how_chunks_were_added(tmp_path: Path) -> None:
    without = LanceDBStore(tmp_path / "without")
    assert without.has_vectors() is False  # empty store
    without.add([_chunk("doc_aaaaaaaaaaaaaaaa", 0, "", "no vectors here")], vectors=None)
    assert without.has_vectors() is False

    with_vectors = LanceDBStore(tmp_path / "with")
    with_vectors.add([_chunk("doc_bbbbbbbbbbbbbbbb", 0, "", "has a vector")], vectors=[[1.0, 0.0]])
    assert with_vectors.has_vectors() is True

    # The answer survives reopening, since it is read off the stored schema.
    assert LanceDBStore(tmp_path / "without").has_vectors() is False
    assert LanceDBStore(tmp_path / "with").has_vectors() is True


def test_text_search_finds_rows_added_after_the_index_was_built(tmp_path: Path) -> None:
    db_path = tmp_path / "db"
    store = LanceDBStore(db_path)
    store.add([_chunk("doc_aaaaaaaaaaaaaaaa", 0, "", "networks and centrality")], vectors=None)
    assert store.search_text("centrality", k=5)

    # Reopening skips rebuilding an already-built index; rows added afterwards
    # must still be findable.
    reopened = LanceDBStore(db_path)
    reopened.add(
        [_chunk("doc_aaaaaaaaaaaaaaaa", 1, "", "quantum tunnelling effects")], vectors=None
    )
    hits = reopened.search_text("tunnelling", k=5)
    assert hits
    assert "tunnelling" in hits[0].chunk.text
