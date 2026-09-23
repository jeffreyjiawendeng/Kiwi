import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLLECTION_COLUMN_LABELS,
  COLLECTION_COLUMNS,
  COLLECTION_FILTER_GROUPS,
  COLLECTION_FILTER_LABELS,
  COLLECTION_PINNED_COLUMN,
  countCollectionFilters,
  defaultCollectionColumns,
  EMPTY_COLLECTION_FILTERS,
  foldCollectionFilterValue,
  isCollectionReadValue,
  isCollectionSortDirection,
  isCollectionSortField,
  isCreatableObjectType,
  objectTypeLabel,
  primaryFileId,
  readCollectionColumns,
  readCollectionFilters,
  readCollectionViewMode,
  tagLabel,
  type CitationStyle,
  type CollectionColumn,
  type CollectionFilterGroup,
  type CollectionFilters,
  type CollectionSortDirection,
  type CollectionSortField,
  type CollectionViewMode,
  type LibraryExportFormat,
  type SavedViewDescriptor,
} from "@kiwi/contracts";
import { readBridge } from "./bridge.js";
import { CanonicalObjectEditor, type PublicationReceiptView } from "./CanonicalObjectEditor.js";
import { DocumentEditor } from "./DocumentEditor.js";
import { DropMenu } from "./DropMenu.js";
import type { RestorationReceiptView } from "./ObjectHistoryPanel.js";
import {
  ObjectOrganizationMenu,
  type ObjectOrganizationAction,
  type ObjectOrganizationRequest,
} from "./ObjectOrganizationMenu.js";
import { DuplicatesPanel } from "./DuplicatesPanel.js";

interface CollectionObject {
  id: string;
  type: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  created_at?: string;
  updated_at: string;
  updated_by: string;
  generation: number;
  /** Both come from a Paper's reference record, and are absent on everything else. */
  reference_year?: number | null;
  first_author?: string | null;
  /** The reader's own line about the item, on anything somebody has written one for. */
  summary?: string;
  /** Whether it has been marked read. Absent on a row an older index generation wrote. */
  read?: boolean;
  /** When this machine last opened it. Null on anything it has not, which is most of a new library. */
  last_opened_at?: string | null;
}

interface CollectionPage {
  generation: number;
  total: number;
  offset: number;
  limit: number;
  objects: CollectionObject[];
  /** Every value this collection could be narrowed by, counted before it was narrowed. */
  available: CollectionFilters;
}

interface StoredCollectionState {
  descriptor: SavedViewDescriptor;
  selected_ids: string[];
  active_id: string | null;
  /**
   * Whether the full object editor is open beside the list.
   *
   * Absent means nobody has said, and the family decides: a Library is a list you sift, so the
   * table takes the width and the Paper is in the dock; a Notes page is a thing you write in, so
   * the editor is the page. Either way it is the way to an object's own text and to restoring an
   * earlier version of it -- the two jobs the panel in the dock does not do.
   */
  editor_open?: boolean;
}

/** What the sort menu offers, and what the label on it reads. */
const SORT_OPTIONS: ReadonlyArray<{
  label: string;
  field: CollectionSortField;
  direction: CollectionSortDirection;
  /** True where only a reference record can answer it. */
  reference?: boolean;
}> = [
  { label: "Recently updated", field: "updated_at", direction: "descending" },
  { label: "Oldest updated", field: "updated_at", direction: "ascending" },
  { label: "Recently added", field: "created_at", direction: "descending" },
  { label: "First added", field: "created_at", direction: "ascending" },
  { label: "Title A to Z", field: "title", direction: "ascending" },
  { label: "Title Z to A", field: "title", direction: "descending" },
  // Offered to every family, unlike the reference columns. A Note is picked up where it was left
  // as often as a Paper is, and this machine has the same answer for both.
  { label: "Recently opened", field: "last_opened", direction: "descending" },
  { label: "Author A to Z", field: "first_author", direction: "ascending", reference: true },
  { label: "Author Z to A", field: "first_author", direction: "descending", reference: true },
  { label: "Newest year", field: "year", direction: "descending", reference: true },
  { label: "Oldest year", field: "year", direction: "ascending", reference: true },
];

/** A project as the selection bar needs it: something to name in a list and something to file into. */
interface ProjectChoice {
  id: string;
  title: string;
}

interface BulkTagTarget {
  object_id: string;
  expected_version: number;
  expected_hash: string;
}

interface BulkTagReceipt {
  action: "add" | "remove";
  changed_count: number;
  skipped_count: number;
  changes: Array<{ object: CollectionObject }>;
  undo: { action: "add" | "remove"; tag_id: string; targets: BulkTagTarget[] } | null;
}

const PAGE_SIZE = 50;
const NEEDS_REVIEW_TAG = "tag:kiwi/needs-review";

/** How much room is left below the last row before the next page is asked for. */
const SCROLL_MARGIN = 240;

/** How long to wait after the last keystroke before narrowing the list. */
const FILTER_DEBOUNCE_MS = 200;

const EXPORT_LABELS: Readonly<Record<LibraryExportFormat, string>> = {
  bibtex: "BibTeX",
  ris: "RIS",
  csv: "CSV",
};

/**
 * The menu behind + Filter.
 *
 * Two levels, because there are five things a library is sifted by and each of them has as many
 * values as the library has authors. Five menus side by side in the control row was five controls
 * for one decision, and four of them were usually empty.
 *
 * A group with nothing left to choose is not offered. Every value in it is already a chip.
 */
function FilterMenu({
  available,
  filters,
  onAdd,
}: {
  available: CollectionFilters;
  filters: CollectionFilters;
  onAdd: (group: CollectionFilterGroup, value: string) => void;
}): React.JSX.Element | null {
  const [group, setGroup] = useState<CollectionFilterGroup | null>(null);

  function remaining(candidate: CollectionFilterGroup): string[] {
    const chosen = filterValues(filters, candidate).map(foldCollectionFilterValue);
    return filterValues(available, candidate).filter(
      (value) => !chosen.includes(foldCollectionFilterValue(value)),
    );
  }

  const groups = COLLECTION_FILTER_GROUPS.filter((candidate) => remaining(candidate).length > 0);
  if (groups.length === 0) return null;

  return (
    <DropMenu
      label="Add a filter"
      className="collection__add-filter"
      trigger={<>+ Filter</>}
      onClose={() => setGroup(null)}
    >
      {(close) =>
        group === null ? (
          groups.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitem"
              onClick={() => setGroup(candidate)}
            >
              {COLLECTION_FILTER_LABELS[candidate]}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="collection__filter-back"
              onClick={() => setGroup(null)}
            >
              {COLLECTION_FILTER_LABELS[group]}
            </button>
            {remaining(group).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setGroup(null);
                  close();
                  onAdd(group, value);
                }}
              >
                {filterValueLabel(group, value)}
              </button>
            ))}
          </>
        )
      }
    </DropMenu>
  );
}

