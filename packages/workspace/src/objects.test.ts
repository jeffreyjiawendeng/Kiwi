import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./store.js";
import {
  ObjectHistoryCorruptionError,
  ObjectCaptureContextConflict,
  ObjectPublicationValidationError,
  ObjectTrashCorruptionError,
  ObjectTrashConflict,
  ObjectVersionConflict,
  ThreadMessageNotYours,
  addThreadReply,
  assignObjectToProject,
  createInboxItem,
  createProject,
  createRelation,
  createThread,
  editThreadMessage,
  listThreads,
  moveThreadAnchor,
  setThreadStatus,
  listCanonicalObjects,
  listTrash,
  objectActivity,
  objectHistory,
  previewTrashCleanupPolicy,
  previewTrashPurge,
  publishObject,
  purgeTrash,
  quickCapture,
  readCanonicalObject,
  readObjectVersion,
  readTrashCleanupPolicy,
  relationsForObject,
  restoreTrashedObject,
  restoreObjectVersion,
  setTrashCleanupPolicy,
  trashObject,
  verifyObjectHash,
  type CanonicalObject,
} from "./objects.js";
import { recoverCanonicalTransactions } from "./canonical-transaction.js";
import { defaultProjectSettings, readThread, type ThreadAnchor } from "@kiwi/contracts";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const OBJECT_A = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
const OBJECT_B = "0198c7c4-5d43-71b7-a135-42494e1e51d4";
const ACTOR = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
let scratch: string;
let sequence: number;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-objects-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Canonical object tests",
    now: "2026-08-22T12:00:00.000Z",
  });
});

