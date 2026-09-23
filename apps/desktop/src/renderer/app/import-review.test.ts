import { describe, expect, it } from "vitest";
import {
  collectImport,
  describeDuplicate,
  describeImport,
  describeMissing,
  readImportPreview,
  readImportReceipt,
  type DuplicateVerdict,
  type ImportPart,
} from "./import-review.js";

function verdict(over: Partial<DuplicateVerdict> = {}): DuplicateVerdict {
  return {
    where: "library" as const,
    by: "doi" as const,
    certain: true,
    object_id: "object-1",
    row: null,
    title: "Attention Is All You Need",
    ...over,
  };
}

function committed(first: number, last: number, created: number): ImportPart {
  return {
    first,
    last,
    outcome: {
      status: "committed",
      receipt: {
        created: Array.from({ length: created }, (_, index) => ({
          id: `object-${String(first + index)}`,
          title: `Paper ${String(first + index)}`,
          key: `row-${String(first + index)}`,
        })),
        skipped: [],
      },
    },
  };
}

function failed(first: number, last: number, message: string): ImportPart {
  return { first, last, outcome: { status: "failed", message } };
}

describe("reading a preview", () => {
  it("reads a row whole", () => {
    const preview = readImportPreview({
      found: 1,
      rows: [
        {
          row: 1,
          key: "vaswani2017",
          title: "Attention Is All You Need",
          reference: { kind: "conference", authors: ["Vaswani, A."], year: 2017 },
          file_hash: null,
          selected: true,
          duplicate: null,
          problems: [{ field: "year", severity: "error", message: "Year is in the future." }],
          missing: ["container"],
        },
      ],
    });

    expect(preview?.found).toBe(1);
    expect(preview?.rows[0]).toMatchObject({
      row: 1,
      key: "vaswani2017",
      title: "Attention Is All You Need",
      selected: true,
      missing: ["container"],
    });
    // Read back into a whole record, because the editor beside the row expects every field to
    // exist whether or not the exporter wrote it.
    expect(preview?.rows[0]?.reference).toMatchObject({
      kind: "conference",
      authors: ["Vaswani, A."],
      year: 2017,
      doi: null,
      pages: null,
    });
    expect(preview?.rows[0]?.problems).toHaveLength(1);
  });

  it("keeps a row the preview held back unticked", () => {
    // The one field worth being strict about. A row that arrives ticked because `selected` was
    // spelled unexpectedly is a paper created over a warning nobody was shown.
    const preview = readImportPreview({
      found: 1,
      rows: [{ row: 1, title: "A", selected: false, duplicate: verdict() }],
    });

    expect(preview?.rows[0]?.selected).toBe(false);
    expect(preview?.rows[0]?.duplicate).toMatchObject({ where: "library", by: "doi" });
  });

  it("refuses a preview it cannot read whole", () => {
    expect(readImportPreview(undefined)).toBeNull();
    expect(readImportPreview({ found: 1 })).toBeNull();
    expect(readImportPreview({ found: "many", rows: [] })).toBeNull();
    // A row with no title cannot be shown, and showing the rest without it would leave somebody
    // ticking three rows out of four believing they had the file.
    expect(readImportPreview({ found: 2, rows: [{ row: 1, title: "A" }, { row: 2 }] })).toBeNull();
  });

  it("drops a duplicate verdict it does not recognise rather than inventing one", () => {
    const preview = readImportPreview({
      found: 1,
      rows: [{ row: 1, title: "A", duplicate: { where: "elsewhere", by: "doi" } }],
    });

    expect(preview?.rows[0]?.duplicate).toBeNull();
  });
});

describe("saying what a row is a copy of", () => {
  it("states a certain match as a fact and a resemblance as a resemblance", () => {
    expect(describeDuplicate(verdict({ by: "doi" }))).toBe(
      'Already in the library as "Attention Is All You Need", with the same DOI.',
    );
    expect(describeDuplicate(verdict({ by: "file" }))).toBe(
      'Already in the library as "Attention Is All You Need", from the same file.',
    );
    // A title that reads alike is a guess, and stating a guess as a fact is how a distinct paper
    // ends up unticked and never imported.
    expect(describeDuplicate(verdict({ by: "title", certain: false }))).toBe(
      'Reads like "Attention Is All You Need", already in the library. Check before adding it.',
    );
  });

  it("names the earlier row when the copy is inside the same file", () => {
    expect(describeDuplicate(verdict({ where: "file", by: "doi", row: 4 }))).toBe(
      "The same DOI appears at row 4 of this file.",
    );
    expect(describeDuplicate(verdict({ where: "file", by: "title", certain: false, row: 4 }))).toBe(
      "Reads like row 4 of this file. Check the two before adding both.",
    );
  });

  it("says something usable when the thing matched has no name", () => {
    expect(describeDuplicate(verdict({ title: "" }))).toBe(
      "Already in the library as a work already held, with the same DOI.",
    );
    expect(describeDuplicate(verdict({ where: "file", by: "file", row: null }))).toBe(
      "The same file appears at an earlier row of this file.",
    );
  });
});

describe("saying what an exporter left out", () => {
  it("names fields in words rather than in field names", () => {
    expect(describeMissing(["year"])).toBe("No year.");
    expect(describeMissing(["authors", "year"])).toBe("No authors or year.");
    expect(describeMissing(["authors", "year", "container"])).toBe("No authors, year or venue.");
    expect(describeMissing([])).toBeNull();
  });

  it("passes through a field it has no wording for", () => {
    expect(describeMissing(["editor"])).toBe("No editor.");
  });
});

