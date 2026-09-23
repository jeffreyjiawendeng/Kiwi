# Contributing to Kiwi

Kiwi is an open-source, local-first Windows research workspace built with Electron, React, and
TypeScript.

## Prerequisites

| Tool    | Version                                                 |
| ------- | ------------------------------------------------------- |
| Windows | 10 or 11, 64-bit                                        |
| Node.js | 22.12.0 or later                                        |
| pnpm    | 11.12.0                                                 |
| Docker  | Current Desktop release for account-service development |

Enable pnpm through Corepack so the pinned version is used:

```
corepack enable
corepack prepare pnpm@11.12.0 --activate
```

Other platforms can run unit tests, but the desktop application and packaging target Windows x64.

## Setup

```
pnpm setup
```

This checks prerequisites and installs the dependency graph. It prints a specific message naming
the missing tool and the command that installs it when a prerequisite is not met.

To check prerequisites without installing:

```
pnpm preflight
```

## Commands

| Command            | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `pnpm setup`       | Check prerequisites and install dependencies                            |
| `pnpm dev`         | Launch the Kiwi desktop in development                                  |
| `pnpm dev:service` | Launch the local Kiwi account service after its database is ready       |
| `pnpm verify`      | Run the focused format, lint, type, unit-test, and checker-fixture pass |
| `pnpm format`      | Apply formatting                                                        |
| `pnpm build`       | Build every package                                                     |
| `pnpm package`     | Produce Windows distributables                                          |

`pnpm verify` is the command to run before handing work over. Individual task names
(`lint`, `typecheck`, `test:unit`, `test:contract`, `test:integration`, `test:e2e`, `schema:check`,
`docs:check`) run through Turborepo and can be invoked directly.

## Repository layout

```
apps/desktop/       Electron main, preload, renderer, worker bootstrap
apps/service/       Account/collaboration HTTP service and PostgreSQL migrations
packages/contracts/ JSON Schemas, shared wire types, error catalog
packages/testkit/   Fixtures, fake clocks, deterministic identifier sources
tooling/            Lint, build, and verification configuration
fixtures/           Non-sensitive conformance corpora and checker fixtures
docs/               The user guide, the self-hosting guide, and the service runbook
```

`apps/desktop` builds four independent bundles, one per process boundary:

| Entry                  | Output                           | Format     | Runs as                    |
| ---------------------- | -------------------------------- | ---------- | -------------------------- |
| `src/main`             | `dist/main/index.cjs`            | CommonJS   | Trusted main process       |
| `src/preload`          | `dist/preload/index.cjs`         | CommonJS   | Sandboxed renderer preload |
| `src/renderer`         | `dist/renderer/`                 | ES modules | Unprivileged renderer      |
| `src/worker-bootstrap` | `dist/worker-bootstrap/index.js` | ES modules | Utility worker             |

Main and preload are CommonJS because Electron does not resolve named ESM imports from the
`electron` module in the main process and a sandboxed preload loads CommonJS only.

## Running the desktop application

Start the account service and PostgreSQL first by following
[`apps/service/README.md`](apps/service/README.md). Then run:

```
pnpm dev
```

This starts the renderer dev server on `http://localhost:5273`, builds main and preload, and
launches Electron against them. Closing the window stops the dev server.

Two things to know:

- A VS Code integrated terminal sets `ELECTRON_RUN_AS_NODE=1`. Left in place it makes the Electron
  binary start as plain Node with no `app` module. `scripts/dev.mjs` removes it from the child
  environment, and the launch test does the same.
- After a fresh `pnpm install`, Electron may not have fetched its binary. If `pnpm dev` reports a
  missing executable, run `pnpm rebuild electron` from `apps/desktop`.

## Account-service boundary

`apps/service` is a separate Node process. It owns the PostgreSQL driver, the migrations, and
the account and collaboration endpoints. Those dependencies cannot enter the Electron renderer or preload.

The desktop main process is the only desktop component that contacts the service. It validates the
shared health and authentication contracts. Google uses the system browser plus an ephemeral IPv4
loopback callback with PKCE, state, and nonce validation. Access credentials and provider codes stay
behind the main-process boundary; only public account identity, generic account outcomes, and
development fixture mail codes cross preload. The renderer never receives the service origin,
database configuration, migration error, password verifier, access token, or provider credential.
Rotating refresh credentials are hashed by the service and encrypted with Electron's operating-system
protected storage before they reach the desktop credential file. A valid cached grant can enter the
downloaded-workspace shell during an outage; it never makes remote authorization decisions offline.

