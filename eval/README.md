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

The golden set has survived a full re-ingestion of the corpus: every figure above reproduces after the five papers are parsed again from their PDFs.

A pair's anchor stores `start`, `end`, `exact`, `prefix`, and `suffix`, but evaluation does not trust the stored offsets directly. `kiwi.evaluation.metrics.locate()` re-resolves each pair against the current ingested text using the same quote-selector resolution every Anchor uses (`kiwi.anchor.resolve`). This keeps the golden set valid if the workspace is regenerated under a different GROBID version: offsets can drift, the quoted text does not.

## Method

```bash
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

Runs `FixedSizeChunker` (512-word windows, no section awareness) and `SectionAwareChunker` (the shipped default) under each of three retrieval modes (BM25, vector, hybrid), each into its own Store, and reports Recall@{1,3,5,10} and MRR. A hit is decided by span overlap within the same document, not chunk ID equality: chunk IDs are chunker-derived and do not match across configurations by construction.

Retrieval figures are the same on CPU and GPU. Alignment figures depend on the model, and the alignment model is chosen by device, so the alignment section states which model produced each figure.

## Results (computer science corpus, n=50)

Figures in this section are measured at the shipped settings. The comparison tables further down record what a rejected alternative scored at the time it was measured, and each states the setting it was measured under, so a number there is not comparable with one here.

**BM25 (no Embedder):**

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Fixed-size | 0.720 | 0.900 | 0.940 | 1.000 | 0.812 |
| Section-aware | 0.720 | 0.900 | 0.920 | 1.000 | 0.818 |

BM25 alone is a strong baseline and the figure to beat, not a straw man. On the held-out corpus it beats every hybrid weighting measured.

**Vector (`bge-large-en-v1.5`), unweighted:**

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Section-aware | 0.700 | 0.900 | 0.940 | 0.980 | 0.808 |

**Hybrid** (weighted Reciprocal Rank Fusion, BM25 weighted three times over vector; `HYBRID_WEIGHTS` in `kiwi.components.retrieve.default`; the default whenever an Embedder is configured):

| | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| Fixed-size | 0.680 | 0.920 | 0.940 | 0.980 | 0.797 |
| Section-aware | 0.740 | 0.940 | 0.980 | 1.000 | 0.847 |

The weighting is 5:1 and the embedder is `BAAI/bge-large-en-v1.5`, both chosen by measuring two corpora. See "Hybrid weighting" and "Embedding model" below.

Under BM25, the two chunkers score within noise of each other: keyword overlap does not depend much on where a chunk boundary falls. Under vector retrieval, section-aware chunking outperforms fixed-size chunking on every metric (Recall@1 0.500 vs. 0.400, MRR 0.667 vs. 0.577), consistent with pairing a layout-preserving parser with a structure-aware chunker. Unweighted vector retrieval trails BM25 on every metric.

Hybrid retrieval combines BM25 and vector rankings by Reciprocal Rank Fusion. An unweighted fusion beats vector-only retrieval but still trails BM25 (section-aware MRR 0.767 vs. 0.818): a weaker ranker voting equally against a stronger one's correct top result reduces accuracy. Weighting BM25 three times over vector matches or exceeds BM25 on every Recall@k and MRR for section-aware chunking, and improves every metric for fixed-size chunking. Research papers are dense with exact terminology: method names, metric names, and identifiers that BM25 finds directly and that embeddings often only approximate. The weighting reflects that property of the domain, though it was chosen by measuring against this one golden set and should be re-checked as the golden set grows.

## Hybrid weighting

The weighting was chosen against both corpora, because a weighting chosen against one is a weighting fitted to it.

Measured with the shipped embedder:

| Mode | Tuning MRR | Held-out MRR |
|---|---|---|
| BM25 only | 0.818 | 0.711 |
| Vector only | 0.808 | 0.645 |
| Hybrid 1:1 | 0.833 | 0.699 |
| Hybrid 3:1 | 0.836 | 0.720 |
| **Hybrid 5:1** | **0.847** | **0.710** |

5:1 and 3:1 are close on retrieval, and 3:1 is a point better on the held-out corpus. 5:1 ships because retrieval is not the only thing the weighting changes: alignment scores against retrieved passages, and at 3:1 false attribution on the tuning corpus rises from 0.000 to 0.091 while direct accuracy falls from 0.894 to 0.851. A point of held-out MRR is not worth a wrongly credited paper.

The weaker embedder measured earlier made hybrid retrieval look unjustified: with `nomic-embed-text-v1.5`, BM25 alone scored 0.711 on the held-out corpus against 0.704 for the best hybrid weighting. That deficit was the embedder rather than the approach. With the shipped embedder hybrid beats BM25 alone on the tuning corpus and matches it on the held-out one.

## Anchor durability

A citation, an annotation, an evidence passage, and a suggestion are all recorded as a quote plus its surrounding context, so that the reference still points at the right words after the paper is parsed again. `_anchors.py` measures that on the 105 quotes recorded across the 15 papers in the golden sets.

```bash
uv run python eval/_anchors.py
```

A re-parse does not rewrite a paper. It changes how the text was recovered from the PDF, so each row is one of those differences applied to the whole document, after which the recorded anchors are resolved against the changed text. "By position" is the share that still sit at their recorded offsets; "relocated" is the share the quote selector had to find again.

| Re-parse difference | Correct | By position | Relocated | Lost |
|---|---|---|---|---|
| None, re-read as stored | 1.000 | 1.000 | 0.000 | 0.000 |
| Line breaks and spacing | 1.000 | 0.000 | 1.000 | 0.000 |
| Ligatures and normalisation | 1.000 | 0.010 | 0.990 | 0.000 |
| Hyphenation at line breaks | 1.000 | 0.000 | 1.000 | 0.000 |
| Running heads kept | 0.981 | 0.038 | 0.943 | 0.019 |
| Typographic quotation marks | 1.000 | 0.981 | 0.019 | 0.000 |
| A block dropped | 1.000 | 0.505 | 0.495 | 0.000 |
| Text reordered | 1.000 | 0.524 | 0.476 | 0.000 |

Every difference that moves offsets is fully recovered. Dropping a block and reordering the text each leave about half the quotes at their recorded position and relocate the other half, which is the split those perturbations produce.

The two quotes lost are the one case the quote selector cannot handle: a running head landed inside the quoted passage, so the recorded words are no longer contiguous anywhere in the document. Reporting those as unanchored is the intended outcome. The recorded quote is preserved rather than discarded, and no wrong passage is offered in its place.

Measuring this found two defects in the resolver, both since fixed. Line-break hyphenation was matched only when the recorded quote carried the hyphen, not when the re-parse introduced one, which is the direction that actually occurs; short quotes could not fall back to the fuzzy step, because a budget of 5% of a 33-character caption is under two characters and a hyphen break costs two. Ligature glyphs were not matched at all, because they carry a compatibility decomposition rather than a canonical one. Hyphenation rose from 0.971 to 1.000 and ligatures from 0.990 to 1.000.

The perturbations above are constructed. An early version of the ligature row was wrong in the resolver's favour because it wrote "office" as "ofﬁce" rather than "oﬃce", which no text layer emits.

### Across two parsers

The bundled text-layer Ingestor makes the observed version of this measurement possible: the same PDFs read by two parsers that share no code. A document identifier comes from the file's bytes, so a paper keeps its identity under both, and an anchor recorded under one can be looked for under the other.

```bash
uv run python eval/_anchors.py --across-parsers
```

| | Relocated | Lost |
|---|---|---|
| GROBID-recorded anchors, found in pypdf's text (n=34) | **0.941** | 0.059 |

The two disagree about more than the constructed differences model. GROBID drops running heads and rejoins words broken across lines; the text layer keeps the furniture and leaves "popula- tion" as it found it. Two anchors of 34 do not survive that, against none for most of the constructed rows.

The first run of this reported 0.735, and the difference was a defect in the measurement rather than in the resolver: the comparison treated a hyphen as a line break only when a newline followed it, and the text layer writes a space. The resolver had relocated those anchors correctly and the check then called them wrong.

## Reranking

Fusing BM25 and vector rankings decides order from two views that never see the query and the passage together. A cross-encoder reads both at once. It is too slow to run over a corpus and fast enough over the candidates fusion already found, which is where it runs: the top 20, after fusion and before caption promotion.

It is off unless `KIWI_RERANK_MODEL` names a model, because it is a further model download on top of the embedder. Setting it changes no index and needs no re-ingestion.

```bash
KIWI_RERANK_MODEL=BAAI/bge-reranker-v2-m3 uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

