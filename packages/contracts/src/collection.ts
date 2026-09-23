/**
 * The two ways a collection can be drawn.
 *
 * There were three. The middle one -- a list of rows carrying a title, a summary line and a
 * metadata line -- was a card that had been squashed, and the choice between it and the card was
 * a choice about how tall a row should be. Two modes answer the question somebody actually has:
 * am I operating on this collection, or reading it.
 */
export const COLLECTION_VIEW_MODES = ["table", "card"] as const;

/**
 * What a collection can be ordered by.
 *
 * Three of these are facts about the file, when it was added, when it was last written, what
 * type it is, and three are facts about the work: its title, its year, and who wrote it. A
 * library is looked through by the second set and maintained by the first, which is why both
 * are here rather than only the ones the index happened to hold first.
 *
 * The last is a fact about the reader instead: when this machine last opened the item. It answers
 * the question the other six cannot, which is what you were in the middle of, and it is the only
 * one of them that is not the same for everybody sharing the workspace.
 */
export const COLLECTION_SORT_FIELDS = [
  "title",
  "type",
  "updated_at",
  "created_at",
  "year",
  "first_author",
  "last_opened",
] as const;
export const COLLECTION_SORT_DIRECTIONS = ["ascending", "descending"] as const;

export type CollectionViewMode = (typeof COLLECTION_VIEW_MODES)[number];
export type CollectionSortField = (typeof COLLECTION_SORT_FIELDS)[number];
export type CollectionSortDirection = (typeof COLLECTION_SORT_DIRECTIONS)[number];

/** What a sort field is called on screen, so a column header and the sort menu cannot disagree. */
export const COLLECTION_SORT_LABELS: Record<CollectionSortField, string> = {
  title: "Title",
  type: "Type",
  updated_at: "Updated",
  created_at: "Added",
  year: "Year",
  first_author: "Author",
  last_opened: "Last opened",
};

/**
 * Every column a collection table can show.
 *
 * Most are sort fields as well, because a column somebody orders a library by is a column they
 * wanted to look at. Three go the other way: the version, worth showing on a Note being revised
 * and not something anybody looks a paper up by; the summary, which is a sentence and would order
 * a library by whichever word its writer happened to start with; and read state, which has two
 * values and would sort a library into two heaps when the question it answers is which heap, and
 * that is what the filter is for.
 *
 * The same set is offered for every family rather than one set per family. A Note has no year,
 * but so does a Paper nobody has filled the year in on, and the table already shows that as an
 * empty cell, one rule in one place beats a second list of which column suits which family.
 */
export const COLLECTION_COLUMNS = [
  ...COLLECTION_SORT_FIELDS,
  "version",
  "summary",
  "read",
] as const;

export type CollectionColumn = (typeof COLLECTION_COLUMNS)[number];

/** What a column is called in its header and in the menu that shows or hides it. */
export const COLLECTION_COLUMN_LABELS: Record<CollectionColumn, string> = {
  ...COLLECTION_SORT_LABELS,
  version: "Version",
  summary: "Summary",
  read: "Read",
};

/**
 * The column that is always first and can never be hidden.
 *
 * The title is the row header, and it carries the button that opens the item. A table without it
 * is a table nothing can be selected from.
 */
export const COLLECTION_PINNED_COLUMN = "title";

export function isCollectionColumn(value: unknown): value is CollectionColumn {
  return typeof value === "string" && (COLLECTION_COLUMNS as readonly string[]).includes(value);
}

/**
 * The columns a family is worth showing before anybody says otherwise.
 *
 * A Paper is looked up by who wrote it and when, so the Library leads with those, and ends with
 * whether it has been read: every paper has an answer to that from the day it arrives, and it is
 * the question a shelf is scanned for. Every other family is being written rather than cited, so
 * it shows what it is and how far along it is.
 *
 * The summary is in neither list. It is a sentence among short values, and a library nobody has
 * written summaries in yet would open as a column of empty cells; it is one click away in the
 * Columns menu for the person who has written them.
 *
 * Nor is last opened, for the same reason and one more: it is empty until this machine has opened
 * something, and unlike every other column it would be blank on a colleague's copy of the same
 * library. A column that means different things on two machines should be asked for.
 */
