import { describe, expect, it } from "vitest";
import {
  addFold,
  applyFieldEdit,
  foldMarks,
  foldableRegions,
  foldedText,
  readEdit,
  regionAt,
  remapFolds,
  revealRange,
  toField,
  toSource,
  toggleFold,
  visibleSegments,
} from "./latex-folding.js";

/** Two sections, the first with a body under it. */
const PAPER = "\\section{Method}\nWe counted.\n\\section{Results}\nMore.\n";

/** What the field holds with these runs hidden. */
function shown(source: string, folds: Array<{ from: number; to: number }>): string {
  return foldedText(source, visibleSegments(source.length, folds));
}

describe("foldableRegions", () => {
  it("hides a section's body and leaves its heading line", () => {
    const regions = foldableRegions(PAPER);
    const method = regions.find((region) => region.label === "Method");
    expect(method?.kind).toBe("section");
    expect(PAPER.slice(method?.from, method?.to)).toBe("\nWe counted.");
  });

  it("leaves the newline in front of the next heading alone", () => {
    const method = foldableRegions(PAPER).find((region) => region.label === "Method");
    // Hiding it too would run two headings together on one line.
    expect(shown(PAPER, [{ from: method?.from ?? 0, to: method?.to ?? 0 }])).toBe(
      "\\section{Method}\n\\section{Results}\nMore.\n",
    );
  });

  it("hides what is between a begin and the end that closes it", () => {
    const source = "\\begin{proof}\nx\n\\end{proof}\n";
    const proof = foldableRegions(source)[0];
    expect(proof?.kind).toBe("environment");
    expect(proof?.label).toBe("proof");
    expect(shown(source, [{ from: proof?.from ?? 0, to: proof?.to ?? 0 }])).toBe(
      "\\begin{proof}\\end{proof}\n",
    );
  });

  it("does not offer a section with nothing under it", () => {
    expect(foldableRegions("\\section{A}\n\\section{B}\n")).toEqual([]);
  });

  it("does not offer an environment with nothing in it", () => {
    expect(foldableRegions("\\begin{a}\\end{a}")).toEqual([]);
  });
});

describe("regionAt", () => {
  const NESTED = "\\section{A}\n\\begin{proof}\nx\n\\end{proof}\n";

  it("gives the innermost region the caret is in", () => {
    const at = regionAt(foldableRegions(NESTED), NESTED.indexOf("x"));
    expect(at?.kind).toBe("environment");
  });

  it("counts the line a region opens on as part of it", () => {
    // Standing on \section{A} is how someone asks to fold the section under it.
    expect(regionAt(foldableRegions(NESTED), 3)?.kind).toBe("section");
  });

  it("gives nothing where nothing can be folded", () => {
    expect(regionAt(foldableRegions("plain words"), 4)).toBeNull();
  });
});

describe("hiding and showing runs", () => {
  it("folds a run, and opens it when asked again", () => {
    const run = { from: 16, to: 28 };
    const folded = toggleFold([], run);
    expect(folded).toEqual([run]);
    expect(toggleFold(folded, run)).toEqual([]);
  });

  it("opens a run that is only partly the one asked for", () => {
    // The run was measured against the source as it is now; the hidden one is a few keystrokes old.
    expect(toggleFold([{ from: 16, to: 28 }], { from: 16, to: 30 })).toEqual([]);
  });

  it("drops a run swallowed by a larger one", () => {
    expect(addFold([{ from: 20, to: 24 }], { from: 16, to: 28 })).toEqual([{ from: 16, to: 28 }]);
  });

  it("changes nothing when the run is already hidden inside another", () => {
    expect(addFold([{ from: 16, to: 28 }], { from: 20, to: 24 })).toEqual([{ from: 16, to: 28 }]);
  });

  it("opens whatever covers a range that has to be shown", () => {
    const folds = [
      { from: 16, to: 28 },
      { from: 46, to: 52 },
    ];
    expect(revealRange(folds, 20, 24)).toEqual([{ from: 46, to: 52 }]);
  });

  it("leaves a run alone when the range is beside it rather than inside it", () => {
    expect(revealRange([{ from: 16, to: 28 }], 16, 16)).toEqual([{ from: 16, to: 28 }]);
  });
});

