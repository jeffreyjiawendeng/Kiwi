import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electronPath from "electron";

const appRoot = join(import.meta.dirname, "..", "..");
const mainEntry = join(appRoot, "dist", "main", "index.cjs");

interface LaunchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  logRecords: LogRecord[];
}

interface LogRecord {
  event: string;
  level: string;
  component: string;
  fields: Record<string, unknown>;
}

function launch(runMs: number, extraEnv: Record<string, string> = {}): Promise<LaunchResult> {
  // A VS Code integrated terminal inherits ELECTRON_RUN_AS_NODE, which starts the
  // Electron binary as plain Node and hides real startup failures.
  const env = { ...process.env, ...extraEnv };
  delete env["ELECTRON_RUN_AS_NODE"];

  // An isolated profile keeps the single-instance lock from binding this launch to a
  // Kiwi window the developer already has open.
  const userDataDir = mkdtempSync(join(tmpdir(), "kiwi-launch-"));

  return new Promise((resolve) => {
    const child = spawn(
      electronPath as unknown as string,
      [".", `--user-data-dir=${userDataDir}`],
      { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));

    const timer = setTimeout(() => child.kill(), runMs);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const logFile = join(userDataDir, "logs", "kiwi.log");
      const logRecords = existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as LogRecord)
        : [];
      rmSync(userDataDir, { recursive: true, force: true });
      resolve({ exitCode, signal, output, logRecords });
    });
  });
}

describe.skipIf(!existsSync(mainEntry))("application launch", () => {
  it("starts and stays running without reporting an error", async () => {
    const result = await launch(6000);

    expect(result.output).not.toMatch(/Error|error:|Cannot find|undefined is not/i);
    // A clean run is terminated by the test, not by the application exiting on its own.
    expect(result.exitCode, "the application exited before the test stopped it").toBeNull();
    expect(result.signal).toBe("SIGTERM");
  }, 30000);

  it("serves a renderer document that can paint", () => {
    const html = readFileSync(join(appRoot, "dist", "renderer", "index.html"), "utf8");
    expect(html).toContain('id="kiwi-root"');
    expect(html).toMatch(/<script[^>]+src="[^"]+\.js"/);
    expect(html).toMatch(/<link[^>]+rel="stylesheet"/);
  });
});

describe.skipIf(!existsSync(mainEntry))("worker crash containment", () => {
  it("keeps the application running when the worker fails repeatedly", async () => {
    const result = await launch(12_000, { KIWI_FAULT: "worker" });

    // The test stopped the application. It did not exit on its own.
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");

    const events = result.logRecords.map((record) => record.event);
    expect(events).toContain("worker.crashed");
    expect(events).toContain("startup.completed");
  }, 40000);

  it("restarts with backoff and then gives up inside the policy window", async () => {
    const result = await launch(12_000, { KIWI_FAULT: "worker" });

    const crashes = result.logRecords.filter((record) => record.event === "worker.crashed");
    expect(crashes.length).toBeGreaterThanOrEqual(2);
    expect(crashes.at(-1)?.fields["will_restart"]).toBe(false);
    expect(result.logRecords.some((record) => record.event === "worker.given_up")).toBe(true);
  }, 40000);

  it("records the crash without a stack trace or a path", async () => {
    const result = await launch(12_000, { KIWI_FAULT: "worker" });
    const encoded = JSON.stringify(result.logRecords);

    expect(encoded).not.toMatch(/\bat \w+ \(/);
    expect(encoded).not.toContain("Injected worker fault");
    expect(encoded).not.toMatch(/[A-Za-z]:\\Users/);
  }, 40000);
});
