import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountIdentity } from "@kiwi/contracts";

export interface PersistedSession {
  version: 1;
  account: AccountIdentity;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface SessionVault {
  load(): Promise<PersistedSession | null>;
  save(session: PersistedSession): Promise<void>;
  clear(): Promise<void>;
  protected(): boolean;
}

export interface SessionEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const account = record["account"];
  return (
    Object.keys(record).every((key) =>
      ["version", "account", "refreshToken", "refreshExpiresAt"].includes(key),
    ) &&
    record["version"] === 1 &&
    typeof record["refreshToken"] === "string" &&
    record["refreshToken"].length > 0 &&
    record["refreshToken"].length <= 512 &&
    typeof record["refreshExpiresAt"] === "number" &&
    Number.isFinite(record["refreshExpiresAt"]) &&
    account !== null &&
    typeof account === "object" &&
    !Array.isArray(account) &&
    Object.keys(account).every((key) => ["id", "email", "email_verified"].includes(key)) &&
    typeof (account as Record<string, unknown>)["id"] === "string" &&
    typeof (account as Record<string, unknown>)["email"] === "string" &&
    (account as Record<string, unknown>)["email_verified"] === true
  );
}

export function createProtectedSessionVault(
  filePath: string,
  encryption: SessionEncryption,
): SessionVault {
  const temporaryPath = `${filePath}.next`;
  return {
    protected: () => encryption.isEncryptionAvailable(),

    async load(): Promise<PersistedSession | null> {
      if (!encryption.isEncryptionAvailable()) return null;
      try {
        const encrypted = await readFile(filePath);
        const parsed: unknown = JSON.parse(encryption.decryptString(encrypted));
        return isPersistedSession(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(session): Promise<void> {
      if (!encryption.isEncryptionAvailable()) {
        throw new Error("Protected credential storage is unavailable.");
      }
      await mkdir(dirname(filePath), { recursive: true });
      const encrypted = encryption.encryptString(JSON.stringify(session));
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    },

    async clear(): Promise<void> {
      await Promise.all([
        unlink(filePath).catch(() => undefined),
        unlink(temporaryPath).catch(() => undefined),
      ]);
    },
  };
}

export function createMemorySessionVault(initial: PersistedSession | null = null): SessionVault {
  let value = initial;
  return {
    protected: () => true,
    load: async () => value,
    save: async (session) => {
      value = structuredClone(session);
    },
    clear: async () => {
      value = null;
    },
  };
}
