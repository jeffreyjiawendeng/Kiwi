import { describe, expect, it } from "vitest";
import {
  editorPosition,
  richManuscript,
  selectedPassage,
  sourceManuscript,
  textOffset,
} from "./manuscript-anchors.js";

describe("manuscript anchors", () => {
  it("reads a LaTeX buffer as its own coordinates", () => {
    const manuscript = sourceManuscript("\\section{Bounds}\nThe bound is tight.");
    expect(manuscript.text).toBe("\\section{Bounds}\nThe bound is tight.");
    expect(editorPosition(manuscript, 17)).toBe(17);
    expect(textOffset(manuscript, 17)).toBe(17);
  });

  it("breaks between two paragraphs and not inside one", () => {
    // Two paragraphs: the first holds "the result" split by a bold mark, the second "Two".
    const manuscript = richManuscript([
      { text: "the ", pos: 1 },
      { text: "result", pos: 5 },
      { text: "Two", pos: 13 },
    ]);
    expect(manuscript.text).toBe("the result\nTwo");
  });

  it("puts an offset in the break at the end of the paragraph before it", () => {
    const manuscript = richManuscript([
      { text: "One", pos: 1 },
      { text: "Two", pos: 6 },
    ]);
    // The break itself: the end of "One" rather than the start of "Two".
    expect(editorPosition(manuscript, 3)).toBe(4);
    expect(editorPosition(manuscript, 4)).toBe(6);
    // And back again, from the position between the two paragraphs, which is in neither.
    expect(textOffset(manuscript, 5)).toBe(3);
  });

  it("takes the whitespace off the range and not only off the quotation", () => {
    const manuscript = sourceManuscript("The bound is tight.");
    // A selection dragged one word too far picks up the space before "is".
    expect(selectedPassage(manuscript, 3, 12)).toEqual({
      from: 4,
      to: 12,
      quote: "bound is",
    });
  });

  it("has nothing to comment on when nothing is selected", () => {
    const manuscript = sourceManuscript("The bound is tight.");
    expect(selectedPassage(manuscript, 7, 7)).toBeNull();
    expect(selectedPassage(manuscript, 3, 4)).toBeNull();
  });

  it("comments on the first two thousand characters of a longer selection", () => {
    const manuscript = sourceManuscript("x".repeat(3_000));
    const passage = selectedPassage(manuscript, 0, 3_000);
    expect(passage?.to).toBe(2_000);
    expect(passage?.quote).toHaveLength(2_000);
  });

  it("reads a selection given in the editor's positions", () => {
    const manuscript = richManuscript([
      { text: "One", pos: 1 },
      { text: "Two", pos: 6 },
    ]);
    expect(selectedPassage(manuscript, 6, 9)).toEqual({ from: 4, to: 7, quote: "Two" });
  });
});
