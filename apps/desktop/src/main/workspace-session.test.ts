import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSummary } from "@kiwi/contracts";
import type { SessionPaths } from "@kiwi/workspace";

vi.mock("electron", () => ({
  app: { getPath: () => join(tmpdir(), "kiwi-electron-userdata") },
}));

const { createSessionRegistry, processIsAlive } = await import("./workspace-session.js");
const { memorySink, createLogger } = await import("@kiwi/diagnostics");
const { acquireLock } = await import("@kiwi/workspace");

const ID_A = "0198c7c1-4e7d-7e31-a23a-824269ac230a";
const ID_B = "0198c7c1-4e7d-7e31-a23a-824269ac230b";

let scratch: string;
let paths: SessionPaths;
let sink: ReturnType<typeof memorySink>;

function registry(isAlive: (pid: number) => boolean = () => false) {
  sink = memorySink();
  const logger = createLogger({
    component: "workspace",
    version: "0.1.0",
    correlationId: "corr-1",
    clock: { now: () => new Date("2026-08-22T00:00:00Z") },
    sink,
  });
  return createSessionRegistry(paths, logger, isAlive);
}

function summary(workspaceId: string, root = "C:\\ws"): WorkspaceSummary {
  return {
    workspaceId,
    title: "T",
    root,
    formatVersion: "1.0.0",
    status: "ready",
    trust: "trusted",
    writable: true,
    problems: [],
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-reg-"));
  paths = {
    workspaceState: (id) => join(scratch, "state", id),
    userData: () => join(scratch, "userdata"),
  };
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("processIsAlive", () => {
  it("reports this process as alive", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("reports an implausible pid as gone", () => {
    expect(processIsAlive(2_147_483_646)).toBe(false);
  });
});

describe("binding", () => {
  it("binds a workspace to a window", async () => {
    const sessions = registry();
    const result = await sessions.bind(1, summary(ID_A));

    expect(result.bound).toBe(true);
    expect(sessions.forWindow(1)?.summary.workspaceId).toBe(ID_A);
  });

  it("holds one workspace per window", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));
    await sessions.bind(1, summary(ID_B));

    expect(sessions.forWindow(1)?.summary.workspaceId).toBe(ID_B);
    expect(sessions.openWorkspaceIds()).toEqual([ID_B]);
  });

  it("keeps two windows on different workspaces isolated", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));
    await sessions.bind(2, summary(ID_B));

    expect(sessions.forWindow(1)?.summary.workspaceId).toBe(ID_A);
    expect(sessions.forWindow(2)?.summary.workspaceId).toBe(ID_B);
    expect(sessions.openWorkspaceIds()).toEqual([ID_A, ID_B].sort());
  });

  it("lets two windows share one workspace", async () => {
    const sessions = registry();
    expect((await sessions.bind(1, summary(ID_A))).bound).toBe(true);
    expect((await sessions.bind(2, summary(ID_A))).bound).toBe(true);
  });

  it("returns null for a window with no workspace", () => {
    expect(registry().forWindow(99)).toBeNull();
  });
});

describe("locking", () => {
  it("acquires a lock outside the workspace folder", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));
    expect(existsSync(join(scratch, "state", ID_A, "session.lock"))).toBe(true);
  });

  it("refuses a workspace another live process holds", async () => {
    await acquireLock(
      paths,
      { workspaceId: ID_A, pid: process.pid, acquiredAt: "2026-08-22T00:00:00Z", host: "other" },
      () => true,
    );
    // Rewrite the record so the pid is not this process but is still reported alive.
    const lockPath = join(scratch, "state", ID_A, "session.lock");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      lockPath,
      JSON.stringify({ workspaceId: ID_A, pid: 1, acquiredAt: "x", host: "other" }),
      "utf8",
    );

    const sessions = registry(() => true);
    const result = await sessions.bind(1, summary(ID_A));

    expect(result.bound).toBe(false);
    if (!result.bound) expect(result.reason).toBe("locked");
    expect(sink.records.some((record) => record.event === "workspace.locked")).toBe(true);
  });

  it("releases the lock when the last window closes", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));
    await sessions.bind(2, summary(ID_A));

    await sessions.release(1);
    expect(existsSync(join(scratch, "state", ID_A, "session.lock"))).toBe(true);

    await sessions.release(2);
    expect(existsSync(join(scratch, "state", ID_A, "session.lock"))).toBe(false);
  });

  it("releases the previous lock when a window switches workspace", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));
    await sessions.bind(1, summary(ID_B));

    expect(existsSync(join(scratch, "state", ID_A, "session.lock"))).toBe(false);
    expect(existsSync(join(scratch, "state", ID_B, "session.lock"))).toBe(true);
  });

  it("ignores a release for an unbound window", async () => {
    await expect(registry().release(42)).resolves.toBeUndefined();
  });
});

describe("logging", () => {
  it("records the bind without the workspace folder", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A, "C:\\Users\\ana\\Private Research"));

    const record = sink.records.find((entry) => entry.event === "workspace.bound");
    expect(record?.fields).toMatchObject({ window_id: 1, workspace_status: "ready" });
    expect(JSON.stringify(sink.records)).not.toContain("Private Research");
  });
});

describe("state location", () => {
  it("keeps every session file out of the workspace folder", async () => {
    const sessions = registry();
    await sessions.bind(1, summary(ID_A));

    const raw = await readFile(join(scratch, "state", ID_A, "session.lock"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ workspaceId: ID_A, pid: process.pid });
  });
});
