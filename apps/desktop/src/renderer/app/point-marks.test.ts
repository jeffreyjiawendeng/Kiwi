import { describe, expect, it } from "vitest";
import { POINT_SIZE, isPointKind, pointRect } from "./point-marks.js";

describe("anchoring a mark to a point", () => {
  it("centres the anchor on the place that was clicked", () => {
    const rect = pointRect({ x: 0.5, y: 0.25 });

    expect(rect.width).toBe(POINT_SIZE);
    expect(rect.height).toBe(POINT_SIZE);
    expect(rect.left + rect.width / 2).toBeCloseTo(0.5, 10);
    expect(rect.top + rect.height / 2).toBeCloseTo(0.25, 10);
  });

  it("keeps an anchor placed at the edge on the page", () => {
    // Half of the square would hang off the top left corner, and off the bottom right one.
    const corner = pointRect({ x: 0, y: 0 });
    expect(corner.left).toBe(0);
    expect(corner.top).toBe(0);

    const far = pointRect({ x: 1, y: 1 });
    expect(far.left + far.width).toBeCloseTo(1, 10);
    expect(far.top + far.height).toBeCloseTo(1, 10);
  });

  it("puts a point it cannot read in a place that can be seen and moved", () => {
    // A page with no measurable box gives fractions that are not numbers. A mark in the corner
    // is wrong in a way somebody notices; a mark at NaN is one the page cannot draw at all.
    const rect = pointRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY });

    expect(rect).toEqual({ left: 0, top: 0, width: POINT_SIZE, height: POINT_SIZE });
  });

  it("knows which marks point at a place rather than at words", () => {
    expect(isPointKind("note")).toBe(true);
    expect(isPointKind("text")).toBe(true);
    // These three are drawn over what they mark, and take their size from it.
    expect(isPointKind("highlight")).toBe(false);
    expect(isPointKind("underline")).toBe(false);
    expect(isPointKind("area")).toBe(false);
  });
});
