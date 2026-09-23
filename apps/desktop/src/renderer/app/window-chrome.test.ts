import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The window has no frame of its own, so minimize, maximize and close are drawn by the top bar.
 * Anything laid over the whole window covers them, and a window whose close button is under a
 * backdrop can only be closed from the taskbar. Two dialogs did exactly that.
 *
 * jsdom loads no stylesheet, so this reads the rules instead: every fixed overlay has to start
 * below the title bar. The top bar itself is the one thing allowed to reach the top edge.
 */

const CSS = readFileSync(join(import.meta.dirname, "shell.css"), "utf8");

/** Each rule in the stylesheet, as its selector and the declarations inside it. */
function rules(): Array<{ selector: string; body: string }> {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
    body: match[2] ?? "",
  }));
}

describe("the window controls", () => {
  it("are never covered by anything laid over the window", () => {
    const covering = rules()
      .filter((rule) => /position:\s*fixed/.test(rule.body))
      .filter((rule) => /inset:\s*0[;\s]/.test(rule.body))
      .map((rule) => rule.selector)
      .filter((selector) => !selector.endsWith(".topbar"));

    expect(covering).toEqual([]);
  });

  it("keep the title bar's height clear at the top of the window", () => {
    // The height every overlay starts below, and the one the page area is pushed down by.
    expect(CSS).toMatch(/--titlebar-height:\s*44px/);
  });
});
