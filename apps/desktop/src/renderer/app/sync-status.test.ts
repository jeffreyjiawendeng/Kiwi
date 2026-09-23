import { describe, expect, it } from "vitest";
import type { RendererWorkspaceSyncStatusResult } from "./bridge.js";
import { pendingLines, standingFrom } from "./sync-status.js";

const NOW = new Date("2026-08-27T09:10:00.000Z");

function known(
  over: Partial<Extract<RendererWorkspaceSyncStatusResult, { status: "known" }>> = {},
): RendererWorkspaceSyncStatusResult {
  return {
    status: "known",
    connection: "online",
    working_offline: false,
    pending: { registrations: 0, structured_changes: 0, document_operations: 0, total: 0 },
    conflicts: 0,
    last_succeeded_at: "2026-08-27T09:09:30.000Z",
    last_failure: null,
    ...over,
  };
}

function pending(over: {
  registrations?: number;
  structured_changes?: number;
  document_operations?: number;
}) {
  const counts = {
    registrations: over.registrations ?? 0,
    structured_changes: over.structured_changes ?? 0,
    document_operations: over.document_operations ?? 0,
  };
  return {
    ...counts,
    total: counts.registrations + counts.structured_changes + counts.document_operations,
  };
}

describe("offline on purpose", () => {
  it("does not tell somebody to wait for a connection they switched off", () => {
    const standing = standingFrom(known({ connection: "offline", working_offline: true }), NOW);

    expect(standing?.state).toBe("offline");
    expect(standing?.summary).toContain("go back online on Home");
    expect(standing?.summary).not.toContain("when the connection comes back");
  });

  it("says how much is waiting on that decision", () => {
    const standing = standingFrom(
      known({
        connection: "offline",
        working_offline: true,
        pending: pending({ structured_changes: 3 }),
      }),
      NOW,
    );

    expect(standing?.summary).toBe(
      "3 changes are waiting here because Kiwi is set to work offline. They go out when you go back online on Home.",
    );
  });

  it("still waits for the connection when nobody chose this", () => {
    const standing = standingFrom(known({ connection: "offline" }), NOW);

    expect(standing?.summary).toContain("when the connection comes back");
  });
});

describe("which of the four states this is", () => {
  it("is synchronized when the service is reachable and nothing is waiting", () => {
    expect(standingFrom(known(), NOW)?.state).toBe("synchronized");
  });

  it("is syncing while something is waiting to be sent", () => {
    const standing = standingFrom(known({ pending: pending({ structured_changes: 3 }) }), NOW);

    expect(standing?.state).toBe("syncing");
    expect(standing?.summary).toContain("3 changes are on the way");
  });

  it("is offline when the service cannot be reached, even with nothing waiting", () => {
    // The state most likely to be mistaken for synchronized and the furthest from it: an empty
    // queue because everything went through, against an empty queue because nothing was asked.
    const standing = standingFrom(known({ connection: "offline" }), NOW);

    expect(standing?.state).toBe("offline");
    expect(standing?.summary).toContain("not being shared right now");
  });

  it("says that offline work is kept rather than lost", () => {
    const standing = standingFrom(
      known({ connection: "offline", pending: pending({ document_operations: 12 }) }),
      NOW,
    );

    expect(standing?.summary).toContain("12 changes are waiting");
    expect(standing?.summary).toContain("Nothing is lost");
  });

  it("says conflicts first, because they are the only state that needs a person", () => {
    const standing = standingFrom(
      known({ connection: "offline", conflicts: 2, pending: pending({ structured_changes: 4 }) }),
      NOW,
    );

    expect(standing?.state).toBe("conflicted");
    expect(standing?.label).toBe("Conflicts");
    expect(standing?.summary).toContain("2 saves were refused");
  });

  it("counts one of something without saying ones", () => {
    expect(standingFrom(known({ conflicts: 1 }), NOW)?.summary).toContain("1 save was refused");
  });

  it("has nothing to say when nobody is signed in or no workspace is open", () => {
    // Not a resting state. A status that reads "synchronized" because nothing is being asked is
    // the one thing this must never do.
    expect(standingFrom({ status: "unknown" }, NOW)).toBeNull();
  });
});

describe("what the detail says", () => {
  it("lists what is waiting, registration first", () => {
    expect(
      pendingLines({ registrations: 1, structured_changes: 2, document_operations: 40 }),
    ).toEqual([
      { label: "Registering this workspace", count: 1 },
      { label: "Saved changes", count: 2 },
      { label: "Edits in shared documents", count: 40 },
    ]);
  });

  it("leaves out the kinds with nothing waiting", () => {
    expect(
      pendingLines({ registrations: 0, structured_changes: 2, document_operations: 0 }),
    ).toEqual([{ label: "Saved changes", count: 2 }]);
  });

  it("says when it last got through", () => {
    expect(standingFrom(known(), NOW)?.lastSuccess).toBe("Last synchronized a moment ago.");
  });

  it("says that a fresh window has not synchronized rather than showing an older time", () => {
    expect(standingFrom(known({ last_succeeded_at: null }), NOW)?.lastSuccess).toBe(
      "Nothing has been synchronized since this window opened.",
    );
  });

  it("reports the reason the last attempt gave, with when it was", () => {
    const standing = standingFrom(
      known({
        last_failure: {
          at: "2026-08-27T09:05:00.000Z",
          reason: "Workspace synchronization is unavailable.",
        },
      }),
      NOW,
    );

    expect(standing?.failure).toBe(
      "Last tried 5 minutes ago. Workspace synchronization is unavailable.",
    );
  });

  it("has no failure to report when the last attempt got through", () => {
    expect(standingFrom(known(), NOW)?.failure).toBeNull();
  });
});
