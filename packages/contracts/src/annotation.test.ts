import { describe, expect, it } from "vitest";
import {
  EMPTY_ANNOTATION,
  annotationTitle,
  compareAnnotations,
  readAnnotation,
  validateAnnotation,
  type Annotation,
} from "./annotation.js";

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    ...EMPTY_ANNOTATION,
    asset_id: "asset-1",
    page: 3,
    page_label: "3",
    rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
    ...overrides,
  };
}

describe("validateAnnotation", () => {
  it("accepts an ordinary highlight", () => {
    expect(validateAnnotation(annotation())).toEqual([]);
  });

  it("requires a region for every mark that follows text", () => {
    for (const kind of ["highlight", "underline", "note", "area"] as const) {
      const problems = validateAnnotation(
        annotation({
          kind,
          rects: [],
          ...(kind === "area" ? { image_asset_id: "asset-image" } : {}),
        }),
      );
      expect(problems.map((problem) => problem.field)).toContain("rects");
    }
  });

  it("allows a free text box with no region", () => {
    // A text box is typed onto the page rather than attached to something already there.
    expect(validateAnnotation(annotation({ kind: "text", rects: [] }))).toEqual([]);
  });

  it("rejects a region that is not a fraction of the page", () => {
    for (const rect of [
      { left: 0.1, top: 0.2, width: 0, height: 0.02 },
      { left: 0.1, top: 0.2, width: 0.5, height: -0.1 },
      { left: 12, top: 0.2, width: 0.5, height: 0.02 },
      { left: 0.1, top: 0.2, width: Number.NaN, height: 0.02 },
    ]) {
      expect(validateAnnotation(annotation({ rects: [rect] }))).toMatchObject([{ field: "rects" }]);
    }
  });

  it("tolerates a region just outside the page box", () => {
    // Documents with odd cropping put a highlight slightly past the edge. Rejecting that
    // would refuse a mark the reader can plainly see.
    expect(
      validateAnnotation(
        annotation({ rects: [{ left: -0.02, top: 0.2, width: 0.5, height: 0.02 }] }),
      ),
    ).toEqual([]);
  });

  it("rejects a page that is not a page", () => {
    for (const page of [0, -1, 1.5]) {
      expect(validateAnnotation(annotation({ page }))).toMatchObject([{ field: "page" }]);
    }
  });

  it("rejects a colour outside the palette", () => {
    expect(validateAnnotation(annotation({ color: "chartreuse" as "yellow" }))).toMatchObject([
      { field: "color" },
    ]);
  });

  it("requires an area capture to keep its image", () => {
    // The point of dragging a box round a figure is getting the figure. An area annotation
    // with no image is a rectangle remembering nothing.
    expect(validateAnnotation(annotation({ kind: "area" }))).toMatchObject([
      { field: "image_asset_id" },
    ]);
    expect(
      validateAnnotation(annotation({ kind: "area", image_asset_id: "asset-figure" })),
    ).toEqual([]);
  });
});

describe("readAnnotation", () => {
  it("returns null for anything that is not an annotation", () => {
    for (const value of [null, undefined, 42, "highlight", [], { kind: "highlight" }]) {
      expect(readAnnotation(value)).toBeNull();
    }
  });

  it("replaces an unknown kind and colour rather than rendering them", () => {
    const read = readAnnotation({
      kind: "scribble",
      color: "chartreuse",
      asset_id: "asset-1",
      page: 2,
      rects: [],
    });
    expect(read).toMatchObject({ kind: "highlight", color: "yellow" });
  });

  it("drops a region a later edit made nonsense", () => {
    const read = readAnnotation({
      kind: "highlight",
      asset_id: "asset-1",
      page: 2,
      rects: [
        { left: 0.1, top: 0.1, width: 0.2, height: 0.02 },
        { left: 99, top: 99, width: 99, height: 99 },
      ],
    });
    expect(read?.rects).toHaveLength(1);
  });

  it("falls back to the page number when a label was never stored", () => {
    expect(readAnnotation({ kind: "note", asset_id: "a", page: 7, rects: [] })?.page_label).toBe(
      "7",
    );
  });
});

describe("annotationTitle", () => {
  it("uses the quoted passage, so a list reads like the paper", () => {
    expect(annotationTitle(annotation({ quoted: "  Attention is all\n you need  " }))).toBe(
      "Attention is all you need",
    );
  });

  it("falls back to the comment when nothing was quoted", () => {
    expect(annotationTitle(annotation({ kind: "note", comment: "Check this claim" }))).toBe(
      "Check this claim",
    );
  });

  it("names the page when there is neither", () => {
    expect(annotationTitle(annotation({ kind: "area", page_label: "iv" }))).toBe(
      "Figure on page iv",
    );
  });

  it("shortens a long passage rather than storing a paragraph as a title", () => {
    const title = annotationTitle(annotation({ quoted: "word ".repeat(60) }));
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("compareAnnotations", () => {
  it("orders down the page, then across, so a sidebar matches the eye", () => {
    const sorted = [
      annotation({ page: 2, rects: [{ left: 0.1, top: 0.8, width: 0.2, height: 0.02 }] }),
      annotation({ page: 1, rects: [{ left: 0.6, top: 0.3, width: 0.2, height: 0.02 }] }),
      annotation({ page: 1, rects: [{ left: 0.1, top: 0.3, width: 0.2, height: 0.02 }] }),
      annotation({ page: 1, rects: [{ left: 0.1, top: 0.1, width: 0.2, height: 0.02 }] }),
    ].sort(compareAnnotations);

    expect(sorted.map((item) => [item.page, item.rects[0]?.top, item.rects[0]?.left])).toEqual([
      [1, 0.1, 0.1],
      [1, 0.3, 0.1],
      [1, 0.3, 0.6],
      [2, 0.8, 0.1],
    ]);
  });
});
