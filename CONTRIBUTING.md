# Contributing to Kiwi

## Setup

```bash
uv sync --all-extras --dev
uv run pytest
```

The suite must pass on a clean checkout with no external services running. Tests that need GROBID or the network are marked and skipped by default.

## GROBID

`uv run kiwi setup` reports which capabilities this machine has, what each missing one costs and buys, and writes the chosen settings to `.env`. `--non-interactive` reports without asking, which is what to run in CI.

Ingestion needs a running GROBID service. `kiwi ingest --text-only` reads the PDF's text layer instead, which needs no service but finds no sections and no references; every figure in `eval/README.md` was measured on GROBID's output.

```bash
docker run --rm -p 8070:8070 -e JAVA_TOOL_OPTIONS=-XX:-UseContainerSupport lfoppiano/grobid:0.8.1
```

Run the full test suite, including GROBID-backed tests:

```bash
uv run pytest -m "requires_grobid or requires_network or not (requires_grobid or requires_network)"
# equivalently, drop the default exclusion:
uv run pytest --override-ini="addopts="
```

## Working on the interface

```bash
uv run kiwi serve --reload
```

The interface is plain HTML, CSS, and JavaScript with no build step, read from disk on each request. Editing `src/kiwi/api/static/` and reloading the page is the whole loop; the server does not restart and does not need to. Those files are served with `Cache-Control: no-store` and conditional requests are answered in full, so a reload never shows a stale copy.

`--reload` covers the Python half, restarting when anything under `src/kiwi/` changes. It watches the package rather than the working directory, so editing a note or a draft in an open project does not restart the server underneath the reader.

Three tests cover the interface, in increasing order of what they can see.

`tests/test_frontend_contract.py` reads every module as text: a path the interface requests that no route serves, an element it reads that nothing renders, a name imported that is not exported, and a review decision the API would reject.

`tests/test_frontend_smoke.py` loads the modules under Node with a small browser stub and exercises the logic that does not touch the DOM.

`tests/test_frontend_browser.py` renders the application in headless Chromium, opens a project, and visits every view. It watches the console for an error raised inside a handler, and the request log for a view that asks the API for the same thing without end, which is what a renderer re-entering itself looks like. It needs a browser:

```bash
uv run playwright install chromium
```

The first two pass on an interface that is completely unusable, which has happened. Prefer adding to the third.

## Retrieval evaluation

See `eval/README.md` for the corpus, golden set, and current results.

```bash
uv run kiwi ingest eval/corpus --project eval/workspace.kiwi   # needs GROBID running
uv run kiwi index eval/workspace.kiwi
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden-figures.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment-hedged.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/attribution.json --intent attribution
```

SciFact, an expert-annotated benchmark of 1259 claim-citation pairs over 5183 abstracts, is the check that these figures are not a property of this project's annotator:

```bash
uv run python eval/_scifact.py --download
uv run python eval/_scifact.py
uv run python eval/_scifact.py --retrieval
uv run python eval/_scifact.py --attribution
```

`alignment.json` holds direct claims, `alignment-hedged.json` holds compound and hedged claims of the kind found in published work, and `attribution.json` holds claims scored on the binary attribution scale. Report all three when changing the Aligner or the passage selection rule.

Generated answers are measured against the passages they were built from. Run it when changing the Generator, its prompt, or retrieval:

```bash
KIWI_GENERATOR_MODEL=ollama/qwen2.5:7b-instruct \
    uv run python eval/_answers.py --project eval/workspace.kiwi --golden eval/golden.json
```

Latency decides whether a setting is worth its accuracy, and is the one
figure that does not transfer between machines:

```bash
uv run python eval/_latency.py --cpu-rerank
```

Anchor durability is measured separately, and is what keeps a citation, an annotation, or an evidence passage pointing at the right words after a paper is parsed again. Run it when changing `kiwi.anchor` or the Ingestor:

```bash
uv run python eval/_anchors.py
uv run python eval/_anchors.py --across-parsers
```

Reranking is off unless `KIWI_RERANK_MODEL` is set. Report figures both ways when changing retrieval, because the two paths order passages differently:

```bash
KIWI_RERANK_MODEL=BAAI/bge-reranker-v2-m3 uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

Report `--attribution` as well when changing anything on the attribution scale. The sets written for this project hold 21 negatives between them, too few to show a change that credits the wrong paper more often; the derived set holds 116.

## GPU

Embedding and alignment run on a GPU when one is present. See the README for installing a CUDA build of torch; `uv sync` replaces it with the CPU build, so reinstall it afterwards. `kiwi health` reports the device in use.

Retrieval results do not depend on the device. Alignment uses a larger model where an accelerator is present, so its scores do. Set `KIWI_DEVICE=cpu` to check behavior without a GPU.

A model that does not fit in the free memory of the accelerator, with headroom left for the rest of the machine, stays on the CPU rather than being loaded.

## Ingestion

GROBID's full-text endpoint can place a component DOI in the TEI header, so a paper's DOI arrives as its first figure's (`10.1371/journal.pone.0022557.g001`). `_article_doi` reduces a component DOI to the article it belongs to. Storing the component would give the paper a DOI resolving to a figure, which then reports as a metadata mismatch against Crossref.

## Annotations

Annotations live in `papers/<doc_id>/annotations.json` and carry an `Anchor` into the paper's normalised text. The source PDF is never written to: embedding annotations rewrites the whole file on every change, and two readers annotating one paper produce a conflict with no correct resolution.

`annotate()` locates the passage by searching the stored text, so a passage that appears twice resolves to its first occurrence.

## Removing things

`kiwi.removal` deletes a paper, a draft, or a note along with what that object owns, and nothing else. A paper owns its parsed text, its annotations, its verification results, and its chunks in the index. A draft owns the sidecar holding its scored claims, its suggestions, and the review decisions recorded on it. A note owns nothing further.

A reference is another object's content. A draft citing a removed paper keeps its prose and its decisions, and the drafts that cite it are reported so the reader decides what their own sentence should say.

Removing a paper from disk without removing its chunks would leave it answering questions, so `remove_paper` does both.

## Roles and permissions

`kiwi.permissions` defines the permission set and the default role ladder; `project.json` records a project's roles, members, ownership, and required reviews. `require(project, permission, actor)` raises `PermissionDenied` when the project's records do not grant an operation.

Two invariants are tested rather than assumed. Roles are strictly nested, so `validate_ladder` rejects any role that fails to hold everything the role beneath it holds. A project with no `project.json` reads as single-owner, so permission checks are invisible to a workspace used by one person.

An operation takes an `actor`, which is who performs it and what the permission is checked against. That is separate from an `author` or `reviewer` field, which is the name recorded on what the operation produces.

## Suggestions

A suggestion is a proposed change that leaves the draft unchanged until it is accepted. Every proposed edit uses the same record regardless of origin, and the origin is stored on it.

Two rules constrain the mechanism. A suggestion is accepted or rejected as written, with no operation that edits it first, because the applied text would otherwise be attributed to whoever proposed it. Rejected suggestions are retained rather than deleted.

Spans are re-resolved through `kiwi.anchor` when a change is applied, so a suggestion survives edits made elsewhere in the draft. A span that no longer resolves, or that matches more than one place, raises `SuggestionNotApplicable`.

## Packaging

```bash
uv build
```

An extra adds a model download. Anything a plain install needs to work belongs in the core dependencies, including the Store: `lancedb` sat in the `embed` extra, which left `pip install kiwi` able to read a paper and unable to index it.

CI installs the built wheel on its own, with no extras, and reads, indexes, and queries a paper through it. The rest of the suite runs with every extra installed and would not catch that.

## Checks

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest -m "not requires_grobid and not requires_network"
```

All four run in CI on every push and pull request.

## Adding a component implementation

Every component boundary in `src/kiwi/protocols.py` is a `typing.Protocol`. A new implementation does not import a Kiwi base class; it only needs to match the shape of the protocol it implements.

A new implementation is correct when it passes the same behavioral tests written for its protocol, for example `tests/components/test_chunker.py` for a Chunker. Each component's tests exercise one implementation. There is no shared conformance suite that runs the same tests against every implementation of a protocol.

Rules that apply to every component:

- Data crossing a component boundary is a frozen dataclass from `kiwi.types`, never a dict.
- `protocols.py` must not import from `kiwi.components`. Enforced by a Ruff banned-import rule in CI.
- A component that fails raises a typed error or reports `health(ok=False, detail=...)` rather than degrading silently.

## Style

- Ruff handles linting and formatting; run it before committing.
- mypy runs in strict mode. Untyped code does not merge.
- No comments explaining *what* code does. Only comments explaining a non-obvious *why*.