describe("workspace Trash", () => {
  async function relatedFixture() {
    const first = await create(OBJECT_A, "Source object");
    const second = await create(OBJECT_B, "Related object");
    const relation = await createRelation({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "supports",
      subjectId: first.id,
      objectId: second.id,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });
    return { first, second, relation };
  }

  it("moves a referenced object to Trash and restores its identity and relations", async () => {
    const { first, relation } = await relatedFixture();
    const trashed = await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [
        {
          relation_id: relation.id,
          version: relation.version,
          content_hash: relation.content_hash,
        },
      ],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });

    expect(trashed.impact).toMatchObject({
      relation_count: 1,
      related_object_count: 1,
      outgoing_count: 1,
    });
    expect(await readCanonicalObject(scratch, first.id)).toBeNull();
    expect(await relationsForObject(scratch, first.id)).toEqual([]);
    expect((await relationsForObject(scratch, first.id, true))[0]?.relation).toMatchObject({
      id: relation.id,
      assertion: "retracted",
      version: 2,
    });
    expect(await listTrash(scratch)).toMatchObject([
      {
        object: { id: first.id, content_hash: first.content_hash },
        manifest: {
          original_path: expect.stringContaining(first.id),
          relations: [{ prior: relation }],
        },
      },
    ]);

    const restored = await restoreTrashedObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:05:00.000Z",
      ...ids(),
    });
    expect(restored).toMatchObject({
      object: {
        id: first.id,
        version: 2,
        restored_from_trash_event: trashed.manifest.deletion_event_id,
      },
      restored_relation_count: 1,
    });
    expect((await relationsForObject(scratch, first.id))[0]?.relation).toMatchObject({
      id: relation.id,
      assertion: "asserted",
      version: 3,
    });
    expect(await listTrash(scratch)).toEqual([]);
  });

  it("rolls an interrupted Trash transaction back to the prior object and relation", async () => {
    const { first, relation } = await relatedFixture();
    await expect(
      trashObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        expectedRelations: [
          {
            relation_id: relation.id,
            version: relation.version,
            content_hash: relation.content_hash,
          },
        ],
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:04:00.000Z",
        faultAfterTarget: 3,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");

    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    expect((await readCanonicalObject(scratch, first.id))?.object).toEqual(first);
    expect((await relationsForObject(scratch, first.id))[0]?.relation).toEqual(relation);
    expect(await listTrash(scratch)).toEqual([]);
  });

  it("rejects a damaged Trash snapshot instead of offering an unsafe restore", async () => {
    const first = await create();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });
    await writeFile(join(scratch, ".kiwi", "trash", first.id, "object.json"), "{}\n");
    await expect(listTrash(scratch)).rejects.toBeInstanceOf(ObjectTrashCorruptionError);
  });

  it("requires a new impact review when relations change before deletion", async () => {
    const { first, second, relation } = await relatedFixture();
    await createRelation({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "cites",
      subjectId: second.id,
      objectId: first.id,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });
    await expect(
      trashObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        expectedRelations: [
          {
            relation_id: relation.id,
            version: relation.version,
            content_hash: relation.content_hash,
          },
        ],
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:05:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectTrashConflict);
    expect((await readCanonicalObject(scratch, first.id))?.object).toEqual(first);
  });

  it("keeps the Trash entry recoverable when restoration is interrupted", async () => {
    const first = await create();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });
    await expect(
      restoreTrashedObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:05:00.000Z",
        faultAfterTarget: 1,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");

    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    expect(await readCanonicalObject(scratch, first.id)).toBeNull();
    expect(await listTrash(scratch)).toMatchObject([{ object: { id: first.id } }]);
  });

  it("keeps age cleanup off by default and saves a reviewed policy without deleting", async () => {
    const first = await create();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-07-01T12:00:00.000Z",
      ...ids(),
    });

    expect(await readTrashCleanupPolicy(scratch)).toEqual({
      enabled: false,
      minimum_age_days: 30,
    });
    await expect(
      previewTrashPurge({ root: scratch, scope: "age", now: "2026-08-22T12:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ObjectTrashConflict);

    const preview = await previewTrashCleanupPolicy({
      root: scratch,
      policy: { enabled: true, minimum_age_days: 30 },
      now: "2026-08-22T12:00:00.000Z",
    });
    expect(preview).toMatchObject({
      eligible_count: 1,
      eligible_entries: [{ object_id: first.id, title: first.title }],
    });
    await expect(
      setTrashCleanupPolicy({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        policy: preview.policy,
        previewToken: preview.preview_token,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:00:00.000Z",
        ...ids(),
      }),
    ).resolves.toEqual({ policy: preview.policy, changed: true });
    expect(await readTrashCleanupPolicy(scratch)).toEqual(preview.policy);
    expect(await listTrash(scratch)).toMatchObject([{ object: { id: first.id } }]);
  });

  it("requires a fresh exact preview when Trash changes before permanent deletion", async () => {
    const first = await create();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-20T12:00:00.000Z",
      ...ids(),
    });
    const preview = await previewTrashPurge({
      root: scratch,
      scope: "all",
      now: "2026-08-22T12:00:00.000Z",
    });
    const second = await create(OBJECT_B, "Second object");
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: second.id,
      expectedVersion: second.version,
      expectedHash: second.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-21T12:00:00.000Z",
      ...ids(),
    });

    await expect(
      purgeTrash({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        previewToken: preview.preview_token,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:00:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectTrashConflict);
    expect(await listTrash(scratch)).toHaveLength(2);
  });

  it("permanently purges reviewed snapshots while retaining minimal history evidence", async () => {
    const { first, relation } = await relatedFixture();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [
        {
          relation_id: relation.id,
          version: relation.version,
          content_hash: relation.content_hash,
        },
      ],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-20T12:00:00.000Z",
      ...ids(),
    });
    const preview = await previewTrashPurge({
      root: scratch,
      scope: "all",
      now: "2026-08-22T12:00:00.000Z",
    });
    expect(preview).toMatchObject({
      entry_count: 1,
      relation_count: 1,
      related_object_count: 1,
      object_checkpoint_count: 1,
      relation_checkpoint_count: 1,
      checkpoint_count: 2,
      entries: [{ object_id: first.id, title: first.title }],
      retained_evidence: {
        event_log: true,
        object_checkpoints: true,
        relation_checkpoints: true,
        permanent_tombstone: true,
      },
    });

    const receipt = await purgeTrash({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      scope: "all",
      previewToken: preview.preview_token,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:00:00.000Z",
      ...ids(),
    });
    expect(receipt).toMatchObject({
      purged_count: 1,
      purged_object_ids: [first.id],
      removed_relation_count: 1,
      retained_checkpoint_count: 2,
      undo: null,
    });
    expect(await listTrash(scratch)).toEqual([]);
    expect(await relationsForObject(scratch, first.id, true)).toEqual([]);
    await expect(
      readFile(join(scratch, ".kiwi", "checkpoints", first.id, "00000001.json"), "utf8"),
    ).resolves.toContain(first.id);
    await expect(
      readFile(join(scratch, ".kiwi", "tombstones", `${first.id}.json`), "utf8"),
    ).resolves.toContain('"purge_event_id"');
    await expect(
      restoreTrashedObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:01:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectTrashCorruptionError);
  });

  it("rolls an interrupted permanent purge back to recoverable Trash", async () => {
    const first = await create();
    await trashObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      expectedRelations: [],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-20T12:00:00.000Z",
      ...ids(),
    });
    const preview = await previewTrashPurge({
      root: scratch,
      scope: "all",
      now: "2026-08-22T12:00:00.000Z",
    });
    await expect(
      purgeTrash({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        previewToken: preview.preview_token,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:00:00.000Z",
        faultAfterTarget: 2,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");

    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    expect(await listTrash(scratch)).toMatchObject([{ object: { id: first.id } }]);
    await expect(
      readFile(join(scratch, ".kiwi", "tombstones", `${first.id}.json`), "utf8"),
    ).rejects.toThrow();
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function id(): string {
  sequence += 1;
  return `0198c800-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function ids() {
  return {
    transactionId: id(),
    preparedEventId: id(),
    domainEventId: id(),
    committedEventId: id(),
  };
}

async function create(objectId = OBJECT_A, title = "First thought") {
  return createInboxItem({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    objectId,
    title,
    content: "A readable research thought.",
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-22T12:01:00.000Z",
    ...ids(),
  });
}

describe("canonical Inbox objects", () => {
  it("creates stable readable files, an immutable checkpoint, and append-only events", async () => {
    const object = await create();
    const listed = await listCanonicalObjects(scratch);
    expect(listed).toEqual([object]);
    expect(verifyObjectHash(object)).toBe(true);

    const folder = join(scratch, "objects", "inbox");
    const files = await readdir(folder);
    expect(files).toEqual([`first-thought--${OBJECT_A}.json`]);
    expect(await readFile(join(folder, files[0]!), "utf8")).toContain(
      '"content": "A readable research thought."',
    );
    expect(
      await readFile(join(scratch, ".kiwi", "checkpoints", OBJECT_A, "00000001.json"), "utf8"),
    ).toContain('"version": 1');
    const events = await readFile(
      join(scratch, ".kiwi", "events", "2026", "08", "events.jsonl"),
      "utf8",
    );
    expect(
      events
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event_type),
    ).toEqual(["transaction.prepared", "object.created", "transaction.committed"]);
  });

  it("quick-captures a selected passage with immutable object and command context", async () => {
    const source = await create(OBJECT_A, "Source passage fixture");
    const captured = await quickCapture({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_B,
      title: "Selected observation",
      content: "An editable note about the selected passage.",
      context: {
        surface: "collection",
        project_id: null,
        object: {
          object_id: source.id,
          version: source.version,
          content_hash: source.content_hash,
        },
        source: null,
        selection: {
          text: "A selected source passage.",
          prefix: "Before the passage. ",
          suffix: " After the passage.",
        },
      },
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });

    expect(captured).toMatchObject({
      id: OBJECT_B,
      type: "inbox_item",
      lifecycle: "inbox",
      provenance: [
        {
          type: "quick_capture",
          captured_at: "2026-08-22T12:02:00.000Z",
          capture_command: "kiwi.object.quick-capture",
          surface: "collection",
          project_id: null,
          object: {
            object_id: source.id,
            object_type: "inbox_item",
            object_title: "Source passage fixture",
            version: source.version,
            content_hash: source.content_hash,
          },
          source: null,
          selection: {
            text: "A selected source passage.",
            prefix: "Before the passage. ",
            suffix: " After the passage.",
          },
        },
      ],
    });
    expect((await objectActivity(scratch, captured.id))[0]).toMatchObject({
      event_type: "object.quick_captured",
      version: 1,
    });
    expect((await readCanonicalObject(scratch, captured.id))?.object.provenance).toEqual(
      captured.provenance,
    );
  });

  it("refuses to create a capture when its exact context version is unavailable", async () => {
    const source = await create();
    await expect(
      quickCapture({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: OBJECT_B,
        title: "Must retain context",
        content: "No context-free fallback.",
        context: {
          surface: "inbox",
          project_id: null,
          object: {
            object_id: source.id,
            version: 99,
            content_hash: source.content_hash,
          },
          source: null,
          selection: null,
        },
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectCaptureContextConflict);
    expect(await readCanonicalObject(scratch, OBJECT_B)).toBeNull();
  });

  it("rolls an interrupted Quick Capture back without leaving an anonymous Inbox item", async () => {
    await expect(
      quickCapture({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: OBJECT_B,
        title: "Interrupted capture",
        content: "This capture must remain atomic.",
        context: {
          surface: "workbench",
          project_id: null,
          object: null,
          source: null,
          selection: null,
        },
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        faultAfterTarget: 1,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");
    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    expect(await readCanonicalObject(scratch, OBJECT_B)).toBeNull();
  });

  it("creates two independently stable identities", async () => {
    await create(OBJECT_A, "Same title");
    await create(OBJECT_B, "Same title");
    const files = await readdir(join(scratch, "objects", "inbox"));
    expect(files).toEqual([`same-title--${OBJECT_A}.json`, `same-title--${OBJECT_B}.json`]);
  });
});

describe("tolerant publication and history", () => {
  it("surfaces a historical checkpoint whose bytes no longer match its recorded hash", async () => {
    const first = await create();
    const path = join(scratch, ".kiwi", "checkpoints", first.id, "00000001.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...checkpoint, content: "Tampered" }, null, 2)}\n`);

    await expect(readObjectVersion(scratch, first.id, 1)).rejects.toBeInstanceOf(
      ObjectHistoryCorruptionError,
    );
  });

  it("rejects invalid publication content at the canonical writer boundary", async () => {
    const first = await create();
    await expect(
      publishObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        title: " ",
        content: "Preserved content",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectPublicationValidationError);
    expect((await readCanonicalObject(scratch, first.id))?.object).toEqual(first);
  });

  it("preserves unknown fields through a new immutable version", async () => {
    const first = await create();
    const found = await readCanonicalObject(scratch, first.id);
    if (found === null) throw new Error("Fixture object was not found.");
    await writeFile(
      join(scratch, found.relativePath),
      `${JSON.stringify({ ...first, future_field: { retained: true } }, null, 2)}\n`,
      "utf8",
    );
    const externallyEdited = await readCanonicalObject(scratch, first.id);
    if (externallyEdited === null) throw new Error("External fixture edit was not found.");
    const second = await publishObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: externallyEdited.object.version,
      expectedHash: externallyEdited.object.content_hash,
      title: "First thought revised",
      content: "Revised content.",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    expect(second).toMatchObject({ version: 2, future_field: { retained: true } });
    expect(await objectHistory(scratch, first.id)).toMatchObject([
      { version: 1, title: "First thought" },
      { version: 2, title: "First thought revised" },
    ]);
  });

  it("rejects stale expected versions without overwriting current content", async () => {
    const first = await create();
    await publishObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: first.version,
      expectedHash: first.content_hash,
      title: first.title,
      content: "Current content.",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    await expect(
      publishObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        title: first.title,
        content: "Stale content.",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:03:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectVersionConflict);
    expect((await readCanonicalObject(scratch, first.id))?.object.content).toBe("Current content.");
  });

  it("serializes concurrent publication so one stale writer cannot silently win", async () => {
    const first = await create();
    const attempts = ["Concurrent A", "Concurrent B"].map((content) =>
      publishObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        title: content,
        content,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        ...ids(),
      }),
    );

    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(ObjectVersionConflict) });
    expect((await readCanonicalObject(scratch, first.id))?.object.version).toBe(2);
    expect(await objectHistory(scratch, first.id)).toHaveLength(2);
  });

  it("restores historical content as a third version", async () => {
    const first = await create();
    const second = await publishObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      expectedVersion: 1,
      expectedHash: first.content_hash,
      title: "Second title",
      content: "Second content.",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    const restored = await restoreObjectVersion({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: first.id,
      restoreVersion: 1,
      expectedVersion: 2,
      expectedHash: second.content_hash,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });
    expect(restored).toMatchObject({
      version: 3,
      title: "First thought",
      content: "A readable research thought.",
      restored_from_version: 1,
    });
    expect((await objectHistory(scratch, first.id)).map((entry) => entry.version)).toEqual([
      1, 2, 3,
    ]);
    expect((await objectActivity(scratch, first.id)).map((entry) => entry.event_type)).toEqual([
      "object.created",
      "object.saved",
      "object.restored",
    ]);
  });
});

