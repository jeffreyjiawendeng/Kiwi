import { describe, expect, it } from "vitest";
import {
  importCandidates,
  titleFingerprint,
  titleSimilarity,
  type HeldWork,
  type ImportEntry,
} from "./library-import.js";
import { EMPTY_REFERENCE, type Reference } from "./reference.js";

function entry(
  title: string,
  overrides: Partial<Reference> = {},
  fileHash: string | null = null,
): ImportEntry {
  return {
    key: "key",
    title,
    reference: { ...EMPTY_REFERENCE, authors: ["Ada Lovelace"], year: 1843, ...overrides },
    fileHash,
  };
}

function held(
  title: string,
  overrides: Partial<Reference> = {},
  fileHash: string | null = null,
): HeldWork {
  return {
    id: "obj_held",
    title,
    reference: { ...EMPTY_REFERENCE, authors: ["Ada Lovelace"], year: 1843, ...overrides },
    fileHash,
  };
}

describe("titleFingerprint", () => {
  it("keeps the words and drops everything a second exporter would have spelled differently", () => {
    expect(titleFingerprint("Attention Is All You Need!")).toEqual([
      "attention",
      "is",
      "all",
      "you",
      "need",
    ]);
  });

  it("reads a title through its accents", () => {
    // The same paper cited from a French keyboard and an English one is the same paper.
    expect(titleFingerprint("Théorie des matrices")).toEqual(["theorie", "des", "matrices"]);
  });

  it("reads a title through the braces LaTeX puts round a word it wants left alone", () => {
    expect(titleFingerprint("{DNA} sequencing")).toEqual(titleFingerprint("DNA sequencing"));
  });
});

describe("titleSimilarity", () => {
  it("calls a title spelled two ways the same title", () => {
    expect(titleSimilarity("Attention is all you need", "ATTENTION IS ALL YOU NEED.")).toBe(1);
  });

  it("does not call two surveys of different things the same survey", () => {
    // One word apart out of five, which is close, and close is not the same.
    expect(
      titleSimilarity("A survey of deep learning", "A survey of machine learning"),
    ).toBeLessThan(0.85);
  });

  it("has nothing to say about a title that is empty", () => {
    expect(titleSimilarity("", "Anything")).toBe(0);
  });
});

