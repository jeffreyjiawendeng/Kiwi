import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  WORKSPACE_COEDIT_PATHS,
  readCoeditSyncRequest,
  type CoeditWireOperation,
} from "@kiwi/contracts";

export interface QueuedCoeditOperations {
  workspace_id: string;
  document_id: string;
  operations: CoeditWireOperation[];
}

interface CoeditSyncState {
  outbox: StoredCoeditOperations[];
  cursors: Record<string, number>;
  documents: Record<string, string[]>;
}

interface StoredCoeditOperations {
  account_id: string;
  batch: QueuedCoeditOperations;
}

export interface CoeditSyncStore {
  queue(accountId: string, batch: QueuedCoeditOperations): Promise<void>;
  pending(accountId: string, workspaceId: string): Promise<QueuedCoeditOperations[]>;
  count(accountId: string): Promise<number>;
  complete(accountId: string, operationIds: string[]): Promise<void>;
  cursor(accountId: string, workspaceId: string, documentId: string): Promise<number>;
  setCursor(
    accountId: string,
    workspaceId: string,
    documentId: string,
    sequence: number,
  ): Promise<void>;
  rememberDocument(accountId: string, workspaceId: string, documentId: string): Promise<void>;
  documents(accountId: string, workspaceId: string): Promise<string[]>;
}

const empty = (): CoeditSyncState => ({ outbox: [], cursors: {}, documents: {} });
const LEGACY_ACCOUNT_ID = "legacy-unassigned";
const key = (accountId: string, workspaceId: string, documentId: string): string =>
  `${accountId}:${workspaceId}:${documentId}`;
const documentKey = (accountId: string, workspaceId: string): string =>
  `${accountId}:${workspaceId}`;

function storedBatch(value: unknown): StoredCoeditOperations | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const wrapped = readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.push, record["batch"]);
  if (typeof record["account_id"] === "string" && wrapped !== null && "operations" in wrapped) {
    return { account_id: record["account_id"], batch: wrapped };
  }
  const legacy = readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.push, value);
  return legacy !== null && "operations" in legacy
    ? { account_id: LEGACY_ACCOUNT_ID, batch: legacy }
    : null;
}

export function createCoeditSyncStore(filePath: string): CoeditSyncStore {
  const nextPath = `${filePath}.next`;
  let tail = Promise.resolve();

  async function load(): Promise<CoeditSyncState> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<CoeditSyncState>;
      return {
        outbox: Array.isArray(parsed.outbox)
          ? parsed.outbox
              .map(storedBatch)
              .filter((item): item is StoredCoeditOperations => item !== null)
          : [],
        cursors:
          parsed.cursors !== null && typeof parsed.cursors === "object" ? parsed.cursors : {},
        documents:
          parsed.documents !== null && typeof parsed.documents === "object" ? parsed.documents : {},
      } as CoeditSyncState;
    } catch {
      return empty();
    }
  }

  async function save(state: CoeditSyncState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(nextPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(nextPath, filePath);
  }

  async function update<T>(work: (state: CoeditSyncState) => T | Promise<T>): Promise<T> {
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
    queue(accountId, batch) {
      return update((state) => {
        const known = new Set(
          state.outbox
            .filter((item) => item.account_id === accountId)
            .flatMap((item) => item.batch.operations.map((op) => op.operation_id)),
        );
        const operations = batch.operations.filter(
          (operation) => !known.has(operation.operation_id),
        );
        if (operations.length > 0)
          state.outbox.push({ account_id: accountId, batch: { ...batch, operations } });
        const documentsKey = documentKey(accountId, batch.workspace_id);
        state.documents[documentsKey] = [
          ...new Set([...(state.documents[documentsKey] ?? []), batch.document_id]),
        ].sort();
      });
    },
    async pending(accountId, workspaceId) {
      await tail;
      return (await load()).outbox
        .filter((item) => item.account_id === accountId && item.batch.workspace_id === workspaceId)
        .map((item) => item.batch);
    },
    async count(accountId) {
      await tail;
      return (await load()).outbox
        .filter((item) => item.account_id === accountId)
        .reduce((total, item) => total + item.batch.operations.length, 0);
    },
    complete(accountId, operationIds) {
      const completed = new Set(operationIds);
      return update((state) => {
        state.outbox = state.outbox
          .map((item) => ({
            ...item,
            batch:
              item.account_id === accountId
                ? {
                    ...item.batch,
                    operations: item.batch.operations.filter(
                      (operation) => !completed.has(operation.operation_id),
                    ),
                  }
                : item.batch,
          }))
          .filter((item) => item.batch.operations.length > 0);
      });
    },
    async cursor(accountId, workspaceId, documentId) {
      await tail;
      return (await load()).cursors[key(accountId, workspaceId, documentId)] ?? 0;
    },
    setCursor(accountId, workspaceId, documentId, sequence) {
      return update((state) => {
        const cursorKey = key(accountId, workspaceId, documentId);
        state.cursors[cursorKey] = Math.max(state.cursors[cursorKey] ?? 0, sequence);
      });
    },
    rememberDocument(accountId, workspaceId, documentId) {
      return update((state) => {
        const documentsKey = documentKey(accountId, workspaceId);
        state.documents[documentsKey] = [
          ...new Set([...(state.documents[documentsKey] ?? []), documentId]),
        ].sort();
      });
    },
    async documents(accountId, workspaceId) {
      await tail;
      return (await load()).documents[documentKey(accountId, workspaceId)] ?? [];
    },
  };
}
