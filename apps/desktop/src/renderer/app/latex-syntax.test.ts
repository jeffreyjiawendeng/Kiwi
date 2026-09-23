import { describe, expect, it } from "vitest";
import {
  delimiterPairs,
  environmentPairs,
  highlightSpans,
  matchDelimiters,
  tokenizeLatex,
  type SyntaxToken,
} from "./latex-syntax.js";

/** What a token covers, which is what the editor paints and what these tests read. */
function text(source: string, token: SyntaxToken | undefined): string {
  return token === undefined ? "" : source.slice(token.from, token.to);
}

function painted(source: string, kind: string): string[] {
  return tokenizeLatex(source)
    .filter((token) => token.kind === kind)
    .map((token) => text(source, token));
}

describe("tokenizeLatex", () => {
  it("reads a command as its name, and not the brace after it", () => {
    const source = "\\section{Method}";
    expect(painted(source, "command")).toEqual(["\\section"]);
    expect(painted(source, "brace")).toEqual(["{", "}"]);
  });

  it("keeps the star on a starred command", () => {
    expect(painted("\\section*{Method}", "command")).toEqual(["\\section*"]);
  });

  it("reads an escaped character as two characters, not as a word", () => {
    expect(painted("100\\% of \\$3", "command")).toEqual(["\\%", "\\$"]);
  });

  it("names the environment inside \\begin and \\end", () => {
    expect(painted("\\begin{proof}\nx\n\\end{proof}", "environment")).toEqual(["proof", "proof"]);
  });

  it("does not read a name that has not been typed yet", () => {
    expect(painted("\\begin\n{proof}", "environment")).toEqual([]);
  });

  it("takes a comment to the end of its line and no further", () => {
    expect(painted("a % note\n\\emph{b}", "comment")).toEqual(["% note"]);
    expect(painted("a % note\n\\emph{b}", "command")).toEqual(["\\emph"]);
  });

  it("is not fooled by an escaped per cent sign", () => {
    expect(painted("50\\% real\n", "comment")).toEqual([]);
  });

  it("reads inline and display maths", () => {
    expect(painted("$x$ and $$y$$", "math")).toEqual(["$x$", "$$y$$"]);
  });

  it("reads \\[ and \\( as maths", () => {
    expect(painted("\\[x\\] \\(y\\)", "math")).toEqual(["\\[x\\]", "\\(y\\)"]);
  });

  it("does not let an escaped dollar close maths", () => {
    expect(painted("$a \\$ b$ rest", "math")).toEqual(["$a \\$ b$"]);
  });

  it("colours maths whole, commands inside it included", () => {
    expect(painted("$\\alpha$", "command")).toEqual([]);
    expect(painted("$\\alpha$", "math")).toEqual(["$\\alpha$"]);
  });

  it("runs an unclosed maths to the end rather than giving up", () => {
    expect(painted("text $x + 1", "math")).toEqual(["$x + 1"]);
  });

  it("covers the buffer in order and without overlapping", () => {
    const source = "\\emph{a} % b\n$c$";
    let at = 0;
    for (const token of tokenizeLatex(source)) {
      expect(token.from).toBeGreaterThanOrEqual(at);
      expect(token.to).toBeGreaterThan(token.from);
      at = token.to;
    }
    expect(at).toBeLessThanOrEqual(source.length);
  });
});

describe("delimiterPairs", () => {
  it("pairs the innermost braces first", () => {
    const source = "\\frac{a}{b}";
    expect(delimiterPairs(source)).toEqual([
      { open: 5, close: 7 },
      { open: 8, close: 10 },
    ]);
  });

  it("pairs a brace with the one that closes it, not the next one", () => {
    const source = "{a{b}}";
    expect(delimiterPairs(source)).toEqual([
      { open: 2, close: 4 },
      { open: 0, close: 5 },
    ]);
  });

  it("pairs square brackets separately from braces", () => {
    const source = "\\cite[p. 3]{key}";
    const pairs = delimiterPairs(source);
    expect(pairs).toContainEqual({ open: 5, close: 10 });
    expect(pairs).toContainEqual({ open: 11, close: 15 });
  });

  it("ignores an escaped brace", () => {
    expect(delimiterPairs("\\{a\\}")).toEqual([]);
  });

  it("ignores a brace in a comment", () => {
    expect(delimiterPairs("% {\n")).toEqual([]);
  });

  it("leaves a brace that never closes out of the list", () => {
    expect(delimiterPairs("{a")).toEqual([]);
  });
});

