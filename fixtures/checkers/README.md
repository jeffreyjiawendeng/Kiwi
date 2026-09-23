# Checker fixtures

Each directory holds a file that a configured checker must reject. `tooling/scripts/check-fixtures.mjs`
runs every checker against its fixture and fails when a checker reports success. This proves the
checker is wired up rather than silently passing.

Fixtures are excluded from the normal lint, format, and type-check runs.

| Fixture | Checker | Expected rejection |
| --- | --- | --- |
| `eslint-boundary/` | ESLint | `ENG-REPO-001` forbidden import from `packages/domain` |
| `eslint-renderer/` | ESLint | `ENG-ARCH-001` privileged import from the renderer |
| `eslint-rules/` | ESLint | `@typescript-eslint/no-explicit-any` |
| `prettier/` | Prettier | formatting differs from the committed configuration |
| `typescript/` | TypeScript | `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
