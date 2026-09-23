import { describe, expect, it } from "vitest";
import {
  docxCitationText,
  documentToDocxParts,
  escapeXml,
  imageSize,
  type DocxPart,
} from "./docx.js";
import type { RichDocument } from "./document.js";

function doc(...content: RichDocument["content"]): RichDocument {
  return { type: "doc", content };
}

function text(value: string, marks?: string[]): RichDocument["content"][number] {
  return marks === undefined
    ? { type: "text", text: value }
    : { type: "text", text: value, marks: marks.map((type) => ({ type })) };
}

function partNamed(parts: DocxPart[], name: string): string {
  const found = parts.find((part) => part.name === name);
  return typeof found?.data === "string" ? found.data : "";
}

/** A one-pixel PNG, sized 4 by 3 in its header so the drawing has a ratio to keep. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("escaping", () => {
  it("escapes the characters that would end the element early", () => {
    expect(escapeXml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("drops control characters rather than writing a file Word refuses to open", () => {
    // Word does not skip an invalid character. It offers to repair the document, and repairing
    // is how an export becomes a lost afternoon.
    expect(escapeXml("before\u0000\u0007after")).toBe("beforeafter");
    expect(escapeXml("keep\ttabs")).toBe("keep\ttabs");
  });
});

describe("image sizes", () => {
  it("reads the size out of the picture", () => {
    expect(imageSize(png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(
      imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])),
    ).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("falls back to a shape rather than a zero for a picture it cannot read", () => {
    // Word needs both numbers and will not work them out itself; zero is an invisible figure.
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toEqual({ width: 600, height: 400 });
  });
});

describe("citations", () => {
  it("uses the label the bibliography has now, not the one stored with the node", () => {
    const attrs = { objectId: "obj-1", label: "(Smith, 2019)" };
    expect(docxCitationText(attrs, { "obj-1": "[4]" })).toBe("[4]");
  });

  it("falls back to the stored label when the bibliography has no entry", () => {
    expect(docxCitationText({ objectId: "obj-1", label: "(Smith, 2019)" }, {})).toBe(
      "(Smith, 2019)",
    );
    expect(docxCitationText({ objectId: "obj-1" }, {})).toBe("(?)");
  });

  it("folds a locator inside the brackets, where a reader expects to read it", () => {
    expect(docxCitationText({ objectId: "a", label: "(Smith, 2019)", locator: "p. 45" }, {})).toBe(
      "(Smith, 2019, p. 45)",
    );
    expect(docxCitationText({ objectId: "a", label: "[4]", locator: "ch. 2" }, {})).toBe(
      "[4, ch. 2]",
    );
  });
});

describe("parts", () => {
  it("writes every part Word opens a document by", () => {
    const { parts } = documentToDocxParts(doc({ type: "paragraph", content: [text("Hello")] }));
    expect(parts.map((part) => part.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
    ]);
  });

  it("declares the parts Word looks up by name", () => {
    // An undeclared part is not ignored: Word treats the package as damaged.
    const types = partNamed(
      documentToDocxParts(doc({ type: "paragraph" })).parts,
      "[Content_Types].xml",
    );
    for (const part of ["/word/document.xml", "/word/styles.xml", "/word/numbering.xml"]) {
      expect(types).toContain(`PartName="${part}"`);
    }
    expect(types).toContain('<Default Extension="rels"');
  });

  it("gives an empty document a paragraph, because a body with nothing in it will not open", () => {
    const { parts } = documentToDocxParts({ type: "doc", content: [] });
    expect(partNamed(parts, "word/document.xml")).toContain("<w:body><w:p/>");
  });
});

describe("the body", () => {
  it("carries the marks a manuscript is written with", () => {
    const { parts } = documentToDocxParts(
      doc({
        type: "paragraph",
        content: [
          text("bold", ["bold"]),
          text("italic", ["italic"]),
          text("under", ["underline"]),
          text("struck", ["strike"]),
          text("up", ["superscript"]),
          text("down", ["subscript"]),
        ],
      }),
    );
    const xml = partNamed(parts, "word/document.xml");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain("<w:strike/>");
    expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(xml).toContain('<w:vertAlign w:val="subscript"/>');
  });

  it("keeps the space beside a word that changes formatting mid-sentence", () => {
    // Without xml:space Word closes the gap and the sentence reads "the fastfox".
    const { parts } = documentToDocxParts(
      doc({ type: "paragraph", content: [text("the "), text("fast", ["bold"]), text(" fox")] }),
    );
    expect(partNamed(parts, "word/document.xml")).toContain('<w:t xml:space="preserve">the </w:t>');
  });

  it("gives a heading the style for its level", () => {
    const { parts } = documentToDocxParts(
      doc({ type: "heading", attrs: { level: 2 }, content: [text("Method")] }),
    );
    expect(partNamed(parts, "word/document.xml")).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it("numbers a nested list by depth, because Word has no nesting to give it", () => {
    const { parts } = documentToDocxParts(
      doc({
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [text("outer")] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [text("inner")] }] },
                ],
              },
            ],
          },
        ],
      }),
    );
    const xml = partNamed(parts, "word/document.xml");
    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain('<w:numId w:val="2"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect(xml).toContain('<w:numId w:val="1"/>');
  });

  it("numbers only the first paragraph of a list item", () => {
    // Numbering both would count one two-paragraph item as two items.
    const { parts } = documentToDocxParts(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [text("first")] },
              { type: "paragraph", content: [text("second")] },
            ],
          },
        ],
      }),
    );
    const xml = partNamed(parts, "word/document.xml");
    expect(xml.match(/<w:numPr>/gu)).toHaveLength(1);
  });

  it("gives every table cell a paragraph", () => {
    // An empty cell is ordinary, and a cell with no paragraph is the usual reason Word offers
    // to repair a document.
    const { parts } = documentToDocxParts(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [text("Site")] }] },
              { type: "tableCell" },
            ],
          },
        ],
      }),
    );
    const xml = partNamed(parts, "word/document.xml");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain('<w:pStyle w:val="TableHeading"/>');
    expect(xml).toContain("<w:tcPr><w:tcW");
    expect(xml).toMatch(/<w:tc><w:tcPr>[^]*?<\/w:tcPr><w:p\/><\/w:tc>/u);
  });

  it("puts the reference list under a heading at the end", () => {
    const { parts } = documentToDocxParts(doc({ type: "paragraph", content: [text("Body")] }), {
      references: ["Smith, J. (2019). A paper. Journal, 4(2), 1-10."],
    });
    const xml = partNamed(parts, "word/document.xml");
    expect(xml.indexOf("References")).toBeGreaterThan(xml.indexOf("Body"));
    expect(xml).toContain('<w:pStyle w:val="Bibliography"/>');
  });

  it("puts the title above the manuscript when it has one", () => {
    const { parts } = documentToDocxParts(doc({ type: "paragraph", content: [text("Body")] }), {
      title: "Ice Cores",
      authors: ["A. Reader"],
    });
    const xml = partNamed(parts, "word/document.xml");
    expect(xml.indexOf("Ice Cores")).toBeLessThan(xml.indexOf("Body"));
    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain("A. Reader");
  });
});

describe("figures", () => {
  const image = {
    type: "image",
    attrs: { src: "kiwi-asset://ws/asset-1", alt: "Core depth against age" },
  };

  it("embeds a picture and relates it to the document", () => {
    const { parts, notes } = documentToDocxParts(doc(image), {
      figures: [{ name: "figure-asset-1.png", bytes: png(800, 400) }],
    });
    const xml = partNamed(parts, "word/document.xml");
    expect(xml).toContain('<a:blip r:embed="rId3"/>');
    // Six and a half inches of column, and half as tall as it is wide.
    expect(xml).toContain('cx="5943600" cy="2971800"');
    expect(partNamed(parts, "word/_rels/document.xml.rels")).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure-asset-1.png"',
    );
    expect(parts.some((part) => part.name === "word/media/figure-asset-1.png")).toBe(true);
    expect(partNamed(parts, "[Content_Types].xml")).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
    expect(notes).toEqual([]);
  });

  it("does not blow a small picture up to the width of the column", () => {
    const { parts } = documentToDocxParts(doc(image), {
      figures: [{ name: "figure-asset-1.png", bytes: png(100, 100) }],
    });
    expect(partNamed(parts, "word/document.xml")).toContain('cx="952500" cy="952500"');
  });

  it("keeps the caption of a figure Word cannot place, and says which", () => {
    // A PDF figure compiles in LaTeX and cannot be shown in Word at all. Dropping it silently
    // is how a paper reaches a reviewer with a sentence pointing at nothing.
    const { parts, notes } = documentToDocxParts(doc(image), {
      figures: [{ name: "figure-asset-1.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }],
    });
    const xml = partNamed(parts, "word/document.xml");
    expect(xml).not.toContain("<w:drawing>");
    expect(xml).toContain("Core depth against age");
    expect(notes).toEqual([
      "Word cannot place a figure saved as .pdf. Those figures were left out and their captions kept.",
    ]);
  });
});

describe("equations", () => {
  it("writes an equation as its source and says that is what it did", () => {
    const { parts, notes } = documentToDocxParts(
      doc(
        { type: "mathBlock", attrs: { latex: "E = mc^2" } },
        { type: "paragraph", content: [{ type: "mathInline", attrs: { latex: "x_i" } }] },
      ),
    );
    expect(partNamed(parts, "word/document.xml")).toContain("E = mc^2");
    expect(notes).toEqual([
      "2 equations were written as LaTeX source. Word will show the source, not the rendered equation.",
    ]);
  });

  it("counts one equation as one", () => {
    const { notes } = documentToDocxParts(doc({ type: "mathBlock", attrs: { latex: "a" } }));
    expect(notes[0]).toBe(
      "1 equation was written as LaTeX source. Word will show the source, not the rendered equation.",
    );
  });
});