describe("visibleSegments", () => {
  it("gives the whole buffer when nothing is hidden", () => {
    expect(visibleSegments(PAPER.length, [])).toEqual([{ from: 0, to: PAPER.length }]);
    expect(foldMarks(visibleSegments(PAPER.length, []))).toEqual([]);
  });

  it("cuts the hidden run out and marks where it was", () => {
    const segments = visibleSegments(PAPER.length, [{ from: 16, to: 28 }]);
    expect(segments).toEqual([
      { from: 0, to: 16 },
      { from: 28, to: PAPER.length },
    ]);
    expect(foldMarks(segments)).toEqual([16]);
  });

  it("does not run off the end of a buffer that has since been cut short", () => {
    expect(visibleSegments(10, [{ from: 16, to: 28 }])).toEqual([{ from: 0, to: 10 }]);
  });
});

describe("converting positions", () => {
  const SEGMENTS = visibleSegments(PAPER.length, [{ from: 16, to: 28 }]);

  it("reads a position inside a visible stretch straight through", () => {
    expect(toSource(SEGMENTS, 4, false)).toBe(4);
    expect(toSource(SEGMENTS, 20, false)).toBe(32);
  });

  it("gives both sides of a hidden run for the one position that stands for it", () => {
    expect(toSource(SEGMENTS, 16, false)).toBe(16);
    expect(toSource(SEGMENTS, 16, true)).toBe(28);
  });

  it("puts a source position back on screen, and a hidden one at the edge", () => {
    expect(toField(SEGMENTS, 4)).toBe(4);
    expect(toField(SEGMENTS, 32)).toBe(20);
    expect(toField(SEGMENTS, 22)).toBe(16);
  });
});

describe("readEdit", () => {
  it("finds a character that was typed", () => {
    expect(readEdit("abcd", "abXcd")).toEqual({ from: 2, to: 2, insert: "X" });
  });

  it("finds a stretch that was deleted", () => {
    expect(readEdit("abcd", "ad")).toEqual({ from: 1, to: 3, insert: "" });
  });

  it("finds a stretch that was replaced", () => {
    expect(readEdit("the cat", "the hat")).toEqual({ from: 4, to: 5, insert: "h" });
  });

  it("finds nothing when nothing changed", () => {
    expect(readEdit("abc", "abc").insert).toBe("");
  });
});

describe("remapFolds", () => {
  it("moves a run that sits after the edit", () => {
    expect(remapFolds([{ from: 16, to: 28 }], { from: 4, to: 4, insert: "xx" })).toEqual([
      { from: 18, to: 30 },
    ]);
  });

  it("leaves a run that sits before it", () => {
    expect(remapFolds([{ from: 16, to: 28 }], { from: 40, to: 40, insert: "x" })).toEqual([
      { from: 16, to: 28 },
    ]);
  });

  it("opens a run the edit reached inside of", () => {
    // Its ends could be moved, but what it hid is no longer what it hid.
    expect(remapFolds([{ from: 16, to: 28 }], { from: 20, to: 24, insert: "" })).toEqual([]);
  });
});

describe("applyFieldEdit", () => {
  const FOLDS = [{ from: 16, to: 28 }];
  const SHOWN = shown(PAPER, FOLDS);

  it("puts typing at the marker in front of the hidden run", () => {
    const typed = `${SHOWN.slice(0, 16)}!${SHOWN.slice(16)}`;
    const outcome = applyFieldEdit(PAPER, FOLDS, typed);
    expect(outcome.source).toBe("\\section{Method}!\nWe counted.\n\\section{Results}\nMore.\n");
    // What the field now holds is what was typed into it, or the caret would jump.
    expect(shown(outcome.source, outcome.folds)).toBe(typed);
  });

  it("deletes the character after the marker rather than the run behind it", () => {
    const cut = SHOWN.slice(0, 16) + SHOWN.slice(17);
    const outcome = applyFieldEdit(PAPER, FOLDS, cut);
    expect(outcome.source).toBe("\\section{Method}\nWe counted.\\section{Results}\nMore.\n");
    expect(outcome.folds).toEqual(FOLDS);
    expect(shown(outcome.source, outcome.folds)).toBe(cut);
  });

  it("deletes what a run hid when the selection was dragged across the marker", () => {
    // That one was asked for: the marker was inside what was selected.
    const cut = SHOWN.slice(0, 8) + SHOWN.slice(20);
    const outcome = applyFieldEdit(PAPER, FOLDS, cut);
    expect(outcome.source).toBe("\\sectionction{Results}\nMore.\n");
    expect(outcome.folds).toEqual([]);
    expect(shown(outcome.source, outcome.folds)).toBe(cut);
  });

  it("is the plain edit when nothing is hidden", () => {
    expect(applyFieldEdit("the cat", [], "the hat")).toEqual({ source: "the hat", folds: [] });
  });
});
