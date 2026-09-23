import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(actual, required) {
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

function detectPnpm() {
  try {
    // Run outside the repository so engine-strict does not make an unmet engines
    // range look like a missing installation.
    return execSync("pnpm --version", {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const checks = [];

const requiredNode = parseVersion(manifest.engines.node);
const actualNode = parseVersion(process.version);
checks.push({
  name: "Node.js",
  required: `>=${requiredNode.join(".")}`,
  found: process.version,
  ok: isAtLeast(actualNode, requiredNode),
  fix: "Install Node.js from https://nodejs.org and reopen the terminal.",
});

const requiredPnpm = parseVersion(manifest.packageManager);
const pnpmVersion = detectPnpm();
checks.push({
  name: "pnpm",
  required: `>=${requiredPnpm.join(".")}`,
  found: pnpmVersion ?? "not found",
  ok: pnpmVersion !== null && isAtLeast(parseVersion(pnpmVersion), requiredPnpm),
  fix: `Run: corepack enable && corepack prepare ${manifest.packageManager} --activate`,
});

checks.push({
  name: "Platform",
  required: "win32 x64",
  found: `${process.platform} ${process.arch}`,
  ok: true,
  fix: "",
  warnOnly: process.platform !== "win32" || process.arch !== "x64",
});

const failed = checks.filter((check) => !check.ok);

for (const check of checks) {
  const mark = check.ok ? (check.warnOnly ? "!" : "+") : "x";
  console.log(
    `  ${mark} ${check.name.padEnd(10)} required ${check.required.padEnd(12)} found ${check.found}`,
  );
}

if (checks.some((check) => check.warnOnly)) {
  console.log(
    "\n  Kiwi targets 64-bit Windows 10 and 11. Other platforms can run unit tests only.",
  );
}

if (failed.length > 0) {
  console.error("\nPrerequisites are not met:\n");
  for (const check of failed) {
    console.error(`  ${check.name}: found ${check.found}, need ${check.required}`);
    console.error(`    ${check.fix}\n`);
  }
  process.exit(1);
}

console.log("\nPrerequisites met.");
