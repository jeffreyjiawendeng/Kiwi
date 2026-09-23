import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_ANNOTATION,
  EMPTY_COLLECTION_FILTERS,
  EMPTY_REFERENCE,
  type CollectionFilters,
  type CollectionSortDirection,
  type CollectionSortField,
  type ReferenceKind,
} from "@kiwi/contracts";
import {
  createAnnotation,
  createInboxItem,
  createObject as createTypedObject,
  createRelation,
  createWorkspace,
  publishObject,
  trashObject,
} from "@kiwi/workspace";
import { createProjectionService } from "./projection.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const OBJECT_A = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
const OBJECT_B = "0198c7c4-5d43-71b7-a135-42494e1e51d4";
const ADDED_FIRST = "2026-08-20T09:00:00.000Z";
const ADDED_SECOND = "2026-08-21T09:00:00.000Z";
const ADDED_THIRD = "2026-08-22T09:00:00.000Z";
let scratch: string;
let workspaceRoot: string;
let cacheRoot: string;
let sequence: number;

function id(): string {
  sequence += 1;
  return `0198ca00-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function ids() {
  return {
    transactionId: id(),
    preparedEventId: id(),
    domainEventId: id(),
    committedEventId: id(),
  };
}

async function createObject(objectId: string, title: string, content: string) {
  return createInboxItem({
    root: workspaceRoot,
    workspaceId: WORKSPACE_ID,
    objectId,
    title,
    content,
    actor: "account:test",
    requestId: id(),
    now: `2026-08-22T12:0${sequence}:00.000Z`,
    ...ids(),
  });
}

async function createPaper(
  title: string,
  reference: { authors?: string[]; year?: number | null; kind?: ReferenceKind },
  addedAt: string,
  tags: string[] = [],
  summary = "",
  read = false,
) {
  return createTypedObject({
    root: workspaceRoot,
    workspaceId: WORKSPACE_ID,
    objectId: id(),
    type: "source",
    title,
    content: "",
    actor: "account:test",
    requestId: id(),
    now: addedAt,
    // The mark is written only when there is one, so an unread Paper here is a Paper with no
    // such field at all, which is what every Paper in a workspace written before now looks like.
    additionalFields: {
      reference: { ...EMPTY_REFERENCE, ...reference },
      tags,
      summary,
      ...(read ? { read: true } : {}),
    },
    ...ids(),
  });
}

async function library(
  projection: ReturnType<typeof createProjectionService>,
  query: {
    filters?: Partial<CollectionFilters>;
    sort?: { field: CollectionSortField; direction: CollectionSortDirection };
  } = {},
) {
  return projection.list(
    { workspaceId: WORKSPACE_ID, root: workspaceRoot },
    {
      object_types: ["source"],
      text: "",
      filters: { ...EMPTY_COLLECTION_FILTERS, ...query.filters },
      sort: query.sort ?? { field: "title", direction: "ascending" },
      page: { offset: 0, limit: 50 },
    },
  );
}

async function titlesSortedBy(
  projection: ReturnType<typeof createProjectionService>,
  field: "year" | "first_author" | "created_at",
  direction: "ascending" | "descending",
): Promise<string[]> {
  const listed = await library(projection, { sort: { field, direction } });
  return listed.objects.map((object) => object.title);
}

async function titlesFilteredBy(
  projection: ReturnType<typeof createProjectionService>,
  filters: Partial<CollectionFilters>,
): Promise<string[]> {
  const listed = await library(projection, { filters });
  return listed.objects.map((object) => object.title);
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-projection-"));
  workspaceRoot = join(scratch, "canonical-workspace");
  cacheRoot = join(scratch, "machine-state", "workspaces");
  sequence = 0;
  await createWorkspace({
    root: workspaceRoot,
    workspaceId: WORKSPACE_ID,
    title: "Projection fixture",
    now: "2026-08-22T12:00:00.000Z",
  });
});

afterEach(async () => {
  // Retried, because Windows keeps a database file busy for a moment after it is closed.
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("external SQLite projection", () => {
  it("creates a generation outside the canonical workspace", async () => {
    await createObject(OBJECT_A, "Measurement uncertainty", "A calibration finding.");
    await createObject(OBJECT_B, "Field memo", "A second observation.");
    await createRelation({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "supports",
      subjectId: OBJECT_A,
      objectId: OBJECT_B,
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:10:00.000Z",
      ...ids(),
    });
    const projection = createProjectionService(cacheRoot);
    const status = await projection.ensure({ workspaceId: WORKSPACE_ID, root: workspaceRoot });
    expect(status).toMatchObject({
      status: "ready",
      generation: 1,
      objectCount: 2,
      relationCount: 1,
      location: "outside_workspace",
    });
    expect(await readdir(workspaceRoot)).not.toContain("index.sqlite3");
    expect(await readdir(projection.cacheDirectory(WORKSPACE_ID))).toEqual(
      expect.arrayContaining(["index.sqlite3", "projection-manifest.json"]),
    );
    expect(
      JSON.parse(
        await readFile(
          join(projection.cacheDirectory(WORKSPACE_ID), "projection-manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ workspace_id: WORKSPACE_ID, generation: 1 });
    projection.close(WORKSPACE_ID);
  });

  it("detects drift, advances the generation, and returns indexed queries", async () => {
    const original = await createObject(
      OBJECT_A,
      "Measurement uncertainty",
      "A calibration finding.",
    );
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await projection.ensure(target);
    const found = await projection.search(target, "calibration finding");
    expect(found).toMatchObject({
      generation: 1,
      results: [{ id: OBJECT_A, matched_fields: ["body"] }],
    });
    expect(await projection.search(target, `" OR *`)).toMatchObject({ results: [] });

    await publishObject({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      objectId: OBJECT_A,
      expectedVersion: original.version,
      expectedHash: original.content_hash,
      title: original.title,
      content: "A revised calibration result.",
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:20:00.000Z",
      ...ids(),
    });
    await expect(projection.status(target)).resolves.toMatchObject({
      status: "stale",
      generation: 1,
    });
    await expect(projection.ensure(target)).resolves.toMatchObject({
      status: "ready",
      generation: 2,
    });
    const listed = await projection.list(target);
    expect(listed.objects).toMatchObject([{ id: OBJECT_A, version: 2, generation: 2 }]);
    projection.close(WORKSPACE_ID);
  });

  it("pages, filters, and sorts one object family deterministically", async () => {
    await createObject(OBJECT_A, "Measurement uncertainty", "A calibration finding.");
    await createObject(OBJECT_B, "Field memo", "A calibration observation.");
    await createObject(id(), "Background note", "No matching term.");
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    const first = await projection.list(target, {
      object_types: ["inbox_item"],
      text: "calibration",
      filters: EMPTY_COLLECTION_FILTERS,
      sort: { field: "title", direction: "ascending" },
      page: { offset: 0, limit: 1 },
    });
    expect(first).toMatchObject({
      generation: 1,
      total: 2,
      offset: 0,
      limit: 1,
      objects: [{ id: OBJECT_B, title: "Field memo" }],
    });
    await expect(
      projection.list(target, {
        object_types: ["inbox_item"],
        text: "calibration",
        filters: EMPTY_COLLECTION_FILTERS,
        sort: { field: "title", direction: "ascending" },
        page: { offset: 1, limit: 1 },
      }),
    ).resolves.toMatchObject({
      total: 2,
      offset: 1,
      objects: [{ id: OBJECT_A, title: "Measurement uncertainty" }],
    });
    projection.close(WORKSPACE_ID);
  });

  it("orders a library by year, by author, and by when it was added", async () => {
    await createPaper("Calibration drift", { authors: ["Zoe Adler"], year: 2019 }, ADDED_FIRST);
    await createPaper("Sensor noise", { authors: ["Ana Ortiz"], year: 2024 }, ADDED_SECOND);
    await createPaper("Field variance", { authors: ["Bo Chen"], year: 2001 }, ADDED_THIRD);
    const projection = createProjectionService(cacheRoot);

    await expect(titlesSortedBy(projection, "year", "ascending")).resolves.toEqual([
      "Field variance",
      "Calibration drift",
      "Sensor noise",
    ]);
    // Adler, Chen, Ortiz. Sorting on the name as written would give Ana, Bo, Zoe, which is a
    // library ordered by the authors' first names and no use to anybody looking one up.
    await expect(titlesSortedBy(projection, "first_author", "ascending")).resolves.toEqual([
      "Calibration drift",
      "Field variance",
      "Sensor noise",
    ]);
    await expect(titlesSortedBy(projection, "created_at", "descending")).resolves.toEqual([
      "Field variance",
      "Sensor noise",
      "Calibration drift",
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("narrows a library by every filter at once and by any value within one", async () => {
    await createPaper(
      "Calibration drift",
      { authors: ["Zoe Adler", "Bo Chen"], year: 2019, kind: "article" },
      ADDED_FIRST,
      ["tag:kiwi/needs-review"],
    );
    await createPaper(
      "Sensor noise",
      { authors: ["Ana Ortiz"], year: 2024, kind: "book" },
      ADDED_SECOND,
    );
    await createPaper(
      "Field variance",
      { authors: ["Bo Chen"], year: 2019, kind: "article" },
      ADDED_THIRD,
      ["tag:kiwi/needs-review"],
    );
    const projection = createProjectionService(cacheRoot);

    // Bo Chen wrote one of these and is second author on the other. A filter that read only the
    // column would miss the paper the column does not name.
    await expect(titlesFilteredBy(projection, { authors: ["bo chen"] })).resolves.toEqual([
      "Calibration drift",
      "Field variance",
    ]);
    await expect(titlesFilteredBy(projection, { years: [2019, 2024] })).resolves.toEqual([
      "Calibration drift",
      "Field variance",
      "Sensor noise",
    ]);
    await expect(
      titlesFilteredBy(projection, { kinds: ["article"], years: [2019] }),
    ).resolves.toEqual(["Calibration drift", "Field variance"]);
    await expect(
      titlesFilteredBy(projection, { tags: ["tag:kiwi/needs-review"], authors: ["Ana Ortiz"] }),
    ).resolves.toEqual([]);
    await expect(library(projection, { filters: { kinds: ["book"] } })).resolves.toMatchObject({
      total: 1,
    });
    projection.close(WORKSPACE_ID);
  });

  it("offers the values the whole collection holds, not the ones left after filtering", async () => {
    await createPaper(
      "Calibration drift",
      { authors: ["Zoe Adler", "Bo Chen"], year: 2019, kind: "article" },
      ADDED_FIRST,
      ["tag:kiwi/needs-review"],
    );
    await createPaper(
      "Sensor noise",
      { authors: ["Ana Ortiz"], year: 2024, kind: "book" },
      ADDED_SECOND,
    );
    await createObject(OBJECT_A, "Field memo", "An Inbox item, in another family.");
    const projection = createProjectionService(cacheRoot);

    const narrowed = await library(projection, { filters: { kinds: ["book"] } });
    expect(narrowed.objects).toHaveLength(1);
    // A menu that shrank as it was used would hide the second value of an either-or filter.
    expect(narrowed.available).toEqual({
      kinds: ["article", "book"],
      tags: ["tag:kiwi/needs-review"],
      authors: ["Ana Ortiz", "Bo Chen", "Zoe Adler"],
      years: [2024, 2019],
      read: ["unread"],
    });
    projection.close(WORKSPACE_ID);
  });

  it("keeps a paper with no year at the bottom whichever way the column is turned", async () => {
    await createPaper("Dated", { authors: ["Ana Ortiz"], year: 2024 }, ADDED_FIRST);
    await createPaper("Undated", { authors: [], year: null }, ADDED_SECOND);
    const projection = createProjectionService(cacheRoot);

    await expect(titlesSortedBy(projection, "year", "ascending")).resolves.toEqual([
      "Dated",
      "Undated",
    ]);
    await expect(titlesSortedBy(projection, "year", "descending")).resolves.toEqual([
      "Dated",
      "Undated",
    ]);
    await expect(titlesSortedBy(projection, "first_author", "ascending")).resolves.toEqual([
      "Dated",
      "Undated",
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("carries the reader's own summary into the row the table draws", async () => {
    await createPaper(
      "Attention Is All You Need",
      { year: 2017 },
      ADDED_FIRST,
      [],
      "Attention alone beats recurrence.",
    );
    await createPaper("Unread preprint", { year: 2024 }, ADDED_SECOND);
    const projection = createProjectionService(cacheRoot);

    const listed = await library(projection);
    // A page of rows is drawn from the index alone, so a summary the index does not carry is a
    // summary the table would have to open every JSON file to show.
    expect(listed.objects.map((object) => [object.title, object.summary])).toEqual([
      ["Attention Is All You Need", "Attention alone beats recurrence."],
      ["Unread preprint", ""],
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("carries the read mark, and narrows the library down to one heap", async () => {
    await createPaper("Attention Is All You Need", { year: 2017 }, ADDED_FIRST, [], "", true);
    await createPaper("Unread preprint", { year: 2024 }, ADDED_SECOND);
    const projection = createProjectionService(cacheRoot);

    const listed = await library(projection);
    expect(listed.objects.map((object) => [object.title, object.read])).toEqual([
      ["Attention Is All You Need", true],
      ["Unread preprint", false],
    ]);
    expect(await titlesFilteredBy(projection, { read: ["unread"] })).toEqual(["Unread preprint"]);
    // Choosing both states is choosing neither, the same as picking every tag in the library.
    expect(await titlesFilteredBy(projection, { read: ["read", "unread"] })).toEqual([
      "Attention Is All You Need",
      "Unread preprint",
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("offers only the read states the library actually holds", async () => {
    await createPaper("Unread preprint", { year: 2024 }, ADDED_FIRST);
    await createPaper("Another unread preprint", { year: 2025 }, ADDED_SECOND);
    const projection = createProjectionService(cacheRoot);

    // A menu offering Read in a library where nothing has been read is a menu whose only use is
    // to empty the table.
    expect((await library(projection)).available.read).toEqual(["unread"]);
    projection.close(WORKSPACE_ID);
  });

  it("remembers which items this machine has opened, and orders the library by it", async () => {
    await createPaper("Opened first", { year: 2017 }, ADDED_FIRST);
    await createPaper("Opened second", { year: 2018 }, ADDED_SECOND);
    await createPaper("Never opened", { year: 2019 }, ADDED_THIRD);
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    const listed = await library(projection);
    const byTitle = new Map(listed.objects.map((object) => [object.title, object.id]));

    // Nothing has been opened yet, and the column says so rather than guessing.
    expect(listed.objects.every((object) => object.last_opened_at === null)).toBe(true);
    await projection.markOpened(target, byTitle.get("Opened first") ?? "", ADDED_FIRST);
    await projection.markOpened(target, byTitle.get("Opened second") ?? "", ADDED_SECOND);

    const recent = await library(projection, {
      sort: { field: "last_opened", direction: "descending" },
    });
    // Never opened is not opened long ago, so it sits at the bottom rather than at whichever end
    // nulls happen to fall.
    expect(recent.objects.map((object) => object.title)).toEqual([
      "Opened second",
      "Opened first",
      "Never opened",
    ]);
    expect(recent.objects[0]?.last_opened_at).toBe(ADDED_SECOND);
    const oldest = await library(projection, {
      sort: { field: "last_opened", direction: "ascending" },
    });
    expect(oldest.objects.map((object) => object.title)).toEqual([
      "Opened first",
      "Opened second",
      "Never opened",
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("keeps only the latest opening, and keeps it across a rebuild", async () => {
    await createPaper("Attention Is All You Need", { year: 2017 }, ADDED_FIRST);
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    const objectId = (await library(projection)).objects[0]?.id ?? "";

    await projection.markOpened(target, objectId, ADDED_FIRST);
    await projection.markOpened(target, objectId, ADDED_SECOND);
    expect((await library(projection)).objects[0]?.last_opened_at).toBe(ADDED_SECOND);

    // The rebuild throws away everything it can read again from the files. This is the one thing
    // it cannot, so it is the one thing it leaves alone.
    await projection.rebuild(target);
    expect((await library(projection)).objects[0]?.last_opened_at).toBe(ADDED_SECOND);
    // Clearing the index is a repair. It should not also cost somebody their reading history.
    await projection.clearAndRebuild(target);
    expect((await library(projection)).objects[0]?.last_opened_at).toBe(ADDED_SECOND);
    projection.close(WORKSPACE_ID);
  });

  it("discards a cache written by an older schema instead of querying it", async () => {
    await createObject(OBJECT_A, "Kept record", "The workspace still holds this.");
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await projection.ensure(target);
    projection.close(WORKSPACE_ID);

    const older = new DatabaseSync(join(projection.cacheDirectory(WORKSPACE_ID), "index.sqlite3"));
    try {
      older.exec(
        `DROP INDEX objects_type_year;
         ALTER TABLE objects DROP COLUMN reference_year;
         PRAGMA user_version = 1;`,
      );
    } finally {
      older.close();
    }

    await expect(projection.list(target)).resolves.toMatchObject({
      generation: 1,
      objects: [{ id: OBJECT_A, title: "Kept record" }],
    });
    projection.close(WORKSPACE_ID);
  });

  it("removes trashed objects and relation tombstones from active projections", async () => {
    const first = await createObject(OBJECT_A, "Referenced source", "Source content.");
    await createObject(OBJECT_B, "Dependent note", "Dependent content.");
    const relation = await createRelation({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type: "supports",
      subjectId: OBJECT_A,
      objectId: OBJECT_B,
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:10:00.000Z",
      ...ids(),
    });
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await projection.ensure(target);
    await trashObject({
      root: workspaceRoot,
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
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:20:00.000Z",
      ...ids(),
    });

    await expect(projection.ensure(target)).resolves.toMatchObject({
      generation: 2,
      objectCount: 1,
      relationCount: 0,
    });
    await expect(projection.relations(target, OBJECT_B)).resolves.toMatchObject({
      relations: [],
    });
    await expect(projection.list(target)).resolves.toMatchObject({
      objects: [{ id: OBJECT_B }],
    });
    projection.close(WORKSPACE_ID);
  });

  it("refuses to place machine projection state under the workspace", async () => {
    const projection = createProjectionService(join(workspaceRoot, ".cache"));
    await expect(
      projection.ensure({ workspaceId: WORKSPACE_ID, root: workspaceRoot }),
    ).rejects.toThrow("outside the canonical workspace");
  });

  it("reports corruption without touching canonical files and rebuilds from them", async () => {
    await createObject(OBJECT_A, "Canonical record", "Survives projection loss.");
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await projection.ensure(target);
    projection.close(WORKSPACE_ID);
    await writeFile(
      join(projection.cacheDirectory(WORKSPACE_ID), "index.sqlite3"),
      "not a sqlite database",
      "utf8",
    );

    await expect(projection.status(target)).resolves.toMatchObject({ status: "corrupt" });
    await expect(projection.rebuild(target)).resolves.toMatchObject({
      status: "ready",
      objectCount: 1,
    });
    await expect(projection.search(target, "survives")).resolves.toMatchObject({
      results: [{ id: OBJECT_A }],
    });
    const cacheFiles = await readdir(projection.cacheDirectory(WORKSPACE_ID));
    expect(cacheFiles).toEqual(
      expect.arrayContaining(["index.sqlite3", "projection-manifest.json"]),
    );
    expect(cacheFiles.some((name) => name.startsWith("index.sqlite3.corrupt-"))).toBe(true);
    await expect(projection.clearAndRebuild(target)).resolves.toMatchObject({
      status: "ready",
      objectCount: 1,
    });
    projection.close(WORKSPACE_ID);
  });

  it("honors cancellation before replacing an existing generation", async () => {
    await createObject(OBJECT_A, "Stable generation", "Keep the prior result.");
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await projection.ensure(target);
    await expect(projection.rebuild(target, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(projection.status(target)).resolves.toMatchObject({
      status: "ready",
      generation: 1,
    });
    projection.close(WORKSPACE_ID);
  });
});

describe("links on an object", () => {
  async function typed(type: "source" | "note", title: string) {
    return createTypedObject({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      objectId: id(),
      type,
      title,
      content: "",
      actor: "account:test",
      requestId: id(),
      now: `2026-08-22T12:0${String(sequence % 10)}:00.000Z`,
      ...ids(),
    });
  }

  async function relate(type: string, subjectId: string, objectId: string) {
    return createRelation({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      relationId: id(),
      type,
      subjectId,
      objectId,
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:30:00.000Z",
      ...ids(),
    });
  }

  /** A highlight on a paper, written the way the Reader writes one. */
  async function highlight(paperId: string, quoted: string) {
    return createAnnotation({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      annotationId: id(),
      relationId: id(),
      objectId: paperId,
      annotation: {
        ...EMPTY_ANNOTATION,
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.1, width: 0.4, height: 0.02 }],
        quoted,
      },
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:25:00.000Z",
      ...ids(),
    });
  }

  /** A paper, a highlight on it, and a note that quoted the highlight. */
  async function reading() {
    const paper = await typed("source", "Computing Machinery and Intelligence");
    const note = await typed("note", "Reading group, week three");
    const annotation = await highlight(paper.id, "the imitation game");
    await relate("quotes", note.id, annotation.id);
    return { paper, note, annotation };
  }

  it("says what a note draws on, through the passage it quoted", async () => {
    // The note quotes a highlight and the highlight is on a paper. Nobody thinks of the highlight
    // as the thing the note draws on, so the paper is what the link names.
    const { paper, note, annotation } = await reading();
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await expect(projection.links(target, note.id)).resolves.toMatchObject({
      links: [
        {
          relation_type: "quotes",
          direction: "outgoing",
          object_id: paper.id,
          object_type: "source",
          title: "Computing Machinery and Intelligence",
          via: { object_id: annotation.id, title: "the imitation game" },
        },
      ],
    });
    projection.close(WORKSPACE_ID);
  });

  it("says what quotes a paper, walking the same two steps backwards", async () => {
    const { paper, note, annotation } = await reading();
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await expect(projection.links(target, paper.id)).resolves.toMatchObject({
      links: [
        {
          relation_type: "quotes",
          direction: "incoming",
          object_id: note.id,
          object_type: "note",
          title: "Reading group, week three",
          via: { object_id: annotation.id },
        },
      ],
    });
    projection.close(WORKSPACE_ID);
  });

  it("leaves a paper's own highlights out of its links", async () => {
    // A paper with two hundred highlights would otherwise have two hundred links to itself.
    const paper = await typed("source", "Computing Machinery and Intelligence");
    await highlight(paper.id, "a passage nobody quoted");
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await expect(projection.links(target, paper.id)).resolves.toMatchObject({ links: [] });
    projection.close(WORKSPACE_ID);
  });

  it("reports an @ mention from both ends", async () => {
    const note = await typed("note", "Reading group, week three");
    const paper = await typed("source", "Computing Machinery and Intelligence");
    await relate("mentions", note.id, paper.id);
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await expect(projection.links(target, note.id)).resolves.toMatchObject({
      links: [{ direction: "outgoing", object_id: paper.id, via: null }],
    });
    await expect(projection.links(target, paper.id)).resolves.toMatchObject({
      links: [{ direction: "incoming", object_id: note.id, via: null }],
    });
    projection.close(WORKSPACE_ID);
  });

  it("does not answer with somebody else's use of the same passage", async () => {
    // Two notes quoting one highlight are not linked to each other. What they share is the paper.
    const { note, annotation } = await reading();
    const other = await typed("note", "A different reader");
    await relate("quotes", other.id, annotation.id);
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    const answer = await projection.links(target, note.id);
    expect(answer.links.map((entry) => entry.object_id)).not.toContain(other.id);
    projection.close(WORKSPACE_ID);
  });

  it("counts one link per quotation, so a note that quoted twice says twice", async () => {
    const paper = await typed("source", "Computing Machinery and Intelligence");
    const note = await typed("note", "Reading group, week three");
    for (const words of ["the imitation game", "machines can think"]) {
      const annotation = await highlight(paper.id, words);
      await relate("quotes", note.id, annotation.id);
    }
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    const answer = await projection.links(target, note.id);
    expect(answer.links).toHaveLength(2);
    expect(answer.links.every((entry) => entry.object_id === paper.id)).toBe(true);
    projection.close(WORKSPACE_ID);
  });

  it("forgets a link when the object at the other end is trashed", async () => {
    const note = await typed("note", "Reading group, week three");
    const paper = await typed("source", "Computing Machinery and Intelligence");
    const relation = await relate("mentions", note.id, paper.id);
    const projection = createProjectionService(cacheRoot);
    const target = { workspaceId: WORKSPACE_ID, root: workspaceRoot };
    await expect(projection.links(target, note.id)).resolves.toMatchObject({
      links: [{ object_id: paper.id }],
    });
    await trashObject({
      root: workspaceRoot,
      workspaceId: WORKSPACE_ID,
      objectId: paper.id,
      expectedVersion: paper.version,
      expectedHash: paper.content_hash,
      expectedRelations: [
        {
          relation_id: relation.id,
          version: relation.version,
          content_hash: relation.content_hash,
        },
      ],
      actor: "account:test",
      requestId: id(),
      now: "2026-08-22T12:40:00.000Z",
      ...ids(),
    });
    await expect(projection.links(target, note.id)).resolves.toMatchObject({ links: [] });
    projection.close(WORKSPACE_ID);
  });
});
