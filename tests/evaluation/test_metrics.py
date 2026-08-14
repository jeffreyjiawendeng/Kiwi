from __future__ import annotations

from pathlib import Path

from kiwi.anchor import AnchorState, resolve
from kiwi.evaluation.metrics import (
    GoldenPair,
    compute_metrics,
    load_golden_set,
    locate,
    rank_of_match,
)
from kiwi.types import Anchor, Chunk, Document, Hit


def _hit(document_id: str, start: int, end: int, exact: str) -> Hit:
    chunk = Chunk(
        chunk_id="chk_test_0000",
        anchor=Anchor(
            document_id=document_id,
            section_path="",
            start=start,
            end=end,
            exact=exact,
            prefix="",
            suffix="",
        ),
        text=exact,
        section_path="",
    )
    return Hit(chunk=chunk, score=1.0, retriever="test")


def test_compute_metrics_on_known_ranks() -> None:
    # Query 1 found at rank 1, query 2 at rank 4, query 3 not found at all.
    ranks = [1, 4, None]
    metrics = compute_metrics(ranks, k_values=(1, 3, 5))

    assert metrics.n == 3
    assert metrics.recall_at[1] == 1 / 3
    assert metrics.recall_at[3] == 1 / 3  # rank 4 doesn't count within k=3
    assert metrics.recall_at[5] == 2 / 3
    assert metrics.mrr == (1 / 1 + 1 / 4 + 0) / 3


def test_compute_metrics_on_empty_ranks() -> None:
    metrics = compute_metrics([], k_values=(1, 5))
    assert metrics.n == 0
    assert metrics.recall_at == {1: 0.0, 5: 0.0}
    assert metrics.mrr == 0.0


def test_compute_metrics_perfect_score() -> None:
    metrics = compute_metrics([1, 1, 1], k_values=(1,))
    assert metrics.recall_at[1] == 1.0
    assert metrics.mrr == 1.0


def test_rank_of_match_finds_first_overlapping_hit() -> None:
    golden = Anchor(
        document_id="doc_a", section_path="", start=100, end=120, exact="x", prefix="", suffix=""
    )
    hits = [
        _hit("doc_a", 0, 50, "irrelevant"),
        _hit("doc_b", 100, 120, "wrong document"),  # same span, different doc
        _hit("doc_a", 110, 130, "overlaps the golden span"),
    ]
    assert rank_of_match(golden, hits) == 3


def test_rank_of_match_returns_none_when_nothing_overlaps() -> None:
    golden = Anchor(
        document_id="doc_a", section_path="", start=100, end=120, exact="x", prefix="", suffix=""
    )
    hits = [_hit("doc_a", 0, 50, "irrelevant"), _hit("doc_a", 200, 220, "also irrelevant")]
    assert rank_of_match(golden, hits) is None


def test_locate_reresolves_when_offsets_have_shifted() -> None:
    # Simulates a re-ingestion that shifted every offset but left the
    # quoted passage's text unchanged.
    pair = GoldenPair(
        query="q",
        document_id="doc_a",
        start=0,  # stale: no longer where the passage actually is
        end=10,
        exact="the target passage",
        prefix="before ",
        suffix=" after",
    )
    document = Document(
        document_id="doc_a",
        source_path=None,
        text="Some new preamble text. before the target passage after the rest.",
        sections=(),
        references=(),
        metadata={},
        parser="test",
    )
    anchor = locate(pair, document)
    assert document.text[anchor.start : anchor.end] == "the target passage"

    # Sanity check: the anchor module itself agrees this is a SHIFTED resolution.
    result = resolve(
        Anchor(pair.document_id, "", pair.start, pair.end, pair.exact, pair.prefix, pair.suffix),
        document.text,
    )
    assert result.state is AnchorState.SHIFTED


def test_load_golden_set_round_trips(tmp_path: Path) -> None:
    import json

    payload = {
        "pairs": [
            {
                "query": "What is X?",
                "document_id": "doc_a",
                "anchor": {
                    "start": 0,
                    "end": 4,
                    "exact": "text",
                    "prefix": "",
                    "suffix": "",
                },
            }
        ]
    }
    path = tmp_path / "golden.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    pairs = load_golden_set(path)
    assert len(pairs) == 1
    assert pairs[0].query == "What is X?"
    assert pairs[0].document_id == "doc_a"
    assert pairs[0].exact == "text"


def test_load_golden_set_tolerates_missing_prefix_suffix(tmp_path: Path) -> None:
    import json

    anchor = {"start": 0, "end": 1, "exact": "t"}
    payload = {"pairs": [{"query": "q", "document_id": "doc_a", "anchor": anchor}]}
    path = tmp_path / "golden.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    pairs = load_golden_set(path)
    assert pairs[0].prefix == ""
    assert pairs[0].suffix == ""


def test_the_figure_golden_set_is_well_formed() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_golden_set

    pairs = load_golden_set(Path("eval/golden-figures.json"))
    assert len(pairs) >= 10
    assert all(p.document_id.startswith("doc_") for p in pairs)
    assert all(p.exact.strip() for p in pairs)
    # A caption that still carries its component identifier would be
    # measuring the identifier rather than what the caption says.
    assert not any("doi.org" in p.exact for p in pairs)


def test_the_held_out_sets_are_well_formed() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_alignment_set, load_golden_set

    golden = load_golden_set(Path("eval/golden-heldout.json"))
    assert len(golden) >= 20
    assert all(p.exact.strip() for p in golden)

    claims = load_alignment_set(Path("eval/alignment-heldout.json"))
    assert len(claims) >= 20
    # All three scores must be present, or the set cannot show a failure
    # mode that the tuning corpus does not.
    assert {p.label for p in claims} == {0, 1, 2}


def test_the_held_out_corpus_is_a_different_field() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_golden_set

    tuning = {p.document_id for p in load_golden_set(Path("eval/golden.json"))}
    heldout = {p.document_id for p in load_golden_set(Path("eval/golden-heldout.json"))}
    assert not tuning & heldout, "a held-out paper also appears in the tuning corpus"


def test_the_held_out_hedged_and_attribution_sets_are_well_formed() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_alignment_set

    hedged = load_alignment_set(Path("eval/alignment-heldout-hedged.json"))
    assert len(hedged) >= 20
    assert {p.label for p in hedged} == {0, 1, 2}

    attribution = load_alignment_set(Path("eval/attribution-heldout.json"))
    assert len(attribution) >= 12
    assert {p.label for p in attribution} == {0, 1}
    # The zero cases are what the scale exists to catch, so they must
    # outnumber the originations rather than be a token few.
    assert sum(1 for p in attribution if p.label == 0) > sum(1 for p in attribution if p.label == 1)


def test_the_held_out_figure_set_is_well_formed() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_golden_set

    pairs = load_golden_set(Path("eval/golden-figures-heldout.json"))
    assert len(pairs) >= 8
    assert all(p.exact.strip() for p in pairs)
    assert not any("doi.org" in p.exact for p in pairs)


def test_the_held_out_corpus_spans_several_papers() -> None:
    from pathlib import Path

    from kiwi.evaluation import load_alignment_set, load_golden_set

    golden = load_golden_set(Path("eval/golden-heldout.json"))
    claims = load_alignment_set(Path("eval/alignment-heldout.json"))
    # A set drawn from one or two papers measures those papers, not the
    # system, so both sets must reach across the corpus.
    assert len({p.document_id for p in golden}) >= 8
    assert len({p.citation for p in claims}) >= 8