This is the largest retrieval gain measured for this project, and the only change so far that improves every set it was measured against:

| Set | Recall@1 | | MRR | |
|---|---|---|---|---|
| | Fusion only | Reranked | Fusion only | Reranked |
| Prose tuning (n=50) | 0.740 | **0.940** | 0.847 | **0.963** |
| Prose held-out (n=34) | 0.559 | **0.824** | 0.710 | **0.912** |
| Figures tuning (n=12) | 0.667 | **0.750** | 0.792 | **0.833** |
| Figures held-out (n=9) | 0.889 | **1.000** | 0.944 | **1.000** |
| SciFact, 300 test queries | 0.567 | **0.613** | 0.669 | **0.693** |

The held-out row is the one to read. Retrieval was the measurement that transferred worst, losing 14 points of MRR on fields the settings were not chosen against. Reranking closes that gap: held-out MRR reaches 0.912 against 0.963 on the tuning corpus, where fusion alone reached 0.710 against 0.847. The gain is largest exactly where the pipeline was weakest.

The gain on SciFact is real but much smaller, and the reason is the same one that decided the weighting: a SciFact abstract is a single chunk, so there is less for a reranker to reorder within the right document, and the corpus is 5183 documents rather than ten.

Three models were compared on identical fused candidates. Only one of them survives being measured on queries it was not chosen against:

| Model | Train Recall@1 | Train MRR | Test Recall@1 | Test MRR |
|---|---|---|---|---|
| None | 0.780 | 0.843 | 0.567 | 0.669 |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | 0.798 | 0.857 | 0.533 | 0.637 |
| `BAAI/bge-reranker-base` | 0.790 | 0.848 | 0.553 | 0.655 |
| **`BAAI/bge-reranker-v2-m3`** | **0.828** | **0.879** | **0.613** | **0.693** |

All three improve the training split. On the test split, which took no part in the choice, the two weaker models make retrieval worse than no reranking at all: the MS MARCO cross-encoder loses 0.032 MRR and `bge-reranker-base` loses 0.014. Reading only the training column would have shipped either of them.

That result corroborates the SciRet finding quoted below rather than contradicting it. A general-purpose reranker trained on web search does lose precision on scientific text; the gain it showed on the training split was an artefact of the split. Only the strongest of the three holds up, and by less on SciFact than on the corpora Kiwi is for.

A passage below the reranked depth is kept rather than dropped: it holds its fused order and follows. Depth was swept, because every candidate costs a model pass and a passage the reranker never reads cannot be promoted:

| Depth | Prose tuning Recall@1 / MRR | Prose held-out Recall@1 / MRR |
|---|---|---|
| None | 0.740 / 0.847 | 0.559 / 0.710 |
| 5 | 0.940 / 0.955 | 0.735 / 0.820 |
| 10 | 0.940 / 0.963 | 0.824 / 0.897 |
| **20** | **0.940 / 0.963** | **0.824 / 0.912** |
| 40 | 0.940 / 0.963 | 0.824 / 0.912 |

Every figure is saturated by 20 and 40 adds nothing, so 20 is the default.

`KIWI_RERANK_DEPTH` overrides the default.

### What reranking does to alignment

Retrieval is not the only thing this changes. A claim is scored against the passages retrieved for it, so reordering them reorders what the aligner reads:

| Set | Accuracy | | False endorsement | | Missed support | |
|---|---|---|---|---|---|---|
| | Fusion | Reranked | Fusion | Reranked | Fusion | Reranked |
| Evidence, tuning (n=47) | 0.872 | **0.915** | 0.000 | 0.000 | 0.125 | **0.083** |
| Evidence, held-out (n=24) | 0.917 | **0.979** | 0.000 | 0.000 | 0.091 | **0.000** |
| Hedged, tuning (n=24) | 0.750 | **0.792** | 0.062 | **0.125** | 0.500 | **0.250** |
| Hedged, held-out (n=22) | 0.864 | 0.864 | 0.000 | 0.000 | 0.200 | **0.300** |
| Attribution, tuning (n=17) | 0.882 | 0.882 | 0.091 | 0.091 | — | — |
| Attribution, held-out (n=14) | 1.000 | 1.000 | 0.000 | 0.000 | — | — |

