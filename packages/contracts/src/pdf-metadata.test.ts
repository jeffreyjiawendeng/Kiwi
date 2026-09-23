import { describe, expect, it } from "vitest";
import { readPdfMetadata, type PdfTextRun } from "./pdf-metadata.js";

const NOW = new Date("2024-06-01T00:00:00.000Z");

/** A first page, written the way it reads: a list of lines, largest type first. */
function page(lines: Array<[text: string, height: number]>): PdfTextRun[] {
  return lines.map(([text, height], index) => ({ text, left: 100, top: index * 30, height }));
}

/** The layout of an ordinary paper: title, authors, affiliation, abstract. */
const PAPER = page([
  ["Proceedings of the 41st Conference", 8],
  ["Notes on the Analytical Engine", 18],
  ["Ada Lovelace1, Charles Babbage2", 11],
  ["1 University of London, 2 Royal Society", 8],
  ["Abstract", 11],
  ["The engine weaves algebraic patterns.", 10],
]);

describe("readPdfMetadata", () => {
  it("takes the title the file states about itself", () => {
    const read = readPdfMetadata({ title: "Notes on the Analytical Engine" }, [], NOW);
    expect(read.title).toBe("Notes on the Analytical Engine");
    expect(read.sources.title).toBe("embedded");
  });

  it("reads the page where the file states the name of a file instead", () => {
    // Half the PDFs in the world are titled by whatever LaTeX was run to produce them.
    const read = readPdfMetadata({ title: "paper.dvi" }, PAPER, NOW);
    expect(read.title).toBe("Notes on the Analytical Engine");
    expect(read.sources.title).toBe("page");
  });

  it("reads the page where the file was titled by a word processor", () => {
    const read = readPdfMetadata({ title: "Microsoft Word - final_v3.doc" }, PAPER, NOW);
    expect(read.sources.title).toBe("page");
  });

  it("says when it found no title at all rather than inventing one", () => {
    const read = readPdfMetadata({}, [], NOW);
    expect(read.title).toBe("");
    expect(read.sources.title).toBe("none");
  });

  it("takes the largest type near the top rather than the first line on the page", () => {
    // A running head sits above the title, and a journal stamp above that.
    const read = readPdfMetadata({}, PAPER, NOW);
    expect(read.title).toBe("Notes on the Analytical Engine");
  });

  it("reads a title that wrapped as one title", () => {
    const wrapped = page([
      ["Notes on the Analytical Engine,", 18],
      ["and on the Weaving of Algebraic Patterns", 18],
      ["Ada Lovelace", 11],
    ]);
    expect(readPdfMetadata({}, wrapped, NOW).title).toBe(
      "Notes on the Analytical Engine, and on the Weaving of Algebraic Patterns",
    );
  });

  it("builds a line back out of the pieces the page was broken into", () => {
    const broken: PdfTextRun[] = [
      { text: "Notes on the", left: 100, top: 40, height: 18 },
      { text: "Analytical Engine", left: 220, top: 41, height: 18 },
      { text: "Ada Lovelace", left: 100, top: 80, height: 11 },
    ];
    expect(readPdfMetadata({}, broken, NOW).title).toBe("Notes on the Analytical Engine");
  });

  it("takes the authors the file states", () => {
    const read = readPdfMetadata({ author: "Ada Lovelace; Charles Babbage" }, PAPER, NOW);
    expect(read.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(read.sources.authors).toBe("embedded");
  });

  it("reads a list of authors separated the three ways it is written", () => {
    const read = readPdfMetadata({ author: "Ada Lovelace and Charles Babbage & Luigi Menabrea" });
    expect(read.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage", "Luigi Menabrea"]);
  });

  it("keeps a name written family first whole rather than splitting it into two people", () => {
    // One comma is ambiguous, and a name split wrongly invents an author nobody notices.
    const read = readPdfMetadata({ author: "Lovelace, Ada" });
    expect(read.reference.authors).toEqual(["Lovelace, Ada"]);
  });

  it("splits on commas once there are enough of them to be a list", () => {
    const read = readPdfMetadata({ author: "Ada Lovelace, Charles Babbage, Luigi Menabrea" });
    expect(read.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage", "Luigi Menabrea"]);
  });

  it("reads the line under the title when the file names nobody", () => {
    const read = readPdfMetadata({}, PAPER, NOW);
    expect(read.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(read.sources.authors).toBe("page");
  });

  it("takes the affiliation markers off a name and leaves the name", () => {
    const marked = page([
      ["A short history of engines", 18],
      ["Ada Lovelace1,*, Charles Babbage2", 11],
    ]);
    expect(readPdfMetadata({}, marked, NOW).reference.authors).toEqual([
      "Ada Lovelace",
      "Charles Babbage",
    ]);
  });

  it("does not read an affiliation as a person", () => {
    const noNames = page([
      ["A short history of engines", 18],
      ["University of London, Royal Society", 11],
      ["Abstract", 11],
    ]);
    const read = readPdfMetadata({}, noNames, NOW);
    expect(read.reference.authors).toEqual([]);
    expect(read.sources.authors).toBe("none");
  });

  it("prefers the year printed on the page to the day the file was made", () => {
    // A paper scanned last week has last week's creation date and 1843 on its title page.
    const dated = page([
      ["Notes on the Analytical Engine", 18],
      ["Ada Lovelace", 11],
      ["Scientific Memoirs, 1843", 9],
    ]);
    const read = readPdfMetadata({ creationDate: "D:20240301120000+00'00'" }, dated, NOW);
    expect(read.reference.year).toBe(1843);
    expect(read.sources.year).toBe("page");
  });

  it("falls back to the date the file states when the page prints no year", () => {
    const read = readPdfMetadata({ creationDate: "D:20230415120000+02'00'" }, PAPER, NOW);
    expect(read.reference.year).toBe(2023);
    expect(read.sources.year).toBe("embedded");
  });

  it("refuses a year no paper could carry", () => {
    const read = readPdfMetadata({ creationDate: "D:29990101000000" }, [], NOW);
    expect(read.reference.year).toBeNull();
    expect(read.sources.year).toBe("none");
  });

  it("reads the DOI off the page and drops the full stop after it", () => {
    const stamped = page([
      ["Notes on the Analytical Engine", 18],
      ["Ada Lovelace", 11],
      ["Published at https://doi.org/10.1000/engine.", 9],
    ]);
    const read = readPdfMetadata({}, stamped, NOW);
    expect(read.reference.doi).toBe("10.1000/engine");
    expect(read.sources.doi).toBe("page");
  });

  it("takes a DOI the file states in its keywords", () => {
    const read = readPdfMetadata({ keywords: "engines, doi:10.1000/engine" }, PAPER, NOW);
    expect(read.reference.doi).toBe("10.1000/engine");
    expect(read.sources.doi).toBe("embedded");
  });

  it("calls a stamped arXiv paper a preprint and says where it lives", () => {
    // The stamp is arXiv's own, so it is the one thing on the page that is not a guess.
    const stamped = page([
      ["arXiv:2301.00001v2 [cs.CL] 3 Jan 2023", 8],
      ["Notes on the Analytical Engine", 18],
      ["Ada Lovelace", 11],
    ]);
    const read = readPdfMetadata({}, stamped, NOW);
    expect(read.reference.kind).toBe("preprint");
    expect(read.reference.url).toBe("https://arxiv.org/abs/2301.00001");
    expect(read.sources.url).toBe("page");
    // And the stamp is still not the title.
    expect(read.title).toBe("Notes on the Analytical Engine");
  });

  it("guesses at no journal, because a wrong one prints a wrong citation", () => {
    expect(readPdfMetadata({}, PAPER, NOW).reference.container).toBeNull();
  });

  it("has nothing to say about a PDF that is a scan of a page of nothing", () => {
    const read = readPdfMetadata({}, [], NOW);
    expect(read).toEqual({
      title: "",
      reference: {
        kind: "article",
        authors: [],
        container: null,
        year: null,
        doi: null,
        url: null,
        volume: null,
        issue: null,
        pages: null,
        publisher: null,
        abstract: null,
      },
      sources: { title: "none", authors: "none", year: "none", doi: "none", url: "none" },
    });
  });
});
