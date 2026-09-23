import { describe, expect, it } from "vitest";
import {
  describeCount,
  nameActor,
  readLog,
  readRow,
  shortActor,
  type RawEvent,
} from "./history-log.js";

const NOW = new Date("2026-08-27T15:00:00.000Z");

function event(over: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "event-1",
    event_type: "object.saved",
    occurred_at: "2026-08-27T14:30:00.000Z",
    actor: "account:ana",
    transaction_id: "transaction-1",
    object_ids: ["object-1"],
    object_type: "note",
    version: 3,
    reason: null,
    ...over,
  };
}

const TITLES = new Map([
  ["object-1", "Interview notes"],
  ["object-2", "Field report"],
]);

describe("one thing that happened, as a row", () => {
  it("says what was done in words rather than as an event type", () => {
    const row = readRow(event(), TITLES, NOW);

    expect(row?.action).toBe("object saved");
    expect(row?.who).toBe("ana");
    expect(row?.version).toBe(3);
  });

  it("names what it was about, because an identifier is not an answer", () => {
    const row = readRow(event(), TITLES, NOW);

    expect(row?.subject).toEqual({ objectId: "object-1", title: "Interview notes" });
  });

  it("keeps the row when what it was about is no longer here", () => {
    // An object that was trashed and purged leaves its events behind. What happened still
    // happened, and dropping the line would make the log a record of what survived.
    const row = readRow(event({ object_ids: ["object-9"] }), TITLES, NOW);

    expect(row?.subject).toEqual({ objectId: "object-9", title: "Something no longer here" });
  });

  it("counts the others an event touched rather than listing them in the row", () => {
    const row = readRow(event({ object_ids: ["object-1", "object-2", "object-3"] }), TITLES, NOW);

    expect(row?.subject?.title).toBe("Interview notes");
    expect(row?.alsoTouched).toBe(2);
  });

  it("has no subject when the event named no object", () => {
    const row = readRow(event({ object_ids: [] }), TITLES, NOW);

    expect(row?.subject).toBeNull();
    expect(row?.alsoTouched).toBe(0);
  });

  it("drops an event whose time cannot be read rather than printing a broken one", () => {
    expect(readRow(event({ occurred_at: "not a time" }), TITLES, NOW)).toBeNull();
  });
});

describe("names in the log", () => {
  it("drops the prefix nobody says out loud", () => {
    expect(shortActor("account:ana")).toBe("ana");
  });

  it("leaves an identifier it does not recognise alone", () => {
    expect(shortActor("system")).toBe("system");
  });
});

describe("reading the log down", () => {
  it("groups by day, because that is how somebody remembers when", () => {
    const days = readLog(
      [
        event({ id: "a", occurred_at: "2026-08-27T14:30:00.000Z" }),
        event({ id: "b", occurred_at: "2026-08-27T09:00:00.000Z" }),
        event({ id: "c", occurred_at: "2026-08-26T09:00:00.000Z" }),
        event({ id: "d", occurred_at: "2026-08-20T09:00:00.000Z" }),
      ],
      TITLES,
      NOW,
    );

    expect(days.map((day) => day.heading).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(days[0]?.rows).toHaveLength(2);
    expect(days).toHaveLength(3);
  });

  it("keeps the order it was given inside a day", () => {
    const days = readLog(
      [
        event({ id: "newer", occurred_at: "2026-08-27T14:30:00.000Z" }),
        event({ id: "older", occurred_at: "2026-08-27T09:00:00.000Z" }),
      ],
      TITLES,
      NOW,
    );

    expect(days[0]?.rows.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("has no days when nothing happened", () => {
    expect(readLog([], TITLES, NOW)).toEqual([]);
  });
});

describe("how much of the log is on the page", () => {
  it("says the total whether or not anything was left out", () => {
    expect(describeCount(3, 3)).toBe("3 things have happened.");
    expect(describeCount(1, 1)).toBe("One thing has happened.");
  });

  it("says both numbers when it had to cut the list", () => {
    expect(describeCount(200, 4318)).toBe("Showing the most recent 200 of 4318.");
  });

  it("says nothing has happened rather than showing a zero", () => {
    expect(describeCount(0, 0)).toBe("Nothing has happened here yet that Kiwi recorded.");
  });
});

describe("what a row is about when an event touched several things", () => {
  it("names the first object it knows, so a mark's row names the paper it is on", () => {
    const row = readRow(event({ object_ids: ["mark-1", "object-2"] }), TITLES, NOW);
    expect(row?.subject).toEqual({ objectId: "object-2", title: "Field report" });
  });

  it("still counts the others from the first, whichever one it named", () => {
    const row = readRow(event({ object_ids: ["mark-1", "object-2"] }), TITLES, NOW);
    expect(row?.alsoTouched).toBe(1);
  });

  it("says so of the first when it knows none of them", () => {
    const row = readRow(event({ object_ids: ["mark-1", "mark-2"] }), TITLES, NOW);
    expect(row?.subject).toEqual({ objectId: "mark-1", title: "Something no longer here" });
  });
});

describe("naming people", () => {
  const PEOPLE = new Map([["ana", "Ana Lindqvist"]]);

  it("uses the name the roster gives an account", () => {
    expect(nameActor("account:ana", PEOPLE)).toBe("Ana Lindqvist");
  });

  it("falls back to the identifier for somebody the roster has never heard of", () => {
    expect(nameActor("account:ben", PEOPLE)).toBe("ben");
    expect(nameActor("account:ben")).toBe("ben");
  });

  it("is what a row says under who", () => {
    expect(readRow(event(), TITLES, NOW, PEOPLE)?.who).toBe("Ana Lindqvist");
    expect(readLog([event()], TITLES, NOW, PEOPLE)[0]?.rows[0]?.who).toBe("Ana Lindqvist");
  });
});
