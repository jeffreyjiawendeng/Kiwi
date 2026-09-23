/**
 * What Kiwi's background parts are doing, said on Home rather than only when one of them breaks.
 *
 * There is already a notice for a worker that crashed and an indicator for a workspace that is
 * not reaching anybody. Neither answers the question somebody actually asks, which is "is this
 * thing working?" -- a page that says nothing is indistinguishable from a page that has not
 * checked, and the moment to find out that the service has been unreachable all afternoon is not
 * the moment somebody needs it.
 *
 * None of these are failures in the ordinary sense. Kiwi is local-first: the workspace on disk is
 * the real one, and every row here describes something that makes Kiwi *more* than that. So the
 * wording says what is true and what it costs, and never suggests that work has stopped when it
 * has not.
 */

import type { RendererAccountServiceStatus, RendererRuntimeHealth } from "./bridge.js";
import type { SyncStanding } from "./sync-status.js";

/** Working: nothing to do. Waiting: something is not available and Kiwi carries on. Stopped: it
 *  gave up, and what it did is no longer being done. */
export type ServiceState = "working" | "waiting" | "stopped";

export interface ServiceRow {
  name: string;
  state: ServiceState;
  /** What that means for the person reading it, in one sentence. */
  detail: string;
}

function accountRow(status: RendererAccountServiceStatus | null, offline: boolean): ServiceRow {
  if (offline)
    return {
      name: "Kiwi's service",
      state: "waiting",
      detail: "Not being contacted, because Kiwi is set to work offline.",
    };
  if (status === null)
    return { name: "Kiwi's service", state: "waiting", detail: "Kiwi has not checked yet." };
  return status.status === "ready"
    ? { name: "Kiwi's service", state: "working", detail: "Reachable." }
    : {
        name: "Kiwi's service",
        state: "waiting",
        detail:
          "Kiwi cannot reach it. Your work is saved on this machine either way, and sharing resumes on its own.",
      };
}

function workerRow(health: RendererRuntimeHealth | null): ServiceRow {
  if (health === null)
    return { name: "Background worker", state: "waiting", detail: "Kiwi has not checked yet." };
  if (health.worker === "failed")
    return {
      name: "Background worker",
      state: "stopped",
      detail: "It stopped after repeated failures. Kiwi keeps working without it.",
    };
  if (health.workerRestarts > 0)
    return {
      name: "Background worker",
      state: "working",
      detail: `Running. It has restarted ${String(health.workerRestarts)} ${
        health.workerRestarts === 1 ? "time" : "times"
      } since Kiwi started.`,
    };
  return { name: "Background worker", state: "working", detail: "Running." };
}

function sharingRow(standing: SyncStanding | null): ServiceRow {
  // Null is the same absence the top bar draws nothing for: no workspace on this window, or
  // nobody signed in. Here it is worth a line, because this page is where somebody came to ask.
  if (standing === null)
    return {
      name: "Sharing",
      state: "waiting",
      detail: "Nothing to share from this window yet.",
    };
  return {
    name: "Sharing",
    state:
      standing.state === "synchronized"
        ? "working"
        : standing.state === "conflicted"
          ? "stopped"
          : "waiting",
    detail: standing.summary,
  };
}

export function serviceRows(input: {
  service: RendererAccountServiceStatus | null;
  runtime: RendererRuntimeHealth | null;
  sharing: SyncStanding | null;
  offline: boolean;
}): ServiceRow[] {
  return [
    accountRow(input.service, input.offline),
    workerRow(input.runtime),
    sharingRow(input.sharing),
  ];
}

/** What the switch will do, said as the consequence rather than as the setting. */
export function offlineExplanation(offline: boolean): string {
  return offline
    ? "Kiwi is not contacting its service. Everything you write is kept on this machine and goes out when you turn this off."
    : "Kiwi contacts its service to share your work with everybody else in the workspace. Turn this on to keep this machine to itself for a while.";
}