function defaultDescriptor(objectFamily: string): SavedViewDescriptor {
  return {
    schema_version: 1,
    object_family: objectFamily,
    mode: "table",
    visible_fields: defaultCollectionColumns(objectFamily),
    query: {
      object_types: [objectFamily],
      text: "",
      filters: EMPTY_COLLECTION_FILTERS,
      sort: { field: "updated_at", direction: "descending" },
    },
  };
}

function readStoredState(workspaceId: string, objectFamily: string): StoredCollectionState {
  const fallback = {
    descriptor: defaultDescriptor(objectFamily),
    selected_ids: [],
    active_id: null,
  };
  try {
    const raw = window.localStorage.getItem(`kiwi.collection.${workspaceId}.${objectFamily}`);
    if (raw === null) return fallback;
    const stored = JSON.parse(raw) as Partial<StoredCollectionState>;
    const descriptor = stored.descriptor;
    if (
      descriptor?.schema_version !== 1 ||
      descriptor.object_family !== objectFamily ||
      !Array.isArray(descriptor.query?.object_types) ||
      typeof descriptor.query.text !== "string" ||
      !isCollectionSortField(descriptor.query.sort?.field) ||
      !isCollectionSortDirection(descriptor.query.sort.direction)
    )
      return fallback;
    return {
      // Filters, columns and the mode are read rather than checked, so a view saved before this
      // build had any of them opens as the same view with the part it is missing, rather than
      // being thrown away for the part it has.
      descriptor: {
        ...descriptor,
        mode: readCollectionViewMode(descriptor.mode),
        visible_fields: readCollectionColumns(descriptor.visible_fields, objectFamily),
        query: { ...descriptor.query, filters: readCollectionFilters(descriptor.query.filters) },
      },
      selected_ids: Array.isArray(stored.selected_ids)
        ? stored.selected_ids.filter((value): value is string => typeof value === "string")
        : [],
      active_id: typeof stored.active_id === "string" ? stored.active_id : null,
      ...(typeof stored.editor_open === "boolean" ? { editor_open: stored.editor_open } : {}),
    };
  } catch {
    return fallback;
  }
}

function itemSummary(item: CollectionObject): string {
  const summary = item.content.replaceAll(/\s+/gu, " ").trim();
  return summary === "" ? "No summary yet." : summary.slice(0, 180);
}

function typeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

function updatedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString();
}

/** Adds a column at the end or takes it away, leaving the rest in the order they were in. */
function withColumn(
  columns: CollectionColumn[],
  column: CollectionColumn,
  shown: boolean,
): CollectionColumn[] {
  if (column === COLLECTION_PINNED_COLUMN) return columns;
  return shown
    ? [...columns.filter((entry) => entry !== column), column]
    : columns.filter((entry) => entry !== column);
}

/** Moves one column one place towards the front or the back, and never past the title. */
function movedColumn(
  columns: CollectionColumn[],
  column: CollectionColumn,
  step: 1 | -1,
): CollectionColumn[] {
  const from = columns.indexOf(column);
  const to = from + step;
  if (from < 1 || to < 1 || to >= columns.length) return columns;
  const next = [...columns];
  next.splice(from, 1);
  next.splice(to, 0, column);
  return next;
}

/**
 * Which way a column turns on the first click.
 *
 * A date or a year is asked for newest first; a name or a title is asked for from the start of
 * the alphabet. Starting every column ascending would make the two most-used columns take two
 * clicks each.
 */
function firstDirection(field: CollectionSortField): CollectionSortDirection {
  return field === "title" || field === "type" || field === "first_author"
    ? "ascending"
    : "descending";
}

function columnCell(item: CollectionObject, field: CollectionColumn): string {
  switch (field) {
    case "type":
      return typeLabel(item.type);
    case "version":
      return String(item.version);
    case "summary":
      return item.summary ?? "";
    // Both states are named. A blank cell in a column of blanks would read as a column the index
    // has nothing for, when what it means is a shelf of papers nobody has opened.
    case "read":
      return item.read === true ? "Read" : "Unread";
    case "first_author":
      return item.first_author ?? "";
    case "year":
      return item.reference_year === null || item.reference_year === undefined
        ? ""
        : String(item.reference_year);
    case "created_at":
      return item.created_at === undefined ? "" : updatedLabel(item.created_at);
    case "updated_at":
      return updatedLabel(item.updated_at);
    // Said in words rather than left blank. An empty cell here would read as a date the index has
    // mislaid, when what it means is that this computer has never opened the item.
    case "last_opened":
      return item.last_opened_at === null || item.last_opened_at === undefined
        ? "Not opened here"
        : updatedLabel(item.last_opened_at);
    default:
      return item.title;
  }
}

/** One group's values as strings, because a chip and a menu option are both text. */
function filterValues(source: CollectionFilters, group: CollectionFilterGroup): string[] {
  switch (group) {
    case "kinds":
      return source.kinds;
    case "tags":
      return source.tags;
    case "authors":
      return source.authors;
    case "read":
      return source.read;
    default:
      return source.years.map(String);
  }
}

/** Adds or removes one value, leaving the other groups as they were. */
function withFilterValue(
  source: CollectionFilters,
  group: CollectionFilterGroup,
  value: string,
  present: boolean,
): CollectionFilters {
  if (group === "years") {
    const year = Number(value);
    if (!Number.isInteger(year)) return source;
    return {
      ...source,
      years: present ? [...source.years, year] : source.years.filter((entry) => entry !== year),
    };
  }
  const folded = foldCollectionFilterValue(value);
  if (group === "read") {
    // The one group whose values the contract names rather than the library, so anything else
    // arriving here is a value no item could carry.
    if (!isCollectionReadValue(folded)) return source;
    return {
      ...source,
      read: present ? [...source.read, folded] : source.read.filter((entry) => entry !== folded),
    };
  }
  const current = filterValues(source, group);
  const next = present
    ? [...current, value]
    : current.filter((entry) => foldCollectionFilterValue(entry) !== folded);
  switch (group) {
    case "kinds":
      return { ...source, kinds: next };
    case "tags":
      return { ...source, tags: next };
    default:
      return { ...source, authors: next };
  }
}

/**
 * What a value reads as on a chip.
 *
 * A tag is stored as a path, and a reference kind and a read state as lowercase words; an author
 * and a year are already written the way somebody wrote them.
 */
function filterValueLabel(group: CollectionFilterGroup, value: string): string {
  if (group === "tags") return tagLabel(value);
  if (group === "kinds" || group === "read")
    return value.slice(0, 1).toLocaleUpperCase("en-US") + value.slice(1);
  return value;
}

