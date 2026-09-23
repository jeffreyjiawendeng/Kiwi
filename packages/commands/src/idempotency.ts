import type { CommandResult } from "@kiwi/contracts";

export interface StoredReceipt {
  command: string;
  argsFingerprint: string;
  result: CommandResult;
}

export interface ReceiptStore {
  find(key: string): StoredReceipt | undefined;
  save(key: string, receipt: StoredReceipt): void;
  size(): number;
}

/**
 * Bounded in-memory receipt store. Durable receipts arrive with the canonical event log,
 * so this survives only the current process.
 */
export function memoryReceiptStore(maxEntries = 500): ReceiptStore {
  const entries = new Map<string, StoredReceipt>();

  return {
    find(key) {
      return entries.get(key);
    },

    save(key, receipt) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      entries.set(key, receipt);
    },

    size() {
      return entries.size;
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable ordering so the same arguments always produce the same fingerprint. */
export function fingerprintArgs(args: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(args));
}
