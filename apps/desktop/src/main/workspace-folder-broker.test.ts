import { describe, expect, it } from "vitest";
import { createWorkspaceFolderBroker } from "./workspace-folder-broker.js";

describe("workspace folder broker", () => {
  it("issues a one-use selection scoped to the choosing window", () => {
    const broker = createWorkspaceFolderBroker({ newId: () => "selection-1", now: () => 100 });
    const selection = broker.issue(3, "C:\\Research\\Trial", true);

    expect(selection).toEqual({
      id: "selection-1",
      displayPath: "C:\\Research\\Trial",
      suggestedTitle: "Trial",
      hasExistingContents: true,
    });
    expect(broker.consume(4, selection.id)).toBeNull();
    expect(broker.consume(3, selection.id)).toBe("C:\\Research\\Trial");
    expect(broker.consume(3, selection.id)).toBeNull();
  });

  it("expires and clears selections without exposing their paths", () => {
    let now = 100;
    let nextId = 0;
    const broker = createWorkspaceFolderBroker({
      newId: () => `selection-${(nextId += 1)}`,
      now: () => now,
      lifetimeMs: 10,
    });

    const expired = broker.issue(3, "C:\\Research\\Expired", false);
    now = 111;
    expect(broker.consume(3, expired.id)).toBeNull();

    const closed = broker.issue(3, "C:\\Research\\Closed", false);
    broker.clearWindow(3);
    expect(broker.consume(3, closed.id)).toBeNull();
  });
});
