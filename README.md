# Kiwi

Kiwi is an open source research workspace for retrieval-augmented generation over research papers. Every generated claim is traceable to a passage in a source document, and every component in the pipeline, including the interface, can be swapped, omitted, or replaced with an alternative implementation.

## Features

- Structure-preserving PDF ingestion through GROBID: section hierarchy, figures, tables, and a parsed reference list.
- Section-aware chunking and corpus-wide retrieval. BM25 keyword search runs with no configuration; hybrid BM25 and vector search is used automatically once an embedding model is configured.
- Citation-checked answers generated from retrieved passages, using an optional language model.
- Reference verification against Crossref: existence, metadata consistency, and retraction status.
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
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
```

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

Kiwi is configured through environment variables. None are required; each has a working default or degrades to a narrower but functional mode.

| Variable | Effect |
|---|---|
| `KIWI_GROBID_URL` | GROBID base URL. Defaults to `http://localhost:8070`. |
| `KIWI_NO_EMBED` | Disables the embedding model. Retrieval falls back to BM25 keyword search. |
| `KIWI_GENERATOR_MODEL` | A LiteLLM model string. Enables generated answers; unset, `kiwi ask` returns ranked passages instead. |
| `KIWI_CONTACT_EMAIL` | Contact email sent with Crossref requests, for its polite request pool. |
| `KIWI_NO_VERIFY` | Disables reference verification. |
| `KIWI_DATA_DIR` | Overrides where the known-projects registry is stored. |

## Command line interface

| Command | Description |
|---|---|
| `kiwi ingest PATH [--project PATH]` | Parses a PDF, or every PDF in a directory, into structured sections and references. |
| `kiwi index PROJECT [--doc ID]` | Chunks and indexes papers so they can be queried. |
| `kiwi verify PROJECT [--doc ID]` | Resolves extracted references against Crossref. |
| `kiwi ask PROJECT QUESTION [--doc ID] [--k N]` | Queries indexed papers and returns ranked passages or a generated answer. |
| `kiwi health` | Checks whether the configured GROBID service is reachable. |
| `kiwi evaluate PROJECT [--golden PATH]` | Measures retrieval quality against a golden query set. |
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

Kiwi is a set of substitutable components behind stable interfaces rather than one fixed application. The CLI, the HTTP API, and the web interface are three consumers of the same core.

| Component | Implementation |
|---|---|
| Ingestor | GROBID |
| Chunker | Section-aware: splits along the document's own section boundaries, packing sentence-by-sentence within sections that exceed the token budget |
| Store | LanceDB, embedded, with native BM25 search |
| Embedder | sentence-transformers, `nomic-embed-text-v1.5` by default; optional |
| Retriever | BM25 keyword search, or hybrid BM25 and vector search fused by weighted Reciprocal Rank Fusion when an Embedder is configured |
| Generator | LiteLLM; optional |
| Resolver | Crossref: identifier resolution, metadata, retraction status |
| Interface | A local web UI at `/app`, plain HTML, CSS, and JavaScript with no build step, served by the same process as the API |

## Retrieval evaluation

Retrieval quality is measured against a golden set of 50 hand-verified query-passage pairs drawn from five open-access (CC BY 4.0) computer science papers.

| Retrieval mode | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|
| BM25 | 0.720 | 0.900 | 0.920 | 1.000 | 0.818 |
| Vector | 0.500 | 0.840 | 0.920 | 0.960 | 0.667 |
| Hybrid (default) | 0.720 | 0.940 | 0.960 | 1.000 | 0.827 |

Hybrid retrieval fuses BM25 and vector rankings by Reciprocal Rank Fusion, weighting BM25 three times over vector, and is the default whenever an Embedder is configured. See [eval/README.md](eval/README.md) for the corpus, method, and full results.

```bash
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
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
