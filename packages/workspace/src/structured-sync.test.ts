import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThread } from "@kiwi/contracts";
import { createWorkspace } from "./store.js";
import {
  addThreadReply,
  createInboxItem,
  createThread,
  publishObject,
  readCanonicalObject,
  rehashCanonicalObject,
  setThreadStatus,
  type CanonicalObject,
} from "./objects.js";
import { applyStructuredSyncChange } from "./structured-sync.js";
import {
  createExternalDraftConflict,
  listStructuredConflicts,
  resolveStructuredConflict,
} from "./conflicts.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const OBJECT_ID = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
const THREAD_ID = "0198c7c4-5d43-71b7-a135-42494e1e51d4";
let scratch = "";
let replicaA = "";
let replicaB = "";
let sequence = 0;

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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-replicas-"));
  replicaA = join(scratch, "a");
  replicaB = join(scratch, "b");
  sequence = 0;
  await Promise.all(
    [replicaA, replicaB].map((root) =>
      createWorkspace({
        root,
        workspaceId: WORKSPACE_ID,
        title: "Replicated research",
        now: "2026-08-22T12:00:00.000Z",
      }),
    ),
  );
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("structured replica application", () => {
  it("preserves Base, Mine, and Theirs when an external change overtakes a draft", async () => {
    const base = await createInboxItem({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      title: "Base title",
      content: "Base text",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:01:00.000Z",
      ...ids(),
    });
    const theirs = await publishObject({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      expectedVersion: base.version,
      expectedHash: base.content_hash,
      title: "External title",
      content: "External text",
      actor: "external-editor",
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    const conflict = await createExternalDraftConflict({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      conflictId: id(),
      objectId: OBJECT_ID,
      baseVersion: base.version,
      baseHash: base.content_hash,
      mineTitle: "Draft title",
      mineContent: "Draft text",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    expect(conflict).toMatchObject({
      base_snapshot: { title: "Base title", content: "Base text" },
      mine: { title: "Draft title", content: "Draft text" },
      theirs: { title: theirs.title, content: theirs.content },
      status: "unresolved",
    });
    expect((await readCanonicalObject(replicaA, OBJECT_ID))?.object).toEqual(theirs);
  });

  it("converges an authorized change and ignores duplicate delivery", async () => {
    const created = await createInboxItem({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      title: "Shared observation",
      content: "One canonical version.",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:01:00.000Z",
      ...ids(),
    });
    const change = {
      sequence: 1,
      workspace_id: WORKSPACE_ID,
      command_id: id(),
      object_id: OBJECT_ID,
      base_version: 0,
      base_hash: null,
      proposed: { version: 1, content_hash: created.content_hash, snapshot: created },
      actor_id: "account:a",
      accepted_at: "2026-08-22T12:01:01.000Z",
    };
    const input = {
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      change,
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:01:02.000Z",
      newId: id,
    };
    await expect(applyStructuredSyncChange(input)).resolves.toMatchObject({ status: "applied" });
    await expect(applyStructuredSyncChange(input)).resolves.toMatchObject({ status: "no_change" });
    expect((await readCanonicalObject(replicaB, OBJECT_ID))?.object).toEqual(created);
  });

  it("keeps both same-base variants in an explicit conflict record", async () => {
    const base = await createInboxItem({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      title: "Shared base",
      content: "Base",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:01:00.000Z",
      ...ids(),
    });
    await applyStructuredSyncChange({
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      change: {
        sequence: 1,
        workspace_id: WORKSPACE_ID,
        command_id: id(),
        object_id: OBJECT_ID,
        base_version: 0,
        base_hash: null,
        proposed: { version: 1, content_hash: base.content_hash, snapshot: base },
        actor_id: "account:a",
        accepted_at: "2026-08-22T12:01:01.000Z",
      },
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:01:02.000Z",
      newId: id,
    });
    const remote = await publishObject({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      expectedVersion: 1,
      expectedHash: base.content_hash,
      title: "Remote variant",
      content: "Remote",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    const local = await publishObject({
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      expectedVersion: 1,
      expectedHash: base.content_hash,
      title: "Local variant",
      content: "Local",
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    const result = await applyStructuredSyncChange({
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      change: {
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        command_id: id(),
        object_id: OBJECT_ID,
        base_version: 1,
        base_hash: base.content_hash,
        proposed: { version: 2, content_hash: remote.content_hash, snapshot: remote },
        actor_id: "account:a",
        accepted_at: "2026-08-22T12:02:01.000Z",
      },
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:02:02.000Z",
      newId: id,
    });
    expect(result.status).toBe("conflict");
    expect((await readCanonicalObject(replicaB, OBJECT_ID))?.object).toEqual(local);
    const conflictFiles = await readdir(join(replicaB, ".kiwi", "conflicts"));
    expect(conflictFiles).toHaveLength(1);
    const conflict = JSON.parse(
      await readFile(join(replicaB, ".kiwi", "conflicts", conflictFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(conflict).toMatchObject({
      mine: { title: "Local variant" },
      theirs: { title: "Remote variant" },
      status: "unresolved",
    });

    if (result.status !== "conflict") throw new Error("Expected a local conflict.");
    const resolved = await resolveStructuredConflict({
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      conflictId: result.conflict_id,
      resolution: "theirs",
      expectedVersion: local.version,
      expectedHash: local.content_hash,
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });
    expect(resolved.object).toMatchObject({
      version: 3,
      title: "Remote variant",
      resolved_conflict_id: result.conflict_id,
    });
    expect(await listStructuredConflicts(replicaB)).toMatchObject([
      { id: result.conflict_id, status: "resolved", resolution: "theirs" },
    ]);
  });
});

describe("thread replication", () => {
  let delivery = 0;

  /** Hands one machine's copy of an object to the other, as the pull loop would. */
  async function deliver(
    root: string,
    actor: string,
    object: CanonicalObject,
    base: CanonicalObject | null,
  ) {
    delivery += 1;
    return applyStructuredSyncChange({
      root,
      workspaceId: WORKSPACE_ID,
      change: {
        sequence: delivery,
        workspace_id: WORKSPACE_ID,
        command_id: id(),
        object_id: object.id,
        base_version: base?.version ?? 0,
        base_hash: base?.content_hash ?? null,
        proposed: { version: object.version, content_hash: object.content_hash, snapshot: object },
        actor_id: object.updated_by,
        accepted_at: object.updated_at,
      },
      actor,
      requestId: id(),
      now: "2026-08-22T12:30:00.000Z",
      newId: id,
    });
  }

  async function storedThread(root: string) {
    return readThread((await readCanonicalObject(root, THREAD_ID))?.object["thread"]);
  }

  /** The same thread on both machines, one message long. */
  async function shared() {
    const subject = await createInboxItem({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      title: "Methods",
      content: "The cohort was recruited in 2019.",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:01:00.000Z",
      ...ids(),
    });
    const thread = await createThread({
      root: replicaA,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      relationId: id(),
      messageId: id(),
      anchor: { object_id: OBJECT_ID, kind: "object" },
      body: "Is this the right cohort?",
      authorName: "Ada",
      actor: "account:a",
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });
    await deliver(replicaB, "account:b", subject, null);
    await deliver(replicaB, "account:b", thread, null);
    return thread;
  }

  function reply(root: string, actor: string, name: string, body: string, now: string) {
    return addThreadReply({
      root,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      messageId: id(),
      body,
      authorName: name,
      actor,
      requestId: id(),
      now,
      ...ids(),
    });
  }

  it("keeps both replies when two machines answer the same thread offline", async () => {
    const opened = await shared();
    const mine = await reply(
      replicaA,
      "account:a",
      "Ada",
      "Only the 2019 intake.",
      "2026-08-22T12:03:00.000Z",
    );
    await reply(
      replicaB,
      "account:b",
      "Belle",
      "The 2020 intake is in there too.",
      "2026-08-22T12:04:00.000Z",
    );

    expect(await deliver(replicaB, "account:b", mine, opened)).toMatchObject({ status: "merged" });
    const thread = await storedThread(replicaB);
    expect(thread?.messages.map((message) => message.body)).toEqual([
      "Is this the right cohort?",
      "Only the 2019 intake.",
      "The 2020 intake is in there too.",
    ]);
    expect(thread?.participants).toEqual(["account:a", "account:b"]);
  });

  it("settles once both machines hold the same conversation", async () => {
    const opened = await shared();
    const mine = await reply(
      replicaA,
      "account:a",
      "Ada",
      "Only the 2019 intake.",
      "2026-08-22T12:03:00.000Z",
    );
    const theirs = await reply(
      replicaB,
      "account:b",
      "Belle",
      "The 2020 intake is in there too.",
      "2026-08-22T12:04:00.000Z",
    );
    const mergedThere = await deliver(replicaB, "account:b", mine, opened);
    if (mergedThere.status !== "merged") throw new Error("Expected a merge on the second machine.");
    expect(await deliver(replicaA, "account:a", theirs, opened)).toMatchObject({
      status: "merged",
    });

    // The merge travels back as a change of its own. Each machine already holds every message in
    // it, so the exchange ends here rather than merging merges.
    expect(await deliver(replicaA, "account:a", mergedThere.object, theirs)).toMatchObject({
      status: "no_change",
    });
    expect((await storedThread(replicaA))?.messages).toHaveLength(3);
    expect(await storedThread(replicaA)).toEqual(await storedThread(replicaB));
  });

  it("takes the later of a resolve and a reply, and keeps the reply either way", async () => {
    const opened = await shared();
    const mine = await reply(
      replicaA,
      "account:a",
      "Ada",
      "Only the 2019 intake.",
      "2026-08-22T12:03:00.000Z",
    );
    const settled = await setThreadStatus({
      root: replicaB,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      status: "resolved",
      actor: "account:b",
      requestId: id(),
      now: "2026-08-22T12:05:00.000Z",
      ...ids(),
    });

    expect(await deliver(replicaB, "account:b", mine, opened)).toMatchObject({ status: "merged" });
    expect(await storedThread(replicaB)).toMatchObject({
      status: "resolved",
      resolved_by: "account:b",
    });
    expect((await storedThread(replicaB))?.messages).toHaveLength(2);
    expect(settled.changed).toBe(true);
  });

  it("raises a conflict when the incoming thread is not a thread at all", async () => {
    const opened = await shared();
    await reply(replicaB, "account:b", "Belle", "Mine.", "2026-08-22T12:04:00.000Z");
    const damaged = rehashCanonicalObject({ ...opened, version: 2, thread: { anchor: 1 } });

    expect(await deliver(replicaB, "account:b", damaged, opened)).toMatchObject({
      status: "conflict",
    });
    expect((await storedThread(replicaB))?.messages).toHaveLength(2);
  });
});
