/**
 * Whether what is on this machine has reached anybody else, in words.
 *
 * Four states, because there are four things a person does about it. Synchronized: carry on.
 * Syncing: carry on, it is on its way. Offline: carry on, but nobody else is seeing this yet.
 * Conflicted: stop, somebody has to choose. Anything finer than that is detail, and detail belongs
 * behind the click rather than in the bar.
 *
 * The rule the whole thing turns on is that an empty queue is not the same as a queue that emptied
 * because everything went through. Nothing pending while the service is unreachable is the state
 * that most wants to be called "synchronized" and is furthest from it, so the connection is read
 * before the counts, and a run that was refused is reported with the reason it gave.
 *
 * Offline is a state, not a fault. Kiwi is local-first: the workspace on disk is the real one and
 * editing does not stop. So the words say what is true of the sharing, not of the work.
 */

import { describeAge } from "./members-roster.js";
import type { RendererWorkspaceSyncStatusResult } from "./bridge.js";

export type SyncState = "synchronized" | "syncing" | "offline" | "conflicted";

/** One kind of thing that has not been sent yet. */
export interface PendingLine {
  label: string;
  count: number;
}

export interface SyncStanding {
  state: SyncState;
  /** The word in the bar. */
  label: string;
  /** One sentence saying what that word means for the person reading it. */
  summary: string;
  /** What is waiting, longest-standing kind first. Empty when nothing is. */
  pending: readonly PendingLine[];
  /** When it last got through, or that it has not. Always said: a status with no time on it passes
   *  for current. */
  lastSuccess: string;
  /** The last attempt that was refused, with the reason the service gave, or null. */
  failure: string | null;
}

const STATE_LABELS: Readonly<Record<SyncState, string>> = {
  synchronized: "Synchronized",
  syncing: "Syncing",
  offline: "Offline",
  conflicted: "Conflicts",
};

function count(value: number, singular: string, plural: string): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

/**
 * What has not been sent, in the order somebody would want to read it.
 *
 * Registration first, because a workspace the service has never been told about is not partly
 * shared, it is not shared: the changes queued behind it have nowhere to go.
 */
export function pendingLines(pending: {
  registrations: number;
  structured_changes: number;
  document_operations: number;
}): PendingLine[] {
  return [
    { label: "Registering this workspace", count: pending.registrations },
    { label: "Saved changes", count: pending.structured_changes },
    { label: "Edits in shared documents", count: pending.document_operations },
  ].filter((line) => line.count > 0);
}

/**
 * The reading turned into a state and the words for it.
 *
 * Null when there is nothing to report -- nobody signed in, or no workspace on this window. The
 * indicator is not drawn at all rather than drawn in some resting state, for the same reason the
 * presence row is empty rather than greyed out: a fixture that always says something stops being
 * read, and this one is only worth having when it means something.
 */
export function standingFrom(
  result: RendererWorkspaceSyncStatusResult,
  now: Date,
): SyncStanding | null {
  if (result.status !== "known") return null;
  const pending = pendingLines(result.pending);
  const total = result.pending.total;
  const state: SyncState =
    // A conflict is the only one of these that will not clear itself, so it is said first even
    // while offline: somebody has to choose, and they can choose without a connection.
    result.conflicts > 0
      ? "conflicted"
      : result.connection === "offline"
        ? "offline"
        : total > 0
          ? "syncing"
          : "synchronized";
  return {
    state,
    label: STATE_LABELS[state],
    summary: summaryFor(state, {
      conflicts: result.conflicts,
      total,
      chosen: result.working_offline,
    }),
    pending,
    lastSuccess: describeLastSuccess(result.last_succeeded_at, now),
    failure: describeFailure(result.last_failure, now),
  };
}

function summaryFor(
  state: SyncState,
  counts: { conflicts: number; total: number; chosen: boolean },
): string {
  switch (state) {
    case "conflicted":
      return `${count(counts.conflicts, "save was", "saves were")} refused because somebody else had changed the same thing. Choose which version to keep.`;
    case "offline":
      // Waiting for a connection that was switched off by hand is waiting forever, so an offline
      // this machine chose says what ends it: the switch on Home, and nothing else.
      if (counts.chosen)
        return counts.total === 0
          ? "Kiwi is set to work offline, so nothing is being sent. Everything you write is kept here until you go back online on Home."
          : `${count(counts.total, "change is", "changes are")} waiting here because Kiwi is set to work offline. They go out when you go back online on Home.`;
      return counts.total === 0
        ? "This workspace is not being shared right now. Everything you write is kept here and goes out when the connection comes back."
        : `${count(counts.total, "change is", "changes are")} waiting here until the connection comes back. Nothing is lost in the meantime.`;
    case "syncing":
      return `${count(counts.total, "change is", "changes are")} on the way to everybody else in this workspace.`;
    case "synchronized":
      return "Everything written here has reached everybody else in this workspace.";
  }
}

function describeLastSuccess(at: string | null, now: Date): string {
  const when = at === null ? Number.NaN : Date.parse(at);
  // A window that has just opened has not synchronized in it yet, and says so rather than showing
  // a time from a session that is over. See `sync-journal.ts` for why nothing older is kept.
  if (!Number.isFinite(when)) return "Nothing has been synchronized since this window opened.";
  return `Last synchronized ${describeAge(new Date(when), now)}.`;
}

function describeFailure(failure: { at: string; reason: string } | null, now: Date): string | null {
  if (failure === null) return null;
  const when = Date.parse(failure.at);
  if (!Number.isFinite(when)) return failure.reason;
  return `Last tried ${describeAge(new Date(when), now)}. ${failure.reason}`;
}
