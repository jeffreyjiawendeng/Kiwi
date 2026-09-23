import { describe, expect, it } from "vitest";
import {
  collectMatches,
  findMatches,
  matchSummary,
  replaceAllMatches,
  replaceMatch,
  type FindOptions,
} from "./find-replace.js";

const PLAIN: FindOptions = { caseSensitive: false, wholeWord: false };

describe("findMatches", () => {
  it("finds every occurrence, in order", () => {
    expect(findMatches("the cat and the hat", "the", PLAIN)).toEqual([
      { start: 0, end: 3 },
      { start: 12, end: 15 },
    ]);
  });

  it("ignores case unless asked not to", () => {
    expect(findMatches("The the THE", "the", PLAIN)).toHaveLength(3);
    expect(findMatches("The the THE", "the", { ...PLAIN, caseSensitive: true })).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it("takes the query literally rather than as a pattern", () => {
    // A researcher searching for "p < .05" or "H(x)" is not writing a regular expression, and a
    // search that treats it as one either finds nothing or finds the wrong thing.
    expect(findMatches("p < .05 held", "p < .05", PLAIN)).toEqual([{ start: 0, end: 7 }]);
    expect(findMatches("H(x) and Hax", "H(x)", PLAIN)).toEqual([{ start: 0, end: 4 }]);
  });

  it("skips a whole-word match that is only part of a longer word", () => {
    const whole = { ...PLAIN, wholeWord: true };
    expect(findMatches("there the theory", "the", whole)).toEqual([{ start: 6, end: 9 }]);
  });

  it("keeps looking after rejecting one that is not a whole word", () => {
    // Advancing past the rejected run instead of one character along would hide the real match
    // that begins inside it.
    expect(findMatches("thethe the", "the", { ...PLAIN, wholeWord: true })).toEqual([
      { start: 7, end: 10 },
    ]);
  });

  it("treats punctuation as the end of a word", () => {
    expect(findMatches("the, end", "the", { ...PLAIN, wholeWord: true })).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("finds nothing for an empty query", () => {
    // Otherwise every position in the document is a match, and replace-all rewrites the whole
    // manuscript.
    expect(findMatches("anything", "", PLAIN)).toEqual([]);
  });

  it("does not report overlapping matches", () => {
    // Replacing one destroys the other, so counting both promises a replace-all that cannot
    // happen.
    expect(findMatches("aaaa", "aa", PLAIN)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("collectMatches", () => {
  it("reports positions in the document, not in the text node", () => {
    const runs = [
      { text: "the cat", pos: 1 },
      { text: "the hat", pos: 20 },
    ];
    expect(collectMatches(runs, "the", PLAIN)).toEqual([
      { from: 1, to: 4 },
      { from: 20, to: 23 },
    ]);
  });

  it("does not match across a change of formatting", () => {
    // "the result" split by a bold run is two text nodes. Replacing across them would have to
    // choose which formatting the replacement keeps.
    const runs = [
      { text: "the ", pos: 1 },
      { text: "result", pos: 5 },
    ];
    expect(collectMatches(runs, "the result", PLAIN)).toEqual([]);
  });
});

describe("replaceMatch", () => {
  it("swaps one match and leaves the rest alone", () => {
    expect(replaceMatch("the cat and the hat", { start: 12, end: 15 }, "a")).toBe(
      "the cat and a hat",
    );
  });
});

describe("replaceAllMatches", () => {
  it("swaps every match and says how many", () => {
    expect(replaceAllMatches("the cat and the hat", "the", "a", PLAIN)).toEqual({
      text: "a cat and a hat",
      replaced: 2,
    });
  });

  it("is not confused by a replacement longer than what it replaced", () => {
    // Built back to front, so an earlier replacement cannot shift a later match.
    expect(replaceAllMatches("a a a", "a", "aaa", PLAIN).text).toBe("aaa aaa aaa");
  });

  it("does not find its own replacement", () => {
    expect(replaceAllMatches("cat", "cat", "cat cat", PLAIN)).toEqual({
      text: "cat cat",
      replaced: 1,
    });
  });

  it("deletes when the replacement is empty", () => {
    expect(replaceAllMatches("a very very long word", "very ", "", PLAIN).text).toBe("a long word");
  });

  it("changes nothing when nothing matches", () => {
    expect(replaceAllMatches("the cat", "dog", "wolf", PLAIN)).toEqual({
      text: "the cat",
      replaced: 0,
    });
  });
});

describe("matchSummary", () => {
  it("counts from one, the way a person does", () => {
    expect(matchSummary(3, 0)).toBe("1 of 3");
  });

  it("says so when there are none", () => {
    expect(matchSummary(0, 0)).toBe("No matches");
  });
});
