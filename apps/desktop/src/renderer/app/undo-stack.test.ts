import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNDO_WINDOW_MS,
  forgetUndo,
  lastUndo,
  readUndoFromResult,
  rememberUndo,
  subscribeUndo,
  undoLabelFor,
} from "./undo-stack.js";

const NOW = 1_800_000_000_000;

afterEach(() => {
  forgetUndo();
});

function trashed(over: Record<string, unknown> = {}) {
  return {
    data: {
      entry: { object_id: "object-1" },
      undo: { command: "kiwi.object.restore-from-trash", args: { object_id: "object-1" } },
      ...over,
    },
  };
}

describe("reading an undo off a receipt", () => {
  it("takes the command and the arguments that reverse what happened", () => {
    const action = readUndoFromResult("kiwi.object.trash", trashed(), NOW);

    expect(action).toEqual({
      command: "kiwi.object.restore-from-trash",
      args: { object_id: "object-1" },
      label: "Undo moving that to the Trash",
      at: NOW,
    });
  });

  it("has nothing to offer when the command carried no undo", () => {
    expect(readUndoFromResult("kiwi.object.save", { data: { object: {} } }, NOW)).toBeNull();
    expect(readUndoFromResult("kiwi.object.tag", { data: { undo: null } }, NOW)).toBeNull();
  });

  it("does not throw on a receipt shaped in a way this build does not know", () => {
    // A newer build's receipt is not a reason to fail in the middle of somebody's save.
    expect(readUndoFromResult("kiwi.object.trash", { data: { undo: "yes" } }, NOW)).toBeNull();
    expect(
      readUndoFromResult("kiwi.object.trash", { data: { undo: { command: "x" } } }, NOW),
    ).toBeNull();
    expect(readUndoFromResult("kiwi.object.trash", null, NOW)).toBeNull();
  });

  it("still offers an undo for a command it has no wording for", () => {
    const action = readUndoFromResult("kiwi.something.new", trashed(), NOW);

    expect(action?.label).toBe("Undo");
  });
});

describe("what the offer says", () => {
  it("names what was done, not what will be run", () => {
    expect(undoLabelFor("kiwi.object.trash")).toBe("Undo moving that to the Trash");
    expect(undoLabelFor("kiwi.object.rename")).toBe("Undo renaming that");
  });
});

describe("the offer that stands", () => {
  it("holds the most recent, not a stack", () => {
    // Version history is where "what did this look like before" is answered. This is only for
    // the half-second after a click that was the wrong row.
    rememberUndo(readUndoFromResult("kiwi.object.trash", trashed(), NOW));
    rememberUndo(readUndoFromResult("kiwi.object.rename", trashed(), NOW + 10));

    expect(lastUndo(NOW + 20)?.label).toBe("Undo renaming that");
  });

  it("goes stale rather than offering to undo something from an hour ago", () => {
    rememberUndo(readUndoFromResult("kiwi.object.trash", trashed(), NOW));

    expect(lastUndo(NOW + UNDO_WINDOW_MS - 1)).not.toBeNull();
    expect(lastUndo(NOW + UNDO_WINDOW_MS + 1)).toBeNull();
  });

  it("is cleared once it has been used", () => {
    rememberUndo(readUndoFromResult("kiwi.object.trash", trashed(), NOW));

    forgetUndo();

    expect(lastUndo(NOW)).toBeNull();
  });

  it("keeps what was there when a command carried nothing to undo", () => {
    rememberUndo(readUndoFromResult("kiwi.object.trash", trashed(), NOW));

    rememberUndo(readUndoFromResult("kiwi.object.save", { data: {} }, NOW + 5));

    expect(lastUndo(NOW + 10)?.label).toBe("Undo moving that to the Trash");
  });

  it("tells whoever is listening", () => {
    const heard = vi.fn();
    const stop = subscribeUndo(heard);

    rememberUndo(readUndoFromResult("kiwi.object.trash", trashed(), NOW));
    stop();
    rememberUndo(readUndoFromResult("kiwi.object.rename", trashed(), NOW + 1));

    expect(heard).toHaveBeenCalledTimes(1);
  });
});
