"""How long each step takes, on the machine it is run on.

Every other figure here is about quality. This one is about cost, and it
decides whether a setting is worth its accuracy: reranking reads twenty
passages through a cross-encoder for every question asked, and the gain
it buys is only worth having if a question still returns promptly.

Timings are wall clock on one machine and do not transfer. Run it to
learn what this machine does, not to compare against a published number.
The first call to any model loads it, so a warm-up runs first and is not
counted.

    uv run python eval/_latency.py
"""

from __future__ import annotations

import argparse
import statistics
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from kiwi.components.rerank.cross_encoder import CrossEncoderReranker
from kiwi.components.retrieve.default import DefaultRetriever
from kiwi.core import _ALIGN_PASSAGES, retrieve
from kiwi.evaluation import load_golden_set
from kiwi.registry import default_aligner, default_embedder, default_store
from kiwi.types import Depth, Intent

PROJECT = Path("eval/workspace.kiwi")
GOLDEN = Path("eval/golden.json")


@contextmanager
def timed(record: list[float]) -> Iterator[None]:
    start = time.perf_counter()
    yield
    record.append((time.perf_counter() - start) * 1000)


def report(name: str, samples: list[float]) -> None:
    if not samples:
        print(f"| {name} | no samples | | |")
        return
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(
        f"| {name} | {statistics.median(samples):.0f} | {p95:.0f} | "
        f"{max(samples):.0f} | {len(samples)} |"
    )


def measure(label: str, queries: list[str], run: Callable[[str], object]) -> list[float]:
    run(queries[0])  # warm up: the first call loads the model
    samples: list[float] = []
    for query in queries:
        with timed(samples):
            run(query)
    return samples


def main(limit: int, cpu_rerank: bool = False) -> None:
    queries = sorted({pair.query for pair in load_golden_set(GOLDEN)})[:limit]
    store = default_store(PROJECT)
    embedder = default_embedder()
    if embedder is None:
        raise SystemExit("No Embedder configured.")

    fusion = DefaultRetriever(store, embedder)
    reranking = DefaultRetriever(store, embedder, CrossEncoderReranker())
    aligner = default_aligner()

    print(f"{len(queries)} questions over {store.count()} chunks\n")
    print("| Step | Median ms | p95 ms | Max ms | n |")
    print("|---|---|---|---|---|")

    report("embed the question", measure("embed", queries, embedder.embed_query))
    report("retrieve, fusion only", measure("fusion", queries, lambda q: fusion.retrieve(q, 10)))
    report("retrieve, reranked", measure("rerank", queries, lambda q: reranking.retrieve(q, 10)))

    if cpu_rerank:
        # Whether to turn reranking on is a different question without an
        # accelerator, so the cost of it there is worth knowing.
        on_cpu = DefaultRetriever(store, embedder, CrossEncoderReranker(device="cpu"))
        report(
            "retrieve, reranked on CPU",
            measure("rerank-cpu", queries[:5], lambda q: on_cpu.retrieve(q, 10)),
        )

    if aligner is not None:
        passages = {q: [h.chunk for h in retrieve(PROJECT, q, _ALIGN_PASSAGES)] for q in queries}
        report(
            "score one claim",
            measure(
                "align",
                queries,
                lambda q: aligner.align(q, Intent.EVIDENCE, passages[q], Depth.QUICK),
            ),
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=25, help="Questions to time.")
    parser.add_argument("--cpu-rerank", action="store_true", help="Also time reranking on the CPU.")
    args = parser.parse_args()
    main(args.limit, args.cpu_rerank)
