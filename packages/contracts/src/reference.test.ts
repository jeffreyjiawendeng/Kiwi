import { describe, expect, it } from "vitest";
import {
  EMPTY_REFERENCE,
  normalizeDoi,
  normalizePaperSummary,
  normalizeReference,
  PAPER_SUMMARY_LIMIT,
  primaryFileId,
  readPaperReadState,
  readPaperSummary,
  readReference,
  referenceSummary,
  validateReference,
  type Reference,
} from "./reference.js";

const NOW = new Date("2026-08-25T00:00:00.000Z");

function reference(overrides: Partial<Reference> = {}): Reference {
  return { ...EMPTY_REFERENCE, ...overrides };
}

describe("normalizeDoi", () => {
  it("accepts a bare DOI and lowercases it", () => {
    expect(normalizeDoi("10.1038/S41586-021-03819-2")).toBe("10.1038/s41586-021-03819-2");
  });

  it("accepts the URL forms people actually paste", () => {
    // Rejecting a pasted doi.org link would be pedantry; the DOI is right there in it.
    for (const value of [
      "https://doi.org/10.1000/xyz123",
      "http://dx.doi.org/10.1000/xyz123",
      "doi:10.1000/xyz123",
    ]) {
      expect(normalizeDoi(value)).toBe("10.1000/xyz123");
    }
  });

  it("rejects something that is not a DOI", () => {
    for (const value of ["", "  ", "not-a-doi", "10.x/abc", "https://example.test/paper"]) {
      expect(normalizeDoi(value)).toBeNull();
    }
  });
});

describe("validateReference", () => {
  it("accepts an empty reference, because a Paper may have nothing filled in yet", () => {
    expect(validateReference(EMPTY_REFERENCE, NOW)).toEqual([]);
  });

  it("accepts a complete reference", () => {
    const problems = validateReference(
      reference({
        kind: "article",
        authors: ["Vaswani, Ashish", "Shazeer, Noam"],
        container: "NeurIPS",
        year: 2017,
        doi: "10.48550/arXiv.1706.03762",
        url: "https://arxiv.org/abs/1706.03762",
        pages: "5998-6008",
      }),
      NOW,
    );
    expect(problems).toEqual([]);
  });

  it("rejects a year outside the plausible range but allows one slightly ahead", () => {
    expect(validateReference(reference({ year: 2031 }), NOW)).toEqual([]);
    expect(validateReference(reference({ year: 2032 }), NOW)).toMatchObject([{ field: "year" }]);
    expect(validateReference(reference({ year: 999 }), NOW)).toMatchObject([{ field: "year" }]);
    expect(validateReference(reference({ year: 2017.5 }), NOW)).toMatchObject([{ field: "year" }]);
  });

  it("rejects a malformed DOI", () => {
    expect(validateReference(reference({ doi: "nonsense" }), NOW)).toMatchObject([
      { field: "doi" },
    ]);
  });

  it("rejects a link that is not http or https", () => {
    // A file: or javascript: link would be opened by the interface later.
    for (const url of ["javascript:alert(1)", "file:///C:/secret.txt", "arxiv.org/abs/1706"]) {
      expect(validateReference(reference({ url }), NOW)).toMatchObject([{ field: "url" }]);
    }
  });

  it("rejects a blank author rather than storing an empty name", () => {
    expect(validateReference(reference({ authors: ["Real Name", "   "] }), NOW)).toMatchObject([
      { field: "authors" },
    ]);
  });

  it("rejects an unknown reference kind", () => {
    expect(validateReference(reference({ kind: "napkin" as "article" }), NOW)).toMatchObject([
      { field: "kind" },
    ]);
  });
});

describe("normalizeReference", () => {
  it("trims fields, drops blank authors, and normalizes the DOI", () => {
    const normalized = normalizeReference(
      reference({
        authors: ["  Vaswani, Ashish  ", "   ", "Shazeer, Noam"],
        container: "  NeurIPS  ",
        doi: " https://doi.org/10.1000/XYZ123 ",
        publisher: "   ",
      }),
    );
    expect(normalized.authors).toEqual(["Vaswani, Ashish", "Shazeer, Noam"]);
    expect(normalized.container).toBe("NeurIPS");
    expect(normalized.doi).toBe("10.1000/xyz123");
    expect(normalized.publisher).toBeNull();
  });

  it("keeps an unparseable DOI so the person can see and fix what they typed", () => {
    expect(normalizeReference(reference({ doi: "  nonsense  " })).doi).toBe("nonsense");
  });
});