export function defaultCollectionColumns(objectFamily: string): CollectionColumn[] {
  // Added is off by default and still available: two date columns side by side is one column
  // somebody has to read twice to find out which is which, and Updated is the one that answers
  // "what was I doing".
  return objectFamily === "source"
    ? ["title", "first_author", "year", "updated_at", "read"]
    : ["title", "type", "version", "updated_at"];
}

/**
 * Reads a column choice from whatever was stored, in the order it was stored in.
 *
 * A view saved before columns could be chosen names none of them, and a build that drops a column
 * leaves views naming one that is gone; both read as a choice nobody made, and the family's own
 * columns stand. Choosing only the title is a choice, so it is kept.
 */
export function readCollectionColumns(value: unknown, objectFamily: string): CollectionColumn[] {
  const stored = Array.isArray(value) ? value : [];
  const kept: CollectionColumn[] = [];
  for (const entry of stored)
    if (isCollectionColumn(entry) && !kept.includes(entry)) kept.push(entry);
  if (kept.length === 0) return defaultCollectionColumns(objectFamily);
  return [
    COLLECTION_PINNED_COLUMN,
    ...kept.filter((column) => column !== COLLECTION_PINNED_COLUMN),
  ];
}

/**
 * The groups a collection can be narrowed by, beside the text box.
 *
 * These are the five a research library is actually sifted by, and all five are already on the
 * item: three come from the reference record, one from the object's own tags, and one from the
 * mark the reader puts on it. Project membership belongs here too and is not here yet, because
 * nothing records it on an item today.
 */
export const COLLECTION_FILTER_GROUPS = ["kinds", "tags", "authors", "years", "read"] as const;

export type CollectionFilterGroup = (typeof COLLECTION_FILTER_GROUPS)[number];

/** What each group is called on screen, in the chip and in the menu that adds one. */
export const COLLECTION_FILTER_LABELS: Record<CollectionFilterGroup, string> = {
  kinds: "Type",
  tags: "Tag",
  authors: "Author",
  years: "Year",
  read: "Read state",
};

/**
 * The two answers an item gives about being read, written the way they are stored and matched.
 *
 * A group of values rather than a switch with three positions, so the read filter is added,
 * shown as a chip and taken off again by the same code as every other group. Choosing both is
 * choosing neither, which is what any-of within a group already means everywhere else.
 */
export const COLLECTION_READ_VALUES = ["read", "unread"] as const;

export type CollectionReadValue = (typeof COLLECTION_READ_VALUES)[number];

export function isCollectionReadValue(value: unknown): value is CollectionReadValue {
  return typeof value === "string" && (COLLECTION_READ_VALUES as readonly string[]).includes(value);
}

/** Which of the two an item carries, from the mark on the object. */
export function collectionReadValue(read: boolean): CollectionReadValue {
  return read ? "read" : "unread";
}

/**
 * A narrowing of a collection: some values in each group, none of them required.
 *
 * An item matches when it carries **any** value from each **non-empty** group. Two tags and a
 * year mean either tag published that year, which is what a person picking three chips means;
 * requiring both tags would answer a question nobody asked.
 */
export interface CollectionFilters {
  /** Reference kinds, article, book, thesis. Nothing without a reference record has one. */
  kinds: string[];
  /** Tag ids exactly as they are written on the object. */
  tags: string[];
  /** Author names as written. Matched against every name on the record, not only the first. */
  authors: string[];
  /** Publication years, each named on its own rather than as a range. */
  years: number[];
  /** Read, unread, or both, which narrows nothing and is how the group starts. */
  read: CollectionReadValue[];
}

export const EMPTY_COLLECTION_FILTERS: CollectionFilters = {
  kinds: [],
  tags: [],
  authors: [],
  years: [],
  read: [],
};

/**
 * How many values one group may offer to add.
 *
 * A library of a few thousand papers holds more author names than any menu can be read, so the
 * common ones are offered and the rest are reached through the text box.
 */
