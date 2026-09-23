import { describe, expect, it } from "vitest";
import { bibtexKey, parseBibtex, toBibtex, toBibtexFile, type BibtexEntry } from "./bibtex.js";
import { EMPTY_REFERENCE, type Reference } from "./reference.js";

function entry(
  overrides: Partial<Reference> = {},
  title = "Attention is all you need",
): BibtexEntry {
  return {
    key: "vaswani2017",
    title,
    reference: {
      ...EMPTY_REFERENCE,
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      container: "Advances in Neural Information Processing Systems",
      year: 2017,
      volume: "30",
      pages: "5998-6008",
      ...overrides,
    },
  };
}

describe("bibtexKey", () => {
  it("names the first author and the year, so a LaTeX source reads", () => {
    // A key of ref17 tells the author nothing about what they just cited.
    expect(bibtexKey(entry(), new Set())).toBe("vaswani2017");
  });

  it("adds a letter when two papers share an author and a year", () => {
    expect(bibtexKey(entry(), new Set(["vaswani2017"]))).toBe("vaswani2017a");
    expect(bibtexKey(entry(), new Set(["vaswani2017", "vaswani2017a"]))).toBe("vaswani2017b");
  });

  it("falls back to the title when there is no author", () => {
    expect(bibtexKey(entry({ authors: [] }), new Set())).toBe("attention2017");
  });

  it("produces a key even with nothing to build one from", () => {
    expect(bibtexKey({ title: "", reference: EMPTY_REFERENCE }, new Set())).toBe("ref");
  });
});

describe("toBibtex", () => {
  it("writes the fields a bibliography needs", () => {
    const text = toBibtex(entry());
    expect(text).toContain("@article{vaswani2017,");
    expect(text).toContain("author = {Ashish Vaswani and Noam Shazeer}");
    expect(text).toContain("year = {2017}");
    expect(text).toContain("pages = {5998-6008}");
  });

  it("puts a conference paper in booktitle rather than journal", () => {
    // The same field in Kiwi is two different fields in BibTeX, and a style file cares.
    expect(toBibtex(entry({ kind: "conference" }))).toContain("booktitle = {Advances");
  });

  it("omits a field that has no value rather than writing an empty one", () => {
    const text = toBibtex(entry({ volume: null, pages: null, doi: null }));
    expect(text).not.toContain("volume");
    expect(text).not.toContain("pages");
  });

  it("writes a file of several entries", () => {
    const text = toBibtexFile([entry(), { ...entry(), key: "second" }]);
    expect(text.match(/@article\{/gu)).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("parseBibtex", () => {
  it("reads an ordinary entry", () => {
    const [parsed] = parseBibtex(
      "@article{vaswani2017,\n  title = {Attention is all you need},\n  author = {Ashish Vaswani and Noam Shazeer},\n  year = {2017},\n  journal = {NeurIPS}\n}",
    );
    expect(parsed).toMatchObject({ key: "vaswani2017", title: "Attention is all you need" });
    expect(parsed?.reference.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(parsed?.reference.year).toBe(2017);
    expect(parsed?.reference.container).toBe("NeurIPS");
  });

  it("survives nested braces protecting capitals", () => {
    // {The {DNA} Helix} is how every tool protects an acronym; losing the inner braces must
    // not lose the words inside them.
    const [parsed] = parseBibtex("@book{k,\n title = {The {DNA} Helix},\n year = {1953}\n}");
    expect(parsed?.title).toBe("The DNA Helix");
  });

  it("accepts a value in quotes", () => {
    const [parsed] = parseBibtex('@article{k, title = "A quoted title", year = 1999}');
    expect(parsed?.title).toBe("A quoted title");
    expect(parsed?.reference.year).toBe(1999);
  });

  it("accepts a number with no delimiters at all", () => {
    const [parsed] = parseBibtex("@article{k, title = {T}, year = 2001}");
    expect(parsed?.reference.year).toBe(2001);
  });

  it("does not treat a string definition as a reference", () => {
    const parsed = parseBibtex('@string{nips = "NeurIPS"}\n@article{k, title = {T}}');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe("T");
  });

  it("keeps going after an entry it cannot make sense of", () => {
    // A library of four hundred references with one broken record should import 399.
    const parsed = parseBibtex("@article{broken,\n@article{good, title = {Kept}, year = {2020}}");
    expect(parsed.some((item) => item.title === "Kept")).toBe(true);
  });

  it("maps entry types onto what Kiwi calls them", () => {
    expect(parseBibtex("@inproceedings{k, title={T}}")[0]?.reference.kind).toBe("conference");
    expect(parseBibtex("@phdthesis{k, title={T}}")[0]?.reference.kind).toBe("thesis");
    expect(parseBibtex("@nonsense{k, title={T}}")[0]?.reference.kind).toBe("other");
  });

  it("normalises the double hyphen BibTeX uses for a page range", () => {
    expect(parseBibtex("@article{k, title={T}, pages={1--10}}")[0]?.reference.pages).toBe("1-10");
  });

  it("names an entry that has no title rather than leaving it blank", () => {
    expect(parseBibtex("@article{k, year = {2020}}")[0]?.title).toBe("Untitled");
  });

  it("reads an empty file as an empty library", () => {
    expect(parseBibtex("")).toEqual([]);
    expect(parseBibtex("% just a comment\n")).toEqual([]);
  });
});

describe("a round trip", () => {
  it("keeps every field it carried out", () => {
    const original = entry({
      doi: "10.1000/xyz",
      url: "https://example.test/paper",
      issue: "4",
      publisher: "MIT Press",
      abstract: "A short abstract.",
    });
    const [parsed] = parseBibtex(toBibtex(original));
    expect(parsed?.title).toBe(original.title);
    expect(parsed?.reference).toMatchObject({
      authors: original.reference.authors,
      year: 2017,
      volume: "30",
      issue: "4",
      pages: "5998-6008",
      doi: "10.1000/xyz",
      url: "https://example.test/paper",
      publisher: "MIT Press",
      abstract: "A short abstract.",
    });
  });

  it("keeps the kind for a conference paper", () => {
    const [parsed] = parseBibtex(toBibtex(entry({ kind: "conference" })));
    expect(parsed?.reference.kind).toBe("conference");
  });
});
