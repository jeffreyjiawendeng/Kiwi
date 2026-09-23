import { describe, expect, it, vi } from "vitest";
import {
  base64Of,
  captureName,
  cropCanvas,
  dragRect,
  isCaptureWorthKeeping,
  pointerFraction,
} from "./pdf-capture.js";

describe("dragRect", () => {
  it("describes a drag down and to the right", () => {
    // Fractions subtract inexactly, so the shape is compared rather than the exact bits.
    const rect = dragRect({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 });
    expect(rect.left).toBeCloseTo(0.1);
    expect(rect.top).toBeCloseTo(0.2);
    expect(rect.width).toBeCloseTo(0.3);
    expect(rect.height).toBeCloseTo(0.4);
  });

  it("treats a drag up and to the left the same way", () => {
    // Dragging from the bottom-right corner is as natural as from the top-left.
    const down = dragRect({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 });
    const up = dragRect({ x: 0.4, y: 0.6 }, { x: 0.1, y: 0.2 });
    expect(up.left).toBeCloseTo(down.left);
    expect(up.top).toBeCloseTo(down.top);
    expect(up.width).toBeCloseTo(down.width);
    expect(up.height).toBeCloseTo(down.height);
  });

  it("stops at the edge of the page", () => {
    // A drag that leaves the page should stop there rather than describe a region that is not.
    const rect = dragRect({ x: -0.5, y: 0.5 }, { x: 1.5, y: 2 });
    expect(rect.left).toBe(0);
    expect(rect.left + rect.width).toBeCloseTo(1);
    expect(rect.top + rect.height).toBeCloseTo(1);
  });
});

describe("isCaptureWorthKeeping", () => {
  it("ignores a stray click", () => {
    expect(isCaptureWorthKeeping(dragRect({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }))).toBe(false);
  });

  it("keeps a real drag", () => {
    expect(isCaptureWorthKeeping(dragRect({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }))).toBe(true);
  });

  it("ignores a drag that is long but has no height", () => {
    expect(isCaptureWorthKeeping(dragRect({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }))).toBe(false);
  });
});

describe("pointerFraction", () => {
  function element(box: { left: number; top: number; width: number; height: number }): Element {
    return {
      getBoundingClientRect: () => ({
        ...box,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as unknown as Element;
  }

  it("reports where in the page the pointer landed", () => {
    const at = pointerFraction(element({ left: 100, top: 50, width: 200, height: 400 }), 150, 250);
    expect(at).toEqual({ x: 0.25, y: 0.5 });
  });

  it("does not divide by an element with no size", () => {
    expect(pointerFraction(element({ left: 0, top: 0, width: 0, height: 0 }), 10, 10)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("base64Of", () => {
  it("strips the prefix a canvas produces", () => {
    expect(base64Of("data:image/png;base64,AAAB")).toBe("AAAB");
  });

  it("refuses anything that is not a PNG data URL", () => {
    expect(base64Of("data:image/jpeg;base64,AAAB")).toBeNull();
    expect(base64Of("https://example.test/x.png")).toBeNull();
    expect(base64Of("data:image/png;base64,")).toBeNull();
  });
});

describe("captureName", () => {
  it("names the page it came from", () => {
    // A folder of capture-1.png tells the person who opens it in six months nothing.
    expect(captureName("iv", new Date("2026-08-25T12:00:00.000Z"))).toBe(
      "page-iv-2026-08-25T12-00-00-000Z.png",
    );
  });

  it("survives a page label that is not a word", () => {
    expect(captureName("§ 3", new Date("2026-08-25T12:00:00.000Z"))).toBe(
      "page-3-2026-08-25T12-00-00-000Z.png",
    );
    expect(captureName("///", new Date("2026-08-25T12:00:00.000Z"))).toContain("page-capture-");
  });

  it("produces a name the main process will accept", () => {
    // The name becomes a file, so it is checked there too. These must agree.
    const pattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.png$/u;
    expect(pattern.test(captureName("iv", new Date()))).toBe(true);
    expect(pattern.test(captureName("///", new Date()))).toBe(true);
  });
});

describe("cropCanvas", () => {
  function canvas(overrides: Partial<HTMLCanvasElement> = {}): HTMLCanvasElement {
    return {
      width: 1000,
      height: 800,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toDataURL: vi.fn(() => "data:image/png;base64,AAAB"),
      ...overrides,
    } as unknown as HTMLCanvasElement;
  }

  it("crops the region that was dragged", () => {
    const target = canvas();
    const url = cropCanvas(
      canvas(),
      { left: 0.1, top: 0.2, width: 0.5, height: 0.25 },
      () => target,
    );
    expect(url).toBe("data:image/png;base64,AAAB");
    expect(target.width).toBe(500);
    expect(target.height).toBe(200);
  });

  it("returns nothing rather than a blank image when there is no canvas context", () => {
    // The test environment has none, and a reader whose graphics stack fails should be told
    // the capture did not happen rather than handed an empty picture.
    const target = canvas({ getContext: vi.fn(() => null) as never });
    expect(cropCanvas(canvas(), { left: 0, top: 0, width: 1, height: 1 }, () => target)).toBeNull();
  });

  it("returns nothing for a region smaller than a pixel", () => {
    expect(
      cropCanvas(canvas(), { left: 0, top: 0, width: 0.0001, height: 0.0001 }, () => canvas()),
    ).toBeNull();
  });

  it("returns nothing when the canvas refuses to export", () => {
    const target = canvas({
      toDataURL: vi.fn(() => {
        throw new Error("tainted");
      }) as never,
    });
    expect(cropCanvas(canvas(), { left: 0, top: 0, width: 1, height: 1 }, () => target)).toBeNull();
  });
});
