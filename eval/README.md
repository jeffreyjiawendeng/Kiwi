# Retrieval evaluation

Retrieval quality is measured against a golden set of query-passage pairs, independent of generation. This measures whether the correct passage was retrievable, not what a language model did with it.

## Corpus

Five open-access computer science papers from PLOS ONE, all CC BY 4.0. See `corpus/manifest.json` for titles and DOIs. PDFs are stored in `corpus/`; the ingested workspace (`workspace.kiwi/`) is derived and regenerated on demand:

```bash
docker run --rm -p 8070:8070 -e JAVA_TOOL_OPTIONS=-XX:-UseContainerSupport lfoppiano/grobid:0.8.1
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

Retrieval figures are the same on CPU and GPU. Alignment figures depend on the model, and the alignment model is chosen by device, so the alignment section states which model produced each figure.

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

The three tables above were measured at a 512-token target. At the 768-token target that now ships, section-aware chunking reaches Recall@1 0.760 and MRR 0.856 under hybrid retrieval. See "Chunk size" below.

Under BM25, the two chunkers score within noise of each other: keyword overlap does not depend much on where a chunk boundary falls. Under vector retrieval, section-aware chunking outperforms fixed-size chunking on every metric (Recall@1 0.500 vs. 0.400, MRR 0.667 vs. 0.577), consistent with pairing a layout-preserving parser with a structure-aware chunker. Unweighted vector retrieval trails BM25 on every metric.

Hybrid retrieval combines BM25 and vector rankings by Reciprocal Rank Fusion. An unweighted fusion beats vector-only retrieval but still trails BM25 (section-aware MRR 0.767 vs. 0.818): a weaker ranker voting equally against a stronger one's correct top result reduces accuracy. Weighting BM25 three times over vector matches or exceeds BM25 on every Recall@k and MRR for section-aware chunking, and improves every metric for fixed-size chunking. Research papers are dense with exact terminology: method names, metric names, and identifiers that BM25 finds directly and that embeddings often only approximate. The weighting reflects that property of the domain, though it was chosen by measuring against this one golden set and should be re-checked as the golden set grows.

The weighting was re-swept at the 768-token chunk target, since it had been chosen when chunks were smaller and the vector path was weaker:

| BM25 weight | Recall@1 | MRR |
|---|---|---|
| 1.0 | 0.680 | 0.813 |
| 1.5 | 0.700 | 0.824 |
| 2.0 | 0.760 | 0.853 |
| 2.5 to 6.0 | 0.760 | 0.856 |

Everything from 2.5 upward is indistinguishable on this set, so the shipped 3.0 sits on a plateau rather than at a peak. Equal weighting still costs four points of MRR, which is the same effect measured at the smaller chunk target: a weaker ranker voting equally against a stronger one's correct top result reduces accuracy.

## Comparison to published results

Kiwi's numbers are Recall@k and MRR over 50 span-overlap-matched queries on 5 papers in one field. The results below mostly report nDCG@10 over thousands of queries across 18 heterogeneous domains (BEIR), or come from a different paper's own dataset. These figures are not directly comparable to the ones above; they provide scale and context.

- BM25 baseline, BEIR average: nDCG@10 ≈ 0.434 (Thakur et al., 2021, [arXiv:2104.08663](https://arxiv.org/abs/2104.08663)). BM25 is a strong baseline generally, not one specific to this golden set.
- ColBERTv2 (late-interaction, per-token index): nDCG@10 ≈ 0.500 average on BEIR, about 15% relative over BM25 ([arXiv:2112.01488](https://arxiv.org/pdf/2112.01488)). Closing this gap requires per-token vector storage and higher query cost, which Kiwi's embedded, local-only design does not use.
- [SciRet](https://arxiv.org/abs/2608.03860) (2026) evaluates a similar pipeline (BM25 with BGE-M3 dense retrieval, combined by Reciprocal Rank Fusion) for scientific-paper RAG over CORD-19, and finds hybrid retrieval the most robust configuration, reaching Recall@10 = 1.000, matching the result above. It also finds that a general-purpose cross-encoder reranker trained on MS MARCO reduces precision on scientific text due to domain mismatch.
- Reported gains from hybrid fusion vary by domain: +7.4% NDCG on an e-commerce benchmark (WANDS), up to +40% Recall@10 on scientific code search, and as little as +1.7% NDCG where lexical overlap is already high, such as patent retrieval ([OpenSearch RRF](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/)). Kiwi's hybrid-over-BM25 gain (+1.1% MRR) is at the low end of this range, consistent with BM25 already reaching Recall@10 = 1.000 on this golden set. The hybrid-over-vector-only gain (+24% MRR) is closer to the range reported for hybrid over dense-only retrieval elsewhere (+26 to 31% NDCG in one benchmark).
- [LlamaIndex's default retriever is vector-only](https://docs.llamaindex.ai/en/latest/examples/retrievers/reciprocal_rerank_fusion/); BM25 fusion requires wiring a separate `BM25Retriever` into a `QueryFusionRetriever`. Most framework quickstarts share this default, which is the retrieval mode measured above as trailing BM25 by about 18% MRR.

## Alignment set

`alignment.json` contains 47 claim-citation pairs written against the same five papers. Each pair records the score a reader would assign to the claim given the cited work: 2 where the paper supports it, 1 where the paper is relevant but does not establish it, and 0 where the paper is inconsistent with it. Claims are authored rather than quoted, so a supporting claim paraphrases a real passage and an inconsistent claim negates one.

```bash
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment.json
```

**Results (n=47):**

| | Accuracy | Recall 2 | Recall 1 | Recall 0 | False endorsement | Missed support |
|---|---|---|---|---|---|---|
| `DeBERTa-v3-large-mnli-fever-anli-ling-wanli` (accelerator) | 0.894 | 0.917 | 0.700 | 1.000 | 0.000 | 0.083 |
| `DeBERTa-v3-base-mnli-fever-anli` (CPU) | 0.809 | 0.875 | 0.800 | 0.692 | 0.000 | 0.125 |
| `DeBERTa-v3-base-mnli-fever-anli-scifact-citint` | 0.787 | 0.875 | 0.800 | 0.615 | 0.043 | 0.125 |

The first row is measured at the shipped 768-token chunk target. The other two were measured at 512 and are not re-run here, so they compare models rather than targets.

A score of 2 is displayed without a warning, so an unsupported claim scored 2 reaches the reader unmarked. No model that produces one is used.

## Passage selection

Five passages are retrieved per claim from the cited document. The one scored is the passage the model is least neutral about, and a score of 2 additionally requires the highest-ranked passage to agree.

Both halves of that rule were measured. The alternatives, on the same 47 pairs:

| Rule | Accuracy | Recall 0 | False endorsement | Missed support |
|---|---|---|---|---|
| Highest-ranked passage only | 0.787 | 0.538 | 0.000 | 0.125 |
| Best score across five passages | 0.745 | 0.077 | 0.087 | 0.000 |
| Least neutral of five | 0.851 | 0.692 | 0.087 | 0.042 |
| **Least neutral of five, support needs the highest-ranked passage** | **0.809** | **0.692** | **0.000** | **0.125** |

Taking the best score across passages is the worst rule for detecting contradiction: a single entailing passage outranks a contradicting one, so recall on label 0 falls to 0.077. Selecting the least neutral passage scores highest overall but endorses two contradicted claims, one asserting a node count the paper contradicts and one naming an operating system the paper does not use. Requiring the highest-ranked passage to agree before reporting support removes both while keeping most of the gain in contradiction recall.

Contradiction recall was the weakest figure at a 512-token chunk target, at 0.923. At the 768-token target it reaches 1.000 on this set. An oracle that picks the best of every passage in the cited document reaches 0.936 accuracy, so passage selection remains where the rest of the gap sits.

Scoring the claim against several passages and lowering the score when any of them contradicts it was also measured across thresholds from 0.50 to 0.95. Every threshold reduced accuracy, because supported claims were downgraded more often than contradictions were caught.

## Chunk size

`TARGET_TOKENS` in `kiwi.components.chunk.section_aware` sets the band a chunk aims for, and `MIN_TOKENS` tracks it at half. `KIWI_CHUNK_TOKENS` overrides both. Changing either requires deleting `.kiwi/` and re-indexing, because chunk boundaries move with them.

Six targets were swept against the golden set, section-aware chunking, on the same five papers:

| Target | Chunks | BM25 MRR | Hybrid MRR | Hybrid Recall@1 |
|---|---|---|---|---|
| 128 | 402 | 0.782 | 0.769 | 0.660 |
| 256 | 230 | 0.829 | 0.818 | 0.720 |
| 384 | 171 | 0.817 | 0.817 | 0.720 |
| 512 | 127 | 0.818 | 0.827 | 0.720 |
| **768** | **93** | **0.834** | **0.856** | **0.760** |
| 1024 | 87 | 0.832 | 0.860 | 0.760 |

Retrieval alone cannot settle this. A hit is decided by span overlap, so a larger chunk covers more text and is likelier to overlap the golden span whatever its quality. The same targets were therefore measured on the labelled claim sets, where the aligner scores a claim against the retrieved passage and chunk size carries no such advantage:

| Target | Direct accuracy | Contradiction recall | Missed support | Hedged accuracy |
|---|---|---|---|---|
| 256 | 0.872 | 0.923 | 0.167 | |
| 512 | 0.851 | 0.923 | 0.125 | 0.583 |
| **768** | **0.894** | **1.000** | **0.083** | **0.708** |
| 1024 | 0.894 | 1.000 | 0.083 | 0.667 |

768 and 1024 tie on the direct claims and both reach every contradiction in the set. 768 is ahead on the hedged claims, and produces shorter evidence passages, so it is the shipped target. Attribution is unchanged at 0.824 accuracy across 512, 768, and 1024.

Two independent measurements move together here, which is what the retrieval figures on their own could not establish. The samples remain small: the direct-set gain is two claims of 47, and contradiction recall moving from 0.923 to 1.000 is one claim of 13.

The fixed-size baseline was measured at the same target and does not benefit in the same way: 0.802 BM25 MRR and 0.735 hybrid, against 0.834 and 0.856 for section-aware chunking. Larger windows help when they follow section boundaries, not when they ignore them.

## Alignment model

The model is chosen by device. A machine with an accelerator runs `DeBERTa-v3-large-mnli-fever-anli-ling-wanli`, and a CPU runs the base model of the same family, which is a third of the size and roughly nine times faster per claim on this hardware. `KIWI_ALIGNER_MODEL` overrides both.

A supporting score additionally requires both the scored passage and the highest-ranked passage to put at least 0.70 of the probability mass on entailment. Without that threshold the larger model doubles false endorsement on hedged claims, from 0.125 to 0.250.

Measured on both sets, deep depth:

| Model | Threshold | Direct acc | Direct recall 0 | Hedged acc | False endorsements (of 39) | Contradictions caught (of 20) |
|---|---|---|---|---|---|---|
| base | none | 0.809 | 0.692 | 0.667 | 2 | 14 |
| base | 0.70 | 0.787 | 0.692 | 0.667 | 1 | 14 |
| large | none | 0.872 | 0.923 | 0.625 | 4 | 16 |
| **large** | **0.70** | **0.851** | **0.923** | 0.583 | **2** | **16** |

The shipped pairing matches the base model on overall accuracy and on false endorsement while catching sixteen of the twenty contradictions rather than fourteen. Two other models are unusable on this set: `deberta-v3-large-zeroshot-v2.0` never predicts contradiction, giving recall 0.000 on label 0, and `SCIFACT_xlm_roberta_large` predicts label 1 for every pair.

## Embedding model

`BAAI/bge-large-en-v1.5` retrieves better than the default on the vector path, raising vector MRR from 0.667 to 0.804 and vector Recall@1 from 0.500 to 0.700. It is not the default. Hybrid retrieval is what ships, and there it moves MRR from 0.827 to 0.836, a difference within noise at this sample size, while the model is five times the size and its vectors are a different width. Stored vectors carry the width of the model that produced them, so switching embedders requires deleting `.kiwi/` and re-indexing. `KIWI_EMBED_MODEL` selects it.

The hybrid weighting was re-measured with this embedder, which narrows the gap between the two rankings. Weights between 1.5 and 4.0 all fall in MRR 0.836 to 0.846, a range within noise at this sample size.

`Alibaba-NLP/gte-large-en-v1.5` fails to run under the installed transformers version.

## Quick and deep checks

The quick check scores a claim whole. The deep check splits it into the assertions a reader would check separately, scores each against evidence retrieved for it, and reports the claim as supported only where every assertion is supported and inconsistent where any assertion is.

`alignment-hedged.json` holds 24 compound and hedged claims written against the same five papers, of the kind found in published work. Four of them carry more than one assertion, against none in `alignment.json`.

| Set | Depth | Accuracy | Recall 2 | Recall 1 | Recall 0 | False endorsement | Missed support |
|---|---|---|---|---|---|---|---|
| Direct claims (n=47) | quick | 0.851 | 0.875 | 0.700 | 0.923 | 0.000 | 0.125 |
| Direct claims (n=47) | deep | 0.851 | 0.875 | 0.700 | 0.923 | 0.000 | 0.125 |
| Hedged claims (n=24) | quick | 0.583 | 0.500 | 0.667 | 0.571 | 0.125 | 0.500 |
| Hedged claims (n=24) | deep | 0.625 | 0.625 | 0.667 | 0.571 | 0.125 | 0.375 |

The two depths agree exactly on the direct claims, which carry one assertion each, so the deep check costs a second retrieval there and returns the same answer. On the hedged claims it recovers a supporting score for one claim in eight that the quick check reported as unestablished, because a compound claim scored whole is judged against passages retrieved for one of its halves.

The deep check does not change false endorsement. Endorsing a claim of a speedup of "roughly an order of magnitude" where the paper reports factors of 3 and 1.5 is a failure to read a quantity, not a failure to split a sentence.

Scoring against the whole cited document rather than the retrieved passages was measured and is not used: accuracy fell to 0.787 from 0.809 on the direct claims, because widening the candidate set gives the passage selector more chances to settle on a passage that reads as decisive without addressing the claim.

## Attribution

`attribution.json` contains 17 claims that credit a work with originating something, scored on the binary scale: 1 where the cited paper is the origin, 0 where it is not. Claims labelled 0 name something the paper uses but did not introduce, which is the case a reader has to check.

```bash
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/attribution.json --intent attribution
```

| | Value |
|---|---|
| Accuracy | 0.824 |
| Correctly credited (1 scored 1) | 5 of 6 |
| Wrongly credited (0 scored 1) | 2 of 11, a rate of 0.182 |
| Missed credit (1 scored 0) | 1 of 6, a rate of 0.167 |

The supporting score on this scale is 1, not 2, so the metrics take the supporting value as a parameter. Reporting attribution against the evidence scale gives a false endorsement rate of zero, because a score of 2 never occurs there.

Both wrong credits are the same mistake: crediting a paper for a method it applies. `Brandes' algorithm for betweenness centrality was introduced by the cited authors` and `The Dolev-Yao threat model was introduced in the cited work` both score 1, because passages describing a method in use entail a claim about that method. Entailment does not separate using a technique from originating it, so attribution is weaker than the evidence scale on exactly the distinction it exists to make.