Direct evidence claims improve on both corpora and the attribution scale does not move at all. Hedged prose is where it is not free: accuracy rises and missed support halves on the tuning set, but false endorsement doubles there, from one wrongly endorsed claim to two of sixteen.

That is the error this project treats as the serious one, because a claim scored 2 is displayed without a warning. It is two claims of a 24-claim set and the held-out hedged set does not move, so this is a small sample rather than a settled result — but it is the reason reranking is asked for rather than assumed, alongside the model download. A reader who turns it on gets better retrieval everywhere, better direct-claim alignment, and one more chance of an approximate quantitative claim being reported as supported.

## Held-out corpus

`corpus-heldout/` holds ten open-access papers across ecology, epidemiology, archaeology, psychology, and public health, none of them from the tuning corpus's field. The sets built against it:

| Set | Pairs |
|---|---|
| `golden-heldout.json` | 34 query-passage |
| `alignment-heldout.json` | 48 claim-citation |
| `alignment-heldout-hedged.json` | 22 hedged and compound |
| `attribution-heldout.json` | 14 attribution |
| `golden-figures-heldout.json` | 9 figure-directed |

```bash
uv run kiwi ingest eval/corpus-heldout --project eval/heldout.kiwi
uv run kiwi index eval/heldout.kiwi
uv run kiwi evaluate eval/heldout.kiwi --golden eval/golden-heldout.json
uv run kiwi evaluate-alignment eval/heldout.kiwi --labelled eval/alignment-heldout.json
```

Nothing is tuned against it. Its purpose is to show where a setting chosen on the tuning corpus does not transfer, and it did that immediately.

**Chunk size.** A 768-token target measured better than 512 on the tuning corpus and was briefly the default. On the held-out corpus it is worse on both retrieval and alignment:

| Measurement | 512 | 768 |
|---|---|---|
| Tuning corpus, retrieval MRR | 0.828 | 0.856 |
| Held-out, retrieval MRR | 0.817 | 0.707 |
| Tuning corpus, alignment accuracy | 0.851 | 0.894 |
| Held-out, alignment accuracy | 0.958 | 0.917 |

768 wins on the corpus it was chosen against and loses on the one it was not. Retrieval falls 15 points under it while 512 moves by one. The target is 512.

Hedged prose is the one measurement where 768 looked better on the tuning corpus, at 0.708 against 0.583. It does not transfer either. On `alignment-heldout-hedged.json` the order reverses:

| Held-out hedged (n=22) | 512 | 768 |
|---|---|---|
| Accuracy | 0.818 | 0.773 |
| Contradiction recall | 0.875 | 0.750 |
| False endorsement | 0.000 | 0.000 |

Every held-out measurement favours 512: retrieval, direct claims, and hedged claims alike.

The held-out papers are longer than the tuning papers, at 7612 words against 5920, and carry more sections, at 18.5 against 14.8. A target chosen against shorter papers produced chunks that were too coarse for longer ones.

**Results (held-out, 512-token target):**

| Measurement | Tuning corpus | Held-out |
|---|---|---|
| Retrieval Recall@1 | 0.740 | 0.559 |
| Retrieval MRR | 0.847 | 0.710 |
| Alignment accuracy | 0.872 | 0.917 |
| Contradiction recall | 0.846 | 0.882 |
| False endorsement | 0.000 | 0.000 |
| Missed support | 0.125 | 0.091 |
| Hedged accuracy | 0.750 | 0.864 |
| Hedged false endorsement | 0.062 | 0.000 |
| Attribution accuracy | 0.882 | 1.000 |
| False attribution | 0.091 | 0.000 |
| Figure-directed MRR | 0.792 | 0.944 |
| Revisions repaired | 0.538 | 0.706 |

Alignment transfers. Retrieval does not transfer as well, and the gap grew as the held-out corpus grew: at four papers and 20 queries it was MRR 0.817, against 0.680 at ten papers and 34 queries. Part of that is the corpus, and part is the queries.

**Corpus-wide against within-paper retrieval.** A question is answered across the corpus. A claim is scored against passages retrieved from the work it cites, which is a search within one paper. Scored separately:

| | Corpus-wide Recall@1 | Corpus-wide MRR | Within-paper Recall@1 | Within-paper MRR |
|---|---|---|---|---|
| Tuning | 0.720 | 0.828 | 0.760 | 0.859 |
| Held-out | 0.529 | 0.680 | 0.618 | 0.756 |

Scoping to one paper recovers part of the held-out gap but not all of it, so the loss is not only competition between similar papers. Three of the held-out papers report attention experiments whose method sections are dense with similar durations, and a query naming one of them has many near matches inside its own paper as well as across the corpus.

The practical reading is that alignment, which always searches within the cited work, sits at the better end of this, and that asking a question over a corpus of similar papers is the harder case.

The hedged gap between corpora is a property of the claims rather than of the field. The tuning set's hedged claims turn on quantities stated loosely enough to be arguable, such as a speedup of "roughly an order of magnitude" where the paper reports factors of 3 and 1.5. The held-out hedged claims approximate quantities that are not close to their boundaries, such as a quarter of a million against 250,000. Hedged performance tracks how far an approximation sits from what the paper reports, which is what makes a single hedged figure a poor summary.

Two cautions on those figures. The held-out claims were written by the same person as the tuning claims, so the sets share an author even though they do not share a corpus or a field. And an initial version labelled four claims 1 that stated what a paper is about, which each paper does establish and which is a 2 by this set's own definition. Correcting that changed held-out false endorsement from 0.308 to 0.000. The error was in the labels rather than in the scoring, but it is the kind of error a second annotator would have caught first.

## Comparison to published results

Kiwi's numbers are Recall@k and MRR over 50 span-overlap-matched queries on 5 papers in one field. The results below mostly report nDCG@10 over thousands of queries across 18 heterogeneous domains (BEIR), or come from a different paper's own dataset. These figures are not directly comparable to the ones above; they provide scale and context.

