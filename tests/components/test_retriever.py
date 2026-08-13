from __future__ import annotations

from pathlib import Path

import pytest

from kiwi.components.retrieve import DefaultRetriever
from kiwi.components.retrieve.default import reciprocal_rank_fusion
from kiwi.components.store import LanceDBStore
from kiwi.protocols import Retriever
from kiwi.types import Anchor, Chunk, Health, Hit, Vector


class _FakeEmbedder:
    name = "fake"

    def health(self) -> Health:
        return Health(ok=True, detail="fake")

    @property
    def dimensions(self) -> int:
        return 3

    def embed(self, texts):
        return [self._vector(t) for t in texts]

    def embed_query(self, text: str) -> Vector:
        return self._vector(text)

    @staticmethod
    def _vector(text: str) -> Vector:
        # Deterministic stand-in: encode presence of a keyword as a coordinate.
        return [
            1.0 if "cat" in text else 0.0,
            1.0 if "dog" in text else 0.0,
            1.0 if "bird" in text else 0.0,
        ]


def _chunk(doc_id: str, ordinal: int, text: str) -> Chunk:
    return Chunk(
        chunk_id=f"chk_{doc_id[4:]}_{ordinal:04d}",
        anchor=Anchor(
            document_id=doc_id,
            section_path="",
            start=0,
            end=len(text),
            exact=text,
            prefix="",
            suffix="",
        ),
        text=text,
        section_path="",
    )


def test_retriever_satisfies_protocol_shape(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    retriever = DefaultRetriever(store)
    assert isinstance(retriever, Retriever)


def test_retriever_uses_text_search_without_embedder(tmp_path: Path) -> None:
    store = LanceDBStore(tmp_path / "db")
    store.add([_chunk("doc_aaaaaaaaaaaaaaaa", 0, "the cat sat down")], vectors=None)
    retriever = DefaultRetriever(store)  # no embedder
    hits = retriever.retrieve("cat", k=5)
    assert hits and "cat" in hits[0].chunk.text


def test_retriever_falls_back_to_text_when_index_has_no_vectors(tmp_path: Path) -> None:
    # An index built with no Embedder configured has no vector column.
    # Configuring an Embedder afterwards must not break querying it.
    store = LanceDBStore(tmp_path / "db")
    store.add([_chunk("doc_aaaaaaaaaaaaaaaa", 0, "the cat sat down")], vectors=None)

    retriever = DefaultRetriever(store, embedder=_FakeEmbedder())
    hits = retriever.retrieve("cat", k=5)

    assert hits
    assert hits[0].retriever == "lancedb"


def test_retriever_uses_hybrid_search_with_embedder(tmp_path: Path) -> None:
    embedder = _FakeEmbedder()
    store = LanceDBStore(tmp_path / "db")
    chunks = [
        _chunk("doc_bbbbbbbbbbbbbbbb", 0, "a story about a cat"),
        _chunk("doc_bbbbbbbbbbbbbbbb", 1, "a story about a dog"),
    ]
    vectors = embedder.embed([c.text for c in chunks])
    store.add(chunks, vectors=vectors)

    retriever = DefaultRetriever(store, embedder=embedder)
    hits = retriever.retrieve("tell me about a cat", k=1)
    assert hits[0].chunk.chunk_id == chunks[0].chunk_id
    assert hits[0].retriever == "hybrid"


_LABELS = {"a": 0, "b": 1, "c": 2, "d": 3}


def _labeled_hit(label: str) -> Hit:
    return Hit(
        chunk=_chunk("doc_ccccccccccccccc0", _LABELS[label], label), score=1.0, retriever="fake"
    )


def test_reciprocal_rank_fusion_rewards_agreement() -> None:
    # "a" tops the vector ranking but is entirely absent from the text
    # ranking (and vice versa for "c"); "b" is only 2nd/1st in each but is
    # the one chunk both rankings agree belongs in the results at all.
    vector_ranking = [_labeled_hit("a"), _labeled_hit("b"), _labeled_hit("c")]
    text_ranking = [_labeled_hit("b"), _labeled_hit("d")]

    fused = reciprocal_rank_fusion(vector_ranking, text_ranking, k=4)

    assert [h.chunk.anchor.exact for h in fused][0] == "b"
    assert all(h.retriever == "hybrid" for h in fused)


def test_reciprocal_rank_fusion_respects_k() -> None:
    ranking = [_labeled_hit("a"), _labeled_hit("b"), _labeled_hit("c")]
    fused = reciprocal_rank_fusion(ranking, k=2)
    assert len(fused) == 2


def test_reciprocal_rank_fusion_weights_shift_the_winner() -> None:
    # "a" is the vector ranking's top pick; "c" is the text ranking's top
    # pick. Unweighted, both rankings count equally and neither dominates.
    # Weighting the text ranking should let its top pick win outright.
    vector_ranking = [_labeled_hit("a"), _labeled_hit("c")]
    text_ranking = [_labeled_hit("c"), _labeled_hit("a")]

    unweighted = reciprocal_rank_fusion(vector_ranking, text_ranking, k=2)
    assert unweighted[0].score == unweighted[1].score

    weighted = reciprocal_rank_fusion(vector_ranking, text_ranking, k=2, weights=(1.0, 3.0))
    assert weighted[0].chunk.anchor.exact == "c"


def test_reciprocal_rank_fusion_rejects_mismatched_weights() -> None:
    with pytest.raises(ValueError, match="one entry per ranking"):
        reciprocal_rank_fusion([_labeled_hit("a")], k=1, weights=(1.0, 2.0))
