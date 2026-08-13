# Retrieval evaluation

Retrieval quality is measured against a golden set of query-passage pairs, independent of generation. This measures whether the correct passage was retrievable, not what a language model did with it.

## Corpus

Five open-access computer science papers from PLOS ONE, all CC BY 4.0. See `corpus/manifest.json` for titles and DOIs. PDFs are stored in `corpus/`; the ingested workspace (`workspace.kiwi/`) is derived and regenerated on demand:

```bash
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
uv run kiwi ingest eval/corpus --project eval/workspace.kiwi
```

## Golden set

`golden.json` contains 50 query-passage pairs, written by reading each paper's GROBID-extracted text and quoting a specific sentence or clause that answers the query. Each quote was verified at build time to appear exactly once in its paper's normalized text (see `_build_golden.py`).

A pair's anchor stores `start`, `end`, `exact`, `prefix`, and `suffix`, but evaluation does not trust the stored offsets directly. `kiwi.evaluation.metrics.locate()` re-resolves each pair against the current ingested text using the same quote-selector resolution every Anchor uses (`kiwi.anchor.resolve`). This keeps the golden set valid if the workspace is regenerated under a different GROBID version: offsets can drift, the quoted text does not.

## Method

```bash
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

Runs `FixedSizeChunker` (512-word windows, no section awareness) and `SectionAwareChunker` (the shipped default) under each of three retrieval modes (BM25, vector, hybrid), each into its own Store, and reports Recall@{1,3,5,10} and MRR. A hit is decided by span overlap within the same document, not chunk ID equality: chunk IDs are chunker-derived and do not match across configurations by construction.

## Results (computer science corpus, n=50)

**BM25 (no Embedder):**

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Fixed-size | 0.720 | 0.900 | 0.940 | 1.000 | 0.812 |
| Section-aware | 0.720 | 0.900 | 0.920 | 1.000 | 0.818 |

**Vector (`nomic-embed-text-v1.5`), unweighted:**

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Fixed-size | 0.400 | 0.720 | 0.800 | 0.920 | 0.577 |
| Section-aware | 0.500 | 0.840 | 0.920 | 0.960 | 0.667 |

**Hybrid** (weighted Reciprocal Rank Fusion, BM25 weighted three times over vector; `HYBRID_WEIGHTS` in `kiwi.components.retrieve.default`; the default whenever an Embedder is configured):

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Fixed-size | 0.680 | 0.920 | 0.940 | 0.980 | 0.797 |
| Section-aware | 0.720 | 0.940 | 0.960 | 1.000 | 0.827 |

Under BM25, the two chunkers score within noise of each other: keyword overlap does not depend much on where a chunk boundary falls. Under vector retrieval, section-aware chunking outperforms fixed-size chunking on every metric (Recall@1 0.500 vs. 0.400, MRR 0.667 vs. 0.577), consistent with pairing a layout-preserving parser with a structure-aware chunker. Unweighted vector retrieval trails BM25 on every metric.

Hybrid retrieval combines BM25 and vector rankings by Reciprocal Rank Fusion. An unweighted fusion beats vector-only retrieval but still trails BM25 (section-aware MRR 0.767 vs. 0.818): a weaker ranker voting equally against a stronger one's correct top result reduces accuracy. Weighting BM25 three times over vector matches or exceeds BM25 on every Recall@k and MRR for section-aware chunking, and improves every metric for fixed-size chunking. Research papers are dense with exact terminology: method names, metric names, and identifiers that BM25 finds directly and that embeddings often only approximate. The weighting reflects that property of the domain, though it was chosen by measuring against this one golden set and should be re-checked as the golden set grows.

## Comparison to published results

Kiwi's numbers are Recall@k and MRR over 50 span-overlap-matched queries on 5 papers in one field. The results below mostly report nDCG@10 over thousands of queries across 18 heterogeneous domains (BEIR), or come from a different paper's own dataset. These figures are not directly comparable to the ones above; they provide scale and context.

- BM25 baseline, BEIR average: nDCG@10 ≈ 0.434 (Thakur et al., 2021, [arXiv:2104.08663](https://arxiv.org/abs/2104.08663)). BM25 is a strong baseline generally, not one specific to this golden set.
- ColBERTv2 (late-interaction, per-token index): nDCG@10 ≈ 0.500 average on BEIR, about 15% relative over BM25 ([arXiv:2112.01488](https://arxiv.org/pdf/2112.01488)). Closing this gap requires per-token vector storage and higher query cost, which Kiwi's embedded, local-only design does not use.
- [SciRet](https://arxiv.org/abs/2608.03860) (2026) evaluates a similar pipeline (BM25 with BGE-M3 dense retrieval, combined by Reciprocal Rank Fusion) for scientific-paper RAG over CORD-19, and finds hybrid retrieval the most robust configuration, reaching Recall@10 = 1.000, matching the result above. It also finds that a general-purpose cross-encoder reranker trained on MS MARCO reduces precision on scientific text due to domain mismatch.
- Reported gains from hybrid fusion vary by domain: +7.4% NDCG on an e-commerce benchmark (WANDS), up to +40% Recall@10 on scientific code search, and as little as +1.7% NDCG where lexical overlap is already high, such as patent retrieval ([OpenSearch RRF](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/)). Kiwi's hybrid-over-BM25 gain (+1.1% MRR) is at the low end of this range, consistent with BM25 already reaching Recall@10 = 1.000 on this golden set. The hybrid-over-vector-only gain (+24% MRR) is closer to the range reported for hybrid over dense-only retrieval elsewhere (+26 to 31% NDCG in one benchmark).
- [LlamaIndex's default retriever is vector-only](https://docs.llamaindex.ai/en/latest/examples/retrievers/reciprocal_rerank_fusion/); BM25 fusion requires wiring a separate `BM25Retriever` into a `QueryFusionRetriever`. Most framework quickstarts share this default, which is the retrieval mode measured above as trailing BM25 by about 18% MRR.

## Limitations

- 50 pairs is a first pass on one field (computer science) and five papers. Treat differences smaller than a few points as noise.
- Each paper is represented by exactly 10 pairs regardless of its length or complexity, so a chunker or retrieval-mode effect specific to one paper's structure could be masked or exaggerated by its other nine pairs.
- The 3x hybrid weight was chosen by measuring against this golden set. It should be re-checked as the golden set grows or a second field is added.
- Chunk size (the 256 to 512 token target band) was not swept; both chunkers used the default (512).
- Generation is not evaluated here; this measures retrieval only.
