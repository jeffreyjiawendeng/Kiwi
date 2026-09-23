import { describe, expect, it } from "vitest";
import {
  brokenCrossReferences,
  createCrossReferenceCounter,
  crossReferenceLabel,
  crossReferenceLabelName,
  crossReferenceLabels,
  crossReferenceTargetKind,
  documentCrossReferences,
  documentTargets,
  isCrossReferenceKind,
  referencedTargets,
} from "./crossref.js";

function heading(level: number, text: string, id?: string) {
  return {
    type: "heading",
    attrs: { level, ...(id === undefined ? {} : { kiwiId: id }) },
    content: [{ type: "text", text }],
  };
}

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

function reference(target: string, kind = "figure", label = "") {
  return { type: "crossReference", attrs: { target, kind, label } };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

describe("cross-reference numbering", () => {
  it("numbers each kind on its own count", () => {
    const targets = documentTargets(
      doc(
        figure("First"),
        { type: "table", content: [] },
        figure("Second"),
        { type: "mathBlock", attrs: { latex: "x = 1" } },
        { type: "table", content: [] },
      ),
    );
    expect(targets.map((target) => `${target.kind} ${target.number}`)).toEqual([
      "figure 1",
      "table 1",
      "figure 2",
      "equation 1",
      "table 2",
    ]);
  });

  it("numbers sections by level, the way the document class does", () => {
    // A reference to a subsection prints "2.1" in the PDF. Showing "Section 4" while writing
    // and printing "2.1" when typeset would make the editor a liar about the only thing it is
    // there to be right about.
    const targets = documentTargets(
      doc(
        heading(1, "Method"),
        heading(2, "Samples"),
        heading(2, "Apparatus"),
        heading(1, "Results"),
        heading(2, "Yield"),
      ),
    );
    expect(targets.map((target) => target.number)).toEqual(["1", "1.1", "1.2", "2", "2.1"]);
  });

  it("does not count a heading typed inside a table as a section of the paper", () => {
    const targets = documentTargets(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [heading(1, "Column")] }],
          },
        ],
      }),
    );
    expect(targets.map((target) => target.kind)).toEqual(["table"]);
  });

  it("gives a number to a target nothing points at, so the count stays right", () => {
    // The unlabelled figure still occupies Figure 1, so the one after it is Figure 2 in the
    // editor and Figure 2 in the PDF.
    const labels = crossReferenceLabels(doc(figure("Unreferenced"), figure("Referred to", "f-2")));
    expect(labels).toEqual({ "f-2": "Figure 2" });
  });

  it("reads a level it was never given as the top one", () => {
    const counter = createCrossReferenceCounter();
    expect(counter.next("section")).toBe("1");
    expect(counter.next("figure")).toBe("1");
  });
});

describe("what a reference resolves to", () => {
  it("finds every reference in document order, repeats kept", () => {
    const found = documentCrossReferences(
      doc(
        { type: "paragraph", content: [reference("f-1"), reference("s-1", "section")] },
        { type: "paragraph", content: [reference("f-1")] },
      ),
    );
    expect(found.map((one) => one.target)).toEqual(["f-1", "s-1", "f-1"]);
    expect(referencedTargets(doc({ type: "paragraph", content: [reference("f-1")] }))).toEqual(
      new Set(["f-1"]),
    );
  });

  it("reports a reference whose target has been deleted", () => {
    const broken = brokenCrossReferences(
      doc(figure("Kept", "f-1"), {
        type: "paragraph",
        content: [reference("f-1"), reference("f-gone")],
      }),
    );
    expect(broken.map((one) => one.target)).toEqual(["f-gone"]);
  });

  it("ignores a reference that points at nothing at all", () => {
    expect(documentCrossReferences(doc({ type: "paragraph", content: [reference("")] }))).toEqual(
      [],
    );
    expect(documentTargets(null)).toEqual([]);
  });
});

describe("naming", () => {
  it("words a reference the way it is read aloud", () => {
    expect(crossReferenceLabel("figure", "3")).toBe("Figure 3");
    expect(crossReferenceLabel("section", "2.1")).toBe("Section 2.1");
  });

  it("makes a LaTeX label out of an id without letting anything else through", () => {
    expect(crossReferenceLabelName("a1b2-c3")).toBe("kiwi:a1b2-c3");
    expect(crossReferenceLabelName("a}b{c\\d")).toBe("kiwi:abcd");
  });

  it("knows which nodes are targets and which words are kinds", () => {
    expect(crossReferenceTargetKind("image")).toBe("figure");
    expect(crossReferenceTargetKind("mathBlock")).toBe("equation");
    expect(crossReferenceTargetKind("paragraph")).toBeNull();
    expect(isCrossReferenceKind("table")).toBe(true);
    expect(isCrossReferenceKind("footnote")).toBe(false);
  });
});
