import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

/**
 * How long `findBy` and `waitFor` wait for something to appear.
 *
 * The default is one second. The gate runs every package at once, and on a loaded machine a
 * render that normally takes a few milliseconds sometimes took longer than that, so tests failed
 * at random and passed on the next run. A test that passes waits exactly as long as it did before;
 * only a real failure takes longer to report.
 *
 * Eight seconds rather than four since the suite began running on a build machine with two cores
 * and no display, where a render competes with every other worker for both.
 */
configure({ asyncUtilTimeout: 8_000 });

/**
 * jsdom has no layout engine, so anything that measures the page has nothing to measure.
 *
 * ProseMirror asks for a selection's coordinates whenever it scrolls the caret into view, and
 * `Range.getClientRects` is simply absent rather than returning an empty list. Chromium
 * implements both, so this is a gap in the test environment and not something the application
 * has to guard against.
 *
 * Everything here returns an empty measurement, which is the honest answer for a page that was
 * never laid out. A test that depends on a real coordinate cannot run in jsdom at all and
 * belongs in an integration test against the real renderer.
 */
const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

function emptyRectList(): DOMRectList {
  const list = [] as unknown as DOMRectList;
  Object.defineProperty(list, "item", { value: () => null });
  return list;
}

if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = emptyRectList;
  Range.prototype.getBoundingClientRect = (): DOMRect => emptyRect;
}

if (typeof Element !== "undefined" && typeof Element.prototype.getClientRects !== "function") {
  Element.prototype.getClientRects = emptyRectList;
}

if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = (): void => undefined;
}