describe("readReference", () => {
  it("fills in fields a file written by an earlier version did not carry", () => {
    const stored = { kind: "book", authors: ["Knuth, Donald"] };
    expect(readReference(stored)).toMatchObject({
      kind: "book",
      authors: ["Knuth, Donald"],
      year: null,
      doi: null,
    });
  });

  it("falls back to an empty reference for anything unrecognizable", () => {
    for (const value of [null, undefined, 42, "reference", [], { authors: "one" }]) {
      expect(readReference(value)).toEqual(EMPTY_REFERENCE);
    }
  });

  it("replaces an unknown kind rather than letting it reach a citation style", () => {
    expect(readReference({ kind: "napkin", authors: [] }).kind).toBe("article");
  });
});

describe("referenceSummary", () => {
  it("reads the way a citation does", () => {
    expect(
      referenceSummary(
        reference({
          authors: ["Vaswani, Ashish", "Shazeer, Noam"],
          year: 2017,
          container: "NeurIPS",
        }),
      ),
    ).toBe("Vaswani et al. (2017) NeurIPS");
  });

  it("names a single author without et al.", () => {
    expect(referenceSummary(reference({ authors: ["Knuth, Donald"], year: 1968 }))).toBe(
      "Knuth (1968)",
    );
  });

  it("says nothing when there is nothing to say", () => {
    expect(referenceSummary(EMPTY_REFERENCE)).toBe("");
  });
});

describe("a summary in the reader's own words", () => {
  it("folds text pasted out of a PDF onto one line", () => {
    // Left alone, these breaks read as one line in the box it was typed in and as three in
    // the table column it was written for.
    expect(normalizePaperSummary("  Shows that\nattention alone\r\n\tbeats recurrence. ")).toBe(
      "Shows that attention alone beats recurrence.",
    );
  });

  it("has no summary for everything written before there was one", () => {
    expect(readPaperSummary(undefined)).toBe("");
    expect(readPaperSummary(42)).toBe("");
    expect(readPaperSummary(" Worth reading twice. ")).toBe("Worth reading twice.");
  });

  it("never grows what it was given", () => {
    // The command checks the length of what was sent and stores what this returns. If folding
    // could lengthen a summary, a value that passed the check would be stored over the limit.
    const written = " Sparse attention,  quadratic cost,  no code released. ";
    expect(normalizePaperSummary(written).length).toBeLessThanOrEqual(written.length);
    expect(normalizePaperSummary("x".repeat(PAPER_SUMMARY_LIMIT))).toHaveLength(
      PAPER_SUMMARY_LIMIT,
    );
  });
});

describe("the mark saying a work has been read", () => {
  it("treats everything that is not the mark as unread", () => {
    // A paper the reader has never seen, one written before the field existed, and one carrying
    // some other build's idea of the field all answer the same way.
    expect(readPaperReadState(true)).toBe(true);
    expect(readPaperReadState(undefined)).toBe(false);
    expect(readPaperReadState("true")).toBe(false);
    expect(readPaperReadState(1)).toBe(false);
  });
});

describe("the file a Paper opens to", () => {
  const attached = ["asset-preprint", "asset-published", "asset-supplement"];

  it("opens the chosen file, and the first one when nothing was chosen", () => {
    expect(primaryFileId(attached, "asset-published")).toBe("asset-published");
    // Every Paper written before this build, and every Paper nobody has chosen for.
    expect(primaryFileId(attached, undefined)).toBe("asset-preprint");
    expect(primaryFileId(attached, "")).toBe("asset-preprint");
    expect(primaryFileId([], "asset-published")).toBe("");
  });

  it("falls back when the chosen file has been detached, rather than opening nothing", () => {
    // Detaching the primary file leaves the name behind on purpose: the Paper is not written
    // again, and this is the rule that keeps a stale name from emptying the Reader.
    expect(primaryFileId(["asset-preprint"], "asset-published")).toBe("asset-preprint");
    expect(primaryFileId([], "asset-published")).toBe("");
  });
});
