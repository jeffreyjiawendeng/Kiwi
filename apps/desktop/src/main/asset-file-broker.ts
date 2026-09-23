import type { ManagedAssetSelection } from "./ipc.js";

interface StoredAssetSelection {
  windowId: number;
  path: string;
  declaredMediaType: string | null;
  expiresAt: number;
}

export interface ConsumedAssetSelection {
  path: string;
  declaredMediaType: string | null;
}

export interface AssetFileBroker {
  issue(input: {
    windowId: number;
    path: string;
    name: string;
    size: number;
    modifiedAt: string;
    declaredMediaType: string | null;
  }): ManagedAssetSelection;
  consume(windowId: number, selectionId: string): ConsumedAssetSelection | null;
  /**
   * Looks at a selection without spending it, so a picked file can be shown before it is taken.
   *
   * Consuming is what imports a file, and importing belongs to the window that chose it, which is
   * why `consume` asks which window is asking. Reading the bytes back to whoever is holding the
   * identifier is a smaller act, and the thing that does it -- a protocol response -- is handed a
   * URL and no window at all, so there is nothing here to check a window against. What still
   * holds: the identifier is unguessable, it stops working after ten minutes, and neither this
   * nor anything downstream of it hands the path to the renderer.
   */
  peek(selectionId: string): ConsumedAssetSelection | null;
  clearWindow(windowId: number): void;
}

export function createAssetFileBroker(options: {
  newId(): string;
  now?: () => number;
  lifetimeMs?: number;
}): AssetFileBroker {
  const now = options.now ?? Date.now;
  const lifetimeMs = options.lifetimeMs ?? 10 * 60 * 1000;
  const selections = new Map<string, StoredAssetSelection>();

  function discardExpired(): void {
    const current = now();
    for (const [id, selection] of selections)
      if (selection.expiresAt <= current) selections.delete(id);
  }

  return {
    issue(input) {
      discardExpired();
      const id = options.newId();
      selections.set(id, {
        windowId: input.windowId,
        path: input.path,
        declaredMediaType: input.declaredMediaType,
        expiresAt: now() + lifetimeMs,
      });
      return {
        id,
        name: input.name,
        size: input.size,
        modifiedAt: input.modifiedAt,
        declaredMediaType: input.declaredMediaType,
      };
    },

    consume(windowId, selectionId) {
      discardExpired();
      const selection = selections.get(selectionId);
      if (selection === undefined || selection.windowId !== windowId) return null;
      selections.delete(selectionId);
      return { path: selection.path, declaredMediaType: selection.declaredMediaType };
    },

    peek(selectionId) {
      discardExpired();
      const selection = selections.get(selectionId);
      if (selection === undefined) return null;
      return { path: selection.path, declaredMediaType: selection.declaredMediaType };
    },

    clearWindow(windowId) {
      for (const [id, selection] of selections)
        if (selection.windowId === windowId) selections.delete(id);
    },
  };
}
