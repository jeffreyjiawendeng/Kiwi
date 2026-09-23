import { describe, expect, it } from "vitest";
import {
  compileFailed,
  documentCitationCounts,
  documentCitations,
  documentFigures,
  documentToLatex,
  escapeLatex,
  latexFileName,
  parseLatexLog,
} from "./latex.js";

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

describe("escapeLatex", () => {
  it("escapes the character that silently deletes half a sentence", () => {
    // An unescaped % comments out the rest of the line. The paper still compiles and the
    // missing half is only noticed by reading the PDF.
    expect(escapeLatex("50% of samples")).toBe("50\\% of samples");
  });

  it("escapes every character TeX treats as syntax", () => {
    expect(escapeLatex("&")).toBe("\\&");
    expect(escapeLatex("$")).toBe("\\$");
    expect(escapeLatex("#")).toBe("\\#");
    expect(escapeLatex("_")).toBe("\\_");
    expect(escapeLatex("{}")).toBe("\\{\\}");
    expect(escapeLatex("~")).toBe("\\textasciitilde{}");
    expect(escapeLatex("^")).toBe("\\textasciicircum{}");
    expect(escapeLatex("\\")).toBe("\\textbackslash{}");
  });

  it("leaves ordinary prose alone", () => {
    expect(escapeLatex("We sampled twelve sites in 2024.")).toBe(
      "We sampled twelve sites in 2024.",
    );
  });
});

describe("documentToLatex", () => {
  it("produces a document that could be compiled as it stands", () => {
    const source = documentToLatex(doc(paragraph("Hello.")), { title: "A paper" });
    expect(source).toContain("\\documentclass");
    expect(source).toContain("\\begin{document}");
    expect(source).toContain("\\end{document}");
    expect(source).toContain("\\maketitle");
  });

  it("turns headings into sections at the right depth", () => {
    const source = documentToLatex(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Method" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Sampling" }] },
      ),
    );
    expect(source).toContain("\\section{Method}");
    expect(source).toContain("\\subsection{Sampling}");
  });

  it("carries formatting through", () => {
    const source = documentToLatex(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "very ", marks: [] },
          { type: "text", text: "important", marks: [{ type: "bold" }] },
          { type: "text", text: " and ", marks: [] },
          { type: "text", text: "noted", marks: [{ type: "italic" }] },
        ],
      }),
    );
    expect(source).toContain("\\textbf{important}");
    expect(source).toContain("\\textit{noted}");
  });

  it("raises and lowers text", () => {
    // A footnote marker or an ion that flattens on export is wrong in a way nobody reads back.
    const source = documentToLatex(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "H", marks: [] },
          { type: "text", text: "2", marks: [{ type: "subscript" }] },
          { type: "text", text: "O", marks: [] },
          { type: "text", text: "1", marks: [{ type: "superscript" }] },
        ],
      }),
    );
    expect(source).toContain("\\textsubscript{2}");
    expect(source).toContain("\\textsuperscript{1}");
  });

  it("nests marks rather than losing the inner one", () => {
    const source = documentToLatex(
      doc({
        type: "paragraph",
        content: [{ type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] }],
      }),
    );
    expect(source).toContain("\\textbf{\\textit{both}}");
  });

  it("writes lists as the environments a reader expects", () => {
    const source = documentToLatex(
      doc(
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph("first")] }],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [paragraph("second")] }],
        },
      ),
    );
    expect(source).toContain("\\begin{itemize}");
    expect(source).toContain("\\item first");
    expect(source).toContain("\\begin{enumerate}");
  });

  it("writes inline maths as maths, not as escaped text", () => {
    const source = documentToLatex(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "where " },
          { type: "mathInline", attrs: { latex: "\\alpha_i > 0" } },
        ],
      }),
    );
    // The whole point of a maths node is that its content is not escaped.
    expect(source).toContain("$\\alpha_i > 0$");
  });

  it("writes a display equation, matrices included", () => {
    const source = documentToLatex(
      doc({
        type: "mathBlock",
        attrs: { latex: "A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}" },
      }),
    );
    expect(source).toContain("\\[");
    expect(source).toContain("\\begin{pmatrix}");
  });

  it("writes an image as a figure the compiler can find", () => {
    const source = documentToLatex(
      doc({
        type: "image",
        attrs: { src: "kiwi-asset://workspace-1/asset-abc", alt: "Site map" },
      }),
    );
    expect(source).toContain("\\begin{figure}");
    expect(source).toContain("\\includegraphics[width=\\linewidth]{figure-asset-abc}");
    expect(source).toContain("\\caption{Site map}");
  });

  it("skips an image it cannot name rather than emitting broken source", () => {
    const source = documentToLatex(
      doc({ type: "image", attrs: { src: "https://example.test/a.png" } }),
    );
    expect(source).not.toContain("includegraphics");
  });

  it("writes a table as a tabular with the right column count", () => {
    const cell = (text: string) => ({ type: "tableCell", content: [paragraph(text)] });
    const source = documentToLatex(
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [cell("site"), cell("count")] },
          { type: "tableRow", content: [cell("north"), cell("12")] },
        ],
      }),
    );
    expect(source).toContain("\\begin{tabular}{l l}");
    expect(source).toContain("site & count");
    expect(source).toContain("north & 12");
  });

  it("names the author when there is one", () => {
    const source = documentToLatex(doc(paragraph("text")), {
      title: "A paper",
      authors: ["Deng, Jeffrey"],
    });
    expect(source).toContain("\\author{Deng, Jeffrey}");
  });

  it("uses inputenc for pdflatex and fontspec otherwise", () => {
    expect(documentToLatex(doc(), { engine: "pdflatex" })).toContain("inputenc");
    expect(documentToLatex(doc(), { engine: "lualatex" })).toContain("fontspec");
  });
});

