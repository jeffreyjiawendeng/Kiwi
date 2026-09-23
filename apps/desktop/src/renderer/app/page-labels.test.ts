import { describe, expect, it } from "vitest";
import { findPageByLabel, labelsDifferFromPositions } from "./page-labels.js";

/** A thesis: four pages of front matter numbered in roman, then the body starting again at 1. */
const THESIS = ["i", "ii", "iii", "iv", "1", "2", "3"];

describe("finding a page by what is printed on it", () => {
  it("prefers the printed label over the position in the file", () => {
    // The whole point. "iv" is the fourth roman page, not the fourth page of the body, and
    // "1" is where the body starts rather than the cover.
    expect(findPageByLabel(THESIS, "iv")).toBe(4);
    expect(findPageByLabel(THESIS, "1")).toBe(5);
    expect(findPageByLabel(THESIS, "3")).toBe(7);
  });

  it("ignores case and surrounding space", () => {
    expect(findPageByLabel(THESIS, "IV")).toBe(4);
    expect(findPageByLabel(THESIS, "  ii  ")).toBe(2);
  });

  it("falls back to the position in the file when nothing is printed like that", () => {
    // Plates and blank versos print nothing, so the position is the only number anybody has.
    expect(findPageByLabel(["cover", "", "", "1"], "2")).toBe(2);
  });

  it("refuses a page the document does not have", () => {
    expect(findPageByLabel(THESIS, "xiv")).toBeNull();
    expect(findPageByLabel(THESIS, "900")).toBeNull();
    expect(findPageByLabel(THESIS, "0")).toBeNull();
    expect(findPageByLabel(THESIS, "12a")).toBeNull();
    expect(findPageByLabel(THESIS, "   ")).toBeNull();
    expect(findPageByLabel([], "1")).toBeNull();
  });

  it("sends a repeated label to the first page carrying it", () => {
    // Some documents restart at 1 more than once. Counting forwards from the front finds the
    // first, so that is where typing it goes.
    expect(findPageByLabel(["1", "2", "1", "2"], "1")).toBe(1);
  });
});

describe("telling a labelled document from a plain one", () => {
  it("says nothing extra is worth showing when the labels are the positions", () => {
    expect(labelsDifferFromPositions(["1", "2", "3"])).toBe(false);
    expect(labelsDifferFromPositions([])).toBe(false);
  });

  it("notices a document that numbers itself", () => {
    expect(labelsDifferFromPositions(THESIS)).toBe(true);
    // One offset page is enough: an article whose first page is 481 is numbered, not plain.
    expect(labelsDifferFromPositions(["481", "482"])).toBe(true);
  });
});
