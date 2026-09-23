import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RemoteCarets } from "./RemoteCarets.js";
import type { CaretSpot } from "./caret-spots.js";
import type { RemoteCaret } from "./remote-carets.js";

afterEach(cleanup);

function caret(userId: string, offset: number, labelled = true): RemoteCaret {
  return { userId, name: `${userId} the reader`, colour: "#159078", offset, labelled };
}

/** Stands in for the browser, which lays nothing out under jsdom. Row per line, column per pixel. */
function ruler(offset: number): CaretSpot | null {
  if (offset > 100) return null;
  return { left: offset, top: 20, height: 18 };
}

function marks(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".remote-caret")];
}

describe("drawing everybody else's caret", () => {
  it("draws nothing at all when nobody else is here", () => {
    const { container } = render(<RemoteCarets carets={[]} locate={ruler} />);

    expect(container.querySelector(".remote-carets")).toBeNull();
  });

  it("draws one mark per person, where they are, in their own colour", () => {
    render(<RemoteCarets carets={[caret("ada", 40), caret("bo", 12)]} locate={ruler} />);

    expect(marks().map((mark) => mark.dataset["person"])).toEqual(["ada", "bo"]);
    expect(marks()[0]?.style.left).toBe("40px");
    expect(marks()[0]?.style.top).toBe("20px");
    expect(marks()[0]?.style.background).toBe("rgb(21, 144, 120)");
  });

  it("names them", () => {
    render(<RemoteCarets carets={[caret("ada", 40)]} locate={ruler} />);

    expect(screen.getByText("ada the reader")).toBeTruthy();
  });

  it("draws nobody whose caret does not land anywhere in this copy of the document", () => {
    render(<RemoteCarets carets={[caret("ada", 40), caret("bo", 4_000)]} locate={ruler} />);

    expect(marks().map((mark) => mark.dataset["person"])).toEqual(["ada"]);
  });

  it("keeps a faded name out of the way rather than taking it down", () => {
    // Out of the way and still in the tree: a name that disappeared would take the caret's own
    // width with it on the way out and the mark would jump.
    render(<RemoteCarets carets={[caret("ada", 40, false)]} locate={ruler} />);

    const name = screen.getByText("ada the reader");
    expect(name.className).toContain("remote-caret__name--gone");
  });

  it("says nothing to a screen reader, because the top bar already has", () => {
    const { container } = render(<RemoteCarets carets={[caret("ada", 40)]} locate={ruler} />);

    expect(container.querySelector(".remote-carets")?.getAttribute("aria-hidden")).toBe("true");
  });
});
