import { describe, expect, it } from "vitest";
import { projectFeed, type FeedMember } from "./dashboard-activity.js";
import type { RawEvent } from "./history-log.js";

function event(over: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "event-1",
    event_type: "object.saved",
    occurred_at: "2026-08-27T14:30:00.000Z",
    actor: "account:ana",
    transaction_id: "transaction-1",
    object_ids: ["paper-1"],
    object_type: "source",
    version: 2,
    reason: null,
    ...over,
  };
}

const MEMBERS: ReadonlyMap<string, FeedMember> = new Map([
  ["paper-1", { title: "Smith 2024", type: "source" }],
  ["note-1", { title: "Reading notes", type: "note" }],
]);

describe("what has been happening in this project", () => {
  it("leaves out what happened somewhere else in the workspace", () => {
    const feed = projectFeed(
      [event(), event({ id: "elsewhere", object_ids: ["paper-9"] })],
      MEMBERS,
      8,
    );

    expect(feed.events.map((entry) => entry.id)).toEqual(["event-1"]);
    expect(feed.matched).toBe(1);
  });

  it("keeps an event that touched this project among others", () => {
    const feed = projectFeed([event({ object_ids: ["paper-9", "note-1"] })], MEMBERS, 8);

    expect(feed.events).toHaveLength(1);
  });

  it("counts what belongs here even when it shows fewer", () => {
    const feed = projectFeed(
      [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })],
      MEMBERS,
      2,
    );

    expect(feed.events).toHaveLength(2);
    expect(feed.matched).toBe(3);
  });

  it("says nothing rather than everything when the project holds nothing yet", () => {
    const feed = projectFeed([event()], new Map(), 8);

    expect(feed.events).toEqual([]);
    expect(feed.matched).toBe(0);
  });
});