describe("relations and recovery", () => {
  it("derives incoming and outgoing navigation from one directed relation", async () => {
    await create(OBJECT_A, "Subject");
    await create(OBJECT_B, "Object");
    const relation = await createRelation({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "related_to",
      subjectId: OBJECT_A,
      objectId: OBJECT_B,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });
    expect(await relationsForObject(scratch, OBJECT_A)).toEqual([
      { relation, direction: "outgoing" },
    ]);
    expect(await relationsForObject(scratch, OBJECT_B)).toEqual([
      { relation, direction: "incoming" },
    ]);
  });

  it("rolls back an interrupted multi-record publication without silent loss", async () => {
    const first = await create();
    await expect(
      publishObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: 1,
        expectedHash: first.content_hash,
        title: "Interrupted edit",
        content: "Content that must not masquerade as committed.",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:05:00.000Z",
        faultAfterTarget: 1,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");

    expect((await readCanonicalObject(scratch, first.id))?.object.title).toBe("Interrupted edit");
    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    expect((await readCanonicalObject(scratch, first.id))?.object).toEqual(first);
    expect(await objectHistory(scratch, first.id)).toHaveLength(1);
  });

  it("rolls back an interrupted title-path relocation to one original canonical file", async () => {
    const first = await create();
    const originalPath = (await readCanonicalObject(scratch, first.id))!.relativePath;
    await expect(
      publishObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: first.id,
        expectedVersion: first.version,
        expectedHash: first.content_hash,
        title: "Relocated title",
        content: first.content,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:06:00.000Z",
        relocateToTitlePath: true,
        faultAfterTarget: 1,
        ...ids(),
      }),
    ).rejects.toThrow("Injected canonical interruption");

    await expect(recoverCanonicalTransactions(scratch)).resolves.toMatchObject([
      { action: "rolled_back" },
    ]);
    const recovered = await readCanonicalObject(scratch, first.id);
    expect(recovered).toEqual({ object: first, relativePath: originalPath });
    expect(
      (await listCanonicalObjects(scratch)).filter((object) => object.id === first.id),
    ).toEqual([first]);
  });
});

