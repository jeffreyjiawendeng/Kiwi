import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCollaborationOutbox } from "./collaboration-outbox.js";

describe("durable collaboration outbox", () => {
  it("survives recreation, deduplicates registration, and removes only acknowledged work", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-outbox-"));
    const path = join(root, "outbox.json");
    await createCollaborationOutbox(path).queueRegistration({
      account_id: "account-1",
      workspace_id: "w1",
      title: "First",
    });
    await createCollaborationOutbox(path).queueRegistration({
      account_id: "account-1",
      workspace_id: "w1",
      title: "Renamed",
    });
    await createCollaborationOutbox(path).queueRegistration({
      account_id: "account-2",
      workspace_id: "w2",
      title: "Other account",
    });
    const restarted = createCollaborationOutbox(path);
    expect(await restarted.count("account-1")).toBe(1);
    expect(await restarted.count("account-2")).toBe(1);
    const send = vi.fn(async () => true);
    await expect(restarted.flush("account-1", send)).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith({ workspace_id: "w1", title: "Renamed" });
    expect(await restarted.count("account-1")).toBe(0);
    expect(await restarted.count("account-2")).toBe(1);
  });

  it("counts what one workspace is waiting on, for a status line about that workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-outbox-"));
    const outbox = createCollaborationOutbox(join(root, "outbox.json"));
    await outbox.queueRegistration({ account_id: "a1", workspace_id: "w1", title: "First" });
    await outbox.queueRegistration({ account_id: "a1", workspace_id: "w2", title: "Second" });
    await outbox.queueRegistration({ account_id: "a2", workspace_id: "w1", title: "Somebody" });

    expect(await outbox.countFor("a1", "w1")).toBe(1);
    expect(await outbox.countFor("a1", "w3")).toBe(0);
  });

  it("preserves legacy unassigned registrations without sending them as another account", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-outbox-"));
    const path = join(root, "outbox.json");
    const legacy = { workspace_id: "legacy-workspace", title: "Legacy workspace" };
    await writeFile(path, JSON.stringify([legacy]));
    const outbox = createCollaborationOutbox(path);
    const send = vi.fn(async () => true);
    await expect(outbox.flush("account-1", send)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(path, "utf8")) as Array<{
      account_id: string;
    }>;
    expect(saved).toEqual([{ ...legacy, account_id: "legacy-unassigned" }]);
  });
});
