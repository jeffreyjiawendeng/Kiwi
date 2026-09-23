import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopProcessTree } from "../../../tooling/scripts/process-tree.mjs";

const childEnv = {
  ...process.env,
  KIWI_SERVICE_ENV: "development",
  KIWI_AUTH_FIXTURES: process.env.KIWI_AUTH_FIXTURES ?? "1",
};
const tscEntry = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));

const initialBuild = spawnSync(process.execPath, [tscEntry, "--build"], {
  cwd: import.meta.dirname + "/..",
  env: childEnv,
  stdio: "inherit",
});
if (initialBuild.status !== 0) process.exit(initialBuild.status ?? 1);

const compiler = spawn(
  process.execPath,
  [tscEntry, "--build", "--watch", "--preserveWatchOutput"],
  {
    cwd: import.meta.dirname + "/..",
    env: childEnv,
    stdio: "inherit",
  },
);

// A secret typed into one terminal does not survive the next one, so the service also
// reads apps/service/.env when that file exists. Keep .env out of version control.
const service = spawn("node", ["--env-file-if-exists=.env", "--watch", "dist/index.js"], {
  cwd: import.meta.dirname + "/..",
  env: childEnv,
  stdio: "inherit",
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  stopProcessTree(compiler);
  stopProcessTree(service);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(0));
}

service.on("close", (code) => {
  stop(code ?? 0);
});

compiler.on("close", (code) => stop(code ?? 1));
