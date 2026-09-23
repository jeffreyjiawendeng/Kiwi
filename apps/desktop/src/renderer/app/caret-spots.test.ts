import { afterEach, describe, expect, it } from "vitest";
import { spotInText, textPointAt } from "./caret-spots.js";

/**
 * Nothing here measures pixels. jsdom lays nothing out, so every rectangle it reports is empty,
 * and a test that asserted a position would be asserting the shape of the stub. What is tested is
 * the part that decides which character an offset is: the walk. Where that character is on the
 * screen is the browser's answer, and there is no honest way to check it here.
 */

let box: HTMLElement | null = null;

afterEach(() => {
  box?.remove();
  box = null;
});

/** The painting: coloured runs, with markers between some of them that hold no text. */
function painting(...runs: string[]): HTMLElement {
  const host = document.createElement("pre");
  for (const run of runs) {
    host.append(document.createElement("i"));
    const span = document.createElement("span");
    span.textContent = run;
    host.append(span);
  }
  document.body.append(host);
  box = host;
  return host;
}

describe("the character an offset is", () => {
  it("finds one inside a run", () => {
    const point = textPointAt(painting("hello", " world"), 2);

    expect(point?.node.data).toBe("hello");
    expect(point?.offset).toBe(2);
  });

  it("counts across runs, so the colouring makes no difference to the answer", () => {
    const point = textPointAt(painting("hello", " world"), 8);

    expect(point?.node.data).toBe(" world");
    expect(point?.offset).toBe(3);
  });

  it("puts a caret on a seam at the end of the run before it", () => {
    // The same place either way. Reached from the side that already exists.
    const point = textPointAt(painting("hello", " world"), 5);

    expect(point?.node.data).toBe("hello");
    expect(point?.offset).toBe(5);
  });

  it("sits at the very end of the text", () => {
    const point = textPointAt(painting("hello"), 5);

    expect(point?.offset).toBe(5);
  });

  it("is nowhere past the end", () => {
    // Somebody whose copy of the document is longer than this one. Drawing their caret at the end
    // would be inventing a position rather than reporting one.
    expect(textPointAt(painting("hello"), 6)).toBeNull();
  });

  it("is nowhere before the beginning, and nowhere for a number that is not one", () => {
    expect(textPointAt(painting("hello"), -1)).toBeNull();
    expect(textPointAt(painting("hello"), Number.NaN)).toBeNull();
  });

  it("is nowhere at all in an empty painting", () => {
    expect(textPointAt(painting(), 0)).toBeNull();
  });
});

describe("where that character is", () => {
  it("has no place for an offset the text does not reach", () => {
    const host = painting("hello");

    expect(spotInText(host, host, 40)).toBeNull();
  });

  it("has a place for one it does", () => {
    const host = painting("hello");

    expect(spotInText(host, host, 3)).not.toBeNull();
  });
});