describe("environmentPairs", () => {
  it("pairs a begin with the end that closes it", () => {
    const source = "\\begin{proof}\nx\n\\end{proof}\n";
    const pairs = environmentPairs(source);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.name).toBe("proof");
    expect(source.slice(pairs[0]?.begin.from, pairs[0]?.begin.to)).toBe("\\begin{proof}");
    expect(source.slice(pairs[0]?.end.from, pairs[0]?.end.to)).toBe("\\end{proof}");
  });

  it("pairs nested environments innermost first", () => {
    const source = "\\begin{a}\\begin{b}\\end{b}\\end{a}";
    expect(environmentPairs(source).map((pair) => pair.name)).toEqual(["b", "a"]);
  });

  it("does not close an environment with an end that names another", () => {
    expect(environmentPairs("\\begin{a}\\end{b}")).toEqual([]);
  });

  it("ignores a begin that is commented out", () => {
    expect(environmentPairs("% \\begin{a}\n\\end{a}")).toEqual([]);
  });
});

describe("matchDelimiters", () => {
  it("marks the brace behind the caret and the one it pairs with", () => {
    const source = "\\frac{a}{b}";
    expect(matchDelimiters(source, 8)).toEqual([
      { from: 5, to: 6 },
      { from: 7, to: 8 },
    ]);
  });

  it("marks the brace the caret sits in front of", () => {
    expect(matchDelimiters("{a}", 0)).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ]);
  });

  it("marks nothing away from a delimiter", () => {
    expect(matchDelimiters("\\frac{a}{b}", 2)).toBeNull();
  });

  it("marks nothing for a brace that never closes", () => {
    expect(matchDelimiters("{a", 1)).toBeNull();
  });

  it("marks both ends of an environment from anywhere in its name", () => {
    const source = "\\begin{proof}\nx\n\\end{proof}\n";
    const marks = matchDelimiters(source, 9);
    expect(marks?.[0]).toEqual({ from: 0, to: 13 });
    expect(source.slice(marks?.[1].from, marks?.[1].to)).toBe("\\end{proof}");
  });

  it("marks the environment from the end as well", () => {
    const source = "\\begin{proof}\nx\n\\end{proof}\n";
    expect(matchDelimiters(source, 20)?.[0]).toEqual({ from: 0, to: 13 });
  });
});

describe("highlightSpans", () => {
  it("covers the source exactly", () => {
    const source = "\\section{Method}\nWe counted. % 3\n$x$\n";
    const spans = highlightSpans(source, null);
    expect(spans.map((span) => span.text).join("")).toBe(source);
  });

  it("joins neighbours that would be painted the same way", () => {
    const spans = highlightSpans("plain words here", null);
    expect(spans).toEqual([{ text: "plain words here", kind: null, match: false }]);
  });

  it("says what each stretch is", () => {
    const spans = highlightSpans("\\emph{a} % b", null);
    expect(spans.map((span) => [span.kind, span.text])).toEqual([
      ["command", "\\emph"],
      ["brace", "{"],
      [null, "a"],
      ["brace", "}"],
      [null, " "],
      ["comment", "% b"],
    ]);
  });

  it("marks the pair the caret is on and nothing else", () => {
    const marked = highlightSpans("{a}", 0)
      .filter((span) => span.match)
      .map((span) => span.text);
    expect(marked).toEqual(["{", "}"]);
  });

  it("marks nothing when the caret is away from the field", () => {
    expect(highlightSpans("{a}", null).some((span) => span.match)).toBe(false);
  });

  it("cuts a stretch in two when only part of it is marked", () => {
    const source = "\\begin{a}\n\\end{a}";
    const spans = highlightSpans(source, 3);
    expect(spans.map((span) => span.text).join("")).toBe(source);
    expect(
      spans
        .filter((span) => span.match)
        .map((span) => span.text)
        .join(""),
    ).toBe("\\begin{a}\\end{a}");
  });

  it("paints an empty buffer as nothing", () => {
    expect(highlightSpans("", null)).toEqual([]);
  });
});
