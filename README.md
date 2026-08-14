# Kiwi

Kiwi is an open source workspace for retrieval-augmented generation over research papers. Every generated claim is traceable to a passage in a source document, and every component in the pipeline, including the interface, can be replaced or omitted.

## Features

- Structure-preserving PDF ingestion through GROBID: section hierarchy, figures, tables, and a parsed reference list.
- Section-aware chunking and corpus-wide retrieval. BM25 keyword search runs with no configuration; hybrid BM25 and vector search is used automatically once an embedding model is configured.
- Citation-checked answers generated from retrieved passages, using an optional language model.
- Reference verification against Crossref: existence, metadata consistency, and retraction status.
- Claim alignment scoring: each cited sentence in a draft is scored against the passage it cites, so a citation that resolves but does not support the claim is surfaced.
- Highlights and notes on any passage of a paper, stored in the workspace and never written into the source PDF, with a selected passage citable straight into a draft.
- Suggested revisions for claims their citation does not support, applied only when accepted and recorded either way.
- Roles, nested permissions, and a review page where a reviewer judges each claim against the passage it cites, with every decision recorded.
- A local web interface for browsing papers, writing notes, and drafting documents with inline citations.
- A command line interface and an HTTP API exposing the same functionality as the web interface.

## Install

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12 (uv installs the interpreter), and [Docker](https://www.docker.com/) to run GROBID.

```bash
git clone https://github.com/jeffreyjiawendeng/Kiwi.git
cd Kiwi
uv sync --all-extras --dev
```

`--all-extras` installs the optional embedding, generation, and alignment dependencies. Running `uv sync --dev` without it installs ingestion, chunking, BM25 retrieval, reference verification, and the web interface, with no model download and no API key required.

Start GROBID:

```bash
docker run --rm -p 8070:8070 -e JAVA_TOOL_OPTIONS=-XX:-UseContainerSupport lfoppiano/grobid:0.8.1
```

`JAVA_TOOL_OPTIONS` is required on Docker 29 and later. Without it the container exits on startup with a `CgroupInfo.getMountPoint()` null pointer, because the bundled JDK cannot read the newer runtime's cgroup layout.

### GPU

Embedding and claim alignment run on a GPU when one is present and fall back to the CPU when it is not. Retrieval returns the same results either way. Claim alignment uses a larger model where an accelerator is present, so its scores differ between the two.

PyPI ships a CPU-only build of torch on some platforms. Install a matching CUDA build to use an NVIDIA card:

```bash
uv pip install torch --index-url https://download.pytorch.org/whl/cu129
```

Pick the index that matches the card: `cu129` or `cu128` for Blackwell (RTX 50 series), `cu126` for older cards. Apple silicon uses Metal through the stock build and needs no extra step. Running `uv sync` reinstalls the CPU build, so repeat this command afterwards.

`kiwi health` reports the device in use and the model loaded on it.

## Usage

```bash
uv run kiwi ingest path/to/papers/ --project MyProject.kiwi
uv run kiwi index MyProject.kiwi
uv run kiwi verify MyProject.kiwi
uv run kiwi serve
```

`kiwi serve` opens `http://127.0.0.1:8000/app/` in the browser. Open `MyProject.kiwi`, or any project folder, and browse Papers, Notes, and Drafts, or ask a question through the Ask view.

Every operation is also reachable directly over HTTP:

```bash
curl -X POST http://127.0.0.1:8000/projects -H "Content-Type: application/json" \
     -d '{"path": "MyProject.kiwi", "name": "My Project"}'
curl "http://127.0.0.1:8000/projects/summary?project=MyProject.kiwi"
curl -X PUT http://127.0.0.1:8000/notes/reading-log.md -H "Content-Type: application/json" \
     -d '{"project": "MyProject.kiwi", "content": "Some notes.", "visibility": "private"}'
```

`kiwi serve --no-open-browser` skips the automatic browser launch.

## Configuration

Kiwi is configured through environment variables. None are required; each has a default, or turns off a feature and leaves the rest working.

| Variable | Effect |
|---|---|
| `KIWI_GROBID_URL` | GROBID base URL. Defaults to `http://localhost:8070`. |
| `KIWI_NO_EMBED` | Disables the embedding model. Retrieval falls back to BM25 keyword search. |
| `KIWI_GENERATOR_MODEL` | A LiteLLM model string. Enables generated answers; unset, `kiwi ask` returns ranked passages instead. |
| `KIWI_CONTACT_EMAIL` | Contact email sent with Crossref requests, for its polite request pool. |
| `KIWI_NO_VERIFY` | Disables reference verification. |
| `KIWI_ALIGNER_MODEL` | Sequence classification model used for claim alignment. Defaults to `MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli` with an accelerator and the base model of the same family on a CPU. |
| `KIWI_EMBED_MODEL` | Embedding model. Defaults to `nomic-ai/nomic-embed-text-v1.5`. Changing it requires deleting `.kiwi/` and re-indexing, because stored vectors carry the width of the model that produced them. |
| `KIWI_INTENT_MODEL` | Citation intent classifier labelled `background`, `method`, and `result`. Unset, every claim is treated as evidence and scored. |
| `KIWI_NO_ALIGN` | Disables claim alignment. |
| `KIWI_CHUNK_TOKENS` | Chunk size target. Defaults to 768. Changing it requires deleting `.kiwi/` and re-indexing, because chunk boundaries move with it. A project indexed under an earlier default keeps its existing chunks until it is re-indexed. |
| `KIWI_DEVICE` | Device models run on: `auto` (default), `cuda`, `mps`, or `cpu`. A device that is named but unavailable falls back to the CPU. |
| `KIWI_AUTHOR` | Identity that operations are recorded against and permissions are checked for. Defaults to `local`. |
| `KIWI_DATA_DIR` | Overrides where the known-projects registry is stored. |

## Command line interface

| Command | Description |
|---|---|
| `kiwi ingest PATH [--project PATH]` | Parses a PDF, or every PDF in a directory, into structured sections and references. |
| `kiwi index PROJECT [--doc ID]` | Chunks and indexes papers so they can be queried. |
| `kiwi verify PROJECT [--doc ID]` | Resolves extracted references against Crossref. |
| `kiwi ask PROJECT QUESTION [--doc ID] [--k N]` | Queries indexed papers and returns ranked passages or a generated answer. |
| `kiwi align PROJECT DRAFT [--deep]` | Scores each cited sentence in a draft against the work it cites. `--deep` splits compound claims and scores each assertion separately. |
| `kiwi review PROJECT DRAFT [--actor NAME]` | Shows each cited sentence as a reviewer sees it, with the roles still to approve. |
| `kiwi decide PROJECT DRAFT CLAIM CITATION DECISION --reviewer NAME` | Records a review decision on one claim. |
| `kiwi members PROJECT` | Shows the owner, members, successors, and required reviews. |
| `kiwi process-record PROJECT DRAFT` | Shows what was proposed, declined, and decided. |
| `kiwi annotate PROJECT DOC PASSAGE [--note TEXT]` | Marks a passage in a paper. Records a note when `--note` is given, otherwise a highlight. |
| `kiwi annotations PROJECT DOC [--author NAME]` | Lists the annotations recorded on a paper. |
| `kiwi suggest PROJECT DRAFT` | Proposes a revision for each claim its citation does not support. |
| `kiwi suggestions PROJECT DRAFT [--state S]` | Lists the suggestions recorded for a draft. |
| `kiwi accept PROJECT DRAFT ID` | Applies a pending suggestion to the draft. |
| `kiwi reject PROJECT DRAFT ID` | Records a pending suggestion as rejected. |
| `kiwi health` | Reports the configured components, the device models run on, and whether GROBID is reachable. |
| `kiwi evaluate PROJECT [--golden PATH]` | Measures retrieval quality against a golden query set. |
| `kiwi evaluate-alignment PROJECT [--labelled PATH]` | Measures alignment scoring against a labelled claim set. |
| `kiwi evaluate-revisions PROJECT [--labelled PATH]` | Measures whether suggested rewrites repair the claims flagged as unsupported. |
| `kiwi serve [--host HOST] [--port PORT]` | Runs the HTTP API and the web interface. |

Run `kiwi COMMAND --help` for the full option list of any command.

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service status and version. |
| GET | `/health/ingestor` | Whether the configured GROBID service is reachable. |
| GET | `/projects` | Known projects, most recently opened first. |
| POST | `/projects` | Opens or creates a project and registers it. |
| GET | `/projects/summary` | Papers, notes, and drafts for a project. |
| POST | `/ingest` | Parses an uploaded PDF into a project. |
| POST | `/index` | Chunks and indexes papers. |
| POST | `/verify` | Resolves extracted references against Crossref. |
| POST | `/ask` | Queries indexed papers. |
| POST | `/align` | Scores each cited sentence in a draft. `depth` is `quick` or `deep`. |
| GET | `/align/{path}` | Claims recorded for a draft, at both depths. |
| PUT | `/align/intent` | Overrides the detected intent for one claim. |
| GET | `/review/{path}` | Each cited sentence as a reviewer sees it, with blocking roles. |
| POST | `/review/decision` | Records a review decision on one claim. |
| POST | `/review/propose` | Attaches a suggestion to a claim on a person's behalf. |
| GET | `/process-record/{path}` | What was proposed, declined, and decided. |
| GET | `/projects/settings` | Roles, members, ownership, and required reviews. |
| PUT | `/projects/members` | Adds a member or changes the role assigned to one. |
| GET | `/annotations/{document_id}` | Annotations on a paper, optionally narrowed to one author. |
| POST | `/annotations` | Records a highlight or a note over a passage. |
| DELETE | `/annotations/{document_id}/{id}` | Deletes one annotation. |
| POST | `/drafts/cite` | Appends a citation to a draft, quoting the passage where given. |
| POST | `/suggest` | Proposes a revision for each claim its citation does not support. |
| GET | `/suggestions/{path}` | Suggestions recorded for a draft, whatever their state. |
| POST | `/suggestions/accept` | Applies a pending suggestion to the draft. |
| POST | `/suggestions/reject` | Records a pending suggestion as rejected. |
| GET | `/papers/{document_id}` | A previously ingested paper, with sections and references. |
| GET | `/papers/{document_id}/verification` | The last verification result for a paper. |
| GET, PUT | `/notes/{path}` | Reads or writes a note. |
| GET, PUT | `/drafts/{path}` | Reads or writes a draft. |
| GET | `/app` | The bundled web interface. |

## Public interface

The following surfaces carry a compatibility promise under semantic versioning. A change to any of them is a major version increment.

- Component interfaces defined in `kiwi.protocols`: Ingestor, Chunker, Embedder, Store, Retriever, Generator, Resolver, Aligner.
- The workspace data format on disk.
- The configuration schema listed above.
- The command line interface: command names, options, and output format.
- The HTTP API: endpoint paths, request and response schemas.

Internal module layout, prompt templates, and anything under an `_internal` namespace are not covered and may change at any version.

## Architecture

Kiwi is a set of substitutable components behind stable interfaces. The CLI, the HTTP API, and the web interface are three consumers of the same core.

| Component | Implementation |
|---|---|
| Ingestor | GROBID |
| Chunker | Section-aware: splits along the document's own section boundaries, packing sentence-by-sentence within sections that exceed the token budget |
| Store | LanceDB, embedded, with native BM25 search |
| Embedder | sentence-transformers, `nomic-embed-text-v1.5` by default; optional |
| Retriever | BM25 keyword search, or hybrid BM25 and vector search fused by weighted Reciprocal Rank Fusion when an Embedder is configured |
| Generator | LiteLLM; optional |
| Resolver | Crossref: identifier resolution, metadata, retraction status |
| Aligner | Local NLI model scoring a claim against the passage it cites; optional |
| Interface | A local web UI at `/app`, plain HTML, CSS, and JavaScript with no build step, served by the same process as the API |

In the Drafts view, **Check claims** scores every cited sentence and **Check in depth** splits compound claims into their assertions. Each score is shown with the passage it was computed from, so the score can be checked against what was read. A score of 2 is reported without emphasis, a claim the cited work does not establish is stated plainly, and an unsupported claim is flagged. Where the two depths disagree both are shown, and a deep result whose claim has since been edited is marked stale rather than dropped. Citation intent can be set by hand per claim and the setting persists.

On a paper's page, selecting a passage offers Highlight, Note, Copy, Copy citation, and Cite in draft. Annotations carry colour, author, and timestamp, and the panel filters by author. They are stored in `papers/<doc_id>/annotations.json` and carry the same anchor used for citation targets, so they relocate with their passage when a paper is parsed again. The source PDF is never modified.

**Suggest edits** proposes a revision for each claim scored 0, against the evidence passage the score was computed from. A suggestion changes nothing while pending: it is accepted or rejected as written, and both outcomes are recorded beside the draft. Accepting applies the proposed text and reloads the editor. The span is re-resolved against the current draft when the change is applied, so a suggestion survives edits made elsewhere in the document. Suggestions require a Generator, so `KIWI_GENERATOR_MODEL` must be set.

## Roles and review

A project's roles, members, ownership, and succession live in `project.json`. A project without that file has one owner holding every permission, so a workspace used by one person behaves as it did before roles existed.

Roles are strictly nested: each holds every permission of the role beneath it, so access reads off rank without consulting a matrix. The default ladder runs Viewer, Commenter, Reviewer, Contributor, Maintainer, Owner. A role may be inserted at any rank, validated as a superset of the role below and a subset of the one above.

| Rule | Behavior |
|---|---|
| A member with no assigned role | No access. Not Viewer. |
| Reviewer's position | Below Contributor, so a reviewer records judgements without gaining the ability to edit. |
| An unshared note | No role, including Owner, reads a note its author has not shared. |
| The process record | Reading a draft and reading everything proposed and declined on it are separate permissions. |
| Ownership | Transferable, with designated successors who may claim a project whose owner is unreachable. A project always has exactly one owner. |
| Review | Advisory unless the owner names roles in `required_reviews`, which then block until each approves. |

The review page shows, per claim: the cited source and its status, the detected intent, the score with the evidence passage it was computed from, and staleness. Scores are inputs to a judgement rather than a verdict.

Identity is recorded rather than authenticated. A workspace is a folder, so these checks constrain what the application does, not what the filesystem allows.

## Retrieval evaluation

Retrieval quality is measured against a golden set of 50 hand-verified query-passage pairs drawn from five open-access (CC BY 4.0) computer science papers.

| Retrieval mode | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| BM25 | 0.740 | 0.920 | 0.920 | 1.000 | 0.834 |
| Vector | 0.520 | 0.840 | 0.940 | 0.980 | 0.684 |
| Hybrid (default) | 0.760 | 0.940 | 0.960 | 1.000 | 0.856 |

Hybrid retrieval fuses BM25 and vector rankings by Reciprocal Rank Fusion, weighting BM25 three times over vector, and is the default whenever an Embedder is configured. See [eval/README.md](eval/README.md) for the corpus, method, and full results.

```bash
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

## Alignment evaluation

Alignment scoring is measured against 47 labelled claim-citation pairs written against the same five papers. Each pair records the score a reader would assign: 2 where the paper supports the claim, 1 where it is relevant but does not establish it, and 0 where it is inconsistent.

| | Accuracy | Recall 2 | Recall 1 | Recall 0 | False endorsement | Missed support |
|---|---|---|---|---|---|---|
| `DeBERTa-v3-large-mnli-fever-anli-ling-wanli` (accelerator) | 0.894 | 0.917 | 0.700 | 1.000 | 0.000 | 0.083 |
| `DeBERTa-v3-base-mnli-fever-anli` (CPU) | 0.809 | 0.875 | 0.800 | 0.692 | 0.000 | 0.125 |

False endorsement is the share of unsupported claims scored 2. A score of 2 is shown without a warning, so a false endorsement leaves an unsupported claim unmarked. The default model is the one that produces none on this set.

Five passages are retrieved per claim. The one scored is the passage the model is least neutral about, and a score of 2 additionally requires the highest-ranked passage to agree. Chunk size was swept against both the golden set and the labelled claim sets; 768 tokens is the measured target and `KIWI_CHUNK_TOKENS` overrides it.

`kiwi align --deep` splits a compound claim into its assertions and scores each against evidence retrieved for it. A second set of 24 compound and hedged claims scores 0.708, well below the direct claims. See [eval/README.md](eval/README.md) for the measurements behind these rules and for where the scoring is weakest.

Attribution is scored on a separate binary scale and measured against 17 further pairs: accuracy 0.824, with 2 of 11 claims wrongly credited. Entailment does not separate using a technique from originating it, so a claim naming a method the paper merely applies can be credited to it. See [eval/README.md](eval/README.md).

```bash
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/attribution.json --intent attribution
```

## Development

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest -m "not requires_grobid and not requires_network"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full test setup, including GROBID-backed and network-backed tests.

## License

Apache 2.0. See [LICENSE](LICENSE).
