import { describe, expect, it, vi } from "vitest";
import { EMPTY_ANNOTATION, type Annotation } from "@kiwi/contracts";
import { anchorState, resolveAnchors } from "./annotation-anchors.js";
import type { PdfDocument, PdfPage, PdfTextItem } from "./pdf-document.js";

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    ...EMPTY_ANNOTATION,
    asset_id: "asset-1",
    page: 2,
    page_label: "2",
    rects: [{ left: 0.1, top: 0.2, width: 0.4, height: 0.02 }],
    quoted: "attention is all you need",
    ...overrides,
  };
}

describe("whether a mark still points at anything", () => {
  it("keeps a mark whose quotation is still on its page", () => {
    expect(anchorState(annotation(), { text: "We claim attention is all you need." })).toBe(
      "found",
    );
  });

  it("orphans a mark whose page is no longer in the file", () => {
    // A twelve page preprint replaced by a six page paper. The mark on page nine has nowhere
    // left to be, and must not be quietly moved to a page that happens to still exist.
    expect(anchorState(annotation({ page: 9 }), undefined)).toBe("orphaned");
  });

  it("orphans a mark whose quotation has gone from its page", () => {
    expect(anchorState(annotation(), { text: "An entirely different sentence." })).toBe("orphaned");
  });

  it("reads through the line breaks and hyphens a re-rendered file moves", () => {
    // The same words, broken differently: the text layer joins runs with spaces, and a word
    // split across a line arrives with a hyphen in it. Neither is the passage going missing.
    expect(
      anchorState(annotation({ quoted: "attention is all you need" }), {
        text: "atten- tion\nis all\nyou  need",
      }),
    ).toBe("found");
  });

  it("keeps a mark on a page whose text could not be read", () => {
    // A scan with no text layer says nothing about whether the passage is there. Orphaning on
    // silence would empty the page of every mark on it.
    expect(anchorState(annotation(), { text: null })).toBe("found");
  });

  it("keeps a mark on a page with no text on it at all", () => {
    // A scanned page, or a page of figures. Nothing to search is not the same as searching and
    // finding nothing, and the difference is every mark on a scanned document.
    expect(anchorState(annotation(), { text: "" })).toBe("found");
  });

  it("keeps a pin, which quotes nothing to look for", () => {
    expect(
      anchorState(annotation({ kind: "note", quoted: "", comment: "Check this figure" }), {
        text: "Anything at all",
      }),
    ).toBe("found");
  });

  it("keeps a captured region, whose page is all it points at", () => {
    expect(anchorState(annotation({ kind: "area", quoted: "" }), { text: "" })).toBe("found");
  });

  it("orphans a mark with nothing left to draw", () => {
    // Rectangles that could not be a fraction of a page are dropped on the way in, so a mark
    // can arrive with none. There is nowhere to put it, and it is not a text box.
    expect(anchorState(annotation({ rects: [] }), { text: "attention is all you need" })).toBe(
      "orphaned",
    );
  });

  it("keeps a text box, which stands on a page without a region", () => {
    expect(
      anchorState(annotation({ kind: "text", rects: [], quoted: "", comment: "Note to self" }), {
        text: "",
      }),
    ).toBe("found");
  });

  it("orphans a mark whose rectangle is off the page entirely", () => {
    expect(
      anchorState(annotation({ rects: [{ left: 1.4, top: 0.2, width: 0.1, height: 0.02 }] }), {
        text: "attention is all you need",
      }),
    ).toBe("orphaned");
  });
});

function pageWith(text: string, seen: number[], pageNumber: number): PdfPage {
  return {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async (): Promise<PdfTextItem[]> => {
      seen.push(pageNumber);
      return [{ text, left: 72, top: 96, width: 300, height: 14 }];
    }),
  };
}

describe("resolving a document's anchors", () => {
  it("reads each marked page once, however many marks are on it", async () => {
    const seen: number[] = [];
    const document: PdfDocument = {
      pageCount: 4,
      pageLabel: (pageNumber) => String(pageNumber),
      page: vi.fn(async (pageNumber: number) =>
        pageWith("a passage worth marking", seen, pageNumber),
      ),
      outline: vi.fn(async () => []),
      metadata: vi.fn(async () => ({})),
      destroy: vi.fn(),
    };

    const orphans = await resolveAnchors(document, [
      { id: "one", annotation: annotation({ page: 2, quoted: "a passage worth marking" }) },
      { id: "two", annotation: annotation({ page: 2, quoted: "worth marking" }) },
      { id: "three", annotation: annotation({ page: 3, quoted: "never written" }) },
      { id: "four", annotation: annotation({ page: 9, quoted: "a passage worth marking" }) },
    ]);

    expect([...orphans].sort()).toEqual(["four", "three"]);
    // Page 2 carries two marks and is read once; page 9 is not in the file and is not opened.
    expect(seen).toEqual([2, 3]);
  });
});
