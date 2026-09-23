import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryDraftStore, type RecoveryDraft } from "./recovery-draft-store.js";

let scratch = "";

afterEach(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

function draft(overrides: Partial<RecoveryDraft> = {}): RecoveryDraft {
  return {
    schema_version: 1,
    actor_id: "account:test",
    workspace_id: "workspace-1",
    object_id: "object-1",
    base_version: 2,
    base_hash: `sha256:${"a".repeat(64)}`,
    title: "Recovered title",
    content: "Recovered content",
    updated_at: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("recovery draft store", () => {
  it("persists one exact-base draft per object and replaces it atomically", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-drafts-"));
    const filePath = join(scratch, "recovery-drafts.json");
    const store = createRecoveryDraftStore(filePath);

    await store.save(draft());
    await store.save(
      draft({
        base_version: 3,
        base_hash: `sha256:${"b".repeat(64)}`,
        content: "Newer recovery content",
      }),
    );

    await expect(store.read("account:test", "workspace-1", "object-1")).resolves.toMatchObject({
      base_version: 3,
      content: "Newer recovery content",
    });
    await expect(store.read("account:other", "workspace-1", "object-1")).resolves.toBeNull();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      schema_version: 1,
      drafts: [{ object_id: "object-1", base_version: 3 }],
    });
  });

  it("discards only the draft with the matching base guard", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-drafts-"));
    const store = createRecoveryDraftStore(join(scratch, "recovery-drafts.json"));
    await store.save(draft());

    await expect(
      store.discard("account:test", "workspace-1", "object-1", 1, `sha256:${"f".repeat(64)}`),
    ).resolves.toBe(false);
    await expect(store.read("account:test", "workspace-1", "object-1")).resolves.not.toBeNull();
    await expect(
      store.discard("account:test", "workspace-1", "object-1", 2, `sha256:${"a".repeat(64)}`),
    ).resolves.toBe(true);
    await expect(store.read("account:test", "workspace-1", "object-1")).resolves.toBeNull();
  });

  it("does not silently replace malformed recovery storage", async () => {
    scratch = await mkdtemp(join(tmpdir(), "kiwi-drafts-"));
    const filePath = join(scratch, "recovery-drafts.json");
    await writeFile(filePath, "not json", "utf8");
    const store = createRecoveryDraftStore(filePath);

    await expect(store.save(draft())).rejects.toThrow();
    await expect(readFile(filePath, "utf8")).resolves.toBe("not json");
  });
});
