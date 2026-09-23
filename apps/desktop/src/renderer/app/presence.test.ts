import { describe, expect, it } from "vitest";
import {
  PRESENCE_COLOURS,
  actorUserId,
  describePresence,
  initialsFrom,
  presenceColour,
  presentPeople,
  readingFrom,
  type PresenceMember,
  type PresenceRecord,
} from "./presence.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");

const MEMBERS: PresenceMember[] = [
  { user_id: "ada", display_name: "Ada Okonkwo", email: "ada@example.test" },
  { user_id: "wei", display_name: "Wei Chen", email: "wei@example.test" },
  { user_id: "sam", display_name: "", email: "sam.okoye@example.test" },
];

function record(actor: string, overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    actor_id: `account:${actor}`,
    sequence: 1,
    cursor: 0,
    expires_at: "2026-08-27T12:00:20.000Z",
    ...overrides,
  };
}

describe("reading a presence answer", () => {
  it("names people from the roster and leaves you out of your own answer", () => {
    // The endpoint records your presence in the same call that reports everyone else's, so you
    // are always in the answer it gives back.
    const people = presentPeople({
      records: [record("ada"), record("wei")],
      members: MEMBERS,
      selfUserId: "ada",
      now: NOW,
    });

    expect(people.map((person) => person.name)).toEqual(["Wei Chen"]);
  });

  it("drops somebody whose record has run out, ahead of the service noticing", () => {
    const people = presentPeople({
      records: [record("wei", { expires_at: "2026-08-27T11:59:59.000Z" }), record("sam")],
      members: MEMBERS,
      selfUserId: "ada",
      now: NOW,
    });

    expect(people.map((person) => person.userId)).toEqual(["sam"]);
  });

  it("treats an expiry it cannot read as expired rather than as forever", () => {
    expect(
      presentPeople({
        records: [record("wei", { expires_at: "soon" })],
        members: MEMBERS,
        selfUserId: "ada",
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("shows somebody the roster does not know, by address, and says it does not know them", () => {
    const people = presentPeople({
      records: [record("stranger")],
      members: MEMBERS,
      selfUserId: "ada",
      now: NOW,
    });

    expect(people).toEqual([
      expect.objectContaining({
        userId: "stranger",
        name: "Somebody not on the roster",
        named: false,
      }),
    ]);
  });

  it("falls back to the address for somebody who has not filled in a name", () => {
    const people = presentPeople({
      records: [record("sam")],
      members: MEMBERS,
      selfUserId: "ada",
      now: NOW,
    });

    expect(people[0]?.name).toBe("sam.okoye@example.test");
    expect(people[0]?.named).toBe(true);
  });

  it("lists one row per person even if the answer repeats one", () => {
    const people = presentPeople({
      records: [record("wei"), record("wei", { cursor: 40 })],
      members: MEMBERS,
      selfUserId: "ada",
      now: NOW,
    });

    expect(people).toHaveLength(1);
    expect(people[0]?.cursor).toBe(0);
  });

  it("sorts by name so the row does not reshuffle between polls", () => {
    const people = presentPeople({
      records: [record("wei"), record("sam"), record("ada")],
      members: MEMBERS,
      selfUserId: null,
      now: NOW,
    });

    expect(people.map((person) => person.name)).toEqual([
      "Ada Okonkwo",
      "sam.okoye@example.test",
      "Wei Chen",
    ]);
  });

  it("reads the account prefix off an actor, which the roster does not carry", () => {
    expect(actorUserId("account:ada")).toBe("ada");
    expect(actorUserId("ada")).toBe("ada");
  });
});

describe("an answer that did not arrive", () => {
  it("shows nobody rather than the last people who were there", () => {
    expect(
      readingFrom({ status: "error" }, { members: MEMBERS, selfUserId: "ada", now: NOW }),
    ).toEqual({ state: "unknown", people: [] });
  });

  it("is not the same as an answer that nobody is here", () => {
    const empty = readingFrom(
      { status: "present", collaborators: [record("ada")] },
      { members: MEMBERS, selfUserId: "ada", now: NOW },
    );

    expect(empty).toEqual({ state: "here", people: [] });
  });

  it("reads an answer that did arrive", () => {
    const reading = readingFrom(
      { status: "present", collaborators: [record("wei")] },
      { members: MEMBERS, selfUserId: "ada", now: NOW },
    );

    expect(reading.state).toBe("here");
    expect(reading.people.map((person) => person.name)).toEqual(["Wei Chen"]);
  });
});

describe("telling people apart", () => {
  it("gives one person the same colour every time and every window", () => {
    expect(presenceColour("wei")).toBe(presenceColour("wei"));
    expect(PRESENCE_COLOURS).toContain(presenceColour("wei"));
  });

  it("takes initials from the ends of a name", () => {
    expect(initialsFrom("Ada Okonkwo")).toBe("AO");
    expect(initialsFrom("Maria del Carmen Ruiz")).toBe("MR");
  });

  it("takes two letters from a single word, and something from an address", () => {
    expect(initialsFrom("Wei")).toBe("WE");
    expect(initialsFrom("sam.okoye@example.test")).toBe("ST");
  });

  it("has an answer for a name with nothing in it", () => {
    expect(initialsFrom("   ")).toBe("?");
  });
});

describe("saying who is here in words", () => {
  function people(...names: string[]) {
    return names.map((name) => ({
      userId: name,
      name,
      initials: "??",
      colour: "#000000",
      cursor: 0,
      named: true,
    }));
  }

  it("says nobody plainly", () => {
    expect(describePresence([])).toBe("Nobody else has this document open.");
  });

  it("says one person", () => {
    expect(describePresence(people("Wei Chen"))).toBe("Wei Chen also has this document open.");
  });

  it("joins two with and", () => {
    expect(describePresence(people("Ada", "Wei"))).toBe(
      "Ada and Wei also have this document open.",
    );
  });

  it("counts the rest once there are more names than anybody reads", () => {
    expect(describePresence(people("Ada", "Wei", "Sam", "Lin", "Ola"))).toBe(
      "Ada, Wei, Sam, and 2 others also have this document open.",
    );
    expect(describePresence(people("Ada", "Wei", "Sam", "Lin"))).toBe(
      "Ada, Wei, Sam, and 1 other also have this document open.",
    );
  });
});
