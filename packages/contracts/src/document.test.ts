import { describe, expect, it } from "vitest";
import {
  countNodes,
  countWords,
  documentText,
  emptyDocument,
  isRichDocument,
  readDocument,
  validateDocument,
  type RichDocument,
} from "./document.js";

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("documentText", () => {
  it("reads the words a reader would say", () => {
    const document: RichDocument = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Method" }] },
        paragraph("We sampled twelve sites."),
      ],
    };
    expect(documentText(document)).toBe("Method\nWe sampled twelve sites.");
  });

  it("keeps blocks apart so two paragraphs do not make a word nobody wrote", () => {
    // Without the boundary this reads "endbegin", which a search would then find.
    const document: RichDocument = {
      type: "doc",
      content: [paragraph("end"), paragraph("begin")],
    };
    expect(documentText(document)).toBe("end\nbegin");
  });

  it("reads text through marks rather than around them", () => {
    const document: RichDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "the " },
            { type: "text", text: "important", marks: [{ type: "bold" }] },
            { type: "text", text: " part" },
          ],
        },
      ],
    };
    expect(documentText(document)).toBe("the important part");
  });

  it("reads a table cell by cell", () => {
    const document: RichDocument = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph("site")] },
                { type: "tableCell", content: [paragraph("count")] },
              ],
            },
          ],
        },
      ],
    };
    expect(documentText(document)).toContain("site");
    expect(documentText(document)).toContain("count");
  });

  it("collapses runs of blank lines rather than storing them", () => {
    const document: RichDocument = {
      type: "doc",
      content: [paragraph("one"), { type: "paragraph" }, { type: "paragraph" }, paragraph("two")],
    };
    expect(documentText(document)).toBe("one\n\ntwo");
  });

  it("reads an equation's source, so a search for a symbol finds the paper", () => {
    const document: RichDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "where " },
            { type: "mathInline", attrs: { latex: "\\alpha_i > 0" } },
          ],
        },
        { type: "mathBlock", attrs: { latex: "E = mc^2" } },
      ],
    };
    expect(documentText(document)).toContain("\\alpha_i > 0");
    expect(documentText(document)).toContain("E = mc^2");
  });

  it("says nothing for anything that is not a document", () => {
    for (const value of [null, undefined, 42, "text", []]) {
      expect(documentText(value)).toBe("");
    }
  });

  it("stops rather than recursing forever on a tree that points at itself", () => {
    // A hand-edited canonical file can contain anything, including a cycle.
    const node: Record<string, unknown> = { type: "paragraph" };
    node["content"] = [node];
    expect(() => documentText({ type: "doc", content: [node] })).not.toThrow();
  });
});

describe("validateDocument", () => {
  it("accepts an empty document, because a note starts empty", () => {
    expect(validateDocument(emptyDocument())).toEqual([]);
  });

  it("rejects something that is not a node tree", () => {
    for (const value of [null, "text", 42, [], { type: "paragraph" }]) {
      expect(validateDocument(value)).toHaveLength(1);
    }
  });
});

describe("readDocument", () => {
  it("returns an empty document rather than failing to open a damaged one", () => {
    expect(readDocument("not a document")).toEqual(emptyDocument());
    expect(readDocument(null)).toEqual(emptyDocument());
  });

  it("returns a real document unchanged", () => {
    const document: RichDocument = { type: "doc", content: [paragraph("kept")] };
    expect(readDocument(document)).toBe(document);
  });
});

describe("isRichDocument", () => {
  it("requires the root to be a doc with content", () => {
    expect(isRichDocument({ type: "doc", content: [] })).toBe(true);
    expect(isRichDocument({ type: "doc" })).toBe(false);
    expect(isRichDocument({ type: "paragraph", content: [] })).toBe(false);
  });
});

describe("countNodes", () => {
  it("counts the tree, not just the top", () => {
    expect(countNodes({ type: "doc", content: [paragraph("a"), paragraph("b")] })).toBe(5);
  });
});

describe("countWords", () => {
  it("counts words the way a target is counted", () => {
    expect(countWords("We sampled twelve sites.")).toBe(4);
    expect(countWords("  spaced   out  ")).toBe(2);
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });
});
