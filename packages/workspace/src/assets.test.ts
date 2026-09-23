import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { PROTOCOL_VERSION } from "@kiwi/contracts";
import { assetCommands } from "./asset-commands.js";
import { importManagedAsset } from "./assets.js";
import { recoverCanonicalTransactions } from "./canonical-transaction.js";
import { listCanonicalObjects } from "./objects.js";
import { createWorkspace } from "./store.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACTOR = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const NOW = "2026-08-22T12:00:00.000Z";
let scratch: string;
let sequence: number;

function nextId(): string {
  sequence += 1;
  return `0198c900-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function ids() {
  return {
    transactionId: nextId(),
    preparedEventId: nextId(),
    domainEventId: nextId(),
    committedEventId: nextId(),
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-assets-"));
  sequence = 0;
  await createWorkspace({
    root: join(scratch, "workspace"),
    workspaceId: WORKSPACE_ID,
    title: "Managed asset tests",
    now: NOW,
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function root(): string {
  return join(scratch, "workspace");
}

async function importFixture(sourcePath: string, faultAfterTarget?: number) {
  return importManagedAsset({
    root: root(),
    workspaceId: WORKSPACE_ID,
    assetId: nextId(),
    sourcePath,
    declaredMediaType: null,
    actor: ACTOR,
    requestId: nextId(),
    now: NOW,
    ...ids(),
    ...(faultAfterTarget === undefined ? {} : { faultAfterTarget }),
  });
}

describe("managed assets", () => {
  it("streams exact bytes into a managed path and records a hash-bound manifest", async () => {
    const source = join(scratch, "Field notes.txt");
    const bytes = Buffer.from("alpha\r\nbeta\n", "utf8");
    await writeFile(source, bytes);
    const receipt = await importFixture(source);
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    expect(receipt).toMatchObject({
      copied_bytes: bytes.length,
      duplicate_assets: [],
      asset: {
        title: "Field notes.txt",
        original_filename: "Field notes.txt",
        sha256: expectedHash,
        byte_size: bytes.length,
        media_type: { determined: "text/plain", evidence: "extension" },
        storage: { disposition: "managed" },
      },
    });
    const storedPath = join(root(), receipt.asset.storage.relative_path);
    expect(await readFile(storedPath)).toEqual(bytes);
    expect(receipt.manifest_hash).toBe(receipt.asset.content_hash);
    expect(
      (await listCanonicalObjects(root())).find((item) => item.id === receipt.asset.id),
    ).toEqual(receipt.asset);
    const events = await readFile(
      join(root(), ".kiwi", "events", "2026", "08", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"event_type":"asset.imported_managed"');
    expect(events).toContain(`"asset_sha256":"${expectedHash}"`);
  });

  it("reports byte-identical assets while preserving independent identities and copies", async () => {
    const source = join(scratch, "same.txt");
    await writeFile(source, "same bytes", "utf8");
    const first = await importFixture(source);
    const second = await importFixture(source);

    expect(second.asset.id).not.toBe(first.asset.id);
    expect(second.asset.storage.relative_path).not.toBe(first.asset.storage.relative_path);
    expect(second.duplicate_assets).toEqual([
      { asset_id: first.asset.id, title: first.asset.title, sha256: first.asset.sha256 },
    ]);
    await expect(access(join(root(), first.asset.storage.relative_path))).resolves.toBeUndefined();
    await expect(access(join(root(), second.asset.storage.relative_path))).resolves.toBeUndefined();
  });

  it("rolls back copied bytes and manifests after an interrupted atomic commit", async () => {
    const source = join(scratch, "interrupted.txt");
    await writeFile(source, "do not leave a partial import", "utf8");
    await expect(importFixture(source, 1)).rejects.toThrow("Injected canonical interruption");

    expect(await recoverCanonicalTransactions(root())).toMatchObject([{ action: "rolled_back" }]);
    expect((await listCanonicalObjects(root())).filter((item) => item.type === "asset")).toEqual(
      [],
    );
    expect(await readdir(join(root(), "assets"))).toEqual([]);
  });

  it("cancels before canonical mutation and removes acquisition staging", async () => {
    const source = join(scratch, "cancel.txt");
    await writeFile(source, "cancel this copy", "utf8");
    await expect(
      importManagedAsset({
        root: root(),
        workspaceId: WORKSPACE_ID,
        assetId: nextId(),
        sourcePath: source,
        declaredMediaType: "text/plain",
        actor: ACTOR,
        requestId: nextId(),
        now: NOW,
        signal: AbortSignal.abort(),
        ...ids(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect((await listCanonicalObjects(root())).filter((item) => item.type === "asset")).toEqual(
      [],
    );
    expect(await readdir(join(root(), ".kiwi", "transactions"))).toEqual([]);
  });
});

describe("managed asset command", () => {
  let gateway: Gateway;
  let revealFile = vi.fn<(root: string, relativePath: string) => Promise<void>>();
  let openFile = vi.fn<(root: string, relativePath: string) => Promise<void>>();

  beforeEach(() => {
    const registry = createRegistry();
    revealFile = vi.fn<(root: string, relativePath: string) => Promise<void>>();
    revealFile.mockResolvedValue(undefined);
    openFile = vi.fn<(root: string, relativePath: string) => Promise<void>>();
    openFile.mockResolvedValue(undefined);
    for (const command of assetCommands({ newId: nextId, now: () => NOW, revealFile, openFile }))
      registry.register(command);
    gateway = createGateway({ registry, newCorrelationId: () => "corr-asset" });
  });

  it("returns the canonical transaction receipt and duplicate warning", async () => {
    const source = join(scratch, "command.txt");
    await writeFile(source, "command bytes", "utf8");
    const invoke = () =>
      gateway.invoke(
        {
          protocol_version: PROTOCOL_VERSION,
          request_id: nextId(),
          workspace_id: WORKSPACE_ID,
          command: "kiwi.asset.import-managed",
          args: { root: root(), source_path: source, declared_media_type: "text/plain" },
        },
        {
          actor: { kind: "local_user", id: ACTOR },
          origin: { surface: "ui", extension_id: null },
        },
      );

    const first = await invoke();
    const second = await invoke();
    expect(first).toMatchObject({ status: "committed", event_ids: expect.any(Array) });
    expect(second.warnings).toEqual(["Kiwi found 1 existing logical asset with identical bytes."]);
    expect((second.data?.["asset"] as { created_by: string }).created_by).toBe(ACTOR);
  });

  it("returns an actionable not-found error when the brokered file disappears", async () => {
    const result = await gateway.invoke(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: nextId(),
        workspace_id: WORKSPACE_ID,
        command: "kiwi.asset.import-managed",
        args: {
          root: root(),
          source_path: join(scratch, "missing.txt"),
          declared_media_type: null,
        },
      },
      {
        actor: { kind: "local_user", id: ACTOR },
        origin: { surface: "ui", extension_id: null },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "KIWI_NOT_FOUND",
        message: "The selected file is no longer available. Choose it again.",
        recovery_actions: ["retry"],
      },
    });
  });

  it("reveals only the canonical managed path through its trusted dependency", async () => {
    const source = join(scratch, "reveal.txt");
    await writeFile(source, "reveal these bytes", "utf8");
    const imported = await gateway.invoke(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: nextId(),
        workspace_id: WORKSPACE_ID,
        command: "kiwi.asset.import-managed",
        args: { root: root(), source_path: source, declared_media_type: null },
      },
      {
        actor: { kind: "local_user", id: ACTOR },
        origin: { surface: "ui", extension_id: null },
      },
    );
    const asset = imported.data?.["asset"] as {
      id: string;
      storage: { relative_path: string };
    };
    const revealed = await gateway.invoke(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: nextId(),
        workspace_id: WORKSPACE_ID,
        command: "kiwi.asset.reveal-managed",
        args: { root: root(), asset_id: asset.id },
      },
      {
        actor: { kind: "local_user", id: ACTOR },
        origin: { surface: "ui", extension_id: null },
      },
    );

    expect(revealed.status).toBe("no_change");
    expect(revealFile).toHaveBeenCalledWith(root(), asset.storage.relative_path);
    expect(JSON.stringify(revealed.data)).not.toContain(source);
  });

  /** Imports one file and returns the asset the command wrote, the way the interface would. */
  async function imported(filename: string, contents = "some bytes") {
    const source = join(scratch, filename);
    await writeFile(source, contents, "utf8");
    const result = await gateway.invoke(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: nextId(),
        workspace_id: WORKSPACE_ID,
        command: "kiwi.asset.import-managed",
        args: { root: root(), source_path: source, declared_media_type: null },
      },
      {
        actor: { kind: "local_user", id: ACTOR },
        origin: { surface: "ui", extension_id: null },
      },
    );
    return result.data?.["asset"] as { id: string; storage: { relative_path: string } };
  }

  function open(assetId: string) {
    return gateway.invoke(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: nextId(),
        workspace_id: WORKSPACE_ID,
        command: "kiwi.asset.open-managed",
        args: { root: root(), asset_id: assetId },
      },
      {
        actor: { kind: "local_user", id: ACTOR },
        origin: { surface: "ui", extension_id: null },
      },
    );
  }

  it("hands the managed path to the system and changes nothing", async () => {
    const asset = await imported("readable.pdf");

    const result = await open(asset.id);

    expect(result.status).toBe("no_change");
    expect(openFile).toHaveBeenCalledWith(root(), asset.storage.relative_path);
  });

  it("will not hand the system a file the system would run", async () => {
    // The escape hatch exists so that a document can be read outside Kiwi. A workspace folder is
    // synced and shared, so a file in one is not necessarily a file this person put there, and
    // "open it" must never be able to mean "run it".
    const asset = await imported("setup.bat", "echo hello");

    const result = await open(asset.id);

    expect(result).toMatchObject({ status: "failed", error: { code: "KIWI_PATH_DENIED" } });
    expect(openFile).not.toHaveBeenCalled();
  });

  it("refuses a file the workspace folder no longer holds", async () => {
    const asset = await imported("gone.pdf");
    await rm(join(root(), asset.storage.relative_path));

    const result = await open(asset.id);

    expect(result).toMatchObject({ status: "failed", error: { code: "KIWI_NOT_FOUND" } });
    expect(openFile).not.toHaveBeenCalled();
  });

  it("reports a refusal from the system without repeating the path it names", async () => {
    const asset = await imported("unopenable.pdf");
    const absolute = join(root(), asset.storage.relative_path);
    openFile.mockRejectedValue(new Error(`Failed to open path ${absolute}`));

    const result = await open(asset.id);

    expect(result).toMatchObject({ status: "failed", error: { code: "KIWI_UNAVAILABLE" } });
    // A path is the one thing the interface never learns: it names the machine this workspace
    // sits on, and every command it sends has its root filled in for it by the main process.
    expect(JSON.stringify(result)).not.toContain("Failed to open path");
    expect(result.error?.message).toBe(
      "The system would not open this file. There may be no application set up for this kind of file.",
    );
  });
});
