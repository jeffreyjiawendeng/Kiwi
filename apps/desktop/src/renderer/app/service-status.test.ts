import { describe, expect, it } from "vitest";
import { offlineExplanation, serviceRows, type ServiceRow } from "./service-status.js";
import type { SyncStanding } from "./sync-status.js";

function standing(over: Partial<SyncStanding> = {}): SyncStanding {
  return {
    state: "synchronized",
    label: "Synchronized",
    summary: "Everything written here has reached everybody else in this workspace.",
    pending: [],
    lastSuccess: "Last synchronized 2 minutes ago.",
    failure: null,
    ...over,
  };
}

function rows(over: Partial<Parameters<typeof serviceRows>[0]> = {}): Record<string, ServiceRow> {
  const list = serviceRows({
    service: { status: "ready" },
    runtime: { worker: "running", workerRestarts: 0, commandsInFlight: 0, rendererFailure: null },
    sharing: standing(),
    offline: false,
    ...over,
  });
  return Object.fromEntries(list.map((row) => [row.name, row]));
}

describe("what Kiwi's background parts are doing", () => {
  it("says all three are working when they are", () => {
    const answer = rows();

    expect(answer["Kiwi's service"]).toEqual({
      name: "Kiwi's service",
      state: "working",
      detail: "Reachable.",
    });
    expect(answer["Background worker"]?.state).toBe("working");
    expect(answer["Sharing"]?.state).toBe("working");
  });

  it("does not call an unreachable service a stopped one", () => {
    // Local-first: the work is on disk and nothing about it has stopped.
    const answer = rows({ service: { status: "unavailable", retryable: true } });

    expect(answer["Kiwi's service"]?.state).toBe("waiting");
    expect(answer["Kiwi's service"]?.detail).toContain("saved on this machine either way");
  });

  it("says the service is not being contacted rather than unreachable when that was chosen", () => {
    const answer = rows({ offline: true, service: { status: "unavailable", retryable: true } });

    expect(answer["Kiwi's service"]?.detail).toBe(
      "Not being contacted, because Kiwi is set to work offline.",
    );
  });

  it("distinguishes a worker that restarted from one that gave up", () => {
    const restarted = rows({
      runtime: { worker: "running", workerRestarts: 2, commandsInFlight: 0, rendererFailure: null },
    });
    const gone = rows({
      runtime: { worker: "failed", workerRestarts: 5, commandsInFlight: 0, rendererFailure: null },
    });

    expect(restarted["Background worker"]).toMatchObject({
      state: "working",
      detail: "Running. It has restarted 2 times since Kiwi started.",
    });
    expect(gone["Background worker"]?.state).toBe("stopped");
    expect(gone["Background worker"]?.detail).toContain("Kiwi keeps working without it");
  });

  it("counts one restart as one", () => {
    const answer = rows({
      runtime: { worker: "running", workerRestarts: 1, commandsInFlight: 0, rendererFailure: null },
    });

    expect(answer["Background worker"]?.detail).toContain("restarted 1 time since");
  });

  it("says it has not looked yet rather than guessing", () => {
    const answer = rows({ service: null, runtime: null });

    expect(answer["Kiwi's service"]?.detail).toBe("Kiwi has not checked yet.");
    expect(answer["Background worker"]?.detail).toBe("Kiwi has not checked yet.");
  });

  it("carries the sharing sentence rather than writing a second one", () => {
    const answer = rows({
      sharing: standing({ state: "offline", summary: "Nothing is being sent right now." }),
    });

    expect(answer["Sharing"]).toEqual({
      name: "Sharing",
      state: "waiting",
      detail: "Nothing is being sent right now.",
    });
  });

  it("treats a conflict as the one thing that will not clear itself", () => {
    const answer = rows({ sharing: standing({ state: "conflicted", summary: "Choose one." }) });

    expect(answer["Sharing"]?.state).toBe("stopped");
  });

  it("still has a line for sharing when there is nothing to share", () => {
    const answer = rows({ sharing: null });

    expect(answer["Sharing"]?.detail).toBe("Nothing to share from this window yet.");
  });
});

describe("what the offline switch says it will do", () => {
  it("says what turning it off would restore", () => {
    expect(offlineExplanation(true)).toContain("goes out when you turn this off");
  });

  it("says what turning it on would stop", () => {
    expect(offlineExplanation(false)).toContain("keep this machine to itself");
  });
});
