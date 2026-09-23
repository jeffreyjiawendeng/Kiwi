import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  COLLECTION_FILTER_OPTION_LIMIT,
  collectionReadValue,
  DEFAULT_COLLECTION_QUERY,
  EMPTY_COLLECTION_FILTERS,
  foldCollectionFilterValue,
  parseAuthorName,
  readPaperReadState,
  readPaperSummary,
  readReference,
  type CollectionFilters,
  type CollectionQuery,
  type CollectionSortField,
} from "@kiwi/contracts";
import {
  ANNOTATES_RELATION,
  listCanonicalObjects,
  listCanonicalRelations,
  listCoeditNotes,
  readCanonicalObject,
} from "@kiwi/workspace";

const APPLICATION_ID = 0x4b495749;
/** What a highlight is filed as. Links run through one rather than stopping at it. */
const ANNOTATION_TYPE = "annotation";
/**
 * Raised to 2 when the sortable columns arrived, to 3 when the filterable ones did, to 4 for the
 * reader's own summary, to 5 for the mark saying a work has been read, and to 6 for the times
 * this machine opened things. The index is disposable by design, so a cache written by an older
 * schema is deleted and built again rather than migrated: a migration is a thing to maintain
 * forever, and this file can always be reproduced from the workspace.
 *
 * `object_opens` is the one table here that cannot be reproduced, so raising this number forgets
 * it. That is the price of not maintaining migrations, and it is a price worth paying for this
 * one table: what is lost is an ordering, not a fact about anybody's research.
 */
const SCHEMA_VERSION = 6;

export interface ProjectionTarget {
  workspaceId: string;
  root: string;
}

export interface ProjectionStatus {
  status: "ready" | "missing" | "stale" | "corrupt";
  generation: number;
  schemaVersion: number;
  objectCount: number;
  relationCount: number;
  errorCount: number;
  updatedAt: string | null;
  location: "outside_workspace";
}

export interface ProjectedObject {
  id: string;
  type: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  canonical_path: string;
  generation: number;
  /** From the Paper's reference record. Null on everything that has no such record. */
  reference_year: number | null;
  /** The first author as written, for a column. The order uses `author_sort` instead. */
  first_author: string | null;
  /** Article, book, thesis, from the same record, and null for the same reason. */
  reference_kind: string | null;
  /** The reader's own one line about the work. Empty on everything nobody has written one for. */
  summary: string;
  /** Whether the work has been marked read. False on everything nobody has marked. */
  read: boolean;
  /**
   * When this machine last opened the item, and null for everything it has not.
   *
   * The one field here that is not a fact about the workspace. It is kept beside the others
   * because the table sorts by it, and a column the table sorts by has to be somewhere the sort
   * can read.
   */
  last_opened_at: string | null;
}

export interface ProjectionSearchResult extends ProjectedObject {
  matched_fields: string[];
  rank: number;
}

interface StateRow {
  workspace_id: string;
  generation: number;
  structural_hash: string;
  updated_at: string;
  object_count: number;
  relation_count: number;
  error_count: number;
}

/**
 * One link on an object, with the thing at the other end named.
 *
 * The relation store holds pairs of ids. Every surface that shows links wants sentences -- what
 * this note draws on, what has quoted this paper -- so the join onto titles happens here, once,
 * rather than in three panels each making one read per row.
 */
export interface ProjectedLink {
  /** The relation this came from. Two quotations of one paper are two links, not one. */
  relation_id: string;
  relation_type: string;
  /** Outgoing is this object pointing at something; incoming is something pointing at it. */
  direction: "incoming" | "outgoing";
  object_id: string;
  object_type: string;
  title: string;
  /**
   * The annotation the link runs through, where it runs through one.
   *
   * A note quotes a highlight, and the highlight is on a paper. Nobody thinks of the highlight as
   * the thing the note draws on, so the link is reported against the paper and the passage is
   * kept here -- it is what gets somebody back to the page the words are on.
   */
  via: { object_id: string; title: string } | null;
}

