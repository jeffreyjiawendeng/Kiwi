import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./store.js";
import {
  CoeditVersionConflict,
  applyCoeditNoteOperations,
  createCoeditNote,
  listCoeditNotes,
  readCoeditNote,
  replaceCoeditNoteText,
} from "./coedit-notes.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const DOCUMENT_ID = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
const ACTOR = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
let scratch: string;
let sequence: number;

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
  scratch = await mkdtemp(join(tmpdir(), "kiwi-coedit-notes-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Coediting tests",
    now: "2026-08-22T12:00:00.000Z",
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function create() {
  return createCoeditNote({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    title: "Shared finding",
    content: "First line\r\nSecond line",
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-22T12:01:00.000Z",
    newOperationId: id,
    ...ids(),
  });
}

describe("canonical coedited notes", () => {
  it("materializes deterministic readable Markdown and a checkpoint", async () => {
    const created = await create();
    expect(created.note.content).toBe("First line\nSecond line");
    expect(await listCoeditNotes(scratch)).toEqual([created.note]);
    expect(
      await readFile(
        join(scratch, "objects", "notes", `shared-finding--${DOCUMENT_ID}.md`),
        "utf8",
      ),
    ).toBe("First line\nSecond line");
    expect(
      JSON.parse(
        await readFile(
          join(scratch, ".kiwi", "coedit-checkpoints", DOCUMENT_ID, "00000001.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ document_id: DOCUMENT_ID, operation_count: 1 });
  });

  it("replaces text as convergent operations and rejects a stale editor", async () => {
    const created = await create();
    const changed = await replaceCoeditNoteText({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      expectedHash: created.note.content_hash,
      content: "A revised finding",
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:02:00.000Z",
      newOperationId: id,
      ...ids(),
    });
    expect(changed.operations.map((item) => item.kind)).toEqual(["delete", "insert"]);
    expect(changed.note.content).toBe("A revised finding");
    expect(await readCoeditNote(scratch, DOCUMENT_ID)).toEqual(changed.note);

    await expect(
      replaceCoeditNoteText({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        expectedHash: created.note.content_hash,
        content: "Stale replacement",
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-22T12:03:00.000Z",
        newOperationId: id,
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(CoeditVersionConflict);
  });

  it("merges duplicate remote delivery once and rematerializes the same file", async () => {
    await create();
    const remote = {
      document_id: DOCUMENT_ID,
      operation_id: "0198c900-0000-7000-8000-000000000001",
      actor_id: "account:remote",
      lamport: 2,
      kind: "insert" as const,
      after_id: null,
      text: "Remote paragraph\n",
    };
    const first = await applyCoeditNoteOperations({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      operations: [remote, remote],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:04:00.000Z",
      ...ids(),
    });
    const replay = await applyCoeditNoteOperations({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      operations: [remote],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:05:00.000Z",
      ...ids(),
    });
    expect(first?.applied).toBe(1);
    expect(replay?.applied).toBe(0);
    expect(replay?.note.content_hash).toBe(first?.note.content_hash);
  });

  it("discovers a remote note from its titled creation operation", async () => {
    const documentId = "0198c7c4-5d43-71b7-a135-42494e1e51d9";
    const applied = await applyCoeditNoteOperations({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      documentId,
      operations: [
        {
          document_id: documentId,
          operation_id: "0198c900-0000-7000-8000-000000000009",
          actor_id: "account:remote",
          lamport: 1,
          kind: "insert",
          after_id: null,
          text: "Downloaded content",
          document_title: "Downloaded note",
        },
      ],
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-22T12:06:00.000Z",
      ...ids(),
    });
    expect(applied).toMatchObject({ applied: 1, note: { title: "Downloaded note" } });
    expect(
      await readFile(
        join(scratch, "objects", "notes", `downloaded-note--${documentId}.md`),
        "utf8",
      ),
    ).toBe("Downloaded content");
  });
});
