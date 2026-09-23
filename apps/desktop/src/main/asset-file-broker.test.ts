import { describe, expect, it } from "vitest";
import { createAssetFileBroker } from "./asset-file-broker.js";

describe("managed asset file broker", () => {
  it("returns metadata without the path and consumes the path once in the choosing window", () => {
    const broker = createAssetFileBroker({ newId: () => "selection-1", now: () => 100 });
    const selection = broker.issue({
      windowId: 3,
      path: "C:\\Research\\private\\notes.txt",
      name: "notes.txt",
      size: 42,
      modifiedAt: "2026-08-22T12:00:00.000Z",
      declaredMediaType: "text/plain",
    });

    expect(selection).toEqual({
      id: "selection-1",
      name: "notes.txt",
      size: 42,
      modifiedAt: "2026-08-22T12:00:00.000Z",
      declaredMediaType: "text/plain",
    });
    expect(JSON.stringify(selection)).not.toContain("private");
    expect(broker.consume(4, selection.id)).toBeNull();
    expect(broker.consume(3, selection.id)).toEqual({
      path: "C:\\Research\\private\\notes.txt",
      declaredMediaType: "text/plain",
    });
    expect(broker.consume(3, selection.id)).toBeNull();
  });

  it("looks at a selection as often as asked without spending it", () => {
    // Reading a picked file back is not importing it: the review table may open the same file
    // twice, and either time it is still waiting to be taken.
    const broker = createAssetFileBroker({ newId: () => "selection-1", now: () => 100 });
    const selection = broker.issue({
      windowId: 3,
      path: "C:\\Research\\paper.pdf",
      name: "paper.pdf",
      size: 42,
      modifiedAt: "2026-08-22T12:00:00.000Z",
      declaredMediaType: "application/pdf",
    });

    const looked = { path: "C:\\Research\\paper.pdf", declaredMediaType: "application/pdf" };
    expect(broker.peek(selection.id)).toEqual(looked);
    expect(broker.peek(selection.id)).toEqual(looked);
    expect(broker.consume(3, selection.id)).toEqual(looked);
    expect(broker.peek(selection.id)).toBeNull();
  });

  it("stops looking at a selection once it has expired", () => {
    let now = 100;
    const broker = createAssetFileBroker({
      newId: () => "selection-1",
      now: () => now,
      lifetimeMs: 10,
    });
    const selection = broker.issue({
      windowId: 3,
      path: "C:\\Research\\paper.pdf",
      name: "paper.pdf",
      size: 42,
      modifiedAt: "2026-08-22T12:00:00.000Z",
      declaredMediaType: "application/pdf",
    });

    now = 111;
    expect(broker.peek(selection.id)).toBeNull();
  });

  it("expires and clears unused handles", () => {
    let now = 100;
    let sequence = 0;
    const broker = createAssetFileBroker({
      newId: () => `selection-${(sequence += 1)}`,
      now: () => now,
      lifetimeMs: 10,
    });
    const input = {
      windowId: 3,
      path: "C:\\Research\\notes.txt",
      name: "notes.txt",
      size: 42,
      modifiedAt: "2026-08-22T12:00:00.000Z",
      declaredMediaType: null,
    };
    const expired = broker.issue(input);
    now = 111;
    expect(broker.consume(3, expired.id)).toBeNull();
    const closed = broker.issue(input);
    broker.clearWindow(3);
    expect(broker.consume(3, closed.id)).toBeNull();
  });
});