export interface ProjectionService {
  ensure(target: ProjectionTarget): Promise<ProjectionStatus>;
  status(target: ProjectionTarget): Promise<ProjectionStatus>;
  rebuild(target: ProjectionTarget, signal?: AbortSignal): Promise<ProjectionStatus>;
  clearAndRebuild(target: ProjectionTarget, signal?: AbortSignal): Promise<ProjectionStatus>;
  list(
    target: ProjectionTarget,
    query?: CollectionQuery,
  ): Promise<{
    generation: number;
    total: number;
    offset: number;
    limit: number;
    objects: ProjectedObject[];
    /** Every value this collection could be narrowed by, whether or not it currently is. */
    available: CollectionFilters;
  }>;
  relations(
    target: ProjectionTarget,
    objectId: string,
  ): Promise<{
    generation: number;
    relations: Array<{
      direction: "incoming" | "outgoing";
      relation: {
        id: string;
        type: string;
        subject: { object_id: string };
        object: { object_id: string };
      };
    }>;
  }>;
  links(
    target: ProjectionTarget,
    objectId: string,
  ): Promise<{ generation: number; links: ProjectedLink[] }>;
  search(
    target: ProjectionTarget,
    query: string,
  ): Promise<{ generation: number; results: ProjectionSearchResult[] }>;
  /** Records that this machine opened an item, now or at a time it is told. */
  markOpened(
    target: ProjectionTarget,
    objectId: string,
    at?: string,
  ): Promise<{ object_id: string; opened_at: string }>;
  cacheDirectory(workspaceId: string): string;
  close(workspaceId: string): void;
}

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function rowStatus(
  row: StateRow | undefined,
  status: ProjectionStatus["status"],
): ProjectionStatus {
  return {
    status,
    generation: row?.generation ?? 0,
    schemaVersion: SCHEMA_VERSION,
    objectCount: row?.object_count ?? 0,
    relationCount: row?.relation_count ?? 0,
    errorCount: row?.error_count ?? 0,
    updatedAt: row?.updated_at ?? null,
    location: "outside_workspace",
  };
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 2500;
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
    CREATE TABLE IF NOT EXISTS projection_state (
      workspace_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      structural_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      object_count INTEGER NOT NULL,
      relation_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL,
      reference_year INTEGER,
      first_author TEXT,
      author_sort TEXT,
      reference_kind TEXT,
      -- The reader's own sentence about the work. A column rather than something read back out
      -- of the JSON, because the table shows it a page of rows at a time.
      summary TEXT NOT NULL DEFAULT '',
      -- Whether the work has been marked read, as 0 or 1 because SQLite has no boolean of its
      -- own. Every row has an answer, so the filter never has to reason about a missing one.
      read INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS objects_type_updated ON objects(type, updated_at);
    CREATE INDEX IF NOT EXISTS objects_type_created ON objects(type, created_at);
    CREATE INDEX IF NOT EXISTS objects_type_year ON objects(type, reference_year);
    CREATE INDEX IF NOT EXISTS objects_type_author ON objects(type, author_sort);
    CREATE INDEX IF NOT EXISTS objects_type_kind ON objects(type, reference_kind);
    CREATE INDEX IF NOT EXISTS objects_type_read ON objects(type, read);
    -- The values an object has several of, one row each: its tags, and every author on its
    -- reference record. A filter matches on the folded value and a menu shows the display one,
    -- so 'ana ortiz' finds the paper and the chip still reads Ana Ortiz.
    CREATE TABLE IF NOT EXISTS object_facets (
      object_id TEXT NOT NULL,
      facet TEXT NOT NULL,
      value TEXT NOT NULL,
      display TEXT NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (object_id, facet, value)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS object_facets_lookup ON object_facets(facet, value, generation);
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      generation INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS relations_forward ON relations(subject_id, type, object_id);
    CREATE INDEX IF NOT EXISTS relations_reverse ON relations(object_id, type, subject_id);
    -- When this machine last opened each item. Not a projection of anything: nothing in the
    -- workspace records it, and nothing should, because it is one person's reading on one
    -- computer rather than a fact the whole workspace shares. The rebuild leaves this table
    -- alone, which is the one exception to everything here being reproducible from the files.
    -- It is kept in this database anyway, because the Library sorts by it, and SQLite cannot
    -- order rows by a value held in browser storage.
    CREATE TABLE IF NOT EXISTS object_opens (
      object_id TEXT PRIMARY KEY,
      opened_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS projection_errors (
      canonical_path TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      generation INTEGER NOT NULL
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_objects USING fts5(
      object_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as
    Record<string, unknown> | undefined;
  if (Number(foreignKeys?.["foreign_keys"]) !== 1)
    throw new Error("The projection could not enable SQLite foreign keys.");
}

function state(database: DatabaseSync, workspaceId: string): StateRow | undefined {
  return database
    .prepare(
      `SELECT workspace_id, generation, structural_hash, updated_at,
              object_count, relation_count, error_count
         FROM projection_state WHERE workspace_id = ?`,
    )
    .get(workspaceId) as StateRow | undefined;
}

function quoteFts(query: string): string {
  return query
    .normalize("NFC")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * How each sortable column is ordered, and which column decides that a row has no value at all.
 *
 * A paper with no year and a paper with no author go to the bottom whichever way the column is
 * turned, because a missing year is not an early one and an anonymous work is not first
 * alphabetically. SQLite would otherwise put them at whichever end nulls happen to fall.
 */
const COLLECTION_SORT_SQL: Record<CollectionSortField, { order: string; missing: string | null }> =
  {
    title: { order: "title COLLATE NOCASE", missing: null },
    type: { order: "type COLLATE NOCASE", missing: null },
    updated_at: { order: "updated_at", missing: null },
    created_at: { order: "created_at", missing: null },
    year: { order: "reference_year", missing: "reference_year" },
    first_author: { order: "author_sort COLLATE NOCASE", missing: "author_sort" },
    // Never opened is not "opened long ago", so those rows sit at the bottom whichever way the
    // column is turned, exactly as a missing year does.
    last_opened: { order: "last_opened_at", missing: "last_opened_at" },
  };

interface ReferenceFields {
  year: number | null;
  firstAuthor: string | null;
  authorSort: string | null;
  kind: string | null;
  authors: string[];
}

const NO_REFERENCE: ReferenceFields = {
  year: null,
  firstAuthor: null,
  authorSort: null,
  kind: null,
  authors: [],
};

/**
 * The year, the kind, and the authors a Paper is filed under.
 *
 * The order uses the family name, because a library sorted by given name is a library nobody
 * can find anything in, while the column shows the name as its author wrote it. Every author is
 * kept for the filter and only the first for the column: somebody looking for a colleague's
 * work wants the papers they are third author on as well. Anything that is not a Paper, and any
 * Paper whose record is unreadable, simply has no value here: losing a place in one ordering is
 * a smaller failure than losing the row.
 */
function referenceFields(object: Record<string, unknown>): ReferenceFields {
  if (object["reference"] === undefined) return NO_REFERENCE;
  const reference = readReference(object["reference"]);
  const authors = reference.authors
    .map((author) => author.trim())
    .filter((author) => author !== "");
  const first = authors[0] ?? "";
  const name = first === "" ? null : parseAuthorName(first);
  return {
    year: reference.year,
    firstAuthor: first === "" ? null : first,
    authorSort: name === null ? null : `${name.family} ${name.given}`.trim(),
    kind: reference.kind,
    authors,
  };
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted === true)
    throw new DOMException("Projection rebuild cancelled.", "AbortError");
}

async function yieldForCancellation(signal?: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  aborted(signal);
}

export function createProjectionService(machineWorkspacesRoot: string): ProjectionService {
  const open = new Map<string, DatabaseSync>();

  function cacheDirectory(workspaceId: string): string {
    return join(machineWorkspacesRoot, workspaceId);
  }

  async function database(target: ProjectionTarget): Promise<DatabaseSync> {
    const cache = cacheDirectory(target.workspaceId);
    if (inside(target.root, cache))
      throw new Error("The projection cache must remain outside the canonical workspace.");
    await mkdir(cache, { recursive: true });
    const existing = open.get(target.workspaceId);
    if (existing !== undefined) return existing;
    await discardOutdatedSchema(cache);
    const created = new DatabaseSync(join(cache, "index.sqlite3"), { timeout: 2_500 });
    try {
      initialize(created);
    } catch (cause) {
      created.close();
      throw cause;
    }
    open.set(target.workspaceId, created);
    return created;
  }

  /**
   * Deletes a cache left by an older schema, so the next open builds a current one.
   *
   * Nothing here is not also in the workspace, so rebuilding costs a moment while carrying
   * migration code for a disposable file costs forever. An unreadable database is left alone:
   * that is corruption, which `rebuild` already quarantines rather than deletes.
   */
  async function discardOutdatedSchema(cache: string): Promise<void> {
    const path = join(cache, "index.sqlite3");
    if (
      !(await access(path)
        .then(() => true)
        .catch(() => false))
    )
      return;
    let version: number;
    try {
      const probe = new DatabaseSync(path, { timeout: 2_500 });
      try {
        const row = probe.prepare("PRAGMA user_version").get() as
          Record<string, unknown> | undefined;
        version = Number(row?.["user_version"] ?? 0);
      } finally {
        probe.close();
      }
    } catch {
      return;
    }
    if (version === SCHEMA_VERSION) return;
    for (const name of ["index.sqlite3", "index.sqlite3-wal", "index.sqlite3-shm"]) {
      await rm(join(cache, name), { force: true });
    }
  }

  async function quarantineDatabase(target: ProjectionTarget): Promise<void> {
    open.get(target.workspaceId)?.close();
    open.delete(target.workspaceId);
    const cache = cacheDirectory(target.workspaceId);
    const suffix = new Date().toISOString().replaceAll(":", "-");
    for (const name of ["index.sqlite3", "index.sqlite3-wal", "index.sqlite3-shm"]) {
      const source = join(cache, name);
      if (
        await access(source)
          .then(() => true)
          .catch(() => false)
      ) {
        await rename(source, join(cache, `${name}.corrupt-${suffix}`));
      }
    }
  }

  async function inventory(target: ProjectionTarget) {
    const [objects, relations, notes] = await Promise.all([
      listCanonicalObjects(target.root),
      listCanonicalRelations(target.root),
      listCoeditNotes(target.root),
    ]);
    const structuralHash = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          objects: objects.map((item) => [item.id, item.version, item.content_hash]),
          relations: relations.map((item) => [item.id, item.version, item.content_hash]),
          notes: notes.map((item) => [item.document_id, item.operation_count, item.content_hash]),
        }),
      )
      .digest("hex")}`;
    return { objects, relations, notes, structuralHash };
  }

  async function writeManifest(
    target: ProjectionTarget,
    projection: ProjectionStatus,
    structuralHash: string,
  ): Promise<void> {
    const path = join(cacheDirectory(target.workspaceId), "projection-manifest.json");
    const next = `${path}.next`;
    await writeFile(
      next,
      `${JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          workspace_id: target.workspaceId,
          generation: projection.generation,
          structural_hash: structuralHash,
          updated_at: projection.updatedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(next, path);
  }

  async function rebuild(
    target: ProjectionTarget,
    signal?: AbortSignal,
  ): Promise<ProjectionStatus> {
    aborted(signal);
    let db: DatabaseSync;
    try {
      db = await database(target);
      db.prepare("PRAGMA quick_check").get();
    } catch {
      await quarantineDatabase(target);
      db = await database(target);
    }
    const prior = state(db, target.workspaceId);
    const generation = (prior?.generation ?? 0) + 1;
    const now = new Date().toISOString();
    const scanned = await inventory(target);
    aborted(signal);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "DELETE FROM fts_objects; DELETE FROM relations; DELETE FROM objects; DELETE FROM object_facets; DELETE FROM projection_errors;",
      );
      const insertObject = db.prepare(
        `INSERT INTO objects
          (id,type,title,content,version,content_hash,created_at,updated_at,updated_by,
           canonical_path,generation,reference_year,first_author,author_sort,reference_kind,
           summary,read)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertFts = db.prepare("INSERT INTO fts_objects(object_id,title,body) VALUES (?,?,?)");
      const insertFacet = db.prepare(
        `INSERT INTO object_facets(object_id,facet,value,display,generation) VALUES (?,?,?,?,?)
         ON CONFLICT(object_id,facet,value) DO NOTHING`,
      );
      function facet(objectId: string, name: "tag" | "author", values: readonly string[]): void {
        for (const value of values) {
          const folded = foldCollectionFilterValue(value);
          if (folded === "") continue;
          insertFacet.run(objectId, name, folded, value.normalize("NFC").trim(), generation);
        }
      }
      for (const object of scanned.objects) {
        if (object === scanned.objects[0] || scanned.objects.indexOf(object) % 100 === 0)
          await yieldForCancellation(signal);
        const found = await readCanonicalObject(target.root, object.id);
        const reference = referenceFields(object);
        insertObject.run(
          object.id,
          object.type,
          object.title,
          object.content,
          object.version,
          object.content_hash,
          object.created_at,
          object.updated_at,
          object.updated_by,
          found?.relativePath ?? `objects/${object.id}.json`,
          generation,
          reference.year,
          reference.firstAuthor,
          reference.authorSort,
          reference.kind,
          readPaperSummary(object["summary"]),
          readPaperReadState(object["read"]) ? 1 : 0,
        );
        facet(object.id, "author", reference.authors);
        facet(object.id, "tag", Array.isArray(object.tags) ? object.tags : []);
        insertFts.run(object.id, object.title, object.content);
      }
      for (const note of scanned.notes) {
        if (scanned.notes.indexOf(note) % 100 === 0) await yieldForCancellation(signal);
        insertObject.run(
          note.document_id,
          "note",
          note.title,
          note.content,
          Math.max(1, note.operation_count),
          note.content_hash,
          // A live note keeps no creation time, so the only honest answer to when it was added
          // is when it was last written. Sorting by date added puts it where it last moved.
          note.updated_at,
          note.updated_at,
          "coedit",
          `objects/notes/${note.document_id}.md`,
          generation,
          null,
          null,
          null,
          null,
          // A live note is a stream of operations rather than a canonical file, so there is
          // nowhere on it for a summary or a read mark to have been written yet.
          "",
          0,
        );
        insertFts.run(note.document_id, note.title, note.content);
      }
      const insertRelation = db.prepare(
        `INSERT INTO relations(id,type,subject_id,object_id,content_hash,generation)
         VALUES (?,?,?,?,?,?)`,
      );
      const activeRelations = scanned.relations.filter(
        (relation) => relation.assertion === "asserted",
      );
      for (const relation of activeRelations) {
        if (activeRelations.indexOf(relation) % 100 === 0) await yieldForCancellation(signal);
        insertRelation.run(
          relation.id,
          relation.type,
          relation.subject.object_id,
          relation.object.object_id,
          relation.content_hash,
          generation,
        );
      }
      db.prepare(
        `INSERT INTO projection_state
          (workspace_id,generation,structural_hash,updated_at,object_count,relation_count,error_count)
         VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(workspace_id) DO UPDATE SET
           generation=excluded.generation, structural_hash=excluded.structural_hash,
           updated_at=excluded.updated_at, object_count=excluded.object_count,
           relation_count=excluded.relation_count, error_count=0`,
      ).run(
        target.workspaceId,
        generation,
        scanned.structuralHash,
        now,
        scanned.objects.length + scanned.notes.length,
        activeRelations.length,
      );
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    const result = rowStatus(state(db, target.workspaceId), "ready");
    await writeManifest(target, result, scanned.structuralHash);
    return result;
  }

  async function status(target: ProjectionTarget): Promise<ProjectionStatus> {
    try {
      const db = await database(target);
      const integrity = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      if (String(integrity["quick_check"]) !== "ok") return rowStatus(undefined, "corrupt");
      const current = state(db, target.workspaceId);
      if (current === undefined) return rowStatus(undefined, "missing");
      const scanned = await inventory(target);
      return rowStatus(
        current,
        scanned.structuralHash === current.structural_hash ? "ready" : "stale",
      );
    } catch {
      return rowStatus(undefined, "corrupt");
    }
  }

  async function ensure(target: ProjectionTarget): Promise<ProjectionStatus> {
    const current = await status(target);
    return current.status === "ready" ? current : rebuild(target);
  }

  async function clearAndRebuild(
    target: ProjectionTarget,
    signal?: AbortSignal,
  ): Promise<ProjectionStatus> {
    aborted(signal);
    const cache = cacheDirectory(target.workspaceId);
    if (inside(target.root, cache))
      throw new Error("The projection cache must remain outside the canonical workspace.");
    /**
     * The reading times are carried across the wipe, because they are the one thing here that
     * deleting the file would actually lose.
     *
     * Somebody clearing the index is repairing it. Everything else comes back from the workspace
     * a moment later, and forgetting which papers they had opened would be a second, unasked-for
     * loss handed to them for asking to fix the first. If the file is too broken to read, the
     * repair still goes ahead with nothing carried.
     */
    const carried = await (async (): Promise<Array<{ id: string; at: string }>> => {
      try {
        const db = await database(target);
        return (
          db.prepare("SELECT object_id, opened_at FROM object_opens").all() as Record<
            string,
            unknown
          >[]
        ).map((row) => ({ id: String(row["object_id"]), at: String(row["opened_at"]) }));
      } catch {
        return [];
      }
    })();
    open.get(target.workspaceId)?.close();
    open.delete(target.workspaceId);
    await rm(cache, { recursive: true, force: true });
    aborted(signal);
    const status = await rebuild(target, signal);
    if (carried.length > 0) {
      const db = await database(target);
      const insert = db.prepare(
        `INSERT INTO object_opens(object_id,opened_at) VALUES (?,?)
         ON CONFLICT(object_id) DO UPDATE SET opened_at = excluded.opened_at`,
      );
      for (const entry of carried) insert.run(entry.id, entry.at);
    }
    return status;
  }

  function projected(row: Record<string, unknown>): ProjectedObject {
    return {
      id: String(row["id"]),
      type: String(row["type"]),
      title: String(row["title"]),
      content: String(row["content"]),
      version: Number(row["version"]),
      content_hash: String(row["content_hash"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      updated_by: String(row["updated_by"]),
      canonical_path: String(row["canonical_path"]),
      generation: Number(row["generation"]),
      reference_year: row["reference_year"] === null ? null : Number(row["reference_year"]),
      first_author: row["first_author"] === null ? null : String(row["first_author"]),
      reference_kind:
        row["reference_kind"] === null || row["reference_kind"] === undefined
          ? null
          : String(row["reference_kind"]),
      summary:
        row["summary"] === null || row["summary"] === undefined ? "" : String(row["summary"]),
      read: Number(row["read"] ?? 0) === 1,
      last_opened_at:
        row["last_opened_at"] === null || row["last_opened_at"] === undefined
          ? null
          : String(row["last_opened_at"]),
    };
  }

  /**
   * The list of rows joined to whichever query is asking, and the join that puts the reading
   * times beside them.
   *
   * `LEFT`, because a library where nothing has been opened is still a library, and an inner
   * join would quietly hide every row until somebody had read it.
   */
  const OPENS_JOIN = "LEFT JOIN object_opens n ON n.object_id = o.id";

  return {
    ensure,
    status,
    rebuild,
    clearAndRebuild,
    cacheDirectory,
    async list(target, query = DEFAULT_COLLECTION_QUERY) {
      const current = await ensure(target);
      const db = await database(target);
      /**
       * The collection before any narrowing: this generation, and the family being looked at.
       *
       * The values offered to filter by are counted over this rather than over the narrowed
       * result, so choosing one tag does not empty the menu the second tag would come from.
       */
      function family(prefix: string): { where: string; parameters: Array<string | number> } {
        const clauses = [`${prefix}generation = ?`];
        const values: Array<string | number> = [current.generation];
        if (query.object_types.length > 0) {
          clauses.push(`${prefix}type IN (${query.object_types.map(() => "?").join(",")})`);
          values.push(...query.object_types);
        }
        return { where: clauses.join(" AND "), parameters: values };
      }
      const scope = family("");
      const conditions = [scope.where];
      const parameters: Array<string | number> = [...scope.parameters];
      const normalizedText = query.text.normalize("NFC").trim();
      if (normalizedText !== "") {
        conditions.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
        const pattern = `%${escapeLike(normalizedText)}%`;
        parameters.push(pattern, pattern);
      }
      const filters = query.filters ?? EMPTY_COLLECTION_FILTERS;
      if (filters.kinds.length > 0) {
        conditions.push(`reference_kind IN (${filters.kinds.map(() => "?").join(",")})`);
        parameters.push(...filters.kinds.map(foldCollectionFilterValue));
      }
      // Both values chosen is every row, and the SQL says so rather than being special-cased:
      // `read IN (0,1)` is what a group nobody narrowed already means.
      if (filters.read.length > 0) {
        conditions.push(`read IN (${filters.read.map(() => "?").join(",")})`);
        parameters.push(...filters.read.map((value) => (value === "read" ? 1 : 0)));
      }
      if (filters.years.length > 0) {
        conditions.push(`reference_year IN (${filters.years.map(() => "?").join(",")})`);
        parameters.push(...filters.years);
      }
      // Each group is a separate condition, so an item must match something in every group that
      // has anything in it, and any one value within that group is enough.
      for (const group of [
        { facet: "tag", values: filters.tags },
        { facet: "author", values: filters.authors },
      ] as const) {
        if (group.values.length === 0) continue;
        conditions.push(
          `id IN (SELECT object_id FROM object_facets
                   WHERE generation = ? AND facet = ?
                     AND value IN (${group.values.map(() => "?").join(",")}))`,
        );
        parameters.push(
          current.generation,
          group.facet,
          ...group.values.map(foldCollectionFilterValue),
        );
      }
      const where = conditions.join(" AND ");
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS total FROM objects WHERE ${where}`)
        .get(...parameters) as Record<string, unknown>;
      const direction = query.sort.direction === "ascending" ? "ASC" : "DESC";
      const sort = COLLECTION_SORT_SQL[query.sort.field];
      const absent = sort.missing === null ? "" : `${sort.missing} IS NULL, `;
      const rows = db
        .prepare(
          `SELECT o.*, n.opened_at AS last_opened_at FROM objects o ${OPENS_JOIN}
            WHERE ${where}
            ORDER BY ${absent}${sort.order} ${direction}, o.id ASC LIMIT ? OFFSET ?`,
        )
        .all(...parameters, query.page.limit, query.page.offset) as Record<string, unknown>[];
      const joined = family("o.");
      function values(column: string, order: string): unknown[] {
        return (
          db
            .prepare(
              `SELECT DISTINCT ${column} AS value FROM objects
                WHERE ${scope.where} AND ${column} IS NOT NULL
                ORDER BY ${order} LIMIT ?`,
            )
            .all(...scope.parameters, COLLECTION_FILTER_OPTION_LIMIT) as Record<string, unknown>[]
        ).map((row) => row["value"]);
      }
      function facetValues(facet: "tag" | "author"): string[] {
        return (
          db
            .prepare(
              `SELECT MIN(f.display) AS display, COUNT(*) AS uses
                 FROM object_facets f JOIN objects o ON o.id = f.object_id
                WHERE f.generation = ? AND f.facet = ? AND ${joined.where}
                GROUP BY f.value
                ORDER BY uses DESC, display COLLATE NOCASE ASC LIMIT ?`,
            )
            .all(
              current.generation,
              facet,
              ...joined.parameters,
              COLLECTION_FILTER_OPTION_LIMIT,
            ) as Record<string, unknown>[]
        ).map((row) => String(row["display"]));
      }
      return {
        generation: current.generation,
        total: Number(totalRow["total"]),
        offset: query.page.offset,
        limit: query.page.limit,
        objects: rows.map(projected),
        available: {
          kinds: values("reference_kind", "value COLLATE NOCASE ASC").map(String),
          tags: facetValues("tag"),
          authors: facetValues("author"),
          years: values("reference_year", "value DESC").map(Number),
          // Only the states this family actually holds. A library where nothing has been read
          // offers Unread alone, and a filter that could only ever return everything is not
          // offered at all.
          read: values("read", "value DESC").map((value) =>
            collectionReadValue(Number(value) === 1),
          ),
        },
      };
    },
    async search(target, query) {
      const current = await ensure(target);
      const expression = quoteFts(query);
      if (expression === "") return { generation: current.generation, results: [] };
      const db = await database(target);
      const rows = db
        .prepare(
          `SELECT o.*, n.opened_at AS last_opened_at, bm25(fts_objects, 0.0, 4.0, 1.0) AS score
             FROM fts_objects JOIN objects o ON o.id = fts_objects.object_id ${OPENS_JOIN}
            WHERE fts_objects MATCH ? AND o.generation = ?
            ORDER BY score, o.id LIMIT 100`,
        )
        .all(expression, current.generation) as Record<string, unknown>[];
      const terms = query.toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
      return {
        generation: current.generation,
        results: rows.map((row) => {
          const object = projected(row);
          const title = object.title.toLocaleLowerCase("en-US");
          const body = object.content.toLocaleLowerCase("en-US");
          return {
            ...object,
            matched_fields: [
              ...(terms.some((term) => title.includes(term)) ? ["title"] : []),
              ...(terms.some((term) => body.includes(term)) ? ["body"] : []),
            ],
            rank: Number(row["score"]),
          };
        }),
      };
    },
    /**
     * Writes down that this machine opened something, keeping only the latest time.
     *
     * One row per item and not a history. What the Library asks is where you were last, and a
     * log of every time a paper was opened would answer that no better while growing without
     * end. The row is written whether or not the workspace is writable, because opening a paper
     * on a read-only copy is still something you did.
     */
    async markOpened(target, objectId, at) {
      await ensure(target);
      const db = await database(target);
      const openedAt = at ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO object_opens(object_id,opened_at) VALUES (?,?)
         ON CONFLICT(object_id) DO UPDATE SET opened_at = excluded.opened_at`,
      ).run(objectId, openedAt);
      return { object_id: objectId, opened_at: openedAt };
    },
    async relations(target, objectId) {
      const current = await ensure(target);
      const db = await database(target);
      const rows = db
        .prepare(
          `SELECT id,type,subject_id,object_id FROM relations
            WHERE generation = ? AND (subject_id = ? OR object_id = ?)
            ORDER BY id`,
        )
        .all(current.generation, objectId, objectId) as Record<string, unknown>[];
      return {
        generation: current.generation,
        relations: rows.map((row) => ({
          direction: String(row["subject_id"]) === objectId ? "outgoing" : "incoming",
          relation: {
            id: String(row["id"]),
            type: String(row["type"]),
            subject: { object_id: String(row["subject_id"]) },
            object: { object_id: String(row["object_id"]) },
          },
        })),
      };
    },
    /**
     * Every link on an object, named, in both directions.
     *
     * The relation store answers this already; what it does not do is say what the things are
     * called, or fold the step through an annotation. Both happen here so that the Note page, the
     * Library inspector and the dock are three renderings of one query rather than three walks of
     * the same graph, each with its own idea of what counts as a link.
     */
    async links(target, objectId) {
      const current = await ensure(target);
      const db = await database(target);
      const touching = (ids: string[]): Record<string, unknown>[] => {
        if (ids.length === 0) return [];
        const marks = ids.map(() => "?").join(",");
        return db
          .prepare(
            `SELECT r.id, r.type, r.subject_id, r.object_id,
                    subject_row.type AS subject_type, subject_row.title AS subject_title,
                    object_row.type AS object_type, object_row.title AS object_title
               FROM relations r
               LEFT JOIN objects subject_row ON subject_row.id = r.subject_id
               LEFT JOIN objects object_row ON object_row.id = r.object_id
              WHERE r.generation = ?
                AND (r.subject_id IN (${marks}) OR r.object_id IN (${marks}))
              ORDER BY r.id`,
          )
          .all(current.generation, ...ids, ...ids) as Record<string, unknown>[];
      };

      const askedType = (
        db.prepare("SELECT type FROM objects WHERE id = ?").get(objectId) as
          Record<string, unknown> | undefined
      )?.["type"];
      const direct = touching([objectId]);

      // The annotations either side of this object: the ones on it, when it is a Paper, and the
      // ones it points at, when it is a Note quoting a passage. The first set is walked outwards
      // to find who quoted them; the second is walked outwards to find the paper they are on.
      const own = new Set<string>();
      const quoted = new Set<string>();
      for (const row of direct) {
        const outgoing = String(row["subject_id"]) === objectId;
        const farId = outgoing ? String(row["object_id"]) : String(row["subject_id"]);
        const farType = outgoing ? row["object_type"] : row["subject_type"];
        if (farType !== ANNOTATION_TYPE) continue;
        if (String(row["type"]) === ANNOTATES_RELATION) own.add(farId);
        else quoted.add(farId);
      }
      const second = touching([...own, ...quoted]);

      const paperOf = new Map<string, { id: string; type: string; title: string }>();
      for (const row of [...direct, ...second]) {
        if (String(row["type"]) !== ANNOTATES_RELATION) continue;
        if (typeof row["object_type"] !== "string") continue;
        paperOf.set(String(row["subject_id"]), {
          id: String(row["object_id"]),
          type: row["object_type"],
          title: String(row["object_title"] ?? ""),
        });
      }

      const links: ProjectedLink[] = [];
      const take = (
        row: Record<string, unknown>,
        nearId: string,
        via: ProjectedLink["via"],
      ): void => {
        const outgoing = String(row["subject_id"]) === nearId;
        let farId = outgoing ? String(row["object_id"]) : String(row["subject_id"]);
        let farType = outgoing ? row["object_type"] : row["subject_type"];
        let farTitle = outgoing ? row["object_title"] : row["subject_title"];
        let through = via;
        if (farType === ANNOTATION_TYPE) {
          const paper = paperOf.get(farId);
          // An annotation whose paper this index cannot name is a link to nowhere. Reporting the
          // highlight instead would put a sentence fragment in a list of works.
          if (paper === undefined) return;
          through = { object_id: farId, title: String(farTitle ?? "") };
          farId = paper.id;
          farType = paper.type;
          farTitle = paper.title;
        }
        // A relation whose other end is not in the index points at something trashed or not yet
        // projected, and a row with no name on it is worse than no row.
        if (typeof farType !== "string" || farId === objectId) return;
        links.push({
          relation_id: String(row["id"]),
          relation_type: String(row["type"]),
          direction: outgoing ? "outgoing" : "incoming",
          object_id: farId,
          object_type: farType,
          title: String(farTitle ?? ""),
          via: through,
        });
      };

      for (const row of direct) {
        // What ties an annotation to its paper is the step, not the destination. Listing it would
        // put every highlight in the paper's own list of links.
        if (String(row["type"]) === ANNOTATES_RELATION && askedType !== ANNOTATION_TYPE) continue;
        take(row, objectId, null);
      }
      for (const row of second) {
        if (String(row["type"]) === ANNOTATES_RELATION) continue;
        const subjectId = String(row["subject_id"]);
        const objectEnd = String(row["object_id"]);
        // Only the annotations on this object are walked outwards. The ones it quotes belong to
        // somebody else's paper, and what else quotes them is not a link on this.
        const nearId = own.has(subjectId) ? subjectId : own.has(objectEnd) ? objectEnd : null;
        if (nearId === null) continue;
        const nearTitle = nearId === subjectId ? row["subject_title"] : row["object_title"];
        take(row, nearId, { object_id: nearId, title: String(nearTitle ?? "") });
      }

      links.sort(
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.relation_id.localeCompare(right.relation_id),
      );
      return { generation: current.generation, links };
    },
    close(workspaceId) {
      open.get(workspaceId)?.close();
      open.delete(workspaceId);
    },
  };
}
