/**
 * Windows opened to show one object.
 *
 * A manuscript beside its sources, on a second monitor, is how most people write. Doing that
 * inside one window means splitting the shell in half; doing it with a second window means the
 * shell is whole in both places. So a detached window is an ordinary Kiwi window that happens to
 * have been told which object to open, and everything else about it -- the preload, the security
 * settings, the workspace session -- is what every other window has.
 *
 * This module holds only the bookkeeping: which window was opened to show what, and by whom. It
 * knows nothing about Electron so it can be tested without one, and the rules it enforces are
 * the two that matter. Detaching the same object twice returns to the window that already has it
 * rather than opening a second copy. And a detached window belongs to the window that opened it,
 * so closing the parent closes the children: a detached pane outliving its workspace session
 * would be a window holding a root that has been released.
 */

/**
 * What a detached window was opened to show.
 *
 * Two kinds: a document, which is the whole of what it shows, and a Reader, which shows one file
 * of a Paper. A Note is a document -- it is written in the same editor and read out of the same
 * canonical file -- so it detaches as one rather than as a third kind. A kind is added here only
 * for a thing that needs a different view at the end of it, which is what separates the Reader.
 */
export const DETACHED_KINDS = ["document", "reader"] as const;
export type DetachedKind = (typeof DETACHED_KINDS)[number];

export interface DetachRequest {
  objectId: string;
  kind: DetachedKind;
  /**
   * Which file of the object to open, for the kinds that have more than one. A Paper can hold a
   * preprint and the published version, and they are two different things to read.
   */
  assetId?: string;
}

export interface DetachedAssignment extends DetachRequest {
  /** The window this was detached from, and with it the window whose closing closes this one. */
  parentWindowId: number;
}

export function isDetachRequest(value: unknown): value is DetachRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DetachRequest>;
  if (typeof candidate.objectId !== "string" || candidate.objectId === "") return false;
  if (
    typeof candidate.kind !== "string" ||
    !(DETACHED_KINDS as readonly string[]).includes(candidate.kind)
  ) {
    return false;
  }
  // A Reader is opened on a file, so a request without one names no document to read. The other
  // kinds are the object itself, and a file alongside would be an instruction nobody obeys.
  if (candidate.kind === "reader") {
    return typeof candidate.assetId === "string" && candidate.assetId !== "";
  }
  return candidate.assetId === undefined;
}

export interface DetachedWindows {
  /** Records that a window has been opened to show one object. */
  attach(windowId: number, assignment: DetachedAssignment): void;
  /** What a window was opened to show, or null when it is an ordinary window. */
  forWindow(windowId: number): DetachedAssignment | null;
  /** The windows opened from this one, so closing it can close them. */
  childrenOf(windowId: number): number[];
  /** A window already showing this object for this parent, or null. */
  windowShowing(parentWindowId: number, request: DetachRequest): number | null;
  /** Forgets a window, whether it was a parent, a child, or both. */
  clearWindow(windowId: number): void;
}

export function createDetachedWindows(): DetachedWindows {
  const byWindow = new Map<number, DetachedAssignment>();

  return {
    attach(windowId, assignment) {
      byWindow.set(windowId, assignment);
    },

    forWindow(windowId) {
      return byWindow.get(windowId) ?? null;
    },

    childrenOf(windowId) {
      return [...byWindow.entries()]
        .filter(([, assignment]) => assignment.parentWindowId === windowId)
        .map(([id]) => id);
    },

    windowShowing(parentWindowId, request) {
      for (const [id, assignment] of byWindow) {
        if (
          assignment.parentWindowId === parentWindowId &&
          assignment.objectId === request.objectId &&
          assignment.kind === request.kind &&
          assignment.assetId === request.assetId
        ) {
          return id;
        }
      }
      return null;
    },

    clearWindow(windowId) {
      byWindow.delete(windowId);
      // A child whose parent has gone is no longer anybody's child. It is closed rather than
      // left behind, and this keeps the entry from naming a window id that will be reused.
      for (const [id, assignment] of byWindow) {
        if (assignment.parentWindowId === windowId) byWindow.delete(id);
      }
    },
  };
}
