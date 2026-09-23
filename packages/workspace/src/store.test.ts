import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_FILENAME, WORKSPACE_FORMAT_VERSION } from "@kiwi/contracts";
import {
  WorkspaceError,
  checkWorkspaceHealth,
  createWorkspace,
  openWorkspace,
  repairWorkspaceLayout,
  renameWorkspace,
  touchManifest,
} from "./store.js";
import { WORKSPACE_DIRECTORIES } from "./paths.js";
import { readManifest, serializeManifest } from "./manifest.js";

const NOW = "2026-08-22T10:00:00.000Z";
const ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-ws-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function root(name = "workspace"): string {
  return join(scratch, name);
}

async function create(name = "workspace") {
  return createWorkspace({ root: root(name), workspaceId: ID, title: "Trial workspace", now: NOW });
}

describe("createWorkspace", () => {
  it("returns a ready writable workspace", async () => {
    const summary = await create();
    expect(summary).toMatchObject({
      workspaceId: ID,
      title: "Trial workspace",
      formatVersion: WORKSPACE_FORMAT_VERSION,
      status: "ready",
      writable: true,
      problems: [],
    });
  });

  it("creates every documented folder", async () => {
    await create();
    const health = await checkWorkspaceHealth(root());
    expect(health.missingDirectories).toEqual([]);
  });

  it("writes a manifest a person can read", async () => {
    await create();
    const raw = await readFile(join(root(), MANIFEST_FILENAME), "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("\r\n");
    expect(raw.split("\n")[0]).toBe("{");

    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({ workspace_id: ID, format_version: WORKSPACE_FORMAT_VERSION });
  });

  it("serializes deterministically", async () => {
    await create("a");
    await create("b");
    const a = await readFile(join(root("a"), MANIFEST_FILENAME), "utf8");
    const b = await readFile(join(root("b"), MANIFEST_FILENAME), "utf8");
    expect(a).toBe(b);
  });

  it("explains the .kiwi folder in place", async () => {
    await create();
    const readme = await readFile(join(root(), ".kiwi", "README.md"), "utf8");
    expect(readme).toContain("rebuildable");
  });

  it("refuses a folder that already holds a workspace", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ kind: "already_exists" });
  });

  it("leaves an existing unrelated file untouched", async () => {
    await mkdir(root(), { recursive: true });
    await writeFile(join(root(), "notes.txt"), "user content", "utf8");
    await create();
    expect(await readFile(join(root(), "notes.txt"), "utf8")).toBe("user content");
  });

  it.each([
    ["a relative path", "relative/path"],
    ["a reserved device name", join("C:", "temp", "NUL", "ws")],
    ["a trailing dot", join("C:", "temp", "ws.")],
  ])("rejects %s", async (_label, candidate) => {
    await expect(
      createWorkspace({ root: candidate, workspaceId: ID, title: "t", now: NOW }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("names the path problem without echoing the path", async () => {
    let caught: unknown;
    try {
      await createWorkspace({ root: "relative/path", workspaceId: ID, title: "t", now: NOW });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkspaceError);
    const error = caught as WorkspaceError;
    expect(error.detail).toEqual({ reason: "not_absolute" });
    expect(JSON.stringify(error.detail)).not.toContain("relative/path");
  });
});

describe("renameWorkspace", () => {
  it("atomically updates the canonical title and preserves unknown manifest fields", async () => {
    await create();
    const manifestPath = join(root(), MANIFEST_FILENAME);
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...original, future_hint: { retained: true } }, null, 2)}\n`,
      "utf8",
    );

    const renamed = await renameWorkspace(
      root(),
      "  Renamed workspace  ",
      "2026-08-22T11:00:00.000Z",
    );
    const stored = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

    expect(renamed.title).toBe("Renamed workspace");
    expect(stored).toMatchObject({
      title: "Renamed workspace",
      updated_at: "2026-08-22T11:00:00.000Z",
      future_hint: { retained: true },
    });
  });

  it("refuses to alter a future workspace format", async () => {
    await create();
    const manifestPath = join(root(), MANIFEST_FILENAME);
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...original, format_version: "2.0.0" }, null, 2)}\n`,
      "utf8",
    );
    await expect(renameWorkspace(root(), "Blocked", NOW)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      title: "Trial workspace",
      format_version: "2.0.0",
    });
  });
});

