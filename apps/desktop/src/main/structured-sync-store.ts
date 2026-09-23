import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  WORKSPACE_SYNC_PATHS,
  readStructuredSyncRequest,
  type StructuredSyncResult,
  type StructuredSyncSubmitRequest,
} from "@kiwi/contracts";

export type StoredSyncConflict = Extract<StructuredSyncResult, { status: "conflict" }>;

interface SyncState {
  outbox: StoredStructuredChange[];
  cursors: Record<string, number>;
  conflicts: Record<string, StoredSyncConflict[]>;
}

interface StoredStructuredChange {
  account_id: string;
  change: StructuredSyncSubmitRequest;
}

export interface StructuredSyncStore {
  queue(accountId: string, change: StructuredSyncSubmitRequest): Promise<void>;
  pending(accountId: string, workspaceId: string): Promise<StructuredSyncSubmitRequest[]>;
  count(accountId: string): Promise<number>;
  complete(accountId: string, commandId: string): Promise<void>;
  cursor(accountId: string, workspaceId: string): Promise<number>;
  setCursor(accountId: string, workspaceId: string, sequence: number): Promise<void>;
  recordConflict(
    accountId: string,
    workspaceId: string,
    conflict: StoredSyncConflict,
  ): Promise<void>;
  conflicts(accountId: string, workspaceId: string): Promise<StoredSyncConflict[]>;
}

const empty = (): SyncState => ({ outbox: [], cursors: {}, conflicts: {} });
const LEGACY_ACCOUNT_ID = "legacy-unassigned";
const cursorKey = (accountId: string, workspaceId: string): string => `${accountId}:${workspaceId}`;
const conflictKey = cursorKey;

function storedChange(value: unknown): StoredStructuredChange | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const wrapped = readStructuredSyncRequest(WORKSPACE_SYNC_PATHS.submit, record["change"]);
  if (typeof record["account_id"] === "string" && wrapped !== null && "command_id" in wrapped) {
    return { account_id: record["account_id"], change: wrapped };
  }
  const legacy = readStructuredSyncRequest(WORKSPACE_SYNC_PATHS.submit, value);
  return legacy !== null && "command_id" in legacy
    ? { account_id: LEGACY_ACCOUNT_ID, change: legacy }
    : null;
}

export function createStructuredSyncStore(filePath: string): StructuredSyncStore {
  const nextPath = `${filePath}.next`;
  let tail = Promise.resolve();

  async function load(): Promise<SyncState> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SyncState>;
      return {
        outbox: Array.isArray(parsed.outbox)
          ? parsed.outbox
              .map(storedChange)
              .filter((item): item is StoredStructuredChange => item !== null)
          : [],
        cursors:
          parsed.cursors !== null && typeof parsed.cursors === "object" ? parsed.cursors : {},
        conflicts:
          parsed.conflicts !== null && typeof parsed.conflicts === "object" ? parsed.conflicts : {},
      } as SyncState;
    } catch {
      return empty();
    }
  }

  async function save(state: SyncState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(nextPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(nextPath, filePath);
  }

  async function update<T>(work: (state: SyncState) => T | Promise<T>): Promise<T> {
    const previous = tail;
    let release = (): void => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const state = await load();
      const result = await work(state);
      await save(state);
      return result;
    } finally {
      release();
    }
  }

  return {
    queue(accountId, change) {
      return update((state) => {
        state.outbox = [
          ...state.outbox.filter(
            (item) => item.account_id !== accountId || item.change.command_id !== change.command_id,
          ),
          { account_id: accountId, change },
        ];
      });
    },
    async pending(accountId, workspaceId) {
      await tail;
      return (await load()).outbox
        .filter((item) => item.account_id === accountId && item.change.workspace_id === workspaceId)
        .map((item) => item.change);
    },
    async count(accountId) {
      await tail;
      return (await load()).outbox.filter((item) => item.account_id === accountId).length;
    },
    complete(accountId, commandId) {
      return update((state) => {
        state.outbox = state.outbox.filter(
          (item) => item.account_id !== accountId || item.change.command_id !== commandId,
        );
      });
    },
    async cursor(accountId, workspaceId) {
      await tail;
      return (await load()).cursors[cursorKey(accountId, workspaceId)] ?? 0;
    },
    setCursor(accountId, workspaceId, sequence) {
      return update((state) => {
        const key = cursorKey(accountId, workspaceId);
        state.cursors[key] = Math.max(state.cursors[key] ?? 0, sequence);
      });
    },
    recordConflict(accountId, workspaceId, conflict) {
      return update((state) => {
        const key = conflictKey(accountId, workspaceId);
        state.conflicts[key] = [
          conflict,
          ...(state.conflicts[key] ?? []).filter(
            (item) => item.conflict_id !== conflict.conflict_id,
          ),
        ];
      });
    },
    async conflicts(accountId, workspaceId) {
      await tail;
      return (await load()).conflicts[conflictKey(accountId, workspaceId)] ?? [];
    },
  };
}
