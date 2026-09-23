import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOverlayScrollbars } from "./scrollbars.js";

// jsdom performs no layout, so a region that scrolls has to be described directly.
function makeRegion(options: {
  scrollHeight?: number;
  clientHeight?: number;
  scrollWidth?: number;
  clientWidth?: number;
  rect?: { top: number; left: number; width: number; height: number };
}): HTMLDivElement {
  const region = document.createElement("div");
  const rect = options.rect ?? { top: 0, left: 0, width: 200, height: 100 };
  // jsdom does not expand the overflow shorthand into its per-axis computed values.
  region.style.overflowY = "auto";
  region.style.overflowX = "auto";
  for (const [name, value] of [
    ["scrollHeight", options.scrollHeight ?? 100],
    ["clientHeight", options.clientHeight ?? 100],
    ["scrollWidth", options.scrollWidth ?? 200],
    ["clientWidth", options.clientWidth ?? 200],
    ["clientTop", 0],
    ["clientLeft", 0],
  ] as const) {
    Object.defineProperty(region, name, { value, configurable: true });
  }
  region.getBoundingClientRect = (): DOMRect =>
    ({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.append(region);
  return region;
}

function movePointer(target: EventTarget, clientX: number, clientY: number): void {
  target.dispatchEvent(
    new PointerEvent("pointermove", { clientX, clientY, bubbles: true, pointerId: 1 }),
  );
}

function verticalBar(): HTMLElement {
  const bar = document.querySelector(".kiwi-scrollbar--vertical");
  if (!(bar instanceof HTMLElement)) throw new Error("The vertical scrollbar was not installed.");
  return bar;
}

function isVisible(bar: HTMLElement): boolean {
  return bar.hasAttribute("data-visible");
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  // Paint synchronously so a test observes the frame the event scheduled.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("overlay scrollbars", () => {
  it("installs one thumb per axis and shows neither at rest", () => {
    stop = installOverlayScrollbars();

    expect(document.querySelectorAll(".kiwi-scrollbar")).toHaveLength(2);
    expect(isVisible(verticalBar())).toBe(false);
  });

  it("stays hidden for a region whose content does not overflow", () => {
    const region = makeRegion({ scrollHeight: 100, clientHeight: 100 });
    stop = installOverlayScrollbars();

    region.dispatchEvent(new Event("scroll", { bubbles: false }));
    movePointer(region, 199, 50);

    expect(isVisible(verticalBar())).toBe(false);
  });

  it("shows the thumb while a region is scrolling and hides it once it settles", () => {
    const region = makeRegion({ scrollHeight: 400, clientHeight: 100 });
    stop = installOverlayScrollbars();

    region.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(isVisible(verticalBar())).toBe(true);

    vi.advanceTimersByTime(699);
    expect(isVisible(verticalBar())).toBe(true);

    vi.advanceTimersByTime(2);
    expect(isVisible(verticalBar())).toBe(false);
  });

  it("shows the thumb for a pointer on the scrollbar but not for one over the content", () => {
    const region = makeRegion({
      scrollHeight: 400,
      clientHeight: 100,
      rect: { top: 0, left: 0, width: 200, height: 100 },
    });
    stop = installOverlayScrollbars();

    // Well inside the region, away from its right edge.
    movePointer(region, 100, 50);
    expect(isVisible(verticalBar())).toBe(false);

    // Within the scrollbar's strip at the right edge.
    movePointer(region, 195, 50);
    expect(isVisible(verticalBar())).toBe(true);
  });

  it("draws the thumb inside the region rather than beside it", () => {
    const region = makeRegion({
      scrollHeight: 400,
      clientHeight: 100,
      clientWidth: 200,
      rect: { top: 30, left: 40, width: 200, height: 100 },
    });
    stop = installOverlayScrollbars();
    region.dispatchEvent(new Event("scroll", { bubbles: false }));

    const bar = verticalBar();
    // Right edge of the region is 240. A 10px thumb with a 2px gap starts at 228, so the
    // whole thumb lies within the region and none of it beside.
    expect(bar.style.transform).toBe("translate(228px, 30px)");
    expect(bar.style.width).toBe("10px");
  });

  it("offsets the thumb by how far the region has been scrolled", () => {
    const region = makeRegion({
      scrollHeight: 400,
      clientHeight: 100,
      rect: { top: 0, left: 0, width: 200, height: 100 },
    });
    stop = installOverlayScrollbars();

    region.scrollTop = 300;
    region.dispatchEvent(new Event("scroll", { bubbles: false }));

    // Scrolled to the end, so the thumb sits at the end of its travel: 100 - 25 = 75.
    expect(verticalBar().style.transform).toBe("translate(188px, 75px)");
  });

  it("scrolls the region when the thumb is dragged", () => {
    const region = makeRegion({
      scrollHeight: 400,
      clientHeight: 100,
      rect: { top: 0, left: 0, width: 200, height: 100 },
    });
    stop = installOverlayScrollbars();
    region.dispatchEvent(new Event("scroll", { bubbles: false }));

    const bar = verticalBar();
    bar.dispatchEvent(new PointerEvent("pointerdown", { clientY: 0, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 75, pointerId: 1 }));

    // A full sweep of the 75px travel moves the full 300px of scrollable content.
    expect(region.scrollTop).toBe(300);

    window.dispatchEvent(new PointerEvent("pointerup", { clientY: 75, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 0, pointerId: 1 }));
    expect(region.scrollTop).toBe(300);
  });

  it("keeps a hidden thumb from intercepting a click meant for the content", () => {
    stop = installOverlayScrollbars();

    // The visible state carries pointer-events in the stylesheet; the attribute is what
    // the stylesheet keys on, and a resting thumb must not have it.
    expect(verticalBar().hasAttribute("data-visible")).toBe(false);
  });

  it("removes both thumbs and stops listening when uninstalled", () => {
    const region = makeRegion({ scrollHeight: 400, clientHeight: 100 });
    const uninstall = installOverlayScrollbars();

    uninstall();
    expect(document.querySelectorAll(".kiwi-scrollbar")).toHaveLength(0);

    // Nothing left to update, and no listener that could throw against a removed thumb.
    expect(() => region.dispatchEvent(new Event("scroll", { bubbles: false }))).not.toThrow();
  });
});
