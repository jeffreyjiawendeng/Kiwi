import { describe, expect, it, vi } from "vitest";
import {
  joinPageText,
  matchesOnPage,
  runsCovering,
  searchDocument,
  type PageText,
} from "./pdf-search.js";
import type { PdfDocument, PdfPage, PdfTextItem } from "./pdf-document.js";

function run(text: string, left: number, top = 0): PdfTextItem {
  return { text, left, top, width: text.length * 6, height: 12 };
}

function page(...items: PdfTextItem[]): PageText {
  return joinPageText(items);
}

describe("joinPageText", () => {
  it("separates runs so words do not fuse across them", () => {
    // Without a separator "the" + "orem" matches a search for "theorem", which is the kind of
    // false hit that makes a search box useless.
    const joined = page(run("the", 0), run("orem", 20));
    expect(joined.text).toBe("the orem ");
    expect(matchesOnPage(joined, "theorem", 1, 100, 100)).toEqual([]);
  });

  it("records where each run begins", () => {
    expect(page(run("abc", 0), run("de", 20)).starts).toEqual([0, 4]);
  });

  it("handles a page with no text", () => {
    expect(page().text).toBe("");
    expect(matchesOnPage(page(), "anything", 1, 100, 100)).toEqual([]);
  });
});

describe("runsCovering", () => {
  it("finds the run a match sits inside", () => {
    expect(runsCovering(page(run("ribosome", 0), run("assembly", 60)), 0, 8)).toEqual([0]);
  });

  it("finds every run a phrase straddles", () => {
    // A phrase routinely spans several runs, which is why the page is searched as one string.
    expect(runsCovering(page(run("ribosome", 0), run("assembly", 60)), 0, 17)).toEqual([0, 1]);
  });

  it("does not include a run the match merely touches the edge of", () => {
    expect(runsCovering(page(run("abc", 0), run("def", 20)), 0, 3)).toEqual([0]);
  });
});

describe("matchesOnPage", () => {
  it("is case-insensitive", () => {
    expect(matchesOnPage(page(run("Ribosome", 0)), "ribosome", 3, 100, 100)).toHaveLength(1);
  });

  it("finds every occurrence, not only the first", () => {
    const found = matchesOnPage(page(run("aa aa aa", 0)), "aa", 1, 100, 100);
    expect(found.map((match) => match.offset)).toEqual([0, 3, 6]);
  });

  it("gives rectangles as fractions of the page", () => {
    // Fractions, so a match lands correctly at any zoom.
    const found = matchesOnPage(page(run("word", 10, 20)), "word", 1, 200, 400);
    expect(found[0]?.rects[0]).toEqual({ left: 0.05, top: 0.05, width: 0.12, height: 0.03 });
  });

  it("carries the page number, so a match can be jumped to", () => {
    expect(matchesOnPage(page(run("x", 0)), "x", 7, 100, 100)[0]?.page).toBe(7);
  });

  it("returns nothing for a blank query", () => {
    expect(matchesOnPage(page(run("anything", 0)), "   ", 1, 100, 100)).toEqual([]);
  });

  it("does not divide by a page with no size", () => {
    expect(matchesOnPage(page(run("x", 0)), "x", 1, 0, 0)[0]?.rects).toEqual([]);
  });
});

function document(pages: PdfTextItem[][]): PdfDocument {
  return {
    pageCount: pages.length,
    pageLabel: (number) => String(number),
    page: vi.fn(async (number): Promise<PdfPage> => ({
      width: 100,
      height: 100,
      render: async () => undefined,
      textItems: async () => pages[number - 1] ?? [],
    })),
    outline: async () => [],
    metadata: async () => ({}),
    destroy: () => undefined,
  };
}

describe("searchDocument", () => {
  it("searches every page and reports where each match is", async () => {
    const found = await searchDocument(document([[run("alpha", 0)], [run("beta", 0)]]), "beta");
    expect(found).toHaveLength(1);
    expect(found[0]?.page).toBe(2);
  });

  it("reads one page at a time rather than all at once", async () => {
    // A four-hundred page thesis asked to extract every page's text at once exhausts memory.
    const doc = document([[run("a", 0)], [run("a", 0)], [run("a", 0)]]);
    const seen: number[] = [];
    await searchDocument(doc, "a", { onPage: (number) => seen.push(number) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("abandons the search when a newer query replaces it", async () => {
    const doc = document([[run("a", 0)], [run("a", 0)], [run("a", 0)]]);
    let searched = 0;
    const found = await searchDocument(doc, "a", {
      onPage: () => (searched += 1),
      cancelled: () => searched >= 1,
    });
    expect(found).toHaveLength(1);
  });

  it("skips a page it cannot read rather than failing the whole search", async () => {
    const doc = document([[run("a", 0)], [run("a", 0)]]);
    doc.page = vi.fn(async (number) => {
      if (number === 1) throw new Error("broken page");
      return {
        width: 100,
        height: 100,
        render: async () => undefined,
        textItems: async () => [run("a", 0)],
      };
    });
    expect(await searchDocument(doc, "a")).toHaveLength(1);
  });

  it("returns nothing for a blank query without reading anything", async () => {
    const doc = document([[run("a", 0)]]);
    expect(await searchDocument(doc, "  ")).toEqual([]);
    expect(doc.page).not.toHaveBeenCalled();
  });
});
