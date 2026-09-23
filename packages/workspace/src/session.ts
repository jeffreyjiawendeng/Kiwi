import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrustLevel, RecentWorkspace } from "@kiwi/contracts";
import { writeFileAtomic } from "./atomic.js";

/**
 * Session, trust, and recent-workspace records live outside the workspace folder so a
 * workspace stays portable and carries no machine-specific state.
 */
export interface SessionPaths {
  /** Per-workspace cache and lock root, keyed by workspace id. */
  workspaceState(workspaceId: string): string;
  /** Application-level user data root. */
  userData(): string;
}

export interface LockRecord {
  workspaceId: string;
  pid: number;
  acquiredAt: string;
  host: string;
}

export interface LockResult {
  acquired: boolean;
  heldBy?: LockRecord;
}

const LOCK_FILENAME = "session.lock";

export async function acquireLock(
  paths: SessionPaths,
  record: LockRecord,
  isAlive: (pid: number) => boolean,
): Promise<LockResult> {
  const directory = paths.workspaceState(record.workspaceId);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, LOCK_FILENAME);

  const existing = await readLock(lockPath);
  if (existing !== null && existing.pid !== record.pid && isAlive(existing.pid)) {
    return { acquired: false, heldBy: existing };
  }

  // A lock left by a process that is gone is stale and may be replaced.
  await writeFileAtomic(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  return { acquired: true };
}

export async function releaseLock(paths: SessionPaths, workspaceId: string): Promise<void> {
  await rm(join(paths.workspaceState(workspaceId), LOCK_FILENAME), { force: true });
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Partial<LockRecord>;
    if (typeof record.pid !== "number" || typeof record.workspaceId !== "string") return null;
    return record as LockRecord;
  } catch {
    return null;
  }
}

export interface TrustRecord {
  root: string;
  trust: TrustLevel;
  decidedAt: string;
}

export interface TrustStore {
  lookup(root: string): Promise<TrustLevel | null>;
  remember(record: TrustRecord): Promise<void>;
  forget(root: string): Promise<void>;
  all(): Promise<TrustRecord[]>;
}

function normalizeKey(root: string): string {
  return root.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

export function fileTrustStore(paths: SessionPaths): TrustStore {
  const file = join(paths.userData(), "workspace-trust.json");

  async function load(): Promise<Record<string, TrustRecord>> {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, TrustRecord>)
        : {};
    } catch {
      return {};
    }
  }

  async function save(records: Record<string, TrustRecord>): Promise<void> {
    await mkdir(paths.userData(), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(records, null, 2)}\n`);
  }

  return {
    async lookup(root) {
      return (await load())[normalizeKey(root)]?.trust ?? null;
    },

    async remember(record) {
      const records = await load();
      records[normalizeKey(record.root)] = record;
      await save(records);
    },

    async forget(root) {
      const records = await load();
      delete records[normalizeKey(root)];
      await save(records);
    },

    async all() {
      return Object.values(await load());
    },
  };
}

export interface RecentStore {
  list(): Promise<RecentWorkspace[]>;
  record(entry: RecentWorkspace): Promise<void>;
  remove(root: string): Promise<void>;
}

const MAX_RECENT = 10;

export function fileRecentStore(paths: SessionPaths): RecentStore {
  const file = join(paths.userData(), "recent-workspaces.json");

  async function load(): Promise<RecentWorkspace[]> {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RecentWorkspace[]) : [];
    } catch {
      return [];
    }
  }

  return {
    list: load,

    async record(entry) {
      const existing = await load();
      const key = normalizeKey(entry.root);
      const next = [entry, ...existing.filter((item) => normalizeKey(item.root) !== key)].slice(
        0,
        MAX_RECENT,
      );
      await mkdir(paths.userData(), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    async remove(root) {
      const key = normalizeKey(root);
      const next = (await load()).filter((item) => normalizeKey(item.root) !== key);
      await mkdir(paths.userData(), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

const SYNC_FOLDER_HINTS = [
  "onedrive",
  "dropbox",
  "google drive",
  "icloud",
  "box sync",
  "nextcloud",
];

/**
 * A workspace inside a synchronizing folder can be rewritten under Kiwi by another
 * machine. Detection is a hint for the user, not a block.
 */
export function detectSyncFolder(root: string): string | null {
  const lower = root.toLowerCase();
  return SYNC_FOLDER_HINTS.find((hint) => lower.includes(hint)) ?? null;
}

export async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