describe("comment threads", () => {
  const OTHER = "account:0198c7c1-4e7d-7e31-a23a-824269ac2301";
  const OPENING = "Is this the right cohort?";

  function anchorOn(objectId: string, overrides: Partial<ThreadAnchor> = {}): ThreadAnchor {
    return {
      object_id: objectId,
      kind: "text_range",
      from: 120,
      to: 161,
      quote: "the effect was larger in the second cohort",
      ...overrides,
    };
  }

  async function start(
    objectId: string,
    text = OPENING,
    actor = ACTOR,
    now = "2026-08-22T12:02:00.000Z",
  ) {
    return createThread({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      threadId: id(),
      relationId: id(),
      messageId: id(),
      anchor: anchorOn(objectId),
      body: text,
      authorName: actor === ACTOR ? "Ada Lovelace" : "Grace Hopper",
      actor,
      requestId: id(),
      now,
      ...ids(),
    });
  }

  function read(object: CanonicalObject) {
    const thread = readThread(object["thread"]);
    if (thread === null) throw new Error("That object does not hold a thread.");
    return thread;
  }

  function writeIds(threadId: string, actor = ACTOR, now = "2026-08-22T12:04:00.000Z") {
    return {
      root: scratch,
      workspaceId: WORKSPACE_ID,
      threadId,
      actor,
      requestId: id(),
      now,
      ...ids(),
    };
  }

  it("files the thread as its own object and links it to what it is about", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);

    expect(started.type).toBe("thread");
    // Forty margin comments must not mean forty rewrites of the manuscript.
    expect(await readdir(join(scratch, "objects"))).toContain("threads");
    const links = await relationsForObject(scratch, paper.id);
    expect(links.map((link) => link.relation.type)).toContain("comments_on");
  });

  it("titles the thread by what was said, with a mention read as a name", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id, `@[Grace](user:${OTHER}) is this the right cohort?`);
    expect(started.title).toBe("@Grace is this the right cohort?");
  });

  it("stores every message as the object's content so a search finds the conversation", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const replied = await addThreadReply({
      ...writeIds(started.id, OTHER),
      messageId: id(),
      body: "No, it is the pooled one.",
      authorName: "Grace Hopper",
    });
    expect(replied.content).toContain(OPENING);
    expect(replied.content).toContain("No, it is the pooled one.");
  });

  it("appends a reply with no version to check, and keeps both", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const replied = await addThreadReply({
      ...writeIds(started.id, OTHER),
      messageId: id(),
      body: `@[Ada](user:${ACTOR}) no, the pooled one.`,
      authorName: "Grace Hopper",
    });

    const thread = read(replied);
    expect(thread.messages.map((message) => message.author_id)).toEqual([ACTOR, OTHER]);
    // Denormalised for the inbox, which must answer "who is in this" without opening a message.
    expect(thread.participants).toEqual([ACTOR, OTHER]);
    expect(thread.mentions).toEqual([ACTOR]);
  });

  it("records an edit and leaves the words as they were in the version history", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const original = read(started).messages[0]!;
    const edited = await editThreadMessage({
      ...writeIds(started.id),
      messageId: original.id,
      body: "Is this the pre-registered cohort?",
    });

    const message = read(edited).messages[0]!;
    expect(message.body).toBe("Is this the pre-registered cohort?");
    expect(message.edited_at).toBe("2026-08-22T12:04:00.000Z");
    const before = await readObjectVersion(scratch, started.id, started.version);
    expect(read(before!).messages[0]!.body).toBe(OPENING);
  });

  it("refuses to rewrite somebody else's comment", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const original = read(started).messages[0]!;

    // A thread is a record of who said what. Editing another person's words would file the
    // change in the history under their name.
    await expect(
      editThreadMessage({
        ...writeIds(started.id, OTHER),
        messageId: original.id,
        body: "Actually I agree.",
      }),
    ).rejects.toBeInstanceOf(ThreadMessageNotYours);
  });

  it("resolves once however many times it is resolved", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const resolved = await setThreadStatus({ ...writeIds(started.id), status: "resolved" });
    const again = await setThreadStatus({
      ...writeIds(started.id, OTHER, "2026-08-22T12:05:00.000Z"),
      status: "resolved",
    });

    expect(resolved.changed).toBe(true);
    expect(read(resolved.object).resolved_by).toBe(ACTOR);
    // Two people clicking Resolve leaves one record, not two versions and a changed name.
    expect(again.changed).toBe(false);
    expect(again.object.version).toBe(resolved.object.version);
    expect(read(again.object).resolved_by).toBe(ACTOR);
  });

  it("forgets who resolved a thread when it is reopened", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    await setThreadStatus({ ...writeIds(started.id), status: "resolved" });
    const reopened = await setThreadStatus({
      ...writeIds(started.id, OTHER, "2026-08-22T12:06:00.000Z"),
      status: "open",
    });

    expect(reopened.changed).toBe(true);
    const thread = read(reopened.object);
    expect(thread.status).toBe("open");
    expect(thread.resolved_by).toBeNull();
    expect(thread.resolved_at).toBeNull();
  });

  it("points an orphan at the words it is about now", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const started = await start(paper.id);
    const moved = await moveThreadAnchor({
      ...writeIds(started.id),
      from: 40,
      to: 53,
      quote: "second cohort",
    });

    // The quotation is replaced too, or the thread would orphan again on the next load.
    expect(read(moved).anchor).toMatchObject({
      kind: "text_range",
      from: 40,
      to: 53,
      quote: "second cohort",
    });
  });

  it("filters the inbox by object, status, author, and mention", async () => {
    const paper = await create(OBJECT_A, "Cohort study");
    const other = await create(OBJECT_B, "Another paper");
    const mine = await start(paper.id);
    const theirs = await start(other.id, `@[Ada](user:${ACTOR}) have a look`, OTHER);
    await setThreadStatus({ ...writeIds(theirs.id, OTHER), status: "resolved" });

    const idsOf = async (query: Parameters<typeof listThreads>[1]) =>
      (await listThreads(scratch, query)).map((entry) => entry.object.id);

    expect(await idsOf({ objectId: paper.id })).toEqual([mine.id]);
    expect(await idsOf({ status: "open" })).toEqual([mine.id]);
    expect(await idsOf({ participant: OTHER })).toEqual([theirs.id]);
    expect(await idsOf({ mentions: ACTOR })).toEqual([theirs.id]);

    // One I wrote, one that names me: an intersection would return neither, and the second is
    // the one nobody can afford to miss.
    expect(new Set(await idsOf({ involving: ACTOR }))).toEqual(new Set([mine.id, theirs.id]));
    expect(await idsOf({ involving: OTHER })).toEqual([theirs.id]);
  });

  it("filters the inbox by the project the commented object is filed in", async () => {
    const project = await createProject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: id(),
      title: "Ribosome assembly",
      settings: defaultProjectSettings(),
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:00:30.000Z",
      ...ids(),
    });
    const filed = await create(OBJECT_A, "Filed paper");
    const loose = await create(OBJECT_B, "Loose paper");
    await assignObjectToProject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      objectId: filed.id,
      projectId: project.id,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:01:30.000Z",
      ...ids(),
    });
    const inside = await start(filed.id);
    await start(loose.id, "And this one?", ACTOR, "2026-08-22T12:03:00.000Z");

    // The thread is not in the project; the thing it comments on is.
    const found = await listThreads(scratch, { projectId: project.id });
    expect(found.map((entry) => entry.object.id)).toEqual([inside.id]);
  });
});