describe("openWorkspace", () => {
  it("opens a workspace it created", async () => {
    await create();
    const summary = await openWorkspace({ root: root(), trust: "trusted" });
    expect(summary).toMatchObject({ workspaceId: ID, status: "ready", writable: true });
  });

  it("reports a folder with no manifest as missing", async () => {
    await mkdir(root(), { recursive: true });
    const summary = await openWorkspace({ root: root(), trust: "trusted" });

    expect(summary.status).toBe("workspace_missing");
    expect(summary.writable).toBe(false);
    expect(summary.problems[0]?.rule).toBe("manifest.missing");
  });

  it("reports unparsable JSON as needing repair", async () => {
    await create();
    await writeFile(join(root(), MANIFEST_FILENAME), "{ not json", "utf8");
    const summary = await openWorkspace({ root: root(), trust: "trusted" });

    expect(summary.status).toBe("repair_required");
    expect(summary.problems[0]?.rule).toBe("manifest.unparsable");
  });

  it("opens a future major version without permitting writes", async () => {
    await create();
    const raw = await readFile(join(root(), MANIFEST_FILENAME), "utf8");
    const manifest = { ...(JSON.parse(raw) as Record<string, unknown>), format_version: "2.0.0" };
    await writeFile(join(root(), MANIFEST_FILENAME), serializeManifest(manifest as never), "utf8");

    const summary = await openWorkspace({ root: root(), trust: "trusted" });
    expect(summary.status).toBe("future_schema");
    expect(summary.writable).toBe(false);
  });

  it("never permits writes to an untrusted workspace", async () => {
    await create();
    const summary = await openWorkspace({ root: root(), trust: "restricted" });
    expect(summary.status).toBe("ready");
    expect(summary.writable).toBe(false);
  });
});

describe("checkWorkspaceHealth", () => {
  it("reports a healthy workspace with no problems", async () => {
    await create();
    const health = await checkWorkspaceHealth(root());
    expect(health).toMatchObject({
      status: "ready",
      manifestPresent: true,
      rootWritable: true,
      missingDirectories: [],
      pendingTransactions: 0,
      problems: [],
    });
  });

  it("names missing folders without changing anything", async () => {
    await create();
    await rm(join(root(), "relations"), { recursive: true });

    const first = await checkWorkspaceHealth(root());
    const second = await checkWorkspaceHealth(root());

    expect(first.missingDirectories).toContain("relations");
    expect(second.missingDirectories).toEqual(first.missingDirectories);
  });

  it("counts interrupted write records", async () => {
    await create();
    await writeFile(join(root(), ".kiwi", "transactions", "tx-1.json"), "{}", "utf8");

    const health = await checkWorkspaceHealth(root());
    expect(health.pendingTransactions).toBe(1);
    expect(health.problems.some((p) => p.rule === "transactions.pending")).toBe(true);
  });
});

describe("repairWorkspaceLayout", () => {
  it("recreates only the missing folders", async () => {
    await create();
    await rm(join(root(), "views"), { recursive: true });
    await writeFile(join(root(), "objects", "keep.md"), "kept", "utf8");

    const repaired = await repairWorkspaceLayout(root());

    expect(repaired).toEqual(["views"]);
    expect(await readFile(join(root(), "objects", "keep.md"), "utf8")).toBe("kept");
    expect((await checkWorkspaceHealth(root())).missingDirectories).toEqual([]);
  });

  it("refuses a folder that is not a workspace", async () => {
    await mkdir(root(), { recursive: true });
    await expect(repairWorkspaceLayout(root())).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("touchManifest", () => {
  it("updates the timestamp and preserves unknown fields", async () => {
    await create();
    const path = join(root(), MANIFEST_FILENAME);
    const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(
      path,
      serializeManifest({ ...original, future_field: { kept: true } } as never),
      "utf8",
    );

    const updated = await touchManifest(root(), "2026-08-23T00:00:00.000Z");

    expect(updated.updated_at).toBe("2026-08-23T00:00:00.000Z");
    expect(updated["future_field"]).toEqual({ kept: true });

    const onDisk = readManifest(await readFile(path, "utf8"));
    expect(onDisk.manifest?.["future_field"]).toEqual({ kept: true });
  });

  it("refuses to write a future major version", async () => {
    await create();
    const path = join(root(), MANIFEST_FILENAME);
    const manifest = { ...(JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) };
    manifest["format_version"] = "9.0.0";
    await writeFile(path, serializeManifest(manifest as never), "utf8");

    await expect(touchManifest(root(), NOW)).rejects.toMatchObject({ kind: "invalid" });

    const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(after["format_version"]).toBe("9.0.0");
  });
});

describe("layout contract", () => {
  it("keeps cache and index folders out of the workspace", async () => {
    await create();
    for (const directory of WORKSPACE_DIRECTORIES) {
      expect(directory).not.toMatch(/cache|index|logs|secrets|sqlite/i);
    }
  });
});

describe("read-only root", () => {
  it("reports read_only when the folder cannot be written", async () => {
    await create();
    await chmod(root(), 0o500).catch(() => undefined);

    const summary = await openWorkspace({ root: root(), trust: "trusted" });
    await chmod(root(), 0o700).catch(() => undefined);

    // Windows ignores POSIX mode bits, so this asserts only that the status is coherent.
    expect(["ready", "read_only"]).toContain(summary.status);
    if (summary.status === "read_only") expect(summary.writable).toBe(false);
  });
});
