import { describe, expect, it } from "vitest";
import { createDetachedWindows, isDetachRequest } from "./detached-windows.js";

describe("detach requests", () => {
  it("accepts an object id and a kind it knows, and nothing else", () => {
    expect(isDetachRequest({ objectId: "note-1", kind: "document" })).toBe(true);
    expect(isDetachRequest({ objectId: "", kind: "document" })).toBe(false);
    expect(isDetachRequest({ objectId: "note-1", kind: "outline" })).toBe(false);
    expect(isDetachRequest({ objectId: "note-1" })).toBe(false);
    expect(isDetachRequest("note-1")).toBe(false);
    expect(isDetachRequest(null)).toBe(false);
  });

  it("asks a Reader which file of the Paper it is opening", () => {
    // A Paper can hold the preprint and the published version. A window told only the Paper
    // would have to guess which of them somebody meant to read.
    expect(isDetachRequest({ objectId: "paper-1", kind: "reader", assetId: "asset-1" })).toBe(true);
    expect(isDetachRequest({ objectId: "paper-1", kind: "reader" })).toBe(false);
    expect(isDetachRequest({ objectId: "paper-1", kind: "reader", assetId: "" })).toBe(false);
    // A document is the whole of what its window shows, so a file alongside means nothing.
    expect(isDetachRequest({ objectId: "note-1", kind: "document", assetId: "asset-1" })).toBe(
      false,
    );
  });
});

describe("detached windows", () => {
  it("remembers what a window was opened to show", () => {
    const windows = createDetachedWindows();
    windows.attach(7, { objectId: "note-1", kind: "document", parentWindowId: 3 });

    expect(windows.forWindow(7)).toEqual({
      objectId: "note-1",
      kind: "document",
      parentWindowId: 3,
    });
    // An ordinary window has no assignment, which is how the renderer tells the two apart.
    expect(windows.forWindow(3)).toBeNull();
  });

  it("returns to the window that already has a document rather than opening a second", () => {
    // Two windows editing one document would be two editors racing each other's saves.
    const windows = createDetachedWindows();
    windows.attach(7, { objectId: "note-1", kind: "document", parentWindowId: 3 });

    expect(windows.windowShowing(3, { objectId: "note-1", kind: "document" })).toBe(7);
    expect(windows.windowShowing(3, { objectId: "note-2", kind: "document" })).toBeNull();
    // Detached from a different window, it is a different window's business.
    expect(windows.windowShowing(4, { objectId: "note-1", kind: "document" })).toBeNull();
  });

  it("tells two files of one Paper apart", () => {
    // Reading the preprint in one window and the published version in another is the point of
    // detaching at all, so the file is part of what a window is already showing.
    const windows = createDetachedWindows();
    windows.attach(7, {
      objectId: "paper-1",
      kind: "reader",
      assetId: "asset-1",
      parentWindowId: 3,
    });

    expect(
      windows.windowShowing(3, { objectId: "paper-1", kind: "reader", assetId: "asset-1" }),
    ).toBe(7);
    expect(
      windows.windowShowing(3, { objectId: "paper-1", kind: "reader", assetId: "asset-2" }),
    ).toBeNull();
  });

  it("names the children a closing window has to close", () => {
    const windows = createDetachedWindows();
    windows.attach(7, { objectId: "note-1", kind: "document", parentWindowId: 3 });
    windows.attach(8, { objectId: "note-2", kind: "document", parentWindowId: 3 });
    windows.attach(9, { objectId: "note-3", kind: "document", parentWindowId: 4 });

    expect(windows.childrenOf(3).sort()).toEqual([7, 8]);
    expect(windows.childrenOf(4)).toEqual([9]);
    expect(windows.childrenOf(7)).toEqual([]);
  });

  it("forgets a window's children along with the window", () => {
    // Window ids are reused. An entry still naming a closed parent would make the next window
    // to take that id the parent of something it never opened.
    const windows = createDetachedWindows();
    windows.attach(7, { objectId: "note-1", kind: "document", parentWindowId: 3 });
    windows.attach(8, { objectId: "note-2", kind: "document", parentWindowId: 3 });

    windows.clearWindow(3);

    expect(windows.childrenOf(3)).toEqual([]);
    expect(windows.forWindow(7)).toBeNull();
    expect(windows.forWindow(8)).toBeNull();
  });

  it("forgets one detached window without disturbing its siblings", () => {
    const windows = createDetachedWindows();
    windows.attach(7, { objectId: "note-1", kind: "document", parentWindowId: 3 });
    windows.attach(8, { objectId: "note-2", kind: "document", parentWindowId: 3 });

    windows.clearWindow(7);

    expect(windows.forWindow(7)).toBeNull();
    expect(windows.childrenOf(3)).toEqual([8]);
  });
});
