import { describe, expect, it } from "vitest";
import {
  COLLECTION_COLUMN_LABELS,
  COLLECTION_COLUMNS,
  COLLECTION_FILTER_GROUPS,
  COLLECTION_FILTER_LABELS,
  COLLECTION_READ_VALUES,
  COLLECTION_SORT_FIELDS,
  COLLECTION_SORT_LABELS,
  collectionReadValue,
  countCollectionFilters,
  DEFAULT_COLLECTION_QUERY,
  defaultCollectionColumns,
  EMPTY_COLLECTION_FILTERS,
  foldCollectionFilterValue,
  isCollectionReadValue,
  isCollectionSortDirection,
  isCollectionSortField,
  isCollectionViewMode,
  readCollectionViewMode,
  readCollectionColumns,
  readCollectionFilters,
  type SavedViewDescriptor,
} from "./collection.js";

describe("collection contracts", () => {
  it("provides a bounded deterministic default query", () => {
    expect(DEFAULT_COLLECTION_QUERY).toEqual({
      object_types: [],
      text: "",
      filters: { kinds: [], tags: [], authors: [], years: [], read: [] },
      sort: { field: "updated_at", direction: "descending" },
      page: { offset: 0, limit: 50 },
    });
    expect(countCollectionFilters(EMPTY_COLLECTION_FILTERS)).toBe(0);
  });

  it("accepts only registered view and sort values", () => {
    expect(isCollectionViewMode("card")).toBe(true);
    expect(isCollectionViewMode("board")).toBe(false);
    // The squashed card in the middle is gone. A view saved as one opens as the table, which is
    // the other thing that draws a row per item.
    expect(isCollectionViewMode("list")).toBe(false);
    expect(readCollectionViewMode("list")).toBe("table");
    expect(readCollectionViewMode("card")).toBe("card");
    expect(readCollectionViewMode(undefined)).toBe("table");
    expect(isCollectionSortField("updated_at")).toBe(true);
    expect(isCollectionSortField("content")).toBe(false);
    expect(isCollectionSortField("year")).toBe(true);
    expect(isCollectionSortField("first_author")).toBe(true);
    expect(isCollectionSortField("created_at")).toBe(true);
    expect(isCollectionSortDirection("ascending")).toBe(true);
    expect(isCollectionSortDirection("newest")).toBe(false);
  });

  it("names every sort field it offers", () => {
    for (const field of COLLECTION_SORT_FIELDS) {
      expect(COLLECTION_SORT_LABELS[field]).toMatch(/\S/u);
    }
    expect(new Set(Object.values(COLLECTION_SORT_LABELS)).size).toBe(COLLECTION_SORT_FIELDS.length);
  });

  it("names every filter group it offers", () => {
    for (const group of COLLECTION_FILTER_GROUPS) {
      expect(COLLECTION_FILTER_LABELS[group]).toMatch(/\S/u);
    }
    expect(new Set(Object.values(COLLECTION_FILTER_LABELS)).size).toBe(
      COLLECTION_FILTER_GROUPS.length,
    );
  });

  it("reads filters from a saved view that predates them", () => {
    expect(readCollectionFilters(undefined)).toEqual(EMPTY_COLLECTION_FILTERS);
    expect(readCollectionFilters({ kinds: ["article"] })).toEqual({
      ...EMPTY_COLLECTION_FILTERS,
      kinds: ["article"],
    });
  });

  it("drops values no filter could match and keeps one spelling of each", () => {
    const filters = readCollectionFilters({
      kinds: ["article", 7, "  "],
      tags: ["tag:kiwi/needs-review", "tag:kiwi/needs-review"],
      authors: ["Ana Ortiz", "ana ortiz", " Bo Chen "],
      years: [2019, 2019, 2020.5, "2021"],
      read: ["Unread", "unread", "finished", 1],
    });
    expect(filters).toEqual({
      kinds: ["article"],
      tags: ["tag:kiwi/needs-review"],
      authors: ["Ana Ortiz", "Bo Chen"],
      years: [2019],
      read: ["unread"],
    });
    expect(countCollectionFilters(filters)).toBe(6);
  });

  it("offers read state as a group like any other, and both of its values", () => {
    expect(COLLECTION_FILTER_GROUPS).toContain("read");
    expect(COLLECTION_READ_VALUES.map(isCollectionReadValue)).toEqual([true, true]);
    expect(isCollectionReadValue("skimmed")).toBe(false);
    expect(collectionReadValue(true)).toBe("read");
    expect(collectionReadValue(false)).toBe("unread");
    // Both chosen is a group that narrows nothing, the same as choosing every tag in the library.
    expect(countCollectionFilters(readCollectionFilters({ read: ["read", "unread"] }))).toBe(2);
  });

  it("folds a value the same way wherever it is compared", () => {
    expect(foldCollectionFilterValue("  Ana Ortiz ")).toBe(foldCollectionFilterValue("ana ortiz"));
  });

  it("names every column it can show, and can sort all but three of them", () => {
    for (const column of COLLECTION_COLUMNS) {
      expect(COLLECTION_COLUMN_LABELS[column]).toMatch(/\S/u);
    }
    expect(COLLECTION_COLUMNS.filter((column) => !isCollectionSortField(column))).toEqual([
      "version",
      "summary",
      "read",
    ]);
  });

  it("offers the summary as a column without opening a library full of empty ones", () => {
    expect(COLLECTION_COLUMNS).toContain("summary");
    expect(defaultCollectionColumns("source")).not.toContain("summary");
    expect(readCollectionColumns(["title", "summary"], "source")).toEqual(["title", "summary"]);
  });

  it("offers last opened the same way, for the same reason and one more", () => {
    // Every other column reads the same on a colleague's copy of the library. This one is about
    // one machine, so it is asked for rather than shown.
    expect(isCollectionSortField("last_opened")).toBe(true);
    expect(COLLECTION_COLUMNS).toContain("last_opened");
    for (const family of ["source", "note", "output"])
      expect(defaultCollectionColumns(family)).not.toContain("last_opened");
  });

  it("shows a Paper by who wrote it and everything else by what it is", () => {
    // Added is available and off: two date columns side by side is one column somebody has to
    // read twice to find out which is which.
    expect(defaultCollectionColumns("source")).toEqual([
      "title",
      "first_author",
      "year",
      "updated_at",
      "read",
    ]);
    expect(defaultCollectionColumns("note")).toEqual(["title", "type", "version", "updated_at"]);
  });

  it("falls back to the family's columns for a saved view that chose none", () => {
    expect(readCollectionColumns(undefined, "source")).toEqual(defaultCollectionColumns("source"));
    expect(readCollectionColumns(["citations", "colour"], "note")).toEqual(
      defaultCollectionColumns("note"),
    );
  });

  it("keeps a chosen order, drops what it cannot show, and leads with the title", () => {
    expect(readCollectionColumns(["year", "type", "year", "abstract", "title"], "source")).toEqual([
      "title",
      "year",
      "type",
    ]);
    expect(readCollectionColumns(["title"], "source")).toEqual(["title"]);
  });

  it("keeps page state outside the saved view descriptor", () => {
    const descriptor: SavedViewDescriptor = {
      schema_version: 1,
      object_family: "inbox_item",
      mode: "table",
      visible_fields: ["title", "type", "updated_at"],
      query: {
        object_types: ["inbox_item"],
        text: "calibration",
        filters: EMPTY_COLLECTION_FILTERS,
        sort: { field: "title", direction: "ascending" },
      },
    };
    expect(descriptor.query).not.toHaveProperty("page");
  });
});
