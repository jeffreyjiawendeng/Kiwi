# Contributing to Kiwi

## Setup

```bash
uv sync --all-extras --dev
uv run pytest
```

The suite must pass on a clean checkout with no external services running. Tests that need GROBID or the network are marked and skipped by default.

## GROBID

Ingestion needs a running GROBID service.

```bash
docker run --rm -p 8070:8070 lfoppiano/grobid:0.8.1
```

Run the full test suite, including GROBID-backed tests:

```bash
uv run pytest -m "requires_grobid or requires_network or not (requires_grobid or requires_network)"
# equivalently, drop the default exclusion:
uv run pytest --override-ini="addopts="
```

## Retrieval evaluation

See `eval/README.md` for the corpus, golden set, and current results.

```bash
uv run kiwi ingest eval/corpus --project eval/workspace.kiwi   # needs GROBID running
uv run kiwi index eval/workspace.kiwi
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/alignment-hedged.json
uv run kiwi evaluate-alignment eval/workspace.kiwi --labelled eval/attribution.json --intent attribution
```

`alignment.json` holds direct claims, `alignment-hedged.json` holds compound and hedged claims of the kind found in published work, and `attribution.json` holds claims scored on the binary attribution scale. Report all three when changing the Aligner or the passage selection rule.

## GPU

Embedding and alignment run on a GPU when one is present. See the README for installing a CUDA build of torch; `uv sync` replaces it with the CPU build, so reinstall it afterwards. `kiwi health` reports the device in use.

Retrieval results do not depend on the device. Alignment uses a larger model where an accelerator is present, so its scores do. Set `KIWI_DEVICE=cpu` to check behavior without a GPU.

A model that does not fit in the free memory of the accelerator, with headroom left for the rest of the machine, stays on the CPU rather than being loaded.

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