export const COLLECTION_FILTER_OPTION_LIMIT = 200;

export interface CollectionQuery {
  object_types: string[];
  text: string;
  filters: CollectionFilters;
  sort: {
    field: CollectionSortField;
    direction: CollectionSortDirection;
  };
  page: {
    offset: number;
    limit: number;
  };
}

export interface SavedViewDescriptor {
  schema_version: 1;
  object_family: string;
  mode: CollectionViewMode;
  /** The columns to show, in the order they are shown. The title is always the first of them. */
  visible_fields: CollectionColumn[];
  query: Omit<CollectionQuery, "page">;
}

export const DEFAULT_COLLECTION_QUERY: CollectionQuery = {
  object_types: [],
  text: "",
  filters: EMPTY_COLLECTION_FILTERS,
  sort: { field: "updated_at", direction: "descending" },
  page: { offset: 0, limit: 50 },
};

export function isCollectionViewMode(value: unknown): value is CollectionViewMode {
  return typeof value === "string" && (COLLECTION_VIEW_MODES as readonly string[]).includes(value);
}

/**
 * The mode a saved view opens in, whatever it was saved as.
 *
 * A view stored as "list" was saved by a build that had one, and the nearest thing to it now is
 * the table: both are a row per item. Throwing the whole view away over the one field it names a
 * retired mode in would also throw away its filters and its columns.
 */
export function readCollectionViewMode(value: unknown): CollectionViewMode {
  if (value === "list") return "table";
  return isCollectionViewMode(value) ? value : "table";
}

export function isCollectionSortField(value: unknown): value is CollectionSortField {
  return typeof value === "string" && (COLLECTION_SORT_FIELDS as readonly string[]).includes(value);
}

export function isCollectionSortDirection(value: unknown): value is CollectionSortDirection {
  return (
    typeof value === "string" && (COLLECTION_SORT_DIRECTIONS as readonly string[]).includes(value)
  );
}

/**
 * The form a filter value is compared in.
 *
 * Both sides of the comparison fold the same way, and they fold here rather than once in the
 * index and once in the interface: a tag chosen from a menu must match the tag on the item, and
 * `Ana Ortiz` and `ana ortiz` are one author.
 */
export function foldCollectionFilterValue(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

/**
 * Reads a set of filters from whatever was stored or sent.
 *
 * Anything unrecognised is dropped rather than refused. A saved view written before a group
 * existed is still a saved view, and a filter that cannot be read is not worth losing the whole
 * collection over.
 */
export function readCollectionFilters(value: unknown): CollectionFilters {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  function names(key: CollectionFilterGroup): string[] {
    const list = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
    const kept: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.normalize("NFC").trim();
      if (trimmed === "") continue;
      if (
        !kept.some(
          (existing) => foldCollectionFilterValue(existing) === foldCollectionFilterValue(trimmed),
        )
      )
        kept.push(trimmed);
    }
    return kept;
  }
  const years = Array.isArray(source["years"]) ? (source["years"] as unknown[]) : [];
  // The one group whose values are the contract's own rather than the library's. Anything else
  // stored under it would match no item at all, and a filter that empties a collection while
  // naming a state nothing can be in is worse than no filter.
  const read = Array.isArray(source["read"]) ? (source["read"] as unknown[]) : [];
  return {
    kinds: names("kinds"),
    tags: names("tags"),
    authors: names("authors"),
    read: [
      ...new Set(
        read
          .map((entry) => (typeof entry === "string" ? foldCollectionFilterValue(entry) : ""))
          .filter(isCollectionReadValue),
      ),
    ],
    years: [
      ...new Set(
        years.filter(
          (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
        ),
      ),
    ],
  };
}

/** How many chips are showing, which is also whether the collection is narrowed at all. */
export function countCollectionFilters(filters: CollectionFilters): number {
  return (
    filters.kinds.length +
    filters.tags.length +
    filters.authors.length +
    filters.years.length +
    filters.read.length
  );
}
