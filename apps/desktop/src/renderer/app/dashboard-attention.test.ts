import { describe, expect, it } from "vitest";
import { NOTHING_WAITING, attentionRows, type AttentionMember } from "./dashboard-attention.js";

const MEMBERS: ReadonlyMap<string, AttentionMember> = new Map([
  ["paper-1", { title: "Smith 2024", type: "source" }],
  ["note-1", { title: "Reading notes", type: "note" }],
]);

function conflict(over: Record<string, unknown> = {}) {
  return { id: "conflict-1", object_id: "paper-1", status: "unresolved", ...over };
}

function thread(over: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    title: "About the method",
    thread: { anchor: { object_id: "note-1" } },
    ...over,
  };
}

describe("what is wrong in this project", () => {
  it("names the object rather than counting the problems", () => {
    const rows = attentionRows({ conflicts: [conflict()], threads: [], members: MEMBERS });

    expect(rows).toEqual([
      {
        id: "conflict-1",
        kind: "conflict",
        objectId: "paper-1",
        objectType: "source",
        title: "Smith 2024",
        what: "Two versions of this. Choose which one stands.",
      },
    ]);
  });

  it("puts a conflict above a comment", () => {
    // One is waiting on a decision about the work; the other is waiting on a reply about it.
    const rows = attentionRows({
      conflicts: [conflict()],
      threads: [thread()],
      members: MEMBERS,
    });

    expect(rows.map((row) => row.kind)).toEqual(["conflict", "comment"]);
  });

  it("leaves out a conflict that has been settled", () => {
    const rows = attentionRows({
      conflicts: [conflict({ status: "resolved" })],
      threads: [],
      members: MEMBERS,
    });

    expect(rows).toEqual([]);
  });

  it("leaves out what is wrong somewhere else in the workspace", () => {
    const rows = attentionRows({
      conflicts: [conflict({ object_id: "paper-9" })],
      threads: [thread({ thread: { anchor: { object_id: "note-9" } } })],
      members: MEMBERS,
    });

    expect(rows).toEqual([]);
  });

  it("leaves out a comment anchored to nothing it can name", () => {
    const rows = attentionRows({
      conflicts: [],
      threads: [thread({ thread: {} })],
      members: MEMBERS,
    });

    expect(rows).toEqual([]);
  });
});

describe("the panel with nothing in it", () => {
  it("says nothing is waiting rather than disappearing", () => {
    expect(NOTHING_WAITING).toBe("Nothing is waiting on you.");
  });
});
