import { basename } from "node:path";
import type { WorkspaceFolderSelection } from "./ipc.js";

interface StoredSelection {
  windowId: number;
  root: string;
  expiresAt: number;
}

export interface WorkspaceFolderBroker {
  issue(windowId: number, root: string, hasExistingContents: boolean): WorkspaceFolderSelection;
  consume(windowId: number, selectionId: string): string | null;
  clearWindow(windowId: number): void;
}

export interface WorkspaceFolderBrokerOptions {
  newId: () => string;
  now?: () => number;
  lifetimeMs?: number;
}

export function createWorkspaceFolderBroker(
  options: WorkspaceFolderBrokerOptions,
): WorkspaceFolderBroker {
  const now = options.now ?? Date.now;
  const lifetimeMs = options.lifetimeMs ?? 10 * 60 * 1000;
  const selections = new Map<string, StoredSelection>();

  function discardExpired(): void {
    const current = now();
    for (const [id, selection] of selections) {
      if (selection.expiresAt <= current) selections.delete(id);
    }
  }

  return {
    issue(windowId, root, hasExistingContents) {
      discardExpired();
      const id = options.newId();
      selections.set(id, { windowId, root, expiresAt: now() + lifetimeMs });
      return {
        id,
        displayPath: root,
        suggestedTitle: basename(root),
        hasExistingContents,
      };
    },

    consume(windowId, selectionId) {
      discardExpired();
      const selection = selections.get(selectionId);
      if (selection === undefined || selection.windowId !== windowId) return null;
      selections.delete(selectionId);
      return selection.root;
    },

    clearWindow(windowId) {
      for (const [id, selection] of selections) {
        if (selection.windowId === windowId) selections.delete(id);
      }
    },
  };
}