export function CollectionWorkbench({
  workspaceId,
  objectFamily = "inbox_item",
  writable = true,
  requestedObjectId = null,
  requestedAction = null,
  reloadToken = 0,
  citationStyle = "apa",
  onOpenFile,
  onOpenObject,
  onOpenAnnotation,
}: {
  workspaceId: string;
  objectFamily?: string;
  writable?: boolean;
  requestedObjectId?: string | null;
  requestedAction?: {
    objectId: string;
    action: ObjectOrganizationAction | null;
    revision: number;
  } | null;
  /**
   * Bumped by the shell when something outside this page changed an object on it.
   *
   * The dock writes to the same objects the table lists -- marking a paper read is the everyday
   * case -- and a table that went on showing the old row would be two places disagreeing about
   * one fact.
   */
  reloadToken?: number;
  /** The project's citation style, so an inserted citation reads the way the project does. */
  citationStyle?: CitationStyle;
  onOpenFile?: (assetId: string, title: string, objectId: string) => void;
  /** Where an @ link in an open document sends you. */
  onOpenObject?: (objectId: string, type: string) => void;
  /** Where a quotation in an open note or draft sends you: the page it was read on. */
  onOpenAnnotation?: (annotationId: string, paperId?: string) => void;
}): React.JSX.Element {
  const initial = useMemo(
    () => readStoredState(workspaceId, objectFamily),
    [objectFamily, workspaceId],
  );
  const [descriptor, setDescriptor] = useState(initial.descriptor);
  const [draftText, setDraftText] = useState(initial.descriptor.query.text);
  /** Where the next page of rows starts. Zero means start again. */
  const [cursor, setCursor] = useState(0);
  const [page, setPage] = useState<CollectionPage | null>(null);
  /**
   * Every row read so far, which is what the list draws.
   *
   * There were Previous and Next buttons under the table. Paging a research library is a control
   * for a filing cabinet: nobody wants page 4 of their papers, they want to keep going until they
   * see the one they are thinking of.
   */
  const [rows, setRows] = useState<CollectionObject[]>([]);
  const [editorOpen, setEditorOpen] = useState(initial.editor_open ?? objectFamily !== "source");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(initial.selected_ids);
  const [activeId, setActiveId] = useState<string | null>(initial.active_id);
  const [selectionRecords, setSelectionRecords] = useState<Record<string, CollectionObject>>({});
  const [busy, setBusy] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [publicationReceipt, setPublicationReceipt] = useState<PublicationReceiptView | null>(null);
  const [restorationReceipt, setRestorationReceipt] = useState<RestorationReceiptView | null>(null);
  const [undo, setUndo] = useState<BulkTagReceipt["undo"]>(null);
  const [reload, setReload] = useState(0);
  const [createDraft, setCreateDraft] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [organizationRequest, setOrganizationRequest] = useState<ObjectOrganizationRequest | null>(
    null,
  );
  const [projects, setProjects] = useState<ProjectChoice[] | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  // Duplicates are a question about the whole Library rather than about the rows currently
  // filtered onto the screen, so the review takes the screen while it is open instead of
  // sitting in a corner of a list it does not answer to.
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const selectionAnchor = useRef<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(
      `kiwi.collection.${workspaceId}.${objectFamily}`,
      JSON.stringify({
        descriptor,
        selected_ids: selectedIds,
        active_id: activeId,
        editor_open: editorOpen,
      } satisfies StoredCollectionState),
    );
  }, [activeId, descriptor, editorOpen, objectFamily, selectedIds, workspaceId]);

  // Anything that changes what the list is about starts it again from the top. Appending a
  // second page of a different question onto the first would be one list of two things.
  useEffect(() => {
    setCursor(0);
  }, [reload, reloadToken]);

  useEffect(() => {
    let current = true;
    async function load(): Promise<void> {
      const bridge = readBridge();
      if (bridge === null) {
        if (current) {
          setBusy(false);
          setError("The desktop bridge is unavailable.");
        }
        return;
      }
      setBusy(true);
      setError(null);
      const requestId = crypto.randomUUID();
      try {
        const result = await bridge.invokeCommand({
          protocol_version: "1.0.0",
          request_id: requestId,
          idempotency_key: requestId,
          workspace_id: workspaceId,
          command: "kiwi.projection.list",
          args: {
            object_types: descriptor.query.object_types,
            text: descriptor.query.text,
            filters: descriptor.query.filters,
            sort: descriptor.query.sort,
            page: { offset: cursor, limit: PAGE_SIZE },
          },
        });
        if (result.error !== undefined) throw new Error(result.error.message);
        const data = result.data ?? {};
        const loaded: CollectionPage = {
          generation: Number(data["generation"] ?? 0),
          total: Number(data["total"] ?? 0),
          offset: Number(data["offset"] ?? cursor),
          limit: Number(data["limit"] ?? PAGE_SIZE),
          objects: (data["objects"] as CollectionObject[] | undefined) ?? [],
          available: readCollectionFilters(data["available"]),
        };
        if (!current) return;
        setPage(loaded);
        // Appended when this is a further page, replaced when it is the first. Ids are checked on
        // the way in because a row can move between pages while somebody is scrolling, and the
        // same paper twice in one list is worse than a paper missed.
        setRows((existing) => {
          if (loaded.offset === 0) return loaded.objects;
          const seen = new Set(existing.map((item) => item.id));
          return [...existing, ...loaded.objects.filter((item) => !seen.has(item.id))];
        });
        setSelectionRecords((records) => ({
          ...records,
          ...Object.fromEntries(loaded.objects.map((item) => [item.id, item])),
        }));
        if (loaded.offset === 0)
          setActiveId((active) =>
            active !== null && loaded.objects.some((item) => item.id === active)
              ? active
              : (loaded.objects[0]?.id ?? null),
          );
      } catch (cause) {
        if (current)
          setError(cause instanceof Error ? cause.message : "Kiwi could not load this collection.");
      } finally {
        if (current) setBusy(false);
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [descriptor.query, cursor, reload, reloadToken, workspaceId]);

  const active = rows.find((item) => item.id === activeId) ?? null;

  useEffect(() => {
    if (requestedObjectId !== null && rows.some((item) => item.id === requestedObjectId))
      setActiveId(requestedObjectId);
  }, [rows, requestedObjectId]);

  /**
   * The selected Note or Manuscript, read whole.
   *
   * The index holds the words a document says, which is what a listing and a search need, and
   * not the node tree, which is what the editor needs: a blockquote, a citation and an
   * attribution line are all just words by the time they reach the index. So the body is read
   * once when the selection lands on something with one, rather than a node tree per row in
   * every listing of every collection.
   */
  const [body, setBody] = useState<{ id: string; document?: unknown; document_mode?: unknown }>({
    id: "",
  });
  const written = active !== null && (active.type === "note" || active.type === "output");
  const writtenId = written && active !== null ? active.id : null;
  useEffect(() => {
    if (writtenId === null) return;
    const bridge = readBridge();
    if (bridge === null) return;
    let current = true;
    void bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        workspace_id: workspaceId,
        command: "kiwi.object.read",
        args: { object_id: writtenId },
      })
      .then((result) => {
        if (!current || result.error !== undefined) return;
        const object = (result.data ?? {})["object"] as Record<string, unknown> | undefined;
        if (object === undefined) return;
        setBody({
          id: writtenId,
          document: object["document"],
          document_mode: object["document_mode"],
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // Once per document rather than once per version. The editor is the live copy while it is
    // open, and reading over the top of it after each autosave would be this pane arguing with
    // the person typing in it.
  }, [writtenId, workspaceId]);

  useEffect(() => {
    if (active === null) return;
    window.dispatchEvent(
      new CustomEvent("kiwi:object-context", {
        detail: {
          id: active.id,
          title: active.title,
          type: active.type,
          version: active.version,
          content_hash: active.content_hash,
        },
      }),
    );
  }, [active]);

  useEffect(() => {
    if (requestedAction === null) return;
    const object = rows.find((item) => item.id === requestedAction.objectId);
    if (object === undefined) return;
    setActiveId(object.id);
    setOrganizationRequest({
      object,
      action: requestedAction.action,
      revision: requestedAction.revision,
    });
  }, [rows, requestedAction]);

  /**
   * The projects a selection can be filed into, read once something is picked.
   *
   * Not on the way in: most visits to a collection pick nothing and move nothing, and the list is
   * only ever read to fill one menu. A workspace that will not answer leaves the list unread
   * rather than raising an alarm over a control nobody has reached for; the button says so.
   */
  useEffect(() => {
    if (selectedIds.length === 0 || projects !== null) return;
    const bridge = readBridge();
    if (bridge === null) return;
    let current = true;
    const requestId = crypto.randomUUID();
    void bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: "kiwi.project.list",
        args: {},
      })
      .then((result) => {
        if (!current) return;
        const listed = (result.data ?? {})["projects"] as ProjectChoice[] | undefined;
        if (result.error !== undefined || listed === undefined) return;
        setProjects(listed);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projects, selectedIds.length, workspaceId]);

  const columns = descriptor.visible_fields;
  const filters = descriptor.query.filters;
  const available = page?.available ?? EMPTY_COLLECTION_FILTERS;
  const filterCount = countCollectionFilters(filters);
  const total = page?.total ?? 0;
  const familyPlural = objectTypeLabel(objectFamily, true);
  // The year and the author come off a reference record, which only a Paper has.
  const sortOptions = SORT_OPTIONS.filter(
    (option) => objectFamily === "source" || option.reference !== true,
  );
  const currentSort =
    sortOptions.find(
      (option) =>
        option.field === descriptor.query.sort.field &&
        option.direction === descriptor.query.sort.direction,
    ) ?? null;
  /**
   * Whether the control row is showing what to do with the rows that are picked.
   *
   * It takes the room the title was using and nothing else. Swapping the whole left side out
   * would take the filter box away on every click, and clicking a row is how the dock is opened:
   * somebody who has just started narrowing would lose the box they were typing in.
   */
  const bulk = selectedIds.length > 0;
  /** True once every matching row has been read, which is what stops the scroll asking for more. */
  const complete = page !== null && rows.length >= page.total;
  const selectedTargets = selectedIds.flatMap((id) => {
    const item = selectionRecords[id];
    return item === undefined
      ? []
      : [
          {
            object_id: item.id,
            expected_version: item.version,
            expected_hash: item.content_hash,
          },
        ];
  });

  function setMode(mode: CollectionViewMode): void {
    setDescriptor((current) => ({ ...current, mode }));
  }

  /**
   * Which columns are shown, and in what order.
   *
   * This changes nothing about what is asked of the index: every column comes from a field the
   * row already carries, so hiding one is a matter of the table alone. The sort is left where it
   * was, because hiding a column is not a decision about the order the items are in.
   */
  function setColumns(next: (current: CollectionColumn[]) => CollectionColumn[]): void {
    setDescriptor((current) => ({ ...current, visible_fields: next(current.visible_fields) }));
  }

  function setSort(field: CollectionSortField, direction: CollectionSortDirection): void {
    setCursor(0);
    setDescriptor((current) => ({
      ...current,
      query: { ...current.query, sort: { field, direction } },
    }));
  }

  /** A click on the column already sorted turns it round; a click on any other starts it its own way. */
  function toggleSort(field: CollectionSortField): void {
    const current = descriptor.query.sort;
    setSort(
      field,
      current.field !== field
        ? firstDirection(field)
        : current.direction === "ascending"
          ? "descending"
          : "ascending",
    );
  }

  /**
   * The typed filter, applied a moment after somebody stops typing.
   *
   * There was an Apply button. A filter you have to confirm is a filter you cannot feel your way
   * through, and the whole point of typing into a library is watching it narrow. Two hundred
   * milliseconds is short enough to feel like the list is following the keyboard and long enough
   * that typing "hippocampus" is one query rather than eleven.
   */
  const applied = descriptor.query.text;
  useEffect(() => {
    const wanted = draftText.trim().normalize("NFC");
    if (wanted === applied) return;
    const timer = setTimeout(() => {
      setCursor(0);
      setDescriptor((current) => ({ ...current, query: { ...current.query, text: wanted } }));
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [applied, draftText]);

  function setFilters(next: (current: CollectionFilters) => CollectionFilters): void {
    setCursor(0);
    setDescriptor((current) => ({
      ...current,
      query: { ...current.query, filters: next(current.query.filters) },
    }));
  }

  /** Clears the text box and every chip, which is the only way back to the whole collection. */
  function clearNarrowing(): void {
    setDraftText("");
    setCursor(0);
    setDescriptor((current) => ({
      ...current,
      query: { ...current.query, text: "", filters: EMPTY_COLLECTION_FILTERS },
    }));
  }

  function select(item: CollectionObject, event: React.MouseEvent<HTMLButtonElement>): void {
    const extendRange = event.shiftKey;
    const preserveSelection = event.ctrlKey;
    const anchorId = selectionAnchor.current;
    setActiveId(item.id);
    setSelectionRecords((records) => ({ ...records, [item.id]: item }));
    setSelectedIds((selected) => {
      if (extendRange && anchorId !== null) {
        const anchor = rows.findIndex((entry) => entry.id === anchorId);
        const target = rows.findIndex((entry) => entry.id === item.id);
        if (anchor >= 0 && target >= 0) {
          const range = rows
            .slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
            .map((entry) => entry.id);
          return preserveSelection ? [...new Set([...selected, ...range])] : range;
        }
      }
      if (preserveSelection)
        return selected.includes(item.id)
          ? selected.filter((id) => id !== item.id)
          : [...selected, item.id];
      return [item.id];
    });
    selectionAnchor.current = item.id;
    setBulkMessage(null);
    setUndo(null);
  }

  function keyboardSelection(event: React.KeyboardEvent<HTMLElement>): void {
    if (!event.ctrlKey || event.key.toLocaleLowerCase("en-US") !== "a") return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
      return;
    event.preventDefault();
    setSelectedIds(rows.map((item) => item.id));
    setSelectionRecords((records) => ({
      ...records,
      ...Object.fromEntries(rows.map((item) => [item.id, item])),
    }));
    selectionAnchor.current = rows[0]?.id ?? null;
  }

  // Only the four types a person can make offer a New action. The asset family is filled by
  // importing a file and inbox_item by capture, so a button on those would be a dead end.
  const creatable = isCreatableObjectType(objectFamily);
  const familyLabel = objectTypeLabel(objectFamily);

  async function createInFamily(title: string): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !creatable) return;
    setCreateBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: "kiwi.object.create",
        args: { type: objectFamily, title, content: "" },
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const created = (result.data ?? {})["object"] as CollectionObject | undefined;
      if (created === undefined) throw new Error("Kiwi did not return the new item.");
      setCreateDraft(null);
      setActiveId(created.id);
      setSelectionRecords((records) => ({ ...records, [created.id]: created }));
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not create the item.");
    } finally {
      setCreateBusy(false);
    }
  }

  /**
   * The library, or the part of it somebody picked, written out as a reference file.
   *
   * The renderer never sees the file. It names the Papers and the format, the main process
   * asks where the file goes and writes it, and only the file's name comes back.
   */
  async function runExport(format: LibraryExportFormat): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    setExportBusy(true);
    setExportMessage(null);
    try {
      const outcome = await bridge.exportLibrary({
        workspace_id: workspaceId,
        format,
        object_ids: selectedIds,
      });
      if (outcome.status === "written")
        setExportMessage(
          `${outcome.count} ${outcome.count === 1 ? "reference" : "references"} written to ${outcome.path}.`,
        );
      // A cancelled export is somebody changing their mind, which needs no report.
      else if (outcome.status === "error") setExportMessage(outcome.message);
    } catch {
      setExportMessage("Kiwi could not write the export.");
    } finally {
      setExportBusy(false);
    }
  }

  async function runBulk(
    action: "add" | "remove",
    tagId: string,
    targets: BulkTagTarget[],
  ): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || targets.length === 0) return;
    setBulkBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: `kiwi.object.bulk-${action}-tag`,
        args: { tag_id: tagId, targets },
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const receipt = (result.data ?? {})["receipt"] as BulkTagReceipt | undefined;
      if (receipt === undefined) throw new Error("Kiwi did not return a bulk action receipt.");
      setBulkMessage(
        `${receipt.changed_count} ${receipt.changed_count === 1 ? "item" : "items"} ${
          action === "add" ? "tagged" : "restored"
        }.${receipt.skipped_count > 0 ? ` ${receipt.skipped_count} already matched.` : ""}`,
      );
      setUndo(receipt.undo);
      setSelectionRecords((records) => ({
        ...records,
        ...Object.fromEntries(receipt.changes.map((change) => [change.object.id, change.object])),
      }));
      setReload((value) => value + 1);
    } catch (cause) {
      setBulkMessage(null);
      setUndo(null);
      setError(
        `${cause instanceof Error ? cause.message : "Kiwi could not update the selection."} No selected items were changed.`,
      );
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * Files everything picked in one project, or takes it all out of every project.
   *
   * One command per item rather than one for the whole selection. Which project an object belongs
   * to is a relation beside the object, so there is no single write here to be all or nothing
   * about, and no version to guard either: an item picked before it scrolled out of the loaded
   * pages can still be moved, which is why this offers more than the tag action beside it.
   *
   * A refusal partway through therefore leaves the items before it where they were put. The
   * report says how many those were rather than claiming the selection was left alone.
   *
   * No Undo button, because the way back is this control: the selection survives the move, so
   * choosing the project they came from and pressing again puts them all back.
   */
  async function moveSelectionToProject(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || selectedIds.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setBulkMessage(null);
    setUndo(null);
    const destination = destinationId === "" ? null : destinationId;
    let moved = 0;
    let unchanged = 0;
    try {
      for (const objectId of selectedIds) {
        const requestId = crypto.randomUUID();
        const result = await bridge.invokeCommand({
          protocol_version: "1.0.0",
          request_id: requestId,
          idempotency_key: requestId,
          workspace_id: workspaceId,
          command: "kiwi.project.assign",
          args: { object_id: objectId, project_id: destination },
        });
        if (result.error !== undefined) throw new Error(result.error.message);
        if (result.status === "no_change") unchanged += 1;
        else moved += 1;
      }
      const where =
        destination === null
          ? "out of every project"
          : `into ${projects?.find((project) => project.id === destination)?.title ?? "the project"}`;
      setBulkMessage(
        `${moved} ${moved === 1 ? "item" : "items"} moved ${where}.${
          unchanged > 0 ? ` ${unchanged} needed no change.` : ""
        }`,
      );
    } catch (cause) {
      // Reported as a receipt and not as the error banner beside it, because that banner ends by
      // saying the workspace files are unchanged, and here some of them are not: everything before
      // the refusal moved. What is left to say is how far it got.
      setBulkMessage(
        `Kiwi stopped after ${moved} of ${selectedIds.length} selected items had moved. ${
          cause instanceof Error ? cause.message : "Kiwi could not move the selection."
        }`,
      );
    } finally {
      setBulkBusy(false);
    }
  }

  function recordPublication(receipt: PublicationReceiptView): void {
    setPublicationReceipt(receipt);
    setRestorationReceipt(null);
    setRows((current) =>
      current.map((item) =>
        item.id === receipt.object.id ? { ...item, ...receipt.object } : item,
      ),
    );
    setSelectionRecords((records) => {
      const current = records[receipt.object.id];
      return current === undefined
        ? records
        : { ...records, [receipt.object.id]: { ...current, ...receipt.object } };
    });
  }

  function recordRestoration(receipt: RestorationReceiptView): void {
    setRestorationReceipt(receipt);
    setPublicationReceipt(null);
    setRows((current) =>
      current.map((item) =>
        item.id === receipt.object.id ? { ...item, ...receipt.object } : item,
      ),
    );
    setSelectionRecords((records) => {
      const current = records[receipt.object.id];
      return current === undefined
        ? records
        : { ...records, [receipt.object.id]: { ...current, ...receipt.object } };
    });
  }

  function recordOrganizationObject(object: CollectionObject): void {
    setRows((current) =>
      current.map((item) => (item.id === object.id ? { ...item, ...object } : item)),
    );
    setSelectionRecords((records) => ({
      ...records,
      [object.id]: { ...records[object.id], ...object },
    }));
    setReload((value) => value + 1);
  }

  function recordTrashedObject(objectId: string): void {
    setPage((current) =>
      current === null ? current : { ...current, total: Math.max(0, current.total - 1) },
    );
    setRows((current) => current.filter((item) => item.id !== objectId));
    setSelectedIds((current) => current.filter((id) => id !== objectId));
    setSelectionRecords((current) => {
      const next = { ...current };
      delete next[objectId];
      return next;
    });
    setActiveId((current) => (current === objectId ? null : current));
  }

  function openOrganization(
    item: CollectionObject,
    action: ObjectOrganizationAction | null = null,
  ): void {
    setActiveId(item.id);
    setOrganizationRequest({ object: item, action, revision: Date.now() });
  }

  /**
   * Opens the file a Paper reads to, from a double click or from Enter on the row.
   *
   * Which file that is lives on the canonical object, not on the index row: the index holds what a
   * listing and a search need, and the primary file is neither. So it is asked for at the moment
   * somebody asks to read, rather than carried on every row of every listing against the chance.
   */
  const openPrimaryFile = useCallback(
    async (item: CollectionObject): Promise<void> => {
      if (onOpenFile === undefined || item.type !== "source") return;
      const bridge = readBridge();
      if (bridge === null) return;
      async function ask(command: string): Promise<Record<string, unknown>> {
        const requestId = crypto.randomUUID();
        const result = await bridge!.invokeCommand({
          protocol_version: "1.0.0",
          request_id: requestId,
          idempotency_key: requestId,
          workspace_id: workspaceId,
          command,
          args: { object_id: item.id },
        });
        return result.error === undefined ? (result.data ?? {}) : {};
      }
      const [record, listed] = await Promise.all([
        ask("kiwi.object.read"),
        ask("kiwi.object.files"),
      ]);
      const files =
        (listed["files"] as Array<{ id: string; title: string; original_filename?: string }>) ?? [];
      const named = (record["object"] as Record<string, unknown> | undefined)?.["primary_asset_id"];
      const primary = primaryFileId(
        files.map((file) => file.id),
        named,
      );
      const chosen = files.find((file) => file.id === primary) ?? files[0];
      if (chosen !== undefined)
        onOpenFile(chosen.id, chosen.original_filename ?? chosen.title, item.id);
    },
    [onOpenFile, workspaceId],
  );

  /**
   * Asks for the next page as the bottom of the list comes into view.
   *
   * Asked for before the bottom is reached, so that the rows are usually already there. A list
   * that waits until the last row is on screen is a list that stops every fifty rows.
   */
  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    if (busy || complete) return;
    const box = event.currentTarget;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - SCROLL_MARGIN) return;
    setCursor(rows.length);
  }

  const itemButton = (item: CollectionObject, detail: boolean): React.JSX.Element => (
    <button
      type="button"
      className="collection-item"
      aria-label={`Select ${item.title}`}
      aria-pressed={selectedIds.includes(item.id)}
      onClick={(event) => select(item, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        openOrganization(item);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          openOrganization(item);
        }
        // A button treats Enter as a click, so this has to say it is not one. Clicking a row
        // picks it; Enter on a row opens it, which is what Enter does in every list.
        if (event.key === "Enter") {
          event.preventDefault();
          setActiveId(item.id);
          void openPrimaryFile(item);
        }
      }}
    >
      <span className="collection-item__title">{item.title}</span>
      {/* The table says the same things in its own columns. Repeating them under the title was
          three facts in a cell whose job is one. */}
      {detail ? (
        <>
          <span className="collection-item__summary">{itemSummary(item)}</span>
          <span className="collection-item__metadata">
            {typeLabel(item.type)} · Version {item.version} · Updated{" "}
            {updatedLabel(item.updated_at)}
          </span>
        </>
      ) : null}
    </button>
  );

  // The review takes the whole screen rather than sharing it. What it lists is the Library as a
  // whole, and a list of duplicates sitting beside a filtered, paged table would keep inviting
  // the question of which of the two it was talking about.
  if (duplicatesOpen)
    return (
      <DuplicatesPanel
        workspaceId={workspaceId}
        writable={writable}
        onClose={() => setDuplicatesOpen(false)}
        onOpenObject={(objectId) => {
          setDuplicatesOpen(false);
          setActiveId(objectId);
        }}
        onChanged={() => setReload((value) => value + 1)}
      />
    );

  return (
    <section
      className="collection"
      aria-labelledby="collection-title"
      aria-busy={busy || bulkBusy}
      onKeyDown={keyboardSelection}
    >
      {/*
        One row. There were four: a header block with the family name and three buttons, a
        toolbar with the filter box and the view switch, a row of filter menus, and a selection
        bar that appeared under all of them. Every one of those was the same kind of thing --
        controls for this list -- and stacking them pushed the list itself off the top of the
        screen.
      */}
      <div className="collection__control">
        {bulk ? (
          <div className="collection__chosen" role="status">
            <strong>{selectedIds.length} selected</strong>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={bulkBusy || !writable || selectedTargets.length !== selectedIds.length}
              title={
                !writable
                  ? "This workspace is read only"
                  : selectedTargets.length !== selectedIds.length
                    ? "Some selected items have not been read into this list"
                    : "Add Needs review to selected items"
              }
              onClick={() => void runBulk("add", NEEDS_REVIEW_TAG, selectedTargets)}
            >
              Add Needs review
            </button>
            <span aria-hidden="true">·</span>
            {/*
              The destination sits beside the button rather than behind a dialog. Moving a picked
              set into a project is the last step of picking it, and a dialog in the middle of
              that is a second decision about a decision already made.
            */}
            <select
              aria-label="Project to move the selection into"
              value={destinationId}
              disabled={bulkBusy || !writable || projects === null}
              onChange={(event) => setDestinationId(event.target.value)}
            >
              <option value="">No project</option>
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={bulkBusy || !writable || projects === null}
              title={
                !writable
                  ? "This workspace is read only"
                  : projects === null
                    ? "Kiwi has not read the projects in this workspace"
                    : destinationId === ""
                      ? "Take the selected items out of every project"
                      : "Move the selected items into this project"
              }
              onClick={() => void moveSelectionToProject()}
            >
              Move to project
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                setSelectedIds([]);
                selectionAnchor.current = null;
              }}
            >
              Clear
            </button>
          </div>
        ) : (
          <h2 id="collection-title" className="collection__title">
            {familyPlural}
            <span>{page === null ? "" : total}</span>
          </h2>
        )}

        {/*
          No Apply button. A filter you have to confirm is a filter you cannot feel your way
          through, and the whole point of typing into a library is watching it narrow.
        */}
        <input
          className="collection__filter"
          type="search"
          aria-label={`Filter ${familyPlural.toLocaleLowerCase("en-US")}`}
          placeholder={`Filter ${familyPlural.toLocaleLowerCase("en-US")}`}
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
        />
        {COLLECTION_FILTER_GROUPS.flatMap((group) =>
          filterValues(filters, group).map((value) => (
            <button
              key={`${group}:${value}`}
              type="button"
              className="collection__chip"
              aria-label={`Remove ${COLLECTION_FILTER_LABELS[group]} filter ${filterValueLabel(group, value)}`}
              onClick={() => setFilters((current) => withFilterValue(current, group, value, false))}
            >
              <span>{filterValueLabel(group, value)}</span>
              <span aria-hidden="true" className="collection__chip-remove">
                &times;
              </span>
            </button>
          )),
        )}
        <FilterMenu
          available={available}
          filters={filters}
          onAdd={(group, value) =>
            setFilters((current) => withFilterValue(current, group, value, true))
          }
        />

        <div className="collection__control-spacer" />

        <DropMenu
          label="Sort"
          className="collection__sort"
          trigger={
            <>
              {currentSort?.label ?? "Sort"}{" "}
              <span aria-hidden="true" className="collection__caret">
                &#8964;
              </span>
            </>
          }
          align="end"
        >
          {(close) => (
            <>
              {sortOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === currentSort}
                  onClick={() => {
                    close();
                    setSort(option.field, option.direction);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </>
          )}
        </DropMenu>

        <div className="collection__view-switch" role="group" aria-label="Collection view">
          {(["table", "card"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={descriptor.mode === mode}
              onClick={() => setMode(mode)}
            >
              {mode === "table" ? "Table" : "Cards"}
            </button>
          ))}
        </div>

        <DropMenu
          label="More"
          className="collection__overflow"
          trigger={<span aria-hidden="true">&#8943;</span>}
          align="end"
        >
          {(close) => (
            <>
              {descriptor.mode === "table" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setColumnsOpen(true);
                  }}
                >
                  Columns…
                </button>
              ) : null}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={editorOpen}
                onClick={() => {
                  close();
                  setEditorOpen((open) => !open);
                }}
              >
                {editorOpen ? "Hide the object editor" : "Show the object editor"}
              </button>
              {objectFamily === "source"
                ? (["bibtex", "ris", "csv"] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      role="menuitem"
                      disabled={exportBusy}
                      onClick={() => {
                        close();
                        void runExport(format);
                      }}
                    >
                      {selectedIds.length === 0
                        ? `Export the library as ${EXPORT_LABELS[format]}`
                        : `Export ${selectedIds.length} selected as ${EXPORT_LABELS[format]}`}
                    </button>
                  ))
                : null}
              {objectFamily === "source" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setDuplicatesOpen(true);
                  }}
                >
                  Review duplicates
                </button>
              ) : null}
              {creatable && writable ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={createBusy || createDraft !== null}
                  onClick={() => {
                    close();
                    setCreateDraft("");
                  }}
                >
                  New {familyLabel}
                </button>
              ) : null}
            </>
          )}
        </DropMenu>
      </div>

      {/* Only the table has columns. The cards show the same summary of an item however the
          table beside them is arranged. */}
      {columnsOpen && descriptor.mode === "table" ? (
        <div className="collection__columns-menu" role="group" aria-label="Columns">
          {columns.map((column, index) => (
            <div key={column} className="collection__column">
              <label>
                <input
                  type="checkbox"
                  checked
                  disabled={column === COLLECTION_PINNED_COLUMN}
                  onChange={() => setColumns((current) => withColumn(current, column, false))}
                />
                {COLLECTION_COLUMN_LABELS[column]}
              </label>
              {column === COLLECTION_PINNED_COLUMN ? null : (
                <>
                  <button
                    type="button"
                    aria-label={`Move ${COLLECTION_COLUMN_LABELS[column]} left`}
                    disabled={index <= 1}
                    onClick={() => setColumns((current) => movedColumn(current, column, -1))}
                  >
                    <span aria-hidden="true">&larr;</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${COLLECTION_COLUMN_LABELS[column]} right`}
                    disabled={index === columns.length - 1}
                    onClick={() => setColumns((current) => movedColumn(current, column, 1))}
                  >
                    <span aria-hidden="true">&rarr;</span>
                  </button>
                </>
              )}
            </div>
          ))}
          {COLLECTION_COLUMNS.filter((column) => !columns.includes(column)).map((column) => (
            <div key={column} className="collection__column">
              <label>
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => setColumns((current) => withColumn(current, column, true))}
                />
                {COLLECTION_COLUMN_LABELS[column]}
              </label>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setColumns(() => defaultCollectionColumns(objectFamily))}
          >
            Reset columns
          </button>
          <button type="button" onClick={() => setColumnsOpen(false)}>
            Done
          </button>
        </div>
      ) : null}

      {createDraft !== null ? (
        <form
          className="collection__create"
          onSubmit={(event) => {
            event.preventDefault();
            const title = createDraft.trim();
            if (title !== "") void createInFamily(title);
          }}
        >
          <label htmlFor="collection-create-title">{familyLabel} title</label>
          <div className="settings-inline">
            <input
              id="collection-create-title"
              value={createDraft}
              maxLength={200}
              autoFocus
              disabled={createBusy}
              onChange={(event) => setCreateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setCreateDraft(null);
              }}
            />
            <button
              className="button button--primary"
              type="submit"
              disabled={createBusy || createDraft.trim() === ""}
            >
              {createBusy ? "Creating" : "Create"}
            </button>
            <button
              className="button"
              type="button"
              disabled={createBusy}
              onClick={() => setCreateDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {exportMessage === null ? null : (
        <div className="collection__receipt" role="status">
          <span>{exportMessage}</span>
          <button type="button" onClick={() => setExportMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      {bulkMessage === null ? null : (
        <div className="collection__receipt" role="status">
          <span>{bulkMessage}</span>
          {undo === null ? null : (
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk(undo.action, undo.tag_id, undo.targets)}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {publicationReceipt === null ? null : (
        <div className="collection__receipt collection__receipt--publication" role="status">
          <span>
            <strong>Saved version {publicationReceipt.object.version}.</strong>{" "}
            {publicationReceipt.eventIds.length} immutable history events committed.
            {publicationReceipt.impact.relation_count > 0
              ? ` ${publicationReceipt.impact.relation_count} linked relations retained.`
              : ""}
            {publicationReceipt.warnings.length > 0
              ? ` ${publicationReceipt.warnings.length} publication ${publicationReceipt.warnings.length === 1 ? "warning was" : "warnings were"} acknowledged.`
              : ""}
            {publicationReceipt.recoveryDraftRetained
              ? " The local recovery draft could not be removed and remains available."
              : " The recovery draft was removed after commit."}
          </span>
          <details>
            <summary>Inspect receipt</summary>
            <dl>
              <dt>Transaction</dt>
              <dd>{publicationReceipt.transactionId}</dd>
              <dt>Content hash</dt>
              <dd>{publicationReceipt.object.content_hash}</dd>
              <dt>Event IDs</dt>
              <dd>{publicationReceipt.eventIds.join(", ")}</dd>
              {publicationReceipt.warnings.length > 0 ? (
                <>
                  <dt>Warnings</dt>
                  <dd>{publicationReceipt.warnings.join(" ")}</dd>
                </>
              ) : null}
            </dl>
          </details>
          <button type="button" onClick={() => setPublicationReceipt(null)}>
            Dismiss
          </button>
        </div>
      )}

      {restorationReceipt === null ? null : (
        <div className="collection__receipt collection__receipt--publication" role="status">
          <span>
            <strong>
              Restored version {restorationReceipt.sourceVersion} as version{" "}
              {restorationReceipt.object.version}.
            </strong>{" "}
            All {restorationReceipt.historyCount} versions remain in immutable history.
            {restorationReceipt.impact.relation_count > 0
              ? ` ${restorationReceipt.impact.relation_count} linked relations retained.`
              : ""}
          </span>
          <details>
            <summary>Inspect restoration receipt</summary>
            <dl>
              <dt>Transaction</dt>
              <dd>{restorationReceipt.transactionId}</dd>
              <dt>Content hash</dt>
              <dd>{restorationReceipt.object.content_hash}</dd>
              <dt>Event IDs</dt>
              <dd>{restorationReceipt.eventIds.join(", ")}</dd>
            </dl>
          </details>
          <button type="button" onClick={() => setRestorationReceipt(null)}>
            Dismiss
          </button>
        </div>
      )}

      {error === null ? null : (
        <div className="collection__error" role="alert">
          <span>{error} Existing workspace files remain unchanged.</span>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}

      <div className="collection__body" data-editor={editorOpen || undefined}>
        {/*
          The list scrolls, not the page. A sticky column header over a page that scrolls as a
          whole is a header that scrolls away with everything else.
        */}
        <div className="collection__scroll" onScroll={onScroll}>
          {page !== null && total === 0 && !busy ? (
            descriptor.query.text === "" && filterCount === 0 ? (
              <div className="collection__empty">
                <h4>No research items yet</h4>
                <p>Capture an Inbox item to make it available in this collection.</p>
              </div>
            ) : (
              <div className="collection__empty">
                <h4>No matching items</h4>
                <p>Adjust the filter or clear it to return to the full collection.</p>
                <button type="button" onClick={clearNarrowing}>
                  Clear filter
                </button>
              </div>
            )
          ) : null}

          {busy && rows.length === 0 ? (
            // Bars the height of a row rather than the word "Loading": what arrives is rows, and
            // the shape of what is coming is the most useful thing to say about it.
            <div className="collection__skeleton" role="status" aria-label="Reading the list">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} />
              ))}
            </div>
          ) : null}

          {rows.length > 0 && descriptor.mode === "table" ? (
            <table aria-label="Research items">
              <thead>
                <tr>
                  {/*
                    A header is a button only where the index can order by it. Asking the
                    contract rather than naming the exceptions here means a column added
                    there cannot arrive as a header that sorts by nothing.
                  */}
                  {columns.map((column) =>
                    !isCollectionSortField(column) ? (
                      <th key={column} scope="col">
                        {COLLECTION_COLUMN_LABELS[column]}
                      </th>
                    ) : (
                      <th
                        key={column}
                        scope="col"
                        aria-sort={
                          descriptor.query.sort.field === column
                            ? descriptor.query.sort.direction
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          className="collection__sort-header"
                          onClick={() => toggleSort(column)}
                        >
                          {COLLECTION_COLUMN_LABELS[column]}
                          <span aria-hidden="true" className="collection__sort-mark">
                            {descriptor.query.sort.field !== column
                              ? ""
                              : descriptor.query.sort.direction === "ascending"
                                ? "\u2191"
                                : "\u2193"}
                          </span>
                        </button>
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr
                    key={item.id}
                    aria-selected={selectedIds.includes(item.id)}
                    data-active={item.id === activeId || undefined}
                    onDoubleClick={() => void openPrimaryFile(item)}
                  >
                    <th scope="row">{itemButton(item, false)}</th>
                    {columns.slice(1).map((column) =>
                      column === "summary" ? (
                        // A sentence among short values. It is held to one line so the row
                        // stays a row, and the whole of it is on the item itself.
                        <td key={column} className="collection__summary-cell">
                          {columnCell(item, column)}
                        </td>
                      ) : (
                        <td
                          key={column}
                          data-column={column}
                          data-read={column === "read" && item.read === true ? "" : undefined}
                        >
                          {columnCell(item, column)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {rows.length > 0 && descriptor.mode === "card" ? (
            <ul className="collection__items collection__items--card">
              {rows.map((item) => (
                <li key={item.id}>{itemButton(item, true)}</li>
              ))}
            </ul>
          ) : null}

          {rows.length > 0 ? (
            <p className="collection__count" role="status">
              {complete
                ? `${total} ${familyPlural.toLocaleLowerCase("en-US")}`
                : `${rows.length} of ${total} ${familyPlural.toLocaleLowerCase("en-US")}`}
            </p>
          ) : null}
        </div>

        {editorOpen ? (
          <aside className="collection__preview" aria-label="Active object editor">
            {active === null ? (
              <p className="collection__quiet">Select something to edit it here.</p>
            ) : null}
            {/* Not until the body has been read: the editor takes its document once, when it
                is built, and one built on an empty tree would show a written note as a blank
                page and then save the blank page over it. */}
            {active !== null && written && body.id === active.id ? (
              <DocumentEditor
                workspaceId={workspaceId}
                record={{
                  ...active,
                  document: body.document,
                  document_mode: body.document_mode,
                }}
                writable={writable}
                citationStyle={citationStyle}
                onSaved={() => setReload((value) => value + 1)}
                {...(onOpenObject === undefined ? {} : { onOpenObject })}
                {...(onOpenAnnotation === undefined ? {} : { onOpenAnnotation })}
              />
            ) : null}
            {active === null ? null : (
              <CanonicalObjectEditor
                workspaceId={workspaceId}
                object={active}
                writable={writable}
                onPublished={recordPublication}
                onRestored={recordRestoration}
                onOrganize={() => openOrganization(active)}
                {...(onOpenAnnotation === undefined ? {} : { onOpenAnnotation })}
              />
            )}
          </aside>
        ) : null}
      </div>

      <ObjectOrganizationMenu
        workspaceId={workspaceId}
        writable={writable}
        request={organizationRequest}
        onClose={() => setOrganizationRequest(null)}
        onObjectChanged={(object) => recordOrganizationObject(object as CollectionObject)}
        onObjectTrashed={recordTrashedObject}
        onCollectionChanged={() => setReload((value) => value + 1)}
      />
    </section>
  );
}
