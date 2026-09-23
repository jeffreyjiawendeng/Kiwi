import { describe, expect, it } from "vitest";
import {
  documentQuotations,
  quotationMarker,
  quotationText,
  quotedAnnotations,
  readAnnotationLocation,
  readQuotation,
  splitAttribution,
} from "./quotation.js";

const ATTRIBUTES = {
  annotation: "annotation-1",
  target: "paper-1",
  source: "Computing Machinery and Intelligence",
  page_label: "434",
};

function attribution(attrs: Record<string, unknown>) {
  return { type: "quotation", attrs };
}

describe("what an attribution says", () => {
  it("names the paper and the page", () => {
    expect(quotationText(ATTRIBUTES)).toBe("— Computing Machinery and Intelligence, p. 434");
  });

  it("leaves out a page it was not given", () => {
    expect(quotationText({ ...ATTRIBUTES, page_label: "" })).toBe(
      "— Computing Machinery and Intelligence",
    );
  });

  it("still reads when the paper has lost its name", () => {
    // The line is what a reader has. Blank after the dash would be worse than saying so.
    expect(quotationText({ ...ATTRIBUTES, source: "" })).toBe("— Unknown source, p. 434");
  });

  it("defaults everything it cannot read", () => {
    expect(readQuotation(undefined)).toEqual({
      annotation: "",
      target: "",
      source: "",
      page_label: "",
    });
  });
});

describe("the marks a document quotes", () => {
  const document = {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "paragraph" }] },
      attribution(ATTRIBUTES),
      attribution({ ...ATTRIBUTES, annotation: "annotation-2" }),
      attribution({ ...ATTRIBUTES, annotation: "annotation-1" }),
    ],
  };

  it("finds them in document order", () => {
    expect(documentQuotations(document).map((entry) => entry.annotation)).toEqual([
      "annotation-1",
      "annotation-2",
      "annotation-1",
    ]);
  });

  it("counts a mark quoted twice once, which is what a second send has to check", () => {
    expect([...quotedAnnotations(document)]).toEqual(["annotation-1", "annotation-2"]);
  });

  it("ignores an attribution that names no mark", () => {
    expect(documentQuotations(attribution({ ...ATTRIBUTES, annotation: "" }))).toEqual([]);
  });
});

describe("a quotation written into plain text", () => {
  it("splits a line into what it says and the mark it points at", () => {
    expect(splitAttribution(`— Turing, p. 434 ${quotationMarker("annotation-1")}`)).toEqual([
      { kind: "text", text: "— Turing, p. 434 " },
      { kind: "quotation", annotation: "annotation-1" },
    ]);
  });

  it("is the whole line when there is no marker in it", () => {
    expect(splitAttribution("Nothing to follow here")).toEqual([
      { kind: "text", text: "Nothing to follow here" },
    ]);
  });

  it("does not lose its place between two lines", () => {
    // A shared global regex would start the second line partway into itself.
    const line = `p. 1 ${quotationMarker("annotation-1")}`;
    expect(splitAttribution(line)).toEqual(splitAttribution(line));
  });

  it("keeps the words on both sides of a marker", () => {
    expect(splitAttribution(`before ${quotationMarker("a")} after`)).toEqual([
      { kind: "text", text: "before " },
      { kind: "quotation", annotation: "a" },
      { kind: "text", text: " after" },
    ]);
  });
});

describe("reading where a mark was made", () => {
  const location = {
    annotation_id: "annotation-1",
    object_id: "paper-1",
    object_title: "Computing Machinery and Intelligence",
    asset_id: "asset-1",
    file_title: "turing-1950.pdf",
    page: 4,
    page_label: "434",
  };

  it("reads a full answer", () => {
    expect(readAnnotationLocation({ location })).toEqual(location);
  });

  it("is nothing when the mark is gone", () => {
    expect(readAnnotationLocation({ location: null })).toBeNull();
    expect(readAnnotationLocation(undefined)).toBeNull();
  });

  it("is nothing when what came back cannot be acted on", () => {
    // Without a page and a file there is nowhere to open, and a half-answer would be a Reader
    // opening on page one of something and calling it the passage.
    expect(readAnnotationLocation({ location: { ...location, page: "434" } })).toBeNull();
    expect(readAnnotationLocation({ location: { ...location, asset_id: null } })).toBeNull();
  });
});
