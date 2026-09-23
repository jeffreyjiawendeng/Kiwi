import { describe, expect, it } from "vitest";
import { APPLICATION_TITLE, windowTitle } from "./window-title.js";

describe("what a window calls itself", () => {
  it("says what it was opened to show, and whose window it is", () => {
    expect(windowTitle("Method notes")).toBe("Method notes - Kiwi");
  });

  it("is the application's name when there is nothing to name it after", () => {
    // An untitled note would otherwise give a window called "Untitled", which says less than
    // "Kiwi" does and takes longer to read.
    expect(windowTitle(null)).toBe(APPLICATION_TITLE);
    expect(windowTitle("   ")).toBe(APPLICATION_TITLE);
  });

  it("does not keep the spaces a title was saved with", () => {
    expect(windowTitle("  Method notes  ")).toBe("Method notes - Kiwi");
  });
});
