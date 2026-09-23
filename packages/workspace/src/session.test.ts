import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  detectSyncFolder,
  fileRecentStore,
  fileTrustStore,
  releaseLock,
  type SessionPaths,
} from "./session.js";

const ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const NOW = "2026-08-22T10:00:00.000Z";

let scratch: string;
let paths: SessionPaths;

const alive = (): boolean => true;
const dead = (): boolean => false;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-session-"));
  paths = {
    workspaceState: (workspaceId) => join(scratch, "state", workspaceId),
    userData: () => join(scratch, "userdata"),
  };
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function lock(pid: number) {
  return { workspaceId: ID, pid, acquiredAt: NOW, host: "test-host" };
}

describe("session lock", () => {
  it("acquires an unheld lock", async () => {
    expect(await acquireLock(paths, lock(100), alive)).toEqual({ acquired: true });
  });

  it("refuses when another live process holds it", async () => {
    await acquireLock(paths, lock(100), alive);
    const result = await acquireLock(paths, lock(200), alive);

    expect(result.acquired).toBe(false);
    expect(result.heldBy?.pid).toBe(100);
  });

  it("takes over a lock whose process is gone", async () => {
    await acquireLock(paths, lock(100), alive);
    expect(await acquireLock(paths, lock(200), dead)).toEqual({ acquired: true });
  });

  it("lets the same process reacquire its own lock", async () => {
    await acquireLock(paths, lock(100), alive);
    expect(await acquireLock(paths, lock(100), alive)).toEqual({ acquired: true });
  });

  it("frees the lock on release", async () => {
    await acquireLock(paths, lock(100), alive);
    await releaseLock(paths, ID);
    expect(await acquireLock(paths, lock(200), alive)).toEqual({ acquired: true });
  });

  it("treats an unreadable lock as free", async () => {
    await acquireLock(paths, lock(100), alive);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(scratch, "state", ID, "session.lock"), "corrupt", "utf8");

    expect(await acquireLock(paths, lock(200), alive)).toEqual({ acquired: true });
  });

  it("keeps the lock outside the workspace folder", async () => {
    await acquireLock(paths, lock(100), alive);
    const raw = await readFile(join(scratch, "state", ID, "session.lock"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ workspaceId: ID, pid: 100 });
  });
});

describe("trust store", () => {
  it("returns null for a workspace it has not seen", async () => {
    expect(await fileTrustStore(paths).lookup("C:\\ws")).toBeNull();
  });

  it("remembers a decision", async () => {
    const store = fileTrustStore(paths);
    await store.remember({ root: "C:\\ws", trust: "trusted", decidedAt: NOW });
    expect(await store.lookup("C:\\ws")).toBe("trusted");
  });

  it("matches a path regardless of case or trailing separator", async () => {
    const store = fileTrustStore(paths);
    await store.remember({ root: "C:\\Research\\WS", trust: "trusted", decidedAt: NOW });
    expect(await store.lookup("c:\\research\\ws\\")).toBe("trusted");
  });

  it("forgets a decision", async () => {
    const store = fileTrustStore(paths);
    await store.remember({ root: "C:\\ws", trust: "trusted", decidedAt: NOW });
    await store.forget("C:\\ws");
    expect(await store.lookup("C:\\ws")).toBeNull();
  });

  it("keeps trust records outside every workspace", async () => {
    const store = fileTrustStore(paths);
    await store.remember({ root: "C:\\ws", trust: "restricted", decidedAt: NOW });
    const raw = await readFile(join(scratch, "userdata", "workspace-trust.json"), "utf8");
    expect(JSON.parse(raw)).toBeTypeOf("object");
  });

  it("survives a corrupt store file", async () => {
    const store = fileTrustStore(paths);
    await store.remember({ root: "C:\\ws", trust: "trusted", decidedAt: NOW });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(scratch, "userdata", "workspace-trust.json"), "{{{", "utf8");

    expect(await store.lookup("C:\\ws")).toBeNull();
    await store.remember({ root: "C:\\ws", trust: "trusted", decidedAt: NOW });
    expect(await store.lookup("C:\\ws")).toBe("trusted");
  });
});

describe("recent workspaces", () => {
  function entry(root: string, id = ID) {
    return { workspaceId: id, title: "T", root, lastOpenedAt: NOW };
  }

  it("starts empty", async () => {
    expect(await fileRecentStore(paths).list()).toEqual([]);
  });

  it("puts the newest entry first", async () => {
    const store = fileRecentStore(paths);
    await store.record(entry("C:\\a"));
    await store.record(entry("C:\\b"));
    expect((await store.list()).map((item) => item.root)).toEqual(["C:\\b", "C:\\a"]);
  });

  it("moves a repeated workspace to the front without duplicating it", async () => {
    const store = fileRecentStore(paths);
    await store.record(entry("C:\\a"));
    await store.record(entry("C:\\b"));
    await store.record(entry("C:\\a"));

    expect((await store.list()).map((item) => item.root)).toEqual(["C:\\a", "C:\\b"]);
  });

  it("keeps at most ten entries", async () => {
    const store = fileRecentStore(paths);
    for (let index = 0; index < 15; index += 1) await store.record(entry(`C:\\ws${index}`));
    expect(await store.list()).toHaveLength(10);
  });

  it("removes an entry", async () => {
    const store = fileRecentStore(paths);
    await store.record(entry("C:\\a"));
    await store.remove("C:\\A\\");
    expect(await store.list()).toEqual([]);
  });
});

describe("sync folder detection", () => {
  it.each([
    ["C:\\Users\\ana\\OneDrive\\Research", "onedrive"],
    ["C:\\Users\\ana\\Dropbox\\ws", "dropbox"],
    ["C:\\Users\\ana\\Google Drive\\ws", "google drive"],
  ])("flags %s", (root, hint) => {
    expect(detectSyncFolder(root)).toBe(hint);
  });

  it("returns null for an ordinary folder", () => {
    expect(detectSyncFolder("C:\\Research\\ws")).toBeNull();
  });
});
