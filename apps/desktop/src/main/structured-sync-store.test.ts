import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStructuredSyncStore } from "./structured-sync-store.js";

const hash = `sha256:${"a".repeat(64)}`;
let scratch = "";

afterEach(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

describe("structured synchronization store", () => {
  it("durably queues, acknowledges, and advances each workspace cursor", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-sync-store-"));
    const path = join(scratch, "sync.json");
    const store = createStructuredSyncStore(path);
    await store.queue("account-1", {
      workspace_id: "workspace-1",
      command_id: "command-1",
      object_id: "object-1",
      base_version: 0,
      base_hash: null,
      proposed: {
        version: 1,
        content_hash: hash,
        snapshot: { id: "object-1", version: 1, content_hash: hash },
      },
    });
    expect(await createStructuredSyncStore(path).pending("account-1", "workspace-1")).toHaveLength(
      1,
    );
    expect(await createStructuredSyncStore(path).pending("account-2", "workspace-1")).toEqual([]);
    expect(await createStructuredSyncStore(path).count("account-1")).toBe(1);
    await store.setCursor("account-1", "workspace-1", 8);
    await store.setCursor("account-1", "workspace-1", 4);
    expect(await store.cursor("account-1", "workspace-1")).toBe(8);
    expect(await store.cursor("account-2", "workspace-1")).toBe(0);
    const conflict = {
      status: "conflict" as const,
      sequence: 9,
      conflict_id: "conflict-1",
      object_id: "object-1",
      base_version: 0,
      base_hash: null,
      current: { version: 1, content_hash: hash, snapshot: { title: "Remote" } },
      incoming: { version: 1, content_hash: hash, snapshot: { title: "Local" } },
      replayed: false,
    };
    await store.recordConflict("account-1", "workspace-1", conflict);
    expect(await store.conflicts("account-1", "workspace-1")).toEqual([conflict]);
    expect(await store.conflicts("account-2", "workspace-1")).toEqual([]);
    await store.complete("account-2", "command-1");
    expect(await store.count("account-1")).toBe(1);
    await store.complete("account-1", "command-1");
    expect(await store.pending("account-1", "workspace-1")).toEqual([]);
    expect(await store.count("account-1")).toBe(0);
  });

  it("preserves legacy unassigned changes without exposing them to a signed-in account", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-sync-store-"));
    const path = join(scratch, "sync.json");
    const legacy = {
      workspace_id: "workspace-legacy",
      command_id: "command-legacy",
      object_id: "object-legacy",
      base_version: 0,
      base_hash: null,
      proposed: {
        version: 1,
        content_hash: hash,
        snapshot: { id: "object-legacy" },
      },
    };
    await writeFile(path, JSON.stringify({ outbox: [legacy], cursors: {}, conflicts: {} }));
    const store = createStructuredSyncStore(path);
    expect(await store.pending("account-1", "workspace-legacy")).toEqual([]);
    await store.setCursor("account-1", "workspace-legacy", 1);
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      outbox: Array<{ account_id: string }>;
    };
    expect(saved.outbox).toEqual([{ account_id: "legacy-unassigned", change: legacy }]);
  });
});