describe("documentFigures", () => {
  it("finds every asset a document refers to, so the bundle can carry them", () => {
    const figures = documentFigures(
      doc(
        { type: "image", attrs: { src: "kiwi-asset://workspace-1/asset-one" } },
        {
          type: "blockquote",
          content: [{ type: "image", attrs: { src: "kiwi-asset://workspace-1/asset-two" } }],
        },
      ),
    );
    expect(figures).toEqual([
      { name: "figure-asset-one", assetId: "asset-one" },
      { name: "figure-asset-two", assetId: "asset-two" },
    ]);
  });

  it("ignores an image that is not a workspace asset", () => {
    expect(
      documentFigures(doc({ type: "image", attrs: { src: "data:image/png;base64,x" } })),
    ).toEqual([]);
  });
});

describe("latexFileName", () => {
  it("strips anything that is not safe in a filename", () => {
    expect(latexFileName("kiwi-asset://w/abc-123")).toBe("figure-abc-123");
    expect(latexFileName("kiwi-asset://w/a_b.c")).toBe("figure-abc");
  });

  it("returns nothing for a source that is not an asset", () => {
    expect(latexFileName("https://example.test/a.png")).toBeNull();
  });
});

describe("parseLatexLog", () => {
  it("finds an error and the line it happened on", () => {
    const log = [
      "This is LuaHBTeX, Version 1.18.0",
      "(./paper.tex",
      "! Undefined control sequence.",
      "l.42 \\notacommand",
      "                 {x}",
    ].join("\n");
    const problems = parseLatexLog(log);
    expect(problems).toMatchObject([{ severity: "error", file: "paper.tex", line: 42 }]);
  });

  it("reads a LaTeX Error without the boilerplate", () => {
    const log = ["(./paper.tex", "! LaTeX Error: File `missing.sty' not found.", "l.3"].join("\n");
    expect(parseLatexLog(log)[0]?.message).toBe("File `missing.sty' not found.");
  });

  it("collects warnings without calling them errors", () => {
    const log = [
      "(./paper.tex",
      "LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 12.",
    ].join("\n");
    const problems = parseLatexLog(log);
    expect(problems).toMatchObject([{ severity: "warning", line: 12 }]);
    expect(problems[0]?.message).not.toContain("on input line");
  });

  it("says nothing about a clean run", () => {
    const log = ["This is LuaHBTeX", "(./paper.tex", "Output written on paper.pdf (3 pages)."].join(
      "\n",
    );
    expect(parseLatexLog(log)).toEqual([]);
  });

  it("does not drown a person in package chatter", () => {
    // A real log is thousands of lines. Only what someone can act on comes back.
    const noise = Array.from(
      { length: 500 },
      (_unused, index) => `(/usr/share/tex/x${String(index)}.sty)`,
    );
    const log = [...noise, "! Missing $ inserted.", "l.8"].join("\n");
    expect(parseLatexLog(log)).toHaveLength(1);
  });
});

describe("compileFailed", () => {
  it("is true only when something is actually broken", () => {
    expect(compileFailed([{ severity: "warning", file: null, line: 1, message: "x" }])).toBe(false);
    expect(compileFailed([{ severity: "error", file: null, line: 1, message: "x" }])).toBe(true);
  });
});

describe("citations in a converted document", () => {
  function cited(key: string, locator?: string) {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "As shown " },
            {
              type: "citation",
              attrs: { key, objectId: "paper-1", ...(locator === undefined ? {} : { locator }) },
            },
            { type: "text", text: "." },
          ],
        },
      ],
    };
  }

  it("emits the key rather than formatted text", () => {
    // LaTeX formats citations itself. Pre-formatting one would freeze it at whatever style
    // happened to be current when it was typed.
    expect(documentToLatex(cited("vaswani2017"))).toContain("\\cite{vaswani2017}");
  });

  it("carries a locator into the optional argument", () => {
    expect(documentToLatex(cited("vaswani2017", "p. 45"))).toContain("\\cite[p. 45]{vaswani2017}");
  });

  it("escapes a locator rather than letting it run as LaTeX", () => {
    expect(documentToLatex(cited("k", "50% of cases"))).toContain("50\\%");
  });

  it("omits a citation with no key rather than emitting a broken command", () => {
    expect(documentToLatex(cited(""))).not.toContain("cite");
  });

  it("names the bibliography file when the bundle carries one", () => {
    const source = documentToLatex(cited("k"), { bibliography: "references" });
    expect(source).toContain("\\bibliography{references}");
    expect(source).toContain("\\bibliographystyle{plain}");
  });

  it("writes no bibliography command when there is no file", () => {
    expect(documentToLatex(cited("k"))).not.toContain("\\bibliography");
  });
});

