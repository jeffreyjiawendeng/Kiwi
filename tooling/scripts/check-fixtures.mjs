import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const cases = [
  {
    name: "ESLint dependency boundary (ENG-REPO-001)",
    command:
      'pnpm exec eslint --no-ignore --config eslint.config.js "fixtures/checkers/eslint-boundary/packages/domain/src/forbidden.ts"',
    expect: /ENG-REPO-001/,
  },
  {
    name: "ESLint renderer privilege boundary (ENG-ARCH-001)",
    command:
      'pnpm exec eslint --no-ignore --config eslint.config.js "fixtures/checkers/eslint-renderer/apps/desktop/src/renderer/privileged.tsx"',
    expect: /ENG-ARCH-001/,
  },
  {
    name: "ESLint rule set (no-explicit-any)",
    command:
      'pnpm exec eslint --no-ignore --config eslint.config.js "fixtures/checkers/eslint-rules/any-usage.ts"',
    expect: /no-explicit-any/,
  },
  {
    name: "Prettier formatting",
    command:
      'pnpm exec prettier --check --ignore-path=fixtures/checkers/.prettierignore-none "fixtures/checkers/prettier/unformatted.ts"',
    expect: /unformatted\.ts/,
  },
  {
    name: "TypeScript strict options",
    command: "pnpm exec tsc --project fixtures/checkers/typescript/tsconfig.json",
    expect: /TS2322|TS2375/,
  },
];

let failures = 0;

for (const testCase of cases) {
  let output = "";
  let exitCode = 0;
  try {
    output = execSync(testCase.command, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    exitCode = typeof error.status === "number" ? error.status : 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  if (exitCode === 0) {
    console.error(`  x ${testCase.name}: checker accepted a fixture it must reject`);
    failures += 1;
    continue;
  }

  if (!testCase.expect.test(output)) {
    console.error(`  x ${testCase.name}: rejected, but not for the expected reason`);
    console.error(output.trim().split("\n").slice(0, 6).join("\n"));
    failures += 1;
    continue;
  }

  console.log(`  + ${testCase.name}: rejected as expected`);
}

if (failures > 0) {
  console.error(`\n${failures} checker fixture(s) did not behave as required.`);
  process.exit(1);
}

console.log("\nEvery configured checker rejects its known-bad fixture.");
