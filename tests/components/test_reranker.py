from __future__ import annotations

import pytest

from kiwi.components.rerank.cross_encoder import DEFAULT_DEPTH, CrossEncoderReranker
from kiwi.protocols import Reranker
from kiwi.types import Anchor, Chunk, Hit


class _FakeModel:
    """Scores a pair by how many words the query and passage share."""

    def __init__(self) -> None:
        self.batches: list[list[tuple[str, str]]] = []

    def predict(self, pairs, show_progress_bar=False):  # type: ignore[no-untyped-def]
        self.batches.append(list(pairs))
        return [len(set(q.split()) & set(p.split())) for q, p in pairs]


class _StubReranker(CrossEncoderReranker):
    def __init__(self, depth: int | None = None) -> None:
        super().__init__(model_name="stub/model", device="cpu", depth=depth)
        self.model = _FakeModel()

    def _load(self):  # type: ignore[no-untyped-def]
        return self.model


def _hit(text: str, ordinal: int) -> Hit:
    return Hit(
        chunk=Chunk(
            chunk_id=f"chk_{ordinal:04d}",
            anchor=Anchor(
                document_id="doc_0001",
                section_path="",
                start=0,
                end=len(text),
                exact=text,
                prefix="",
                suffix="",
            ),
            text=text,
            section_path="",
        ),
        score=1.0 / (ordinal + 1),
        retriever="hybrid",
    )


def test_reranker_satisfies_protocol_shape() -> None:
    assert isinstance(_StubReranker(), Reranker)


def test_no_hits_rerank_to_no_hits() -> None:
    assert _StubReranker().rerank("anything", [], 5) == []


def test_the_best_matching_passage_is_moved_to_the_front() -> None:
    hits = [_hit("nothing relevant here", 0), _hit("betweenness centrality virtual nodes", 1)]
    reranked = _StubReranker().rerank("betweenness centrality", hits, 2)
    assert reranked[0].chunk.text == "betweenness centrality virtual nodes"


def test_the_reranked_score_replaces_the_fused_one() -> None:
    # A fused score is a rank-fusion artefact; a reranked one is the
    # model's own reading of the pair. Reporting the old score against the
    # new order would describe an order that no longer exists.
    hits = [_hit("betweenness centrality", 0)]
    reranked = _StubReranker().rerank("betweenness centrality", hits, 1)
    assert reranked[0].score == 2.0
    assert reranked[0].retriever == "cross-encoder"


def test_passages_below_the_depth_are_kept_rather_than_dropped() -> None:
    hits = [_hit(f"passage {i}", i) for i in range(6)]
    reranker = _StubReranker(depth=2)
    reranked = reranker.rerank("passage", hits, 6)

    assert len(reranker.model.batches[0]) == 2
    assert len(reranked) == 6
    # The four the model never saw keep their fused order and follow.
    assert [h.chunk.chunk_id for h in reranked[2:]] == [f"chk_{i:04d}" for i in range(2, 6)]


def test_depth_defaults_and_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIWI_RERANK_DEPTH", raising=False)
    assert CrossEncoderReranker(model_name="m", device="cpu").depth == DEFAULT_DEPTH
    monkeypatch.setenv("KIWI_RERANK_DEPTH", "5")
    assert CrossEncoderReranker(model_name="m", device="cpu").depth == 5


def test_reranking_is_off_unless_a_model_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    import kiwi.registry as registry

    monkeypatch.setattr(registry, "_reranker", None)
    monkeypatch.delenv("KIWI_RERANK_MODEL", raising=False)
    assert registry.default_reranker() is None


def test_naming_a_model_turns_reranking_on(monkeypatch: pytest.MonkeyPatch) -> None:
    import kiwi.registry as registry

    monkeypatch.setattr(registry, "_reranker", None)
    monkeypatch.setenv("KIWI_RERANK_MODEL", "some/reranker")
    reranker = registry.default_reranker()
    assert reranker is not None
    assert reranker.model_name == "some/reranker"