The local service binds to `127.0.0.1:4319`. Production deployment must use HTTPS and configured
service infrastructure; the development HTTP exception is accepted only for the exact loopback
origin.

## Packaging

```
pnpm package
```

Builds both Windows distributables into `apps/desktop/release/` and writes
`artifact-manifest.json` and `SHA256SUMS.txt`:

| Artifact                              | Target                                          |
| ------------------------------------- | ----------------------------------------------- |
| `Kiwi-<version>-win-x64-setup.exe`    | NSIS, per-user install, no administrator rights |
| `Kiwi-<version>-win-x64-portable.zip` | Extract and run, no install                     |

Builds are not code signed. The About panel and the artifact manifest both say so. The
[self-hosting guide](docs/self-hosting.md) says what signing changes.

`release/` holds large binaries. Keep it out of version control.

## The command layer

Every state-changing operation is a registered command. The user interface, and any other
adapter such as a CLI or a local API, invokes the same definitions. No adapter carries its own
business logic.

`packages/commands` owns the gateway. One invocation passes through, in order: payload size
and depth limits, envelope schema validation, protocol major compatibility, command lookup,
origin permission, argument schema validation, idempotency replay, then the handler.

Two rules are worth stating plainly:

- The caller never supplies its own identity. The adapter proves `actor` and `origin` from
  its authenticated channel and the gateway overwrites whatever the envelope claims.
- A handler may fail with a `CommandError` naming a catalog code. Anything else it throws
  becomes `KIWI_INTERNAL_REDACTED`, because an unplanned message can carry a path, a query,
  or a provider payload.

Schema documents live in `packages/contracts/schemas` and are the authority for wire
validation. `packages/contracts/src/schemas.ts` holds the runtime copies, and a test fails
if the two drift.

## Process supervision

`apps/desktop/src/main/worker-host.ts` supervises the utility worker. A worker crash is
contained: it restarts with exponential backoff, and after more crashes than the policy
allows inside a rolling window it is given up on while the application keeps running.

A renderer that stops responding is reloaded, and the next health poll surfaces a
nonblocking notice saying so. The notice never takes focus.

Both paths have documented fault injection:

```
KIWI_FAULT=worker pnpm dev
```

## Diagnostics

Structured logs are written as JSON lines to the Electron `logs` path, which is under
`%LOCALAPPDATA%` on Windows. Every record carries an event name, level, UTC time, component,
version, and correlation ID.

`packages/diagnostics` redacts before writing. Field names that could hold research content or a
secret are replaced, and absolute paths in free text are reduced to a final segment. A failure
shown to the user carries a code, a plain message, recovery actions, and the correlation ID. It
never carries a stack trace.

To see the diagnostic screen deliberately:

```
KIWI_FAULT=startup pnpm dev
```

The window opens on the diagnostic screen rather than a blank surface, and the log records
`startup.failed` with the same correlation ID the screen displays.

## Renderer security

The renderer runs sandboxed and context-isolated with no Node integration. It reaches the main
process only through the frozen bridge that `src/preload` exposes.

The content security policy in `src/main/security.ts` is asserted, directive by directive, by a
test. Development differs from production in exactly one directive, `connect-src`, which the Vite
dev server and its hot-update socket require. Every privilege boundary is identical in both modes.
Inline script is forbidden in both, which is why the renderer does not use
`@vitejs/plugin-react` and its Fast Refresh preamble.

## Dependency boundaries

`tooling/eslint/boundaries.js` encodes the package boundary rules. ESLint fails on a forbidden
import. The rules that matter most:

- `packages/domain` stays deterministic and free of Electron, React, SQLite, Node, and network.
- `packages/contracts` stays portable and free of runtime-specific dependencies.
- The renderer never imports Electron, Node builtins, persistence, or a network client. It reaches
  main only through the preload bridge.

## Verification fixtures

`fixtures/checkers/` holds one file per configured checker that the checker must reject.
`pnpm check:fixtures` fails if any checker accepts its known-bad fixture. This catches a checker
that is configured but not actually running.

## Working method

A change is one small vertical slice: its schema, command, persistence, interface, and tests
together, so that every commit leaves the application working. Code style: strict TypeScript, no
`any`, explicit data flow, validation at trusted boundaries, and no comments unless they record a
non-obvious invariant or a security boundary.

## Dependency versions

Versions are pinned exactly. When raising one, say in the commit message what changed and what was
checked.

## License

Contributions are accepted under the Apache License 2.0.