describe("importCandidates", () => {
  it("offers everything in a file the library has never seen", () => {
    const rows = importCandidates([entry("One"), entry("Two")], []);
    expect(rows.map((row) => row.selected)).toEqual([true, true]);
    expect(rows.map((row) => row.duplicate)).toEqual([null, null]);
  });

  it("keeps the row number an entry arrived on", () => {
    // The preview sorts, and a row has to still be able to say which entry in the file it is.
    const rows = importCandidates([entry("One"), entry("Two"), entry("Three")], []);
    expect(rows.map((row) => row.row)).toEqual([0, 1, 2]);
  });

  it("knows a paper the library already holds by its DOI", () => {
    const rows = importCandidates(
      [entry("Notes on the Analytical Engine", { doi: "10.1000/engine" })],
      [held("Sketch of the Analytical Engine", { doi: "10.1000/engine" })],
    );
    expect(rows[0]?.duplicate).toEqual({
      where: "library",
      by: "doi",
      certain: true,
      objectId: "obj_held",
      row: null,
      title: "Sketch of the Analytical Engine",
    });
    expect(rows[0]?.selected).toBe(false);
  });

  it("reads a DOI and the link to it as one identifier", () => {
    // Half the exporters in the world write the bare DOI and the other half the doi.org URL.
    const rows = importCandidates(
      [entry("Notes", { doi: "https://doi.org/10.1000/Engine" })],
      [held("Notes", { doi: "10.1000/engine" })],
    );
    expect(rows[0]?.duplicate).toMatchObject({ by: "doi", certain: true });
  });

  it("knows the same file arriving a second time", () => {
    const rows = importCandidates(
      [entry("Whatever the metadata said", {}, "sha256:abc")],
      [held("Notes on the Analytical Engine", {}, "sha256:abc")],
    );
    expect(rows[0]?.duplicate).toMatchObject({ by: "file", certain: true });
  });

  it("does not match on an absent DOI or an absent file", () => {
    // Two papers that both lack a DOI have nothing in common, and a check that compares null
    // to null would fold an entire library into one paper.
    const rows = importCandidates([entry("One")], [held("Two")]);
    expect(rows[0]?.duplicate).toBeNull();
  });

  it("flags a title that reads the same, and says it is not certain of it", () => {
    const rows = importCandidates(
      [entry("Notes on the Analytical Engine")],
      [held("Notes on the analytical engine.")],
    );
    expect(rows[0]?.duplicate).toMatchObject({ where: "library", by: "title", certain: false });
    expect(rows[0]?.selected).toBe(false);
  });

  it("does not call two papers one when they disagree on the year", () => {
    // An annual report is the same title every year and a different report every year.
    const rows = importCandidates(
      [entry("Annual report", { year: 2020 })],
      [held("Annual report", { year: 2019 })],
    );
    expect(rows[0]?.duplicate).toBeNull();
  });

  it("does not call two papers one when they disagree on who wrote them", () => {
    const rows = importCandidates(
      [entry("A short history of time", { authors: ["Stephen Hawking"] })],
      [held("A short history of time", { authors: ["Ada Lovelace"] })],
    );
    expect(rows[0]?.duplicate).toBeNull();
  });

  it("does not call two papers one when they carry different DOIs", () => {
    // A preprint and the journal version read alike and are separately citable records.
    const rows = importCandidates(
      [entry("Notes on the Analytical Engine", { doi: "10.1000/preprint" })],
      [held("Notes on the Analytical Engine", { doi: "10.1000/journal" })],
    );
    expect(rows[0]?.duplicate).toBeNull();
  });

  it("takes silence on a year as silence rather than as disagreement", () => {
    const rows = importCandidates(
      [entry("Notes on the Analytical Engine", { year: null })],
      [held("Notes on the Analytical Engine", { year: 1843 })],
    );
    expect(rows[0]?.duplicate).toMatchObject({ by: "title" });
  });

  it("catches a file that lists the same paper twice", () => {
    // The commonest broken export there is: two collections merged, both holding the paper.
    const rows = importCandidates(
      [entry("Notes", { doi: "10.1000/engine" }), entry("Notes", { doi: "10.1000/engine" })],
      [],
    );
    expect(rows[0]?.selected).toBe(true);
    expect(rows[1]?.duplicate).toEqual({
      where: "file",
      by: "doi",
      certain: true,
      objectId: null,
      row: 0,
      title: "Notes",
    });
  });

  it("points a third copy back at the first rather than at the second", () => {
    const rows = importCandidates([entry("Notes"), entry("Notes"), entry("Notes")], []);
    expect(rows.map((row) => row.duplicate?.row ?? null)).toEqual([null, 0, 0]);
    expect(rows.map((row) => row.selected)).toEqual([true, false, false]);
  });

  it("prefers the certain match to the resemblance", () => {
    // The library holds the paper under a title that reads alike and another under its DOI.
    // The DOI is what it is, so that is what the row is told it duplicates.
    const rows = importCandidates(
      [entry("Notes on the Analytical Engine", { doi: "10.1000/engine" })],
      [
        { ...held("Notes on the Analytical Engine"), id: "obj_alike" },
        { ...held("Something else entirely", { doi: "10.1000/engine" }), id: "obj_doi" },
      ],
    );
    expect(rows[0]?.duplicate).toMatchObject({ by: "doi", objectId: "obj_doi" });
  });

  it("carries the entry through untouched for whatever creates it later", () => {
    const rows = importCandidates([entry("Notes", { doi: "10.1000/engine" }, "sha256:abc")], []);
    expect(rows[0]).toMatchObject({
      key: "key",
      title: "Notes",
      fileHash: "sha256:abc",
      reference: { doi: "10.1000/engine", year: 1843 },
    });
  });

  it("has nothing to offer from an empty file", () => {
    expect(importCandidates([], [held("Notes")])).toEqual([]);
  });
});
