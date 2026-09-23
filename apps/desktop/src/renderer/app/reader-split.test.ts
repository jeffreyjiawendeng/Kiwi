import { describe, expect, it } from "vitest";
import { clampShare, companionFor, documentMoved, splitAfter } from "./reader-split.js";

const OPEN = ["paper-a", "paper-b", "paper-c"];

describe("choosing what to compare against", () => {
  it("takes whatever was being read a moment ago", () => {
    expect(companionFor(OPEN, "paper-c", "paper-a")).toBe("paper-a");
  });

  it("takes the most recently opened tab when there is no such document", () => {
    expect(companionFor(OPEN, "paper-a", null)).toBe("paper-c");
    // The last thing read is this document itself, which is not a comparison.
    expect(companionFor(OPEN, "paper-a", "paper-a")).toBe("paper-c");
    // It was read, and then it was closed.
    expect(companionFor(OPEN, "paper-a", "paper-gone")).toBe("paper-c");
  });

  it("has nothing to offer when only one document is open", () => {
    expect(companionFor(["paper-a"], "paper-a", null)).toBeNull();
    expect(companionFor([], "paper-a", null)).toBeNull();
  });
});

describe("keeping the two sides honest as the tabs change", () => {
  it("leaves a comparison alone while both documents stay open", () => {
    expect(splitAfter("paper-b", "paper-a", "paper-b", OPEN)).toBe("paper-b");
  });

  it("says nothing is on the right when nothing was", () => {
    expect(splitAfter(null, "paper-a", "paper-b", OPEN)).toBeNull();
  });

  it("swaps the sides when the compared document's own tab is selected", () => {
    // The reader clicked the tab of the paper on the right. It moves to the left, and the paper
    // that was on the left keeps it company rather than disappearing.
    expect(splitAfter("paper-b", "paper-b", "paper-a", OPEN)).toBe("paper-a");
  });

  it("closes the comparison when the compared document is closed", () => {
    expect(splitAfter("paper-b", "paper-a", "paper-b", ["paper-a", "paper-c"])).toBeNull();
  });

  it("closes the comparison when a swap has nothing to swap with", () => {
    // Its tab was selected, but the document that was beside it has since been closed. There is
    // no second document left, so there is no comparison.
    expect(splitAfter("paper-b", "paper-b", "paper-a", ["paper-b", "paper-c"])).toBeNull();
    expect(splitAfter("paper-b", "paper-b", null, ["paper-b"])).toBeNull();
  });
});

describe("how the width is divided", () => {
  it("keeps both sides readable", () => {
    expect(clampShare(0.5)).toBe(0.5);
    expect(clampShare(0.95)).toBe(0.8);
    expect(clampShare(0)).toBe(0.2);
  });

  it("falls back to an even split when the width is not a number", () => {
    // A pointer drag divides by the width of the panes, which is zero before they are laid out.
    expect(clampShare(Number.NaN)).toBe(0.5);
  });
});

describe("moving a document into a window of its own", () => {
  it("lets the tab go with a document that has somewhere to be", () => {
    expect(documentMoved({ status: "committed" } as { error?: unknown })).toBe(true);
    // The window that already had it, brought forward. The document is still out of this one.
    expect(documentMoved(null)).toBe(true);
  });

  it("keeps the tab when the detach was refused", () => {
    // Closing it would take the document away without putting it anywhere.
    expect(documentMoved({ error: { code: "KIWI_FORBIDDEN", message: "Open a workspace." } })).toBe(
      false,
    );
  });
});
