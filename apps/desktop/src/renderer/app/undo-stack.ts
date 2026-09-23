/**
 * The last thing that can be taken back.
 *
 * Receipts have carried an `undo` since the trash was built: a command and the arguments that
 * reverse what just happened. Nothing surfaced it, so the information existed and helped nobody.
 *
 * One action, not a stack. A stack of undos in an application whose objects are versioned files
 * would be a second history that disagrees with the real one: version history is where "what did
 * this look like before" is answered, and this is only for the half-second after a click when
 * somebody realises they clicked the wrong row. So it holds the most recent, it is cleared when
 * it is used, and it goes stale on its own rather than sitting there offering to undo something
 * from an hour ago.
 */

/** How long an offer stands. Long enough to notice a mistake, short enough not to be a feature. */
export const UNDO_WINDOW_MS = 20_000;

export interface UndoableAction {
  /** The command that reverses what happened. */
  command: string;
  args: Record<string, unknown>;
  /** What it will undo, as a person would say it. */
  label: string;
  /** When the original action happened. */
  at: number;
}

/**
 * What each command did, said as the thing being undone.
 *
 * Keyed on the command that *was run*, not the one that reverses it, because that is what the
 * person did and what they are deciding about. A command with no wording here still gets an
 * offer -- a plain "Undo" is worth more than no offer at all -- so a build that grows a new
 * undoable command does not silently lose it.
 */
const DID: Readonly<Record<string, string>> = {
  "kiwi.object.trash": "moving that to the Trash",
  "kiwi.task.trash": "moving that task to the Trash",
  "kiwi.thread.trash": "moving that comment to the Trash",
  "kiwi.object.rename": "renaming that",
  "kiwi.object.tag": "that tag change",
  "kiwi.object.attach-file": "attaching that file",
  "kiwi.object.detach-file": "detaching that file",
  "kiwi.object.organize": "moving that",
  "kiwi.object.add-to-collection": "filing that",
  "kiwi.object.remove-from-collection": "taking that out",
};

export function undoLabelFor(command: string): string {
  const what = DID[command];
  return what === undefined ? "Undo" : `Undo ${what}`;
}

/**
 * The undo a command result carries, if it carries one.
 *
 * Defensive about the shape rather than trusting it: a receipt written by a newer build is not a
 * reason to throw in the middle of somebody's save.
 */
export function readUndoFromResult(
  command: string,
  result: { data?: Record<string, unknown> | undefined } | null,
  at: number,
): UndoableAction | null {
  const undo = result?.data?.["undo"];
  if (undo === null || undo === undefined || typeof undo !== "object" || Array.isArray(undo))
    return null;
  const record = undo as Record<string, unknown>;
  const undoCommand = record["command"];
  const args = record["args"];
  if (typeof undoCommand !== "string" || undoCommand === "") return null;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  return {
    command: undoCommand,
    args: args as Record<string, unknown>,
    label: undoLabelFor(command),
    at,
  };
}

let last: UndoableAction | null = null;
const listeners = new Set<(action: UndoableAction | null) => void>();

function announce(): void {
  for (const listener of listeners) listener(last);
}

export function rememberUndo(action: UndoableAction | null): void {
  if (action === null) return;
  last = action;
  announce();
}

/** The offer that still stands, or null when there is none or it has gone stale. */
export function lastUndo(now = Date.now()): UndoableAction | null {
  if (last === null) return null;
  if (now - last.at > UNDO_WINDOW_MS) return null;
  return last;
}

export function forgetUndo(): void {
  last = null;
  announce();
}

export function subscribeUndo(listener: (action: UndoableAction | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
