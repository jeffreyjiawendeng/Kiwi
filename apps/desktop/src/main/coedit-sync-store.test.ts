import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoeditSyncStore } from "./coedit-sync-store.js";

let scratch = "";

afterEach(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

describe("coediting synchronization store", () => {
  it("durably queues operations, known documents, and monotonic cursors", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-coedit-store-"));
    const path = join(scratch, "coedit.json");
    const store = createCoeditSyncStore(path);
    const operation = {
      document_id: "document-1",
      operation_id: "operation-1",
      actor_id: "account:a",
      lamport: 1,
      kind: "insert" as const,
      after_id: null,
      text: "Finding",
    };
    await store.queue("account-1", {
      workspace_id: "workspace-1",
      document_id: "document-1",
      operations: [operation],
    });
    await store.queue("account-1", {
      workspace_id: "workspace-1",
      document_id: "document-1",
      operations: [operation],
    });
    const restored = createCoeditSyncStore(path);
    expect(await restored.pending("account-1", "workspace-1")).toHaveLength(1);
    expect(await restored.pending("account-2", "workspace-1")).toEqual([]);
    expect(await restored.count("account-1")).toBe(1);
    expect(await restored.documents("account-1", "workspace-1")).toEqual(["document-1"]);
    expect(await restored.documents("account-2", "workspace-1")).toEqual([]);
    await restored.setCursor("account-1", "workspace-1", "document-1", 7);
    await restored.setCursor("account-1", "workspace-1", "document-1", 3);
    expect(await restored.cursor("account-1", "workspace-1", "document-1")).toBe(7);
    expect(await restored.cursor("account-2", "workspace-1", "document-1")).toBe(0);
    await restored.complete("account-2", ["operation-1"]);
    expect(await restored.count("account-1")).toBe(1);
    await restored.complete("account-1", ["operation-1"]);
    expect(await restored.pending("account-1", "workspace-1")).toEqual([]);
    expect(await restored.count("account-1")).toBe(0);
  });

  it("preserves legacy unassigned operations without exposing them to a signed-in account", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-coedit-store-"));
    const path = join(scratch, "coedit.json");
    const legacy = {
      workspace_id: "workspace-legacy",
      document_id: "document-legacy",
      operations: [
        {
          document_id: "document-legacy",
          operation_id: "operation-legacy",
          actor_id: "account:legacy",
          lamport: 1,
          kind: "insert",
          after_id: null,
          text: "Legacy",
        },
      ],
    };
    await writeFile(path, JSON.stringify({ outbox: [legacy], cursors: {}, documents: {} }));
    const store = createCoeditSyncStore(path);
    expect(await store.pending("account-1", "workspace-legacy")).toEqual([]);
    await store.rememberDocument("account-1", "workspace-1", "document-1");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      outbox: Array<{ account_id: string }>;
    };
    expect(saved.outbox).toEqual([{ account_id: "legacy-unassigned", batch: legacy }]);
  });
});
