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
uv run kiwi evaluate eval/workspace.kiwi --golden eval/golden.json
```

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

A new implementation is correct when it passes the same behavioral tests written for its protocol, for example `tests/components/test_chunker.py` for a Chunker. There is no shared conformance suite across implementations yet; each component's tests currently exercise the one implementation that ships with Kiwi.

Rules that apply to every component:

- Data crossing a component boundary is a frozen dataclass from `kiwi.types`, never a dict.
- `protocols.py` must not import from `kiwi.components`. Enforced by a Ruff banned-import rule in CI.
- A component that fails should raise a typed error or report `health(ok=False, detail=...)` rather than degrade silently.

## Style

- Ruff handles linting and formatting; run it before committing.
- mypy runs in strict mode. Untyped code does not merge.
- No comments explaining *what* code does. Only comments explaining a non-obvious *why*.
