import { describe, expect, it } from "vitest";

import type { RichDocument } from "./document.js";
import {
  endOfManuscript,
  insertInDocument,
  insertInSource,
  latexHeadings,
  latexSections,
  manuscriptSections,
  richSections,
  sectionNamed,
} from "./manuscript-sections.js";

function heading(level: number, text: string): RichDocument["content"][number] {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function paragraph(text: string): RichDocument["content"][number] {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function manuscript(...blocks: RichDocument["content"]): RichDocument {
  return { type: "doc", content: blocks };
}

const LATEX = [
  "\\section{Introduction}",
  "Reading is iterative.",
  "",
  "\\subsection{Prior work}",
  "Others have said so.",
  "",
  "\\section{Method}",
  "We did the thing.",
].join("\n");

describe("the sections of a manuscript", () => {
  it("ends a section at the next heading of the same or a higher level", () => {
    // Prior work belongs to Introduction, so a passage sent to Introduction must land after it
    // rather than in front of a subsection that is part of the same section.
    const sections = richSections(
      manuscript(
        heading(1, "Introduction"),
        paragraph("Reading is iterative."),
        heading(2, "Prior work"),
        paragraph("Others have said so."),
        heading(1, "Method"),
        paragraph("We did the thing."),
      ),
    );

    expect(sections.map((section) => [section.title, section.end])).toEqual([
      ["Introduction", 4],
      ["Prior work", 4],
      ["Method", 6],
    ]);
  });

  it("reads the same sections out of a LaTeX manuscript", () => {
    expect(latexSections(LATEX).map((section) => section.title)).toEqual([
      "Introduction",
      "Prior work",
      "Method",
    ]);
    expect(latexSections(LATEX)[2]?.end).toBe(LATEX.length);
  });

  it("leaves out a heading that has been commented away", () => {
    // A writer who commented out a section has already decided it is not part of the paper.
    expect(latexHeadings("% \\section{Cut for length}\n\\section{Method}").map((h) => h.title)) //
      .toEqual(["Method"]);
  });

  it("has no sections when nothing has a heading yet", () => {
    expect(richSections(manuscript(paragraph("Just prose so far.")))).toEqual([]);
    expect(manuscriptSections("latex", null, "No headings here.")).toEqual([]);
  });

  it("finds a section by the name that was read off the list", () => {
    const sections = latexSections(LATEX);

    expect(sectionNamed(sections, " Method ")?.level).toBe(1);
    expect(sectionNamed(sections, "Results")).toBeNull();
  });

  it("puts the end of the whole manuscript where a passage with no section goes", () => {
    expect(endOfManuscript("rich", manuscript(heading(1, "Method"), paragraph("Done.")), "")).toBe(
      2,
    );
    expect(endOfManuscript("latex", null, LATEX)).toBe(LATEX.length);
  });
});

describe("writing a passage into a section", () => {
  it("puts blocks at the end of the section and not at the end of the manuscript", () => {
    const document = manuscript(
      heading(1, "Introduction"),
      paragraph("Reading is iterative."),
      heading(1, "Method"),
    );
    const section = richSections(document)[0];

    const written = insertInDocument(document, section?.end ?? 0, [paragraph("Quoted.")]);

    expect(written.content.map((block) => block.content?.[0]?.text ?? "")).toEqual([
      "Introduction",
      "Reading is iterative.",
      "Quoted.",
      "Method",
    ]);
  });

  it("keeps a blank line between the passage and the heading that follows it", () => {
    const written = insertInSource(LATEX, latexSections(LATEX)[0]?.end ?? 0, "\\begin{quote}x");

    expect(written).toContain("Others have said so.\n\n\\begin{quote}x\n\n\\section{Method}");
  });

  it("ends the manuscript with a newline when the passage goes last", () => {
    expect(insertInSource("Prose.", 6, "Quoted.")).toBe("Prose.\n\nQuoted.\n");
  });
});
