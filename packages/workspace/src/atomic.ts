import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 40 };

const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE"]);

function isTransientLock(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && LOCKED_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ENG-WRITE-004 requires bounded jittered retry for anti-malware, indexer, and cloud sync
 * locks. Persistent failure surfaces rather than blocking forever.
 */
export async function withLockRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientLock(error)) throw error;
      lastError = error;
      const jitter = Math.random() * policy.baseDelayMs;
      await delay(policy.baseDelayMs * 2 ** attempt + jitter);
    }
  }

  throw lastError;
}

/**
 * Writes through a sibling temporary file so a reader never observes a partial record.
 * The directory entry is flushed as well, otherwise a crash can leave the rename
 * unrecorded on some filesystems.
 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.${Date.now()}-${process.pid}.tmp`);

  await withLockRetry(async () => {
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

  try {
    await withLockRetry(() => rename(temporary, target));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  const directoryHandle = await open(directory, "r").catch(() => null);
  if (directoryHandle !== null) {
    await directoryHandle.sync().catch(() => undefined);
    await directoryHandle.close();
  }
}

/** Fails when the target already exists, so a create never overwrites user data. */
export async function writeFileExclusive(target: string, contents: string): Promise<void> {
  await withLockRetry(() => writeFile(target, contents, { encoding: "utf8", flag: "wx" }));
}
