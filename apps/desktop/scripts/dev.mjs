import { spawn } from "node:child_process";
import { createServer } from "vite";
import electronPath from "electron";
import { stopProcessTree } from "../../../tooling/scripts/process-tree.mjs";

const DEV_ORIGIN = "http://localhost:5273";

async function buildOnce(configFile) {
  const { build } = await import("vite");
  await build({ configFile, logLevel: "warn" });
}

await buildOnce("vite.main.config.ts");
await buildOnce("vite.preload.config.ts");
await buildOnce("vite.worker.config.ts");

const server = await createServer({ configFile: "vite.renderer.config.ts" });
await server.listen();

// A VS Code integrated terminal inherits ELECTRON_RUN_AS_NODE from its own host.
// Leaving it set makes the Electron binary start as plain Node with no app module.
const childEnv = {
  ...process.env,
  KIWI_DEV_SERVER: DEV_ORIGIN,
  KIWI_DEV_START_SIGNED_OUT: process.env.KIWI_DEV_START_SIGNED_OUT ?? "0",
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const electron = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: childEnv,
});

console.log(`Kiwi renderer dev server on ${DEV_ORIGIN}`);

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  stopProcessTree(electron);
  await server.close();
  process.exit(code);
}

electron.on("error", () => void stop(1));
electron.on("close", (code) => void stop(code ?? 0));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void stop(0));
}
