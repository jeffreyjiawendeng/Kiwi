import { parentPort } from "node:worker_threads";

if (parentPort === null) {
  throw new Error("worker-bootstrap must run inside a worker");
}

// Documented fault injection for verifying that a worker crash stays contained.
if (process.env["KIWI_FAULT"] === "worker") {
  throw new Error("Injected worker fault");
}

parentPort.postMessage({ type: "ready" });

parentPort.on("message", (message: unknown) => {
  if (message === "ping") parentPort?.postMessage({ type: "pong" });
});
