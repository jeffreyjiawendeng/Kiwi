import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./store.js";
import {
  ObjectNotPromotable,
  ObjectPublicationValidationError,
  ObjectTypeNotCreatable,
  ObjectVersionConflict,
  createInboxItem,
  createObject,
  createRelation,
  listCanonicalObjects,
  objectHistory,
  promoteInboxItem,
  readCanonicalObject,
  readObjectVersion,
  relationsForObject,
  verifyObjectHash,
} from "./objects.js";
import { recoverCanonicalTransactions } from "./canonical-transaction.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACTOR = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
let scratch: string;
let sequence: number;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-object-types-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Typed object tests",
    now: "2026-08-22T12:00:00.000Z",
  });
});

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

async function inbox(title = "Something to sort out") {
  return createInboxItem({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    objectId: id(),
    title,
    content: "Captured in a hurry.",
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-22T12:01:00.000Z",
    ...ids(),
  });
}

describe("creating a typed object", () => {
  it("writes a paper into the folder for its type", async () => {
    const paper = await createObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: id(),
      type: "source",
      title: "Attention Is All You Need",
      content: "Read this before the meeting.",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });

    expect(paper.type).toBe("source");
    expect(paper.lifecycle).toBe("active");
    expect(paper.version).toBe(1);
    expect(paper.$schema).toBe("https://kiwi-research.org/schemas/object/source/1-0-0.json");
    expect(verifyObjectHash(paper)).toBe(true);

    const files = await readdir(join(scratch, "objects", "sources"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(paper.id);
  });

  it("creates each of the four types a person can make", async () => {
    for (const type of ["source", "note", "output", "project"] as const) {
      const created = await createObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: id(),
        type,
        title: `A ${type}`,
        content: "",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        ...ids(),
      });
      expect(created.type).toBe(type);
    }
    const all = await listCanonicalObjects(scratch);
    expect(all.map((object) => object.type).sort()).toEqual([
      "note",
      "output",
      "project",
      "source",
    ]);
  });

  it("refuses a type nothing should create directly", async () => {
    // inbox_item belongs to capture, and the wet-lab types are not offered at all. Allowing
    // either here would put objects on disk that no surface can reach.
    for (const type of ["inbox_item", "asset", "collection", "claim"]) {
      await expect(
        createObject({
          root: scratch,
          workspaceId: WORKSPACE_ID,
          objectId: id(),
          type: type as "source",
          title: "Should not exist",
          content: "",
          actor: ACTOR,
          requestId: id(),
          now: "2026-08-22T12:02:00.000Z",
          ...ids(),
        }),
      ).rejects.toBeInstanceOf(ObjectTypeNotCreatable);
    }
  });

  it("rejects an empty title before writing anything", async () => {
    await expect(
      createObject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: id(),
        type: "note",
        title: "   ",
        content: "",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:02:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectPublicationValidationError);
    expect(await listCanonicalObjects(scratch)).toHaveLength(0);
  });
});

describe("promoting an Inbox item", () => {
  it("moves the file out of the Inbox and into its type's folder", async () => {
    const item = await inbox();
    expect(await readdir(join(scratch, "objects", "inbox"))).toHaveLength(1);

    const paper = await promoteInboxItem({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: item.id,
      type: "source",
      expectedVersion: item.version,
      expectedHash: item.content_hash,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    expect(paper.type).toBe("source");
    expect(paper.lifecycle).toBe("active");
    expect(paper["promoted_from"]).toBe("inbox_item");
    expect(await readdir(join(scratch, "objects", "inbox"))).toHaveLength(0);
    expect(await readdir(join(scratch, "objects", "sources"))).toHaveLength(1);
  });

  it("keeps the identity, so relations still point at it", async () => {
    const item = await inbox();
    const other = await inbox("Another thought");
    await createRelation({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "relates_to",
      subjectId: other.id,
      objectId: item.id,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    const promoted = await promoteInboxItem({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: item.id,
      type: "source",
      expectedVersion: item.version,
      expectedHash: item.content_hash,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });

    // A promotion that minted a new id would orphan every relation, annotation, and
    // checkpoint already pointing at this object. The identity has to survive.
    expect(promoted.id).toBe(item.id);
    const links = await relationsForObject(scratch, item.id);
    expect(links).toHaveLength(1);
  });

  it("keeps the history readable from before the promotion", async () => {
    const item = await inbox();
    await promoteInboxItem({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: item.id,
      type: "note",
      expectedVersion: item.version,
      expectedHash: item.content_hash,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    const first = await readObjectVersion(scratch, item.id, 1);
    expect(first?.type).toBe("inbox_item");
    const history = await objectHistory(scratch, item.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("retitles while promoting when a better title is supplied", async () => {
    const item = await inbox("pdf i found");
    const paper = await promoteInboxItem({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: item.id,
      type: "source",
      expectedVersion: item.version,
      expectedHash: item.content_hash,
      title: "Attention Is All You Need",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    expect(paper.title).toBe("Attention Is All You Need");
    const files = await readdir(join(scratch, "objects", "sources"));
    expect(files[0]).toContain("attention-is-all-you-need");
  });

  it("refuses to promote something that is not an Inbox item", async () => {
    const paper = await createObject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: id(),
      type: "source",
      title: "Already a paper",
      content: "",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      ...ids(),
    });

    await expect(
      promoteInboxItem({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: paper.id,
        type: "note",
        expectedVersion: paper.version,
        expectedHash: paper.content_hash,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:03:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectNotPromotable);
  });

  it("refuses a promotion raised against a stale version", async () => {
    const item = await inbox();
    await expect(
      promoteInboxItem({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: item.id,
        type: "source",
        expectedVersion: item.version + 1,
        expectedHash: item.content_hash,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:03:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(ObjectVersionConflict);
  });

  it("leaves no half-promoted object when the process dies mid-transaction", async () => {
    const item = await inbox();
    await expect(
      promoteInboxItem({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        objectId: item.id,
        type: "source",
        expectedVersion: item.version,
        expectedHash: item.content_hash,
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:03:00.000Z",
        faultAfterTarget: 1,
        ...ids(),
      }),
    ).rejects.toBeTruthy();

    // The move writes the new file and deletes the old one. A crash between the two must not
    // leave the object in both folders or in neither.
    await recoverCanonicalTransactions(scratch);
    const found = await readCanonicalObject(scratch, item.id);
    expect(found).not.toBeNull();
    const inboxFiles = await readdir(join(scratch, "objects", "inbox"));
    const sourceFiles = await readdir(join(scratch, "objects", "sources")).catch(() => []);
    expect(inboxFiles.length + sourceFiles.length).toBe(1);
    expect(verifyObjectHash(found!.object)).toBe(true);
  });

  it("writes a checkpoint that matches the promoted object", async () => {
    const item = await inbox();
    const promoted = await promoteInboxItem({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      objectId: item.id,
      type: "output",
      expectedVersion: item.version,
      expectedHash: item.content_hash,
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:03:00.000Z",
      ...ids(),
    });

    const checkpoint = await readFile(
      join(scratch, ".kiwi", "checkpoints", promoted.id, "00000002.json"),
      "utf8",
    );
    expect(JSON.parse(checkpoint)).toMatchObject({ type: "output", version: 2 });
  });
});
