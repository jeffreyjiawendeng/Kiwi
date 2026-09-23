import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PresenceAvatars } from "./PresenceAvatars.js";
import { presentPeople, type PresenceMember, type PresenceRecord } from "./presence.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");

const MEMBERS: PresenceMember[] = [
  { user_id: "ada", display_name: "Ada Okonkwo", email: "ada@example.test" },
  { user_id: "wei", display_name: "Wei Chen", email: "wei@example.test" },
  { user_id: "sam", display_name: "Sam Okoye", email: "sam@example.test" },
  { user_id: "raj", display_name: "Raj Patel", email: "raj@example.test" },
  { user_id: "mia", display_name: "Mia Fournier", email: "mia@example.test" },
];

function record(actor: string): PresenceRecord {
  return {
    actor_id: `account:${actor}`,
    sequence: 1,
    cursor: 0,
    expires_at: "2026-08-27T12:00:20.000Z",
  };
}

function people(...actors: string[]) {
  return presentPeople({
    records: actors.map(record),
    members: MEMBERS,
    selfUserId: "ada",
    now: NOW,
  });
}

afterEach(cleanup);

describe("the presence row", () => {
  it("draws nothing at all when nobody else is here", () => {
    const { container } = render(<PresenceAvatars people={[]} />);

    // A workspace of one would otherwise carry a permanent empty fixture saying nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it("says who is here in the name a screen reader reads", () => {
    render(<PresenceAvatars people={people("wei", "sam")} />);

    expect(screen.getByRole("group")).toHaveAccessibleName(
      "Sam Okoye and Wei Chen also have this document open.",
    );
  });

  it("shows initials, one colour each, and the name on hover", () => {
    render(<PresenceAvatars people={people("wei", "sam")} />);
    const shown = screen.getByRole("group").querySelectorAll(".presence__person");

    expect([...shown].map((node) => node.textContent)).toEqual(["SO", "WC"]);
    expect([...shown].map((node) => node.getAttribute("title"))).toEqual(["Sam Okoye", "Wei Chen"]);
  });

  it("counts the rest rather than filling the bar with faces", () => {
    render(<PresenceAvatars people={people("wei", "sam", "raj", "mia")} />);

    expect(screen.getByRole("group").querySelectorAll(".presence__person")).toHaveLength(3);
    const more = screen.getByRole("group").querySelector(".presence__more");
    expect(more?.textContent).toBe("+1");
    expect(more?.getAttribute("title")).toBe("Wei Chen");
  });

  it("marks somebody the roster has not caught up with rather than hiding them", () => {
    render(
      <PresenceAvatars
        people={presentPeople({
          records: [record("new-hire")],
          members: MEMBERS,
          selfUserId: "ada",
          now: NOW,
        })}
      />,
    );

    const shown = screen.getByRole("group").querySelector(".presence__person");
    expect(shown).toHaveAttribute("data-unnamed");
    expect(shown).toHaveAttribute("title", "Somebody not on the roster");
  });
});
