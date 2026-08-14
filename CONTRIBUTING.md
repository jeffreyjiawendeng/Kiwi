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

## Annotations

Annotations live in `papers/<doc_id>/annotations.json` and carry an `Anchor` into the paper's normalised text. The source PDF is never written to: embedding annotations rewrites the whole file on every change, and two readers annotating one paper produce a conflict with no correct resolution.

`annotate()` locates the passage by searching the stored text, so a passage that appears twice resolves to its first occurrence.

## Roles and permissions

`kiwi.permissions` defines the permission set and the default role ladder; `project.json` records a project's roles, members, ownership, and required reviews. `require(project, permission, actor)` raises `PermissionDenied` when the project's records do not grant an operation.

Two invariants are tested rather than assumed. Roles are strictly nested, so `validate_ladder` rejects any role that fails to hold everything the role beneath it holds. A project with no `project.json` reads as single-owner, so permission checks are invisible to a workspace used by one person.

An operation takes an `actor`, which is who performs it and what the permission is checked against. That is separate from an `author` or `reviewer` field, which is the name recorded on what the operation produces.

## Suggestions

A suggestion is a proposed change that leaves the draft unchanged until it is accepted. Every proposed edit uses the same record regardless of origin, and the origin is stored on it.

Two rules constrain the mechanism. A suggestion is accepted or rejected as written, with no operation that edits it first, because the applied text would otherwise be attributed to whoever proposed it. Rejected suggestions are retained rather than deleted.

Spans are re-resolved through `kiwi.anchor` when a change is applied, so a suggestion survives edits made elsewhere in the draft. A span that no longer resolves, or that matches more than one place, raises `SuggestionNotApplicable`.

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
