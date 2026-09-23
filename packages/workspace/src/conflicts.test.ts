import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./store.js";
import {
  createInboxItem,
  listCanonicalObjects,
  publishObject,
  readCanonicalObject,
  relationsForObject,
  type CanonicalObject,
} from "./objects.js";
import {
  CONFLICT_VARIANT_RELATION,
  createExternalDraftConflict,
  listStructuredConflicts,
  resolveStructuredConflict,
  type StructuredConflict,
} from "./conflicts.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const OBJECT_ID = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
let root = "";
let sequence = 0;

function id(): string {
  sequence += 1;
  return `0198c900-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function ids() {
  return {
    transactionId: id(),
    preparedEventId: id(),
    domainEventId: id(),
    committedEventId: id(),
  };
}

function keepOther() {
  return {
    objectId: id(),
    relationId: id(),
    objectEventId: id(),
    relationEventId: id(),
  };
}

/**
 * A conflict with two real sides on disk.
 *
 * The external-edit route is used because it is the shortest one that leaves a genuine conflict
 * record: the file moved on, a draft was open against the version before it, and both are kept.
 */
async function conflicted(
  over: { mineTitle?: string; theirsTitle?: string } = {},
): Promise<{ conflict: StructuredConflict; theirs: CanonicalObject }> {
  const base = await createInboxItem({
    root,
    workspaceId: WORKSPACE_ID,
    objectId: OBJECT_ID,
    title: "Interview notes",
    content: "What we both started from",
    actor: "account:a",
    requestId: id(),
    now: "2026-08-27T12:00:00.000Z",
    ...ids(),
  });
  const theirs = await publishObject({
    root,
    workspaceId: WORKSPACE_ID,
    objectId: OBJECT_ID,
    expectedVersion: 1,
    expectedHash: base.content_hash,
    title: over.theirsTitle ?? "Their reading",
    content: "Their sentence",
    actor: "account:b",
    requestId: id(),
    now: "2026-08-27T12:01:00.000Z",
    ...ids(),
  });
  const conflict = await createExternalDraftConflict({
    root,
    workspaceId: WORKSPACE_ID,
    conflictId: id(),
    objectId: OBJECT_ID,
    baseVersion: 1,
    baseHash: base.content_hash,
    mineTitle: over.mineTitle ?? "My reading",
    mineContent: "My sentence",
    actor: "account:a",
    requestId: id(),
    now: "2026-08-27T12:02:00.000Z",
    ...ids(),
  });
  return { conflict, theirs };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kiwi-conflicts-"));
  sequence = 0;
  await createWorkspace({
    root,
    workspaceId: WORKSPACE_ID,
    title: "Conflicted research",
    now: "2026-08-27T11:00:00.000Z",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("choosing one version of a conflicted object", () => {
  it("publishes the chosen side and keeps nothing else when only one was asked for", async () => {
    const { conflict, theirs } = await conflicted();

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "mine",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      ...ids(),
    });

    expect(resolved.kept).toBeNull();
    expect(resolved.object).toMatchObject({ version: 3, title: "My reading" });
    expect(await listCanonicalObjects(root)).toHaveLength(1);
  });
});

describe("keeping both versions of a conflicted object", () => {
  it("writes the side that did not win as an object of its own", async () => {
    const { conflict, theirs } = await conflicted();

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "mine",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      keepOther: keepOther(),
      ...ids(),
    });

    expect(resolved.object).toMatchObject({ title: "My reading", content: "My sentence" });
    expect(resolved.kept).toMatchObject({
      title: "Their reading",
      content: "Their sentence",
      version: 1,
      type: "inbox_item",
    });
    const stored = await readCanonicalObject(root, resolved.kept?.id ?? "");
    expect(stored?.object.content).toBe("Their sentence");
  });

  it("relates the copy to the object it was a version of, so neither is orphaned", async () => {
    const { conflict, theirs } = await conflicted();

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "theirs",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      keepOther: keepOther(),
      ...ids(),
    });

    const links = await relationsForObject(root, OBJECT_ID);
    expect(links).toHaveLength(1);
    expect(links[0]?.direction).toBe("incoming");
    expect(links[0]?.relation).toMatchObject({
      type: CONFLICT_VARIANT_RELATION,
      subject: { object_id: resolved.kept?.id },
      object: { object_id: OBJECT_ID },
    });
  });

  it("says on the copy where it came from", async () => {
    const { conflict, theirs } = await conflicted();

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "mine",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      keepOther: keepOther(),
      ...ids(),
    });

    expect(resolved.kept).toMatchObject({
      kept_from_conflict_id: conflict.id,
      kept_from_object_id: OBJECT_ID,
      kept_conflict_side: "theirs",
    });
    expect(resolved.object["kept_other_as_object_id"]).toBe(resolved.kept?.id);
    expect(await listStructuredConflicts(root)).toMatchObject([
      {
        status: "resolved",
        resolution: "mine",
        kept_other_as: { object_id: resolved.kept?.id, side: "theirs" },
      },
    ]);
  });

  it("names the copy apart when both versions were called the same thing", async () => {
    const { conflict, theirs } = await conflicted({
      mineTitle: "Interview notes",
      theirsTitle: "Interview notes",
    });

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "mine",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      keepOther: keepOther(),
      ...ids(),
    });

    expect(resolved.object.title).toBe("Interview notes");
    expect(resolved.kept?.title).toBe("Interview notes (other version)");
  });

  it("lands the save and the copy in one transaction, so a crash cannot take one of them", async () => {
    const { conflict, theirs } = await conflicted();
    const allocated = ids();

    const resolved = await resolveStructuredConflict({
      root,
      workspaceId: WORKSPACE_ID,
      conflictId: conflict.id,
      resolution: "mine",
      expectedVersion: theirs.version,
      expectedHash: theirs.content_hash,
      actor: "account:a",
      requestId: id(),
      now: "2026-08-27T12:03:00.000Z",
      keepOther: keepOther(),
      ...allocated,
    });

    expect(resolved.kept?.last_transaction_id).toBe(allocated.transactionId);
    expect(resolved.object.last_transaction_id).toBe(allocated.transactionId);
    const journal = await readFile(
      join(root, ".kiwi", "events", "2026", "08", "events.jsonl"),
      "utf8",
    );
    const written = journal
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event["transaction_id"] === allocated.transactionId)
      .map((event) => event["event_type"]);
    expect(written).toContain("object.saved");
    expect(written).toContain("object.created");
    expect(written).toContain("relation.created");
  });

  it("refuses when there is no other version to keep", async () => {
    // A note written on another machine arrives as the only copy there is: there is a side to
    // publish and nothing to set beside it.
    const conflictId = id();
    const theirs = await createInboxItem({
      root,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_ID,
      title: "Arrived from elsewhere",
      content: "Theirs",
      actor: "account:b",
      requestId: id(),
      now: "2026-08-27T12:00:00.000Z",
      ...ids(),
    });
    await mkdir(join(root, ".kiwi", "conflicts"), { recursive: true });
    await writeFile(
      join(root, ".kiwi", "conflicts", `${conflictId}.json`),
      JSON.stringify({
        id: conflictId,
        workspace_id: WORKSPACE_ID,
        object_id: OBJECT_ID,
        status: "unresolved",
        detected_at: "2026-08-27T12:02:00.000Z",
        base: { version: 0, content_hash: null },
        mine: null,
        theirs,
      }),
      "utf8",
    );

    await expect(
      resolveStructuredConflict({
        root,
        workspaceId: WORKSPACE_ID,
        conflictId,
        resolution: "theirs",
        expectedVersion: theirs.version,
        expectedHash: theirs.content_hash,
        actor: "account:a",
        requestId: id(),
        now: "2026-08-27T12:03:00.000Z",
        keepOther: keepOther(),
        ...ids(),
      }),
    ).rejects.toThrow("There is no other version to keep.");
    expect(await listCanonicalObjects(root)).toHaveLength(1);
  });
});