describe("documentCitations", () => {
  function document(...keys: Array<{ objectId: string }>) {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: keys.map((attrs) => ({ type: "citation", attrs })),
        },
      ],
    };
  }

  it("lists the works a document cites", () => {
    expect(documentCitations(document({ objectId: "a" }, { objectId: "b" }))).toEqual(["a", "b"]);
  });

  it("keeps the first appearance, which is what a numeric style numbers by", () => {
    expect(
      documentCitations(document({ objectId: "b" }, { objectId: "a" }, { objectId: "b" })),
    ).toEqual(["b", "a"]);
  });

  it("ignores a citation with no work behind it", () => {
    expect(documentCitations(document({ objectId: "" }))).toEqual([]);
  });

  it("finds nothing in a document that cites nothing", () => {
    expect(documentCitations({ type: "doc", content: [] })).toEqual([]);
    expect(documentCitations(null)).toEqual([]);
  });

  it("counts how often each work is cited, which the list itself cannot show", () => {
    expect(
      documentCitationCounts(document({ objectId: "b" }, { objectId: "a" }, { objectId: "b" })),
    ).toEqual({ a: 1, b: 2 });
  });

  it("counts a work cited in two places as two", () => {
    // The repeats are in different paragraphs, so a counter that only looked at one node
    // would report one.
    const document = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "citation", attrs: { objectId: "a" } }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "citation", attrs: { objectId: "a" } }] },
              ],
            },
          ],
        },
      ],
    };
    expect(documentCitationCounts(document)).toEqual({ a: 2 });
  });

  it("counts nothing in a document that cites nothing", () => {
    expect(documentCitationCounts(null)).toEqual({});
    expect(documentCitationCounts(document({ objectId: "" }))).toEqual({});
  });
});

describe("cross-references in the converted source", () => {
  function figure(caption: string, id?: string) {
    return {
      type: "image",
      attrs: {
        src: "kiwi-asset://workspace-1/asset-1",
        alt: caption,
        ...(id === undefined ? {} : { kiwiId: id }),
      },
    };
  }

  function reference(target: string, kind = "figure") {
    return { type: "paragraph", content: [{ type: "crossReference", attrs: { target, kind } }] };
  }

  it("labels the target and refers to it by that label", () => {
    const source = documentToLatex(doc(figure("Yield", "f-1"), reference("f-1")));
    expect(source).toContain("\\label{kiwi:f-1}");
    expect(source).toContain("Figure~\\ref{kiwi:f-1}");
  });

  it("writes the word in front of the number, because ref prints only the number", () => {
    const source = documentToLatex(
      doc(
        {
          type: "heading",
          attrs: { level: 1, kiwiId: "s-1" },
          content: [{ type: "text", text: "Method" }],
        },
        reference("s-1", "section"),
      ),
    );
    expect(source).toContain("\\section{Method}\\label{kiwi:s-1}");
    expect(source).toContain("Section~\\ref{kiwi:s-1}");
  });

  it("leaves a target nothing points at exactly as it was", () => {
    expect(documentToLatex(doc(figure("Yield", "f-1")))).not.toContain("\\label{");
  });

  it("numbers an equation only once something refers to it", () => {
    const equation = { type: "mathBlock", attrs: { latex: "x = 1", kiwiId: "e-1" } };
    const plain = documentToLatex(doc(equation));
    expect(plain).toContain("\\[");
    expect(plain).not.toContain("\\begin{equation}");

    const referred = documentToLatex(doc(equation, reference("e-1", "equation")));
    expect(referred).toContain("\\begin{equation}");
    expect(referred).toContain("\\label{kiwi:e-1}");
    expect(referred).toContain("Equation~\\ref{kiwi:e-1}");
  });

  it("floats a referred-to table so it has a counter to be numbered by", () => {
    const table = {
      type: "table",
      attrs: { kiwiId: "t-1" },
      content: [
        { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("Yield")] }] },
      ],
    };
    expect(documentToLatex(doc(table))).not.toContain("\\begin{table}");

    const referred = documentToLatex(doc(table, reference("t-1", "table")));
    expect(referred).toContain("\\begin{table}[htbp]");
    // The empty caption is what steps the table counter. Without it the label would take its
    // number from the section it happens to sit in.
    expect(referred).toContain("\\caption{}");
    expect(referred).toContain("\\label{kiwi:t-1}");
  });

  it("captions a referred-to figure that has none, for the same reason", () => {
    const source = documentToLatex(doc(figure("", "f-1"), reference("f-1")));
    expect(source).toContain("\\caption{}");
    expect(source.indexOf("\\caption{}")).toBeLessThan(source.indexOf("\\label{kiwi:f-1}"));
  });
});