describe("adding several receipts into one", () => {
  it("reads a receipt", () => {
    expect(
      readImportReceipt({
        created: [{ id: "object-1", title: "A", key: "row-0", duplicate: null }],
        skipped: [{ title: "B", reason: "rejected", object_id: null }],
        found: 2,
        reviewed: true,
      }),
    ).toEqual({
      created: [{ id: "object-1", title: "A", key: "row-0" }],
      skipped: [{ title: "B", reason: "rejected" }],
    });
    // A receipt that named no row reads as one with nothing left to do for it, which is what a
    // caller that sent no names of its own is owed.
    expect(readImportReceipt({ created: [{ id: "object-1", title: "A" }], skipped: [] })).toEqual({
      created: [{ id: "object-1", title: "A", key: "" }],
      skipped: [],
    });
    expect(readImportReceipt({ created: [{ id: 7, title: "A" }], skipped: [] })).toBeNull();
    expect(readImportReceipt(undefined)).toBeNull();
  });

  it("adds what every part created", () => {
    const outcome = collectImport([committed(1, 200, 200), committed(201, 400, 198)]);

    expect(outcome.created).toHaveLength(398);
    expect(outcome.unsent).toHaveLength(0);
  });

  it("keeps a failure as a stretch of rows rather than as a failed request", () => {
    const outcome = collectImport([
      committed(1, 200, 200),
      failed(201, 400, "The workspace stopped responding."),
    ]);

    expect(outcome.created).toHaveLength(200);
    expect(outcome.unsent).toEqual([
      { first: 201, last: 400, message: "The workspace stopped responding." },
    ]);
  });

  it("joins neighbouring stretches that failed the same way", () => {
    // Two requests is how the ceiling cut it, not something that went wrong twice.
    const outcome = collectImport([
      committed(1, 200, 200),
      failed(201, 400, "The workspace stopped responding."),
      failed(401, 600, "The workspace stopped responding."),
    ]);

    expect(outcome.unsent).toEqual([
      { first: 201, last: 600, message: "The workspace stopped responding." },
    ]);
  });

  it("keeps separate faults separate", () => {
    const outcome = collectImport([
      failed(1, 200, "The workspace stopped responding."),
      failed(201, 400, "The workspace is read-only."),
    ]);

    expect(outcome.unsent).toHaveLength(2);
  });

  it("does not join across a part that went in", () => {
    const outcome = collectImport([
      failed(1, 100, "The workspace stopped responding."),
      committed(101, 200, 100),
      failed(201, 300, "The workspace stopped responding."),
    ]);

    expect(outcome.unsent).toEqual([
      { first: 1, last: 100, message: "The workspace stopped responding." },
      { first: 201, last: 300, message: "The workspace stopped responding." },
    ]);
  });
});

describe("telling somebody what one import did", () => {
  it("counts papers when everything went in", () => {
    expect(describeImport(collectImport([committed(1, 3, 3)]))).toEqual({
      headline: "3 papers added.",
      notes: [],
    });
    expect(describeImport(collectImport([committed(1, 1, 1)])).headline).toBe("1 paper added.");
  });

  it("says the total whenever it differs from what was created", () => {
    // "388 added" invites the reading that 388 was what there was.
    const outcome = collectImport([
      {
        first: 1,
        last: 3,
        outcome: {
          status: "committed",
          receipt: {
            created: [{ id: "object-1", title: "A", key: "row-1" }],
            skipped: [
              { title: "B", reason: "rejected" },
              { title: "C", reason: "rejected" },
            ],
          },
        },
      },
    ]);

    expect(describeImport(outcome)).toEqual({
      headline: "1 of 3 rows added.",
      notes: ["2 rows were not created, because the workspace would not accept the record."],
    });
  });

  it("groups skipped rows by reason", () => {
    const outcome = collectImport([
      {
        first: 1,
        last: 3,
        outcome: {
          status: "committed",
          receipt: {
            created: [],
            skipped: [
              { title: "A", reason: "duplicate_doi" },
              { title: "B", reason: "duplicate_doi" },
              { title: "C", reason: "repeated_in_file" },
            ],
          },
        },
      },
    ]);

    expect(describeImport(outcome).notes).toEqual([
      "2 rows were not created, because the library already holds that DOI.",
      "One row was not created, because the file lists it more than once.",
    ]);
  });

  it("says which rows never went when the import stopped part way", () => {
    const outcome = collectImport([
      committed(1, 200, 200),
      failed(201, 400, "The workspace stopped responding."),
    ]);

    expect(describeImport(outcome)).toEqual({
      headline: "200 of 400 rows added, and the import stopped.",
      notes: ["Rows 201 to 400 were not sent. The workspace stopped responding."],
    });
  });

  it("names a single row that never went", () => {
    expect(
      describeImport(collectImport([failed(7, 7, "The workspace is read-only.")])).notes,
    ).toEqual(["Row 7 was not sent. The workspace is read-only."]);
  });

  it("does not claim a partial import when nothing was added at all", () => {
    expect(
      describeImport(collectImport([failed(1, 400, "The workspace stopped responding.")])).headline,
    ).toBe("Nothing was added.");
  });

  it("says nothing happened when there was nothing to do", () => {
    expect(describeImport(collectImport([]))).toEqual({
      headline: "Nothing was imported.",
      notes: [],
    });
  });
});
