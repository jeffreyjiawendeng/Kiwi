import { describe, expect, it } from "vitest";
import {
  buildOutline,
  latexBlocks,
  moveInText,
  planMove,
  planStep,
  type OutlineBlock,
  type SectionMove,
} from "./outline.js";

/** A move the test expects to exist, so a plan that came back null fails where it happened. */
function planned(plan: SectionMove | null): SectionMove {
  if (plan === null) throw new Error("expected a move");
  return plan;
}

/** Blocks laid out end to end, the way both editors report them. */
function blocks(...parts: Array<[level: number | null, text: string]>): OutlineBlock[] {
  let at = 0;
  return parts.map(([level, text]) => {
    const from = at;
    at += text.length + 2;
    return { level, text, from, to: at };
  });
}

describe("buildOutline", () => {
  it("ends a section at the next heading of the same level", () => {
    const outline = buildOutline(
      blocks([1, "Method"], [null, "We counted them."], [1, "Results"], [null, "There were six."]),
    );

    expect(outline.map((heading) => heading.title)).toEqual(["Method", "Results"]);
    expect(outline[0]?.to).toBe(outline[1]?.from);
  });

  it("keeps a section's subsections inside it", () => {
    // The whole reason the extent is worked out: dragging Method has to take Participants with it.
    const outline = buildOutline(
      blocks(
        [1, "Method"],
        [2, "Participants"],
        [null, "Sixty."],
        [2, "Procedure"],
        [null, "Twice."],
        [1, "Results"],
      ),
    );

    const method = outline[0];
    const results = outline[3];
    expect(method?.to).toBe(results?.from);
    expect(outline[1]?.to).toBe(outline[2]?.from);
  });

  it("ends a subsection at a heading above it", () => {
    const outline = buildOutline(blocks([2, "Procedure"], [null, "Twice."], [1, "Results"]));

    expect(outline[0]?.to).toBe(outline[1]?.from);
  });

  it("runs the last section to the end of the manuscript", () => {
    const parts = blocks([1, "Method"], [null, "We counted them."]);

    expect(buildOutline(parts)[0]?.to).toBe(parts[1]?.to);
  });

  it("counts the words under a heading, its subsections included", () => {
    const outline = buildOutline(
      blocks([1, "Method"], [null, "One two three"], [2, "Participants"], [null, "four five"]),
    );

    // The headings themselves are not prose, so "Method" is not a word of the Method section.
    expect(outline[0]?.words).toBe(5);
    expect(outline[1]?.words).toBe(2);
  });

  it("has nothing to say about a manuscript without headings", () => {
    expect(buildOutline(blocks([null, "Just prose."]))).toEqual([]);
  });
});

describe("latexBlocks", () => {
  it("reads the sectioning commands", () => {
    const outline = buildOutline(
      latexBlocks("\\section{Method}\nWe counted them.\n\\subsection{Participants}\nSixty.\n"),
    );

    expect(outline.map((heading) => [heading.level, heading.title])).toEqual([
      [1, "Method"],
      [2, "Participants"],
    ]);
  });

  it("reads a title through the commands that dressed it up", () => {
    const outline = buildOutline(latexBlocks("\\subsubsection*{The \\emph{first} attempt}\n"));

    expect(outline[0]?.title).toBe("The first attempt");
    expect(outline[0]?.level).toBe(3);
  });

  it("takes the short title a heading was given for the running head", () => {
    const outline = buildOutline(latexBlocks("\\section[Method]{What we did and why}\n"));

    expect(outline[0]?.title).toBe("What we did and why");
  });

  it("does not list a section that has been commented out", () => {
    // A line the writer has already decided is not part of the paper.
    const outline = buildOutline(latexBlocks("% \\section{Abandoned}\n\\section{Method}\n"));

    expect(outline.map((heading) => heading.title)).toEqual(["Method"]);
  });

  it("is not thrown by a percent sign that is text", () => {
    const outline = buildOutline(latexBlocks("Ninety \\% of them. \\section{Method}\n"));

    expect(outline.map((heading) => heading.title)).toEqual(["Method"]);
  });

  it("waits for a title whose brace has not been closed yet", () => {
    expect(buildOutline(latexBlocks("\\section{Half typed"))).toEqual([]);
  });

  it("gives a section the source that follows it", () => {
    const source = "\\section{Method}\nWe counted them.\n\\section{Results}\nSix.\n";
    const outline = buildOutline(latexBlocks(source));

    expect(source.slice(outline[0]?.from, outline[0]?.to)).toBe(
      "\\section{Method}\nWe counted them.\n",
    );
  });
});

describe("planMove", () => {
  const outline = buildOutline(
    blocks(
      [1, "Method"],
      [2, "Participants"],
      [null, "Sixty."],
      [1, "Results"],
      [null, "Six."],
      [1, "Discussion"],
    ),
  );

  it("puts a section dropped lower down after everything the target holds", () => {
    // Dropping Method on Results has to clear Results' own contents, or it lands in the middle
    // of the section it was dropped on.
    const plan = planMove(outline, 0, 2);

    expect(plan).toEqual({ from: outline[0]?.from, to: outline[0]?.to, at: outline[2]?.to });
  });

  it("puts a section dropped higher up in front of the target", () => {
    const plan = planMove(outline, 3, 0);

    expect(plan?.at).toBe(outline[0]?.from);
  });

  it("refuses to move a section inside itself", () => {
    expect(planMove(outline, 0, 1)).toBeNull();
  });

  it("has nothing to do when a section is dropped on itself", () => {
    expect(planMove(outline, 2, 2)).toBeNull();
  });
});

describe("planStep", () => {
  const outline = buildOutline(
    blocks([1, "Method"], [2, "Participants"], [null, "Sixty."], [1, "Results"], [null, "Six."]),
  );

  it("steps a section over the whole of the next one", () => {
    // Not over the next heading, which is this section's own subsection.
    expect(planStep(outline, 0, 1)?.at).toBe(outline[2]?.to);
  });

  it("steps a section in front of the one above it", () => {
    expect(planStep(outline, 2, -1)?.at).toBe(outline[1]?.from);
  });

  it("does not step the last section any further down", () => {
    expect(planStep(outline, 2, 1)).toBeNull();
  });

  it("does not step the first section any further up", () => {
    expect(planStep(outline, 0, -1)).toBeNull();
  });
});

describe("moveInText", () => {
  const source = "\\section{Method}\nWe counted.\n\\section{Results}\nSix.\n";

  const outline = buildOutline(latexBlocks(source));
  const swapped = "\\section{Results}\nSix.\n\\section{Method}\nWe counted.\n";

  it("moves a section down without losing what it passed", () => {
    expect(moveInText(source, planned(planMove(outline, 0, 1)))).toBe(swapped);
  });

  it("moves a section up", () => {
    expect(moveInText(source, planned(planMove(outline, 1, 0)))).toBe(swapped);
  });

  it("leaves the manuscript's own length alone", () => {
    expect(moveInText(source, planned(planMove(outline, 0, 1)))).toHaveLength(source.length);
  });
});
