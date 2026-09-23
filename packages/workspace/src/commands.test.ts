import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type CommandEnvelope, type WorkspaceSummary } from "@kiwi/contracts";
import { createGateway, createRegistry, type CallerContext, type Gateway } from "@kiwi/commands";
import { workspaceCommands } from "./commands.js";
import { fileRecentStore, fileTrustStore, type SessionPaths } from "./session.js";

const UI: CallerContext = {
  actor: { kind: "local_user", id: "actor:local/default" },
  origin: { surface: "ui", extension_id: null },
};
const NOW = "2026-08-22T10:00:00.000Z";

let scratch: string;
let gateway: Gateway;
let ids: number;

function envelope(command: string, args: Record<string, unknown>): CommandEnvelope {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: crypto.randomUUID(),
    command,
    args,
  };
}

async function run(command: string, args: Record<string, unknown>) {
  return gateway.invoke(envelope(command, args), UI);
}

function workspaceOf(data: Record<string, unknown> | undefined): WorkspaceSummary {
  return (data ?? {})["workspace"] as WorkspaceSummary;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-wscmd-"));
  ids = 0;
  const paths: SessionPaths = {
    workspaceState: (id) => join(scratch, "state", id),
    userData: () => join(scratch, "userdata"),
  };
  const registry = createRegistry();
  for (const definition of workspaceCommands({
    trust: fileTrustStore(paths),
    recent: fileRecentStore(paths),
    newWorkspaceId: () => `0198c7c1-4e7d-7e31-a23a-8242${String((ids += 1)).padStart(8, "0")}`,
    now: () => NOW,
  })) {
    registry.register(definition);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-1" });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function root(name = "ws"): string {
  return join(scratch, name);
}

describe("kiwi.workspace.create", () => {
  it("creates a ready trusted workspace", async () => {
    const result = await run("kiwi.workspace.create", { root: root(), title: "Trial" });

    expect(result.status).toBe("committed");
    expect(workspaceOf(result.data)).toMatchObject({
      title: "Trial",
      status: "ready",
      trust: "trusted",
      writable: true,
    });
  });

  it("rejects an empty title through schema validation", async () => {
    const result = await run("kiwi.workspace.create", { root: root(), title: "" });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("rejects a title that contains only whitespace", async () => {
    const result = await run("kiwi.workspace.create", { root: root(), title: "   " });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("normalizes the title and writes explicit locale defaults", async () => {
    const result = await run("kiwi.workspace.create", {
      root: root(),
      title: "  Cafe\u0301 notes  ",
    });
    const manifest = JSON.parse(
      await readFile(join(root(), "kiwi.workspace.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(workspaceOf(result.data).title).toBe("Café notes");
    expect(manifest).toMatchObject({
      title: "Café notes",
      default_locale: "en-US",
      default_time_zone: "UTC",
    });
  });

  it("reports an existing workspace with a specific code", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const again = await run("kiwi.workspace.create", { root: root(), title: "Trial" });

    expect(again.error?.code).toBe("KIWI_WORKSPACE_EXISTS");
    expect(again.error?.recovery_actions).toEqual(["correct_input"]);
  });

  it("reports a relative path as denied without echoing it", async () => {
    const result = await run("kiwi.workspace.create", { root: "relative/path", title: "T" });

    expect(result.error?.code).toBe("KIWI_PATH_DENIED");
    expect(result.error?.details).toMatchObject({ reason: "not_absolute" });
    expect(JSON.stringify(result.error)).not.toContain("relative/path");
  });

  it("rejects a path too short to be a root before reaching the filesystem", async () => {
    const result = await run("kiwi.workspace.create", { root: "C", title: "T" });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("adds the new workspace to the recent list", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const recent = await run("kiwi.workspace.recent", {});

    const list = (recent.data ?? {})["recent"] as { title: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Trial");
  });
});

describe("kiwi.workspace.forget", () => {
  async function created(name: string, title: string) {
    const result = await run("kiwi.workspace.create", { root: root(name), title });
    return workspaceOf(result.data);
  }

  it("takes the workspace off the list and leaves the folder alone", async () => {
    const kept = await created("kept", "Kept");
    const gone = await created("gone", "Gone");

    const result = await run("kiwi.workspace.forget", { workspace_id: gone.workspaceId });

    expect((result.data ?? {})["forgotten"]).toBe("Gone");
    const list = ((result.data ?? {})["recent"] as { workspaceId: string }[]).map(
      (item) => item.workspaceId,
    );
    expect(list).toEqual([kept.workspaceId]);
    // The point of the whole command: the records are files, and they are still there.
    await expect(readFile(join(root("gone"), "kiwi.workspace.json"), "utf8")).resolves.toContain(
      "Gone",
    );
  });

  it("treats a workspace it does not have as already forgotten", async () => {
    await created("kept", "Kept");

    const result = await run("kiwi.workspace.forget", { workspace_id: "not-a-workspace" });

    expect(result.status).toBe("no_change");
    expect((result.data ?? {})["forgotten"]).toBeNull();
  });

  it("puts it back on the list when it is opened again", async () => {
    const gone = await created("gone", "Gone");
    await run("kiwi.workspace.forget", { workspace_id: gone.workspaceId });

    await run("kiwi.workspace.open", { root: root("gone") });

    const list = ((await run("kiwi.workspace.recent", {})).data ?? {})["recent"] as unknown[];
    expect(list).toHaveLength(1);
  });
});

describe("kiwi.workspace.rename", () => {
  it("updates the canonical manifest and returns the renamed workspace", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const result = await run("kiwi.workspace.rename", { root: root(), title: "Renamed" });

    expect(result.status).toBe("committed");
    expect(workspaceOf(result.data)).toMatchObject({ title: "Renamed", status: "ready" });
    expect(JSON.parse(await readFile(join(root(), "kiwi.workspace.json"), "utf8"))).toMatchObject({
      title: "Renamed",
    });
  });
});

describe("kiwi.workspace.open", () => {
  it("opens a workspace it created as trusted", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const result = await run("kiwi.workspace.open", { root: root() });

    expect(workspaceOf(result.data)).toMatchObject({ trust: "trusted", writable: true });
    expect((result.data ?? {})["trustDecided"]).toBe(true);
  });

  it("opens an unseen workspace restricted until the user decides", async () => {
    await run("kiwi.workspace.create", { root: root("a"), title: "A" });
    // A different folder holding a workspace Kiwi has no trust record for.
    const { cp } = await import("node:fs/promises");
    await cp(root("a"), root("b"), { recursive: true });

    const result = await run("kiwi.workspace.open", { root: root("b") });

    expect(workspaceOf(result.data)).toMatchObject({ trust: "restricted", writable: false });
    expect((result.data ?? {})["trustDecided"]).toBe(false);
  });

  it("reports a folder that is not a workspace", async () => {
    await mkdir(root(), { recursive: true });
    const result = await run("kiwi.workspace.open", { root: root() });

    expect(workspaceOf(result.data).status).toBe("workspace_missing");
    expect(workspaceOf(result.data).writable).toBe(false);
  });

  it("flags a synchronizing folder", async () => {
    const synced = join(scratch, "OneDrive", "ws");
    await run("kiwi.workspace.create", { root: synced, title: "Synced" });
    const result = await run("kiwi.workspace.open", { root: synced });

    expect((result.data ?? {})["syncHint"]).toBe("onedrive");
  });
});

describe("kiwi.workspace.set-trust", () => {
  it("makes a restricted workspace writable", async () => {
    await run("kiwi.workspace.create", { root: root("a"), title: "A" });
    const { cp } = await import("node:fs/promises");
    await cp(root("a"), root("b"), { recursive: true });

    expect(workspaceOf((await run("kiwi.workspace.open", { root: root("b") })).data).writable).toBe(
      false,
    );

    const trusted = await run("kiwi.workspace.set-trust", { root: root("b"), trust: "trusted" });
    expect(workspaceOf(trusted.data).writable).toBe(true);
  });

  it("revokes trust again", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const revoked = await run("kiwi.workspace.set-trust", { root: root(), trust: "restricted" });

    expect(workspaceOf(revoked.data)).toMatchObject({ trust: "restricted", writable: false });
  });

  it("rejects a trust value outside the vocabulary", async () => {
    const result = await run("kiwi.workspace.set-trust", { root: root(), trust: "maybe" });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("kiwi.workspace.health", () => {
  it("reports a healthy workspace", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const result = await run("kiwi.workspace.health", { root: root() });

    expect((result.data ?? {})["health"]).toMatchObject({
      status: "ready",
      manifestPresent: true,
      missingDirectories: [],
      pendingTransactions: 0,
    });
  });

  it("does not change the workspace", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    await rm(join(root(), "views"), { recursive: true });

    await run("kiwi.workspace.health", { root: root() });
    const second = await run("kiwi.workspace.health", { root: root() });

    expect(
      ((second.data ?? {})["health"] as { missingDirectories: string[] }).missingDirectories,
    ).toEqual(["views"]);
  });

  it("is available to the local api surface", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const result = await gateway.invoke(envelope("kiwi.workspace.health", { root: root() }), {
      actor: { kind: "automation", id: "actor:api" },
      origin: { surface: "api", extension_id: null },
    });
    expect(result.status).toBe("committed");
  });

  it("is not available to an extension", async () => {
    const result = await gateway.invoke(
      envelope("kiwi.workspace.create", { root: root(), title: "T" }),
      {
        actor: { kind: "extension", id: "ext:x" },
        origin: { surface: "extension", extension_id: "ext:x" },
      },
    );
    expect(result.error?.code).toBe("KIWI_FORBIDDEN");
  });
});

describe("kiwi.workspace.repair-layout", () => {
  it("recreates missing folders and reports which", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    await rm(join(root(), "assets"), { recursive: true });

    const result = await run("kiwi.workspace.repair-layout", { root: root() });

    expect(result.status).toBe("committed");
    expect((result.data ?? {})["repaired"]).toEqual(["assets"]);
  });

  it("reports no change when nothing is missing", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const result = await run("kiwi.workspace.repair-layout", { root: root() });

    expect(result.status).toBe("no_change");
    expect((result.data ?? {})["repaired"]).toEqual([]);
  });

  it("refuses a folder that is not a workspace", async () => {
    await mkdir(root(), { recursive: true });
    const result = await run("kiwi.workspace.repair-layout", { root: root() });
    expect(result.error?.code).toBe("KIWI_WORKSPACE_NOT_FOUND");
  });

  it("leaves a damaged manifest alone", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    await writeFile(join(root(), "kiwi.workspace.json"), "{ broken", "utf8");

    const health = await run("kiwi.workspace.health", { root: root() });
    expect(((health.data ?? {})["health"] as { status: string }).status).toBe("repair_required");
  });
});

describe("kiwi.workspace.recover-transactions", () => {
  it("quarantines unreadable recovery data and writes an authenticated audit event", async () => {
    await run("kiwi.workspace.create", { root: root(), title: "Trial" });
    const brokenId = "0198c800-0000-7000-8000-000000000099";
    const transaction = join(root(), ".kiwi", "transactions", brokenId);
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "manifest.json"), "{broken", "utf8");

    const request = envelope("kiwi.workspace.recover-transactions", { root: root() });
    request.workspace_id = workspaceOf(
      (await run("kiwi.workspace.open", { root: root() })).data,
    ).workspaceId;
    const result = await gateway.invoke(request, UI);

    expect(result.status).toBe("committed");
    expect(result.event_ids).toHaveLength(1);
    await expect(
      readFile(join(root(), ".kiwi", "recovery", "quarantine", brokenId, "manifest.json"), "utf8"),
    ).resolves.toBe("{broken");
    const events = await readFile(
      join(root(), ".kiwi", "events", "2026", "08", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"event_type":"transaction.recovered"');
    expect(events).toContain('"actor":"actor:local/default"');
    expect(
      ((await run("kiwi.workspace.health", { root: root() })).data ?? {})["health"],
    ).toMatchObject({ pendingTransactions: 0 });
  });
});
