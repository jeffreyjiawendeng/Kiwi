from __future__ import annotations

import json
from pathlib import Path

import pytest

from kiwi.components.chunk.fixed_size import FixedSizeChunker
from kiwi.components.chunk.section_aware import SectionAwareChunker
from kiwi.evaluation import GoldenPair, evaluate_configuration, load_golden_set
from kiwi.types import Document, Health, Section, Vector


class _FakeEmbedder:
    name = "fake"

    def health(self) -> Health:
        return Health(ok=True, detail="fake")

    @property
    def dimensions(self) -> int:
        return 2

    def embed(self, texts):
        return [self._vector(t) for t in texts]

    def embed_query(self, text: str) -> Vector:
        return self._vector(text)

    @staticmethod
    def _vector(text: str) -> Vector:
        return [1.0 if "zebra" in text else 0.0, 1.0 if "alpha" in text else 0.0]


def _document(doc_id: str, text: str, sections: tuple[Section, ...]) -> Document:
    return Document(
        document_id=doc_id,
        source_path=None,
        text=text,
        sections=sections,
        references=(),
        metadata={"title": doc_id},
        parser="test",
    )


def test_evaluate_configuration_finds_exact_passage(tmp_path: Path) -> None:
    text = "Introduction text about retrieval. Results show section-aware chunking helped a lot."
    intro_end = text.index("Results")
    document = _document(
        "doc_aaaaaaaaaaaaaaaa",
        text,
        (
            Section(path="Introduction", title="Introduction", level=1, start=0, end=intro_end),
            Section(path="Results", title="Results", level=1, start=intro_end, end=len(text)),
        ),
    )

    quote = "section-aware chunking helped a lot"
    start = text.index(quote)
    golden_path = tmp_path / "golden.json"
    golden_path.write_text(
        json.dumps(
            {
                "pairs": [
                    {
                        "query": "did chunking help",
                        "document_id": document.document_id,
                        "anchor": {
                            "start": start,
                            "end": start + len(quote),
                            "exact": quote,
                            "prefix": "",
                            "suffix": "",
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    pairs = load_golden_set(golden_path)

    result = evaluate_configuration(
        "section-aware",
        SectionAwareChunker(),
        [document],
        pairs,
        tmp_path / "store.lance",
        embedder=None,
    )

    assert result.metrics.n == 1
    assert result.metrics.recall_at[1] == 1.0
    assert result.metrics.mrr == 1.0


def test_baseline_and_section_aware_are_independently_scored(tmp_path: Path) -> None:
    text = "Alpha section content here. " * 5 + "Beta section talks about zebras specifically."
    beta_start = text.index("Beta")
    document = _document(
        "doc_bbbbbbbbbbbbbbbb",
        text,
        (
            Section(path="Alpha", title="Alpha", level=1, start=0, end=beta_start),
            Section(path="Beta", title="Beta", level=1, start=beta_start, end=len(text)),
        ),
    )

    quote = "Beta section talks about zebras specifically."
    start = text.index(quote)
    pairs = [
        GoldenPair(
            query="zebras",
            document_id=document.document_id,
            start=start,
            end=start + len(quote),
            exact=quote,
        )
    ]

    baseline = evaluate_configuration(
        "fixed-size", FixedSizeChunker(), [document], pairs, tmp_path / "a.lance", embedder=None
    )
    section_aware = evaluate_configuration(
        "section-aware",
        SectionAwareChunker(),
        [document],
        pairs,
        tmp_path / "b.lance",
        embedder=None,
    )

    # Both configurations are independently valid Metrics objects. The
    # point of this test is that running two configurations back to back
    # doesn't cross-contaminate their stores or results.
    assert baseline.name == "fixed-size"
    assert section_aware.name == "section-aware"
    assert baseline.metrics.n == section_aware.metrics.n == 1


def test_evaluate_configuration_requires_embedder_for_vector_or_hybrid(tmp_path: Path) -> None:
    document = _document("doc_aaaaaaaaaaaaaaaa", "alpha text here.", ())
    pairs = [
        GoldenPair(query="alpha", document_id=document.document_id, start=0, end=5, exact="alpha")
    ]
    for mode in ("vector", "hybrid"):
        with pytest.raises(ValueError, match="requires an embedder"):
            evaluate_configuration(
                mode,
                SectionAwareChunker(),
                [document],
                pairs,
                tmp_path / f"{mode}.lance",
                embedder=None,
                retrieval_mode=mode,  # type: ignore[arg-type]
            )


def test_evaluate_configuration_hybrid_mode_finds_passage(tmp_path: Path) -> None:
    text = "Alpha section content here. " * 5 + "Beta section talks about zebras specifically."
    beta_start = text.index("Beta")
    document = _document(
        "doc_bbbbbbbbbbbbbbbb",
        text,
        (
            Section(path="Alpha", title="Alpha", level=1, start=0, end=beta_start),
            Section(path="Beta", title="Beta", level=1, start=beta_start, end=len(text)),
        ),
    )
    quote = "Beta section talks about zebras specifically."
    start = text.index(quote)
    pairs = [
        GoldenPair(
            query="zebras",
            document_id=document.document_id,
            start=start,
            end=start + len(quote),
            exact=quote,
        )
    ]

    result = evaluate_configuration(
        "hybrid",
        SectionAwareChunker(),
        [document],
        pairs,
        tmp_path / "hybrid.lance",
        embedder=_FakeEmbedder(),
        retrieval_mode="hybrid",
    )

    assert result.metrics.recall_at[1] == 1.0


def test_fusion_weight_is_a_parameter_of_a_run() -> None:
    # The harness once read the shipped weighting through a from-import,
    # which bound it at module load and made a weighting unmeasurable.
    import inspect

    from kiwi.evaluation import evaluate_configuration

    assert "weights" in inspect.signature(evaluate_configuration).parameters