- BM25 baseline, BEIR average: nDCG@10 ≈ 0.434 (Thakur et al., 2021, [arXiv:2104.08663](https://arxiv.org/abs/2104.08663)). BM25 is a strong baseline generally, not one specific to this golden set.
- ColBERTv2 (late-interaction, per-token index): nDCG@10 ≈ 0.500 average on BEIR, about 15% relative over BM25 ([arXiv:2112.01488](https://arxiv.org/pdf/2112.01488)). Closing this gap requires per-token vector storage and higher query cost, which Kiwi's embedded, local-only design does not use.
- [SciRet](https://arxiv.org/abs/2608.03860) (2026) evaluates a similar pipeline (BM25 with BGE-M3 dense retrieval, combined by Reciprocal Rank Fusion) for scientific-paper RAG over CORD-19, and finds hybrid retrieval the most robust configuration, reaching Recall@10 = 1.000, matching the result above. It also finds that a general-purpose cross-encoder reranker trained on MS MARCO reduces precision on scientific text due to domain mismatch.
- Reported gains from hybrid fusion vary by domain: +7.4% NDCG on an e-commerce benchmark (WANDS), up to +40% Recall@10 on scientific code search, and as little as +1.7% NDCG where lexical overlap is already high, such as patent retrieval ([OpenSearch RRF](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/)). Kiwi's hybrid-over-BM25 gain (+1.1% MRR) is at the low end of this range, consistent with BM25 already reaching Recall@10 = 1.000 on this golden set. The hybrid-over-vector-only gain (+24% MRR) is closer to the range reported for hybrid over dense-only retrieval elsewhere (+26 to 31% NDCG in one benchmark).
- [LlamaIndex's default retriever is vector-only](https://docs.llamaindex.ai/en/latest/examples/retrievers/reciprocal_rerank_fusion/); BM25 fusion requires wiring a separate `BM25Retriever` into a `QueryFusionRetriever`. Most framework quickstarts share this default, which is the retrieval mode measured above as trailing BM25 by about 18% MRR.

## Figures and tables

`golden-figures.json` contains 12 pairs asking what a figure or table shows, answered by that component's caption. The captions come from the same five papers.

```bash
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden-figures.json
```

| Set | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---|---|---|---|
| Prose (n=50) | 0.720 | 0.940 | 0.960 | 0.828 |
| Figures (n=12) | 0.750 | 0.917 | 0.917 | 0.833 |

A figure-directed query used to retrieve markedly worse than a prose query, at Recall@1 0.417 and MRR 0.653. Reading the failures showed the correct passage sitting at rank 2 or 3 behind the section that discusses the figure, which matches the same words at greater length.

A question naming a figure or a table now promotes captioned passages ahead of the rest. Recall@1 rises from 0.417 to 0.750 and MRR from 0.653 to 0.833, and prose retrieval is unchanged to three decimal places, on the tuning corpus and the held-out corpus alike.

The trigger vocabulary was measured rather than guessed:

| Trigger | Figures Recall@1 | Figures MRR | Prose Recall@1 | Prose MRR |
|---|---|---|---|---|
| None | 0.417 | 0.653 | 0.720 | 0.828 |
| **figure, fig, table** | **0.750** | **0.833** | **0.720** | **0.828** |
| plus diagram, flowchart, boxplot | 0.833 | 0.875 | 0.700 | 0.818 |
| plus plot, chart, graph | 0.833 | 0.875 | 0.680 | 0.804 |

The wider vocabularies find more figures and cost prose. "graph" is the clearest case: it appears throughout a paper on graph algorithms, so promoting on it reorders questions that have nothing to do with a figure. The short vocabulary is the only one that costs nothing.

Chunking was the first thing tried and neither form of it helped. Giving each caption its own chunk was measured twice and both make figure retrieval worse:

| Chunking | Figures Recall@1 | Figures MRR | Prose MRR |
|---|---|---|---|
| Section-aware | 0.417 | 0.621 | 0.856 |
| Caption chunk added alongside the enclosing chunk | 0.167 | 0.426 | 0.860 |
| Caption chunk with the caption removed from the enclosing chunk | 0.167 | 0.372 | 0.860 |

Removing the duplication makes it worse rather than better, so the cost is not two near-identical candidates competing. A caption retrieves better inside its surrounding prose than on its own. The text around a figure names what the figure shows, and a query about the figure matches that discussion as much as it matches the caption. Isolating the caption discards the context that makes it findable, and the third row also removes the caption from the chunk that was the successful candidate in the first.

Prose is unaffected either way, which is consistent with captions being a small part of the text. The working fix acts on the query rather than the index: the caption stays in the chunk that gives it context, and is promoted only when the question asks for it.

What GROBID labels a figure is also unreliable in this corpus. Equations and stretches of body prose arrive wrapped in `<figure>`, so a caption-targeted measurement partly measures the parser's classification rather than retrieval. The 12 pairs above were written against captions that are genuinely captions.

## SciFact

Every set above was written by one person against papers chosen for this project. SciFact was not: it is an expert-annotated benchmark of scientific claims, and running against it is the check that these figures are not a property of the annotator.

```bash
uv run python eval/_scifact.py --download
uv run python eval/_scifact.py              # alignment
uv run python eval/_scifact.py --retrieval  # corpus-wide retrieval
```

The corpus is 5183 abstracts and the claims 1109, expanding to 1259 claim-citation pairs because a claim may cite more than one work. The labels map onto the evidence scale without reinterpretation: SUPPORT is 2, CONTRADICT is 0, and a cited abstract the annotators found no evidence in is 1.

| | Kiwi's own sets | SciFact |
|---|---|---|
| Claim-citation pairs | 47 and 48 | 1259 |
| Documents | 5 and 10 | 5183 |
| Annotator | this project | domain experts |
| Field | computer science, then five others | biomedicine |

Claims are CC BY 4.0 and abstracts ODC-By 1.0. Neither is redistributed in this repository; `--download` fetches them from the SciFact release.

**Results (n=1259 claim-citation pairs):**

| | Kiwi's sets | SciFact |
|---|---|---|
| Accuracy | 0.872 and 0.917 | 0.860 |
| Contradiction recall | 0.846 and 0.882 | 0.868 |
| Support recall | 0.875 | 0.785 |
| False endorsement | 0.000 | 0.015 |
| Missed support | 0.125 | 0.215 |

Read the SciFact row as the better estimate of what the scoring does on claims it did not have a hand in writing. It is the only set here whose labels this project did not produce.

Choosing the aligner against it changed the figures considerably. Against the model shipped before, the same 1259 pairs scored 0.758 accuracy, 0.691 contradiction recall and 0.089 false endorsement. Both models were measured on the same retrieved passages, so the difference is the entailment model rather than anything around it.

Two things make the comparison imperfect in Kiwi's favour and are worth stating. The cited abstract is given rather than retrieved, so no part of this measures finding the right paper. And each abstract is short enough to be a single chunk, so the passage-selection rules that the smaller sets exercise do not apply: what is measured is the entailment model judging a claim against a whole abstract.

**Corpus-wide retrieval (300 queries over 5183 abstracts):**

| Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| 0.567 | 0.747 | 0.783 | 0.863 | 0.668 |

A hit is a chunk from a document the annotators marked relevant, so this is document-level rather than the span overlap the other golden sets use. The figure sits close to the held-out corpus at Recall@1 0.559 and MRR 0.710, which is the first evidence that the held-out numbers are representative rather than a property of ten papers.

**The weighting does not transfer, and it is not changed.** SciFact wants the opposite of what Kiwi's corpora want. Swept over the same nine settings on both, with the 809 training claims kept separate from the 300 reported here:

| Weighting (vector:text) | SciFact test MRR | SciFact train MRR | Prose tuning MRR | Prose held-out MRR | Figures tuning MRR |
|---|---|---|---|---|---|
| **1:5, shipped** | 0.668 | 0.842 | **0.847** | 0.710 | **0.792** |
| 1:1 | 0.711 | 0.878 | 0.833 | 0.699 | 0.694 |
| 5:1 | **0.716** | **0.887** | 0.830 | 0.666 | 0.637 |

Vector search alone beats every hybrid setting on SciFact, at MRR 0.705 against 0.640 for BM25 alone. On Kiwi's own corpora the shipped hybrid beats both, at 0.847 against 0.818 and 0.808.

The two are measuring different tasks. A SciFact query is a claim matched against an abstract, where the wording need not be shared and semantic similarity carries the match. A Kiwi query is a question about a paper the reader already has, naming a method, a metric, or an identifier that appears verbatim in the passage that answers it. Reweighting toward vector search would gain 0.048 MRR on SciFact and cost up to 0.155 on figure-directed retrieval, which is a shipped feature. The weighting stays where the corpora Kiwi is for put it, and the SciFact figure is the honest cost of that choice on a task of a different shape.

**Support confidence.** The threshold requiring 0.70 of the probability mass on entailment was chosen against 47 claims. Swept against 919 SciFact training pairs it trades as designed, and the shipped value sits reasonably:

| Threshold | Accuracy | False endorsement | Missed support |
|---|---|---|---|
| 0.50 | 0.758 | 0.111 | 0.257 |
| 0.60 | 0.758 | 0.098 | 0.265 |
| **0.70** | **0.751** | **0.091** | **0.289** |
| 0.80 | 0.749 | 0.084 | 0.300 |
| 0.90 | 0.734 | 0.073 | 0.346 |

Accuracy peaks half a point higher at 0.50 to 0.60, at a cost in false endorsement. The shipped value is kept because a claim wrongly reported as supported reaches the reader unmarked and a claim wrongly reported as unestablished does not.

**Aligner model.** Four models were compared on 250 training pairs, on identical retrieved passages:

| Model | Accuracy | Contradiction recall | Support recall | False endorsement |
|---|---|---|---|---|
| `DeBERTa-v3-large-mnli-fever-anli-ling-wanli` | 0.768 | 0.615 | 0.742 | 0.096 |
| `ModernBERT-large-nli` | 0.792 | 0.846 | 0.602 | 0.000 |
| **`finecat-nli-l`** | **0.876** | **0.846** | **0.785** | **0.013** |
| `ModernCE-large-nli` | 0.060 | 0.115 | 0.000 | 0.287 |

`finecat-nli-l` wins on every figure. `ModernCE-large-nli` declares the same three labels as the others and scores near zero against them, which is what a model whose head order does not match its declared labels looks like; it is not used.

Confirmed on the 340 development pairs, which took no part in the choice: accuracy 0.776 to 0.818 and false endorsement 0.084 to 0.030.

**Attribution keeps the earlier model.** `finecat-nli-l` reads evidence better and attribution worse. On the 17 attribution pairs it scores 0.706 against 0.941, with false attribution rising from 0.000 to 0.091, and the held-out attribution set moves the same way. Both were measured before the restatement was added, so they compare the two models on the same footing rather than stating the shipped figure. The two scales ask different questions and are measured separately, so each uses the model measured better for it. A reader who names a model through `KIWI_ALIGNER_MODEL` gets that model for both.

**Sentence-level scoring.** SciFact makes it possible to ask whether a passage should be scored whole or sentence by sentence, which 47 claims could not settle. Scored sentence by sentence with the same selection rule, on 919 training pairs:

| | Accuracy | Contradiction recall | Support recall | False endorsement |
|---|---|---|---|---|
| Whole passage | 0.751 | 0.706 | 0.711 | 0.091 |
| Sentence level | 0.493 | 0.902 | 0.054 | 0.005 |

Sentence-level scoring finds contradictions far better and loses support almost entirely, because the rule requiring the highest-ranked unit to agree assumes a ranking, and sentences inside a passage are not ranked by relevance.

Keeping whole-passage scoring and consulting sentences only for outright contradiction is a real trade rather than a strict gain. Chosen on the 919 training pairs and reported on the 340 development pairs, which were not used to choose it:

| Development set (n=340) | Accuracy | Contradiction recall | Support recall | False endorsement |
|---|---|---|---|---|
| Whole passage, as shipped | 0.776 | 0.648 | 0.732 | 0.084 |
| Plus sentence refutation at 0.95 | 0.759 | 0.803 | 0.667 | 0.054 |
| Plus sentence refutation at 0.70 | 0.735 | 0.901 | 0.630 | 0.045 |

It buys contradiction recall and lower false endorsement, and costs overall accuracy and support recall. It is not shipped, because it changes what a reader is told often enough to be a decision about the product rather than a tuning step: more claims are reported as unestablished, some of them wrongly.

Both rows above were measured with the earlier aligner. The model now shipped reaches 0.868 contradiction recall and 0.015 false endorsement on the full set without any sentence-level rule, which is better than the hybrid achieved, so the trade is no longer worth making.

## Alignment set

`alignment.json` contains 47 claim-citation pairs written against the same five papers. Each pair records the score a reader would assign to the claim given the cited work: 2 where the paper supports it, 1 where the paper is relevant but does not establish it, and 0 where the paper is inconsistent with it. Claims are authored rather than quoted, so a supporting claim paraphrases a real passage and an inconsistent claim negates one.

```bash
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment.json
```

**Results (n=47):**

| | Accuracy | Recall 2 | Recall 1 | Recall 0 | False endorsement | Missed support |
|---|---|---|---|---|---|---|
| `finecat-nli-l` (accelerator) | 0.872 | 0.875 | 0.900 | 0.846 | 0.000 | 0.125 |
| `DeBERTa-v3-base-mnli-fever-anli` (CPU) | 0.809 | 0.875 | 0.800 | 0.692 | 0.000 | 0.125 |
| `DeBERTa-v3-base-mnli-fever-anli-scifact-citint` | 0.787 | 0.875 | 0.800 | 0.615 | 0.043 | 0.125 |

The first row is measured at the shipped settings. The other two were measured at 512 and are not re-run here, so they compare models rather than targets.

A score of 2 is displayed without a warning, so an unsupported claim scored 2 reaches the reader unmarked. No model that produces one is used.

## Passage selection

Five passages are retrieved per claim from the cited document. The one scored is the passage the model is least neutral about, and a score of 2 additionally requires the highest-ranked passage to agree.

Both halves of that rule were measured. The alternatives, on the same 47 pairs, under the settings in place at the time:

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

Six targets were swept against the golden set, section-aware chunking, on the same five papers. Measured under the earlier embedder and a 3:1 weighting, so the column values are comparable with each other and not with the results above:

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

Measured on both sets at deep depth, under the settings in place at the time:

| Model | Threshold | Direct acc | Direct recall 0 | Hedged acc | False endorsements (of 39) | Contradictions caught (of 20) |
|---|---|---|---|---|---|---|
| base | none | 0.809 | 0.692 | 0.667 | 2 | 14 |
| base | 0.70 | 0.787 | 0.692 | 0.667 | 1 | 14 |
| large | none | 0.872 | 0.923 | 0.625 | 4 | 16 |
| **large** | **0.70** | **0.851** | **0.923** | 0.583 | **2** | **16** |

The shipped pairing matches the base model on overall accuracy and on false endorsement while catching sixteen of the twenty contradictions rather than fourteen. Two other models are unusable on this set: `deberta-v3-large-zeroshot-v2.0` never predicts contradiction, giving recall 0.000 on label 0, and `SCIFACT_xlm_roberta_large` predicts label 1 for every pair.

## Embedding model

`BAAI/bge-large-en-v1.5` is the default. Against `nomic-embed-text-v1.5` on the same corpora:

| | Tuning vector MRR | Held-out vector MRR | Tuning hybrid MRR | Held-out hybrid MRR |
|---|---|---|---|---|
| `nomic-embed-text-v1.5` | 0.664 | 0.583 | 0.837 | 0.704 |
| `bge-large-en-v1.5` | 0.808 | 0.645 | 0.847 | 0.710 |

The vector path is where the difference is large. Through a BM25-weighted fusion most of it is absorbed, which is why an earlier measurement against one corpus read the change as noise and rejected it. Measured against two corpora it is consistent, and it is what makes hybrid retrieval worth its cost at all.

It costs five times the model size and produces vectors of a different width. Stored vectors carry the width of the model that produced them, so a project indexed under a different embedder must be re-indexed after deleting `.kiwi/`. `KIWI_EMBED_MODEL` selects another.

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

Two things happen before a claim is scored on this scale.

**The novelty filter.** Attribution is judged only against passages in which the cited authors claim authorship of something, matched on phrases such as "we propose", "in this paper", and "our approach". A passage describing a method in use entails a claim about that method, which is how a work gets credited for something it applied rather than originated.

Measured on the tuning set before the restatement below was added, so the two columns isolate the filter:

| | With the novelty filter | Without it |
|---|---|---|
| Accuracy | 0.941 | 0.824 |
| Correctly credited (1 scored 1) | 5 of 6 | 5 of 6 |
| Wrongly credited (0 scored 1) | 0 of 11 | 2 of 11, a rate of 0.182 |
| Missed credit (1 scored 0) | 1 of 6, a rate of 0.167 | 1 of 6, a rate of 0.167 |

Both wrong credits are removed and no correct credit is lost. Where no retrieved passage claims authorship of anything, the claim scores 0 and the highest-ranked passage is still reported, so the score stays checkable.

**The restatement.** An attribution claim names the cited work from outside it, as "the cited authors" or "this work". No passage uses that phrasing about itself, so the model has nothing to bind the referent to. Every origination missed on either corpus failed exactly this way, and none failed at the filter: a passage in which the authors plainly describe developing the thing scored neutral at a probability of 1.00. The claim is restated as the sentence those authors would have written, which leaves the model the question that matters, whether the work they claim is the one the claim names.

```
The empirical model of UK cat population dynamics was developed by the cited authors.
In this paper, we develop the empirical model of UK cat population dynamics.
```

A claim about priority is left as written. "Breadth-first search was first described in the cited work" says who was first; restated as "we describe breadth-first search" it becomes a claim that every paper mentioning the thing satisfies, and three works were credited wrongly that way, one on the tuning set and two on the held-out set. Blocking on the priority marker rather than on the verb is what fixes those without giving up the rest:

| Rule | Choose split | | Confirm split | |
|---|---|---|---|---|
| | Derived A false attribution | Tuning | Derived B false attribution | Held-out |
| Restate only origination verbs | 0.172 | 0.091 | 0.121 | 0.000 |
| **Restate all, priority left alone** | **0.103** | **0.091** | **0.052** | **0.000** |

Excluding description verbs outright also fixes the priority cases, and costs more: "described by the cited authors" without a priority marker restates cleanly, and refusing to restate it leaves those claims scored as written, which is where most of the remaining wrong credits were. The derived set was split by claim, alternately, so corpus order does not fall on one side.

**Requiring the contribution sentence to agree was measured and is not taken.** The rule scores a whole passage. Judging the sentence in which the authors claim authorship, and crediting a work only where both agree, removes almost every wrong credit from the derived set and takes most of the right ones with it:

| Set | Rule | Recall | False attribution |
|---|---|---|---|
| Derived A | Shipped | 0.448 | 0.103 |
| Derived A | Plus the sentence | 0.276 | 0.017 |
| Derived B | Shipped | 0.621 | 0.052 |
| Derived B | Plus the sentence | 0.362 | 0.000 |
| Held-out | Shipped | **1.000** | 0.000 |
| Held-out | Plus the sentence | 0.250 | 0.000 |

The held-out row decides it. On claims a reader wrote, the shipped rule already credits every genuine origination and credits nothing wrongly, and the sentence check throws three of four away for nothing. It helps only where a passage is long and the contribution sentence is what separates two readings of it, which is the derived set's shape rather than a reader's. It also leaves the one wrong credit on the tuning set exactly where it was, because that claim's contribution sentence genuinely does propose an ECC-based scheme.

Raising the confidence bar for this scale was measured at the same time and is not taken. At 0.80 it improved the choose split, gained nothing on the confirm split, and cost held-out recall of genuine originations, from 1.000 to 0.750. A claim the pattern does not recognise is scored as written.

The supporting score on this scale is 1, not 2, so the metrics take the supporting value as a parameter. Reporting attribution against the evidence scale gives a false endorsement rate of zero, because a score of 2 never occurs there.

The two claims the filter fixes are the same mistake: crediting a paper for a method it applies. `Brandes' algorithm for betweenness centrality was introduced by the cited authors` and `The Dolev-Yao threat model was introduced in the cited work` both scored 1 without it, because passages describing a method in use entail a claim about that method.

`attribution-heldout.json` holds 14 further pairs written against the held-out corpus, ten of them naming something the cited paper uses but did not introduce. Measured with the filter in place, the restatement is what recovers the missed originations:

| | Tuning (n=17) | | Held-out (n=14) | |
|---|---|---|---|---|
| | Scored as written | Restated | Scored as written | Restated |
| Accuracy | 0.941 | 0.882 | 0.857 | **1.000** |
| Recall of originations | 0.833 | 0.833 | 0.500 | **1.000** |
| False attribution | 0.000 | 0.091 | 0.000 | 0.000 |

Steering retrieval toward novelty language was measured and changes nothing: appending "we propose introduce present develop this paper contribution" to the retrieval query leaves every figure identical on both corpora. The passages are already retrieved, which is why the restatement and not retrieval is what moved recall.

The one claim the restatement now credits wrongly is a difference of grain rather than of voice. The cited paper proposes an ECC-based authentication scheme, and `Elliptic curve cryptography was invented by the cited authors` restates to a claim about ECC itself, which its contribution sentence entails. Fixing that case alone would be fitting to one pair, so it is left as it is.

### A larger attribution set

Both sets above hold 21 negatives between them, which is too few to tell whether a change that makes entailment easier also credits the wrong paper more often. `_scifact.py --attribution` derives a larger one from the SciFact corpus, taking each claim from the abstract that introduced the thing and pairing it both with that abstract and with the highest-ranked other abstract that also claims authorship of something, so the negative reaches the entailment step rather than being turned away by the filter.

```bash
uv run python eval/_scifact.py --attribution
```

| Derived set (n=232, 116 negatives) | Scored as written | Restated |
|---|---|---|
| Accuracy | 0.647 | **0.728** |
| Recall of originations | 0.509 | **0.534** |
| False attribution | 0.216 | **0.078** |

A claim's origin here is recorded rather than judged, so the labels are not this project's reading. A positive shares wording with the passage it was derived from, so recall on this set is an upper bound and not an estimate; the negatives are what it measures well.

This corrects something the two small sets reported. False attribution is not 0.000. Against 116 works that did not originate what the claim names, one in five was credited before the restatement and one in thirteen after. The earlier figure said only that the 21 negatives written for this project were ones the aligner already handled.

A score of 1 on this scale is therefore never displayed silently. The web interface marks it approximate and gives it the same emphasis as a claim the evidence does not establish, and `kiwi align` prints a caution when any claim was scored on it. Recall of genuine originations is 0.534 on the derived set, so a claim scored 0 here is weaker evidence of anything than a claim scored 1.

The novelty vocabulary was checked against the held-out papers before measuring and fires in all four, including phrases such as "This study introduces" and "our model" that the tuning corpus does not use.

A score of 1 on the attribution scale is displayed without a warning. Set the intent by hand and read the evidence passage before relying on the score.

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

```bash
KIWI_GENERATOR_MODEL=ollama/qwen2.5:7b-instruct   uv run kiwi evaluate-revisions eval/workspace.kiwi --labelled eval/alignment.json
```

**Results (n=13, `qwen2.5:7b-instruct` through Ollama):**

| Outcome | Tuning (n=13) | Held-out (n=17) |
|---|---|---|
| Repaired | 0.538 | 0.706 |
| Hedged | 0.385 | 0.235 |
| Unrepaired | 0.000 | 0.059 |
| Only negated | 0.077 | 0.000 |
| Assertion dropped | 0.000 | 0.000 |

The model is a local one, chosen so the figure can be reproduced without an API key. A larger hosted model will do better, so read 0.538 as a floor rather than as the quality of the feature. `KIWI_GENERATOR_MODEL` measures any other.

Sampling is off. The Generator runs at temperature 0 unless `KIWI_GENERATOR_TEMPERATURE` raises it, so the run above repeats. It was not always so: measured at the provider's default temperature the repaired share held at 0.538 while the rest of the distribution moved between runs, hedged reading 0.231 on one and 0.385 on another. A figure that moves is not a measurement, and 13 claims are too few to average it away.

Reading the rewrites changes what the numbers mean, in two directions.

**The repaired share understates the repair rate.** Most rewrites in the hedged bucket are not hedges. They are precise factual corrections that the aligner scored 1 rather than 2:

| Claim | Rewrite | Scored |
|---|---|---|
| The constructed graph contains fewer than one thousand nodes. | The constructed graph consists of 70554 nodes. | 1 |
| The smart contracts were written in Rust. | The smart contracts were written using the Solidity programming language. | 1 |
| The virtual machine ran Ubuntu Linux. | The virtual machine ran Windows Server 2012. | 1 |

Recall on label 1 is 0.700 and on label 2 is 0.917, so the aligner scores a supported claim as merely relevant often enough to account for this. The judge is the limit here, not the rewriter.

**Negation is counted apart from repair.** Reversing a claim satisfies the evidence without saying anything, and scores 2:

| Claim | Rewrite | Scored |
|---|---|---|
| The experiments were run on a GPU cluster. | The experiments were not run on a GPU cluster. | 2 |

One rewrite of the thirteen is a negation, and it is reported on its own rather than as a repair. The guard fires when a negating word is the entire difference between claim and rewrite. A negation carried by an inflected verb, such as "exceeded" becoming "did not exceed", is not detected: a rule loose enough to catch it counts real corrections as negations.

Both effects sit inside one 13-claim set, so neither is quantified. What the numbers establish is that the mechanism works end to end against a local model, that rewrites are rarely left contradicted, and that no rewrite dropped its assertion.

Read against the shape of the whole set: of thirteen contradicted claims, one is left contradicted, one is merely reversed, five are corrected in a way the aligner scores as support, and five are corrected in a way it scores as relevant. Nothing is deleted.

**Held-out.** The same measurement over the claims labelled 0 in the held-out sets:

| Set | n | Repaired | Hedged | Unrepaired | Negated | Dropped |
|---|---|---|---|---|---|---|
| Tuning, direct | 13 | 0.538 | 0.231 | 0.154 | 0.077 | 0.000 |
| Held-out, direct | 17 | 0.647 | 0.235 | 0.118 | 0.000 | 0.000 |

Repair is higher outside the tuning corpus, which matches what the hedged sets show: the tuning claims turn on quantities close to their boundaries and are harder to correct into something the aligner scores as supported.

## Generated answers

`kiwi ask` synthesises an answer from the retrieved passages when a Generator is configured. What matters is not whether the answer reads well but whether a reader can check it, so three things are counted, over the answer's sentences and list items:

- **uncited**, asserting something and citing nothing, so there is nothing to check it against
- **ungrounded**, citing a passage that does not support it, judged by the same Aligner that scores claims
- **dangling**, a bracketed number naming a passage that was never supplied

```bash
KIWI_GENERATOR_MODEL=ollama/qwen2.5:7b-instruct \
    uv run python eval/_answers.py --project eval/workspace.kiwi --golden eval/golden.json
```

**Results (`qwen2.5:7b-instruct` through Ollama, 5 passages per question):**

| | Tuning (50 questions, 80 units) | Held-out (34 questions, 50 units) |
|---|---|---|
| Grounded | 0.625 | 0.620 |
| Uncited | 0.375 | 0.320 |
| Ungrounded | 0.000 | 0.060 |
| Contradicted by the passage it cites | 0.000 | 0.000 |
| Dangling references | 0 | 0 |

Nothing is contradicted by the passage it cites, on either corpus. That is the error that would matter most, and the model does not make it here.

Uncited is the weak figure. About a third of what an answer asserts carries no reference, which is a third a reader cannot check without reading the passages themselves. The panel shows the retrieved passages alongside the answer, so the material is there; the answer does not point at it.

**Every list item carries its own reference.** The prompt originally asked for a reference on every sentence, and the model read a bulleted list as exempt, citing the line introducing it and then enumerating beneath. Asking for one per item as well:

| Set | Prompt | Grounded | Uncited | Ungrounded |
|---|---|---|---|---|
| Tuning | Sentences only | 0.580 | 0.386 | 0.034 |
| Tuning | **Every list item** | **0.625** | **0.375** | **0.000** |
| Held-out | Sentences only | 0.600 | 0.345 | 0.055 |
| Held-out | **Every list item** | **0.620** | **0.320** | 0.060 |

The gain is small and it holds on both corpora, on grounded and on uncited alike. It is not a fix for the uncited share, which stays about a third either way.

**A reference to a passage that was never supplied is removed from the answer.** The citation list already dropped those, so the text used to show a bracket with nothing behind it: 11 of them across the 50 tuning questions. Removing them from the text as well takes that to zero and leaves the numbering alone, because the references that do resolve still name the same passages.

## Limitations

- 50 pairs is a first pass on one field (computer science) and five papers. Treat differences smaller than a few points as noise.
- Each paper is represented by exactly 10 pairs regardless of its length or complexity, so a chunker or retrieval-mode effect specific to one paper's structure could be masked or exaggerated by its other nine pairs.
- The 5:1 hybrid weight was chosen by measuring against this golden set and the held-out one. It does not transfer: SciFact prefers the opposite weighting, and vector search alone beats every hybrid setting there. It should be re-checked as the golden set grows or a second field is added.
- The Generator figures, both answers and revisions, come from one local model and need a Generator to reproduce. A larger hosted model will do better, so read them as a floor.
- Groundedness is judged by the Aligner, which is also what scores claims. An answer sentence the Aligner misreads is counted the same way a claim it misreads is, so the answer figures inherit the alignment figures' error.
- The uncited share counts a sentence or list item with no bracketed reference. Some are framing rather than assertion, so it is an upper bound on what a reader cannot check.
- The figure sets have 12 and 9 pairs, and their queries were written against captions already known to be well formed. They measure whether a well-formed caption is findable, not how often a caption is well formed.
- Every label in every set was written by one person. The held-out sets share that author with the tuning sets even though they share no corpus, no field, and no paper. An early version of the held-out alignment set labelled four claims 1 that each paper establishes, which reported false endorsement as 0.308 until the labels were corrected.
- The held-out corpus grew from four papers to ten during measurement. Retrieval figures fell as it grew, from MRR 0.817 to 0.680, so a figure from a small corpus should not be read as a figure about the system.
- The alignment set has 47 pairs across one field, and its claims are authored rather than drawn from published citing sentences. Contradiction recall in particular rests on 13 pairs.
- Alignment is measured against the retrieved passages rather than the whole cited document.
- The alignment claims and their labels were written by one person, so the figures measure agreement with a single reader rather than with a consensus.
- The figures on direct claims do not carry over to hedged prose. On `alignment-hedged.json` accuracy falls to 0.750 and false endorsement rises from 0.000 to 0.062. Quantitative claims stated approximately are the weak case. Read 0.000 false endorsement as a property of direct claims, not of the aligner.
- The attribution sets written for this project hold 21 negatives between them and reported false attribution as 0.000. Against 116 negatives derived from SciFact the rate is 0.078. A figure from 21 negatives could not have shown that, and the same caution applies to every other rate here resting on a dozen or so pairs.
- The derived attribution set takes each claim from the abstract that introduced the thing, so a positive shares wording with the passage it is scored against. Its recall figure is an upper bound. Its negatives are sound: a sample was read and none had originated what the claim names.
- The anchor figures come from two parsers that differ in what they keep, not from two versions of the same parser. An upgrade within GROBID would move the text less than this, so 0.941 is a floor rather than the expected rate.
- The reranking figures come from one model. Two others were measured and both make retrieval worse on the SciFact test split than no reranking at all, so "reranking helps" is not a safe generalisation: `BAAI/bge-reranker-v2-m3` helps, and a reranker chosen without measuring may not.
- Reranking was measured on retrieval and on alignment, not on latency. It adds one model pass per candidate, twenty per query by default, on top of the embedder.
- Attribution recall is the weakest figure that ships. It reaches 1.000 on the held-out set and 0.534 on the derived one, where a positive is a machine-derived sentence rather than a claim a reader wrote.