A score of 1 on the attribution scale is displayed without a warning, so a wrong credit reaches the reader unmarked at the same rate as a false endorsement does on hedged prose. Set the intent by hand and read the evidence passage before relying on the score.

## Citation intent

Intent detection is off unless `KIWI_INTENT_MODEL` names a classifier. Four approaches were measured and none is usable as a default.

| Approach | Result |
|---|---|
| SciCite-trained SciBERT classifier | Predicts `result` on 0 of 7 sentences, including three reporting results |
| Zero-shot through the base alignment model | 3 of 7, against 2.3 expected by chance |
| Zero-shot through the large alignment model | 8 of 15, against 5 expected by chance |
| Purpose-built 12B and 14B classifiers | Generative models, not sequence classifiers, so they do not fit the Aligner interface |

`result` is the only class routed to scoring, so the SciCite classifier scores no claims at all. The large alignment model has the opposite bias: it labels 12 of 15 sentences `result` and never labels one `background`, so it recovers every claim that should be scored and adds seven that should not be. Scoring a background citation on the evidence scale produces a judgement the scale does not measure.

Without a classifier, every claim is treated as evidence and scored, and intent is set by hand through `PUT /align/intent` or the Drafts view. A hand-set intent overrides a detected one and persists across runs.

## Revision quality

`kiwi evaluate-revisions` measures whether a suggested rewrite repairs the claim it was proposed for. Each claim labelled 0 is rewritten against the evidence retrieved for it and re-scored, and the run reports four shares: repaired, hedged into the middle score, still contradicted, and rewritten so short that the assertion was dropped.

The aligner is both the source of the flag and the judge of the repair, so a rewrite that games the aligner counts as repaired. Two guards narrow that. A rewrite keeping less than half the original length is counted as having dropped the assertion rather than corrected it, and hedging into a score of 1 is reported separately from reaching support.

No figures are recorded here. Producing a rewrite requires a Generator, and the measurement is only meaningful against the model a reader would actually run.

## Limitations

- 50 pairs is a first pass on one field (computer science) and five papers. Treat differences smaller than a few points as noise.
- Each paper is represented by exactly 10 pairs regardless of its length or complexity, so a chunker or retrieval-mode effect specific to one paper's structure could be masked or exaggerated by its other nine pairs.
- The 3x hybrid weight was chosen by measuring against this golden set. It should be re-checked as the golden set grows or a second field is added.
- Generation is not evaluated here, and no revision figures are recorded: both require a configured Generator.
- The alignment set has 47 pairs across one field, and its claims are authored rather than drawn from published citing sentences. Contradiction recall in particular rests on 13 pairs.
- Alignment is measured against the retrieved passages rather than the whole cited document.
- The alignment claims and their labels were written by one person, so the figures measure agreement with a single reader rather than with a consensus.
- The figures on direct claims do not carry over to hedged prose. On `alignment-hedged.json` accuracy falls from 0.851 to 0.625 and false endorsement rises from 0.000 to 0.125. Quantitative claims stated approximately are the weak case. Read 0.000 false endorsement as a property of direct claims, not of the aligner.
