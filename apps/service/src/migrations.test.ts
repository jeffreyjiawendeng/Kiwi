import { describe, expect, it } from "vitest";
import type { ServiceDatabase, SqlExecutor, SqlResult } from "./database.js";
import {
  applyMigrations,
  loadMigrations,
  migrationDirectory,
  type Migration,
} from "./migrations.js";

class RecordingDatabase implements ServiceDatabase, SqlExecutor {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly applied = new Map<string, string>();

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query(text: string, values: readonly unknown[] = []): Promise<SqlResult> {
    this.queries.push({ text, values });
    if (text.startsWith("SELECT version")) {
      return {
        rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })),
      };
    }
    if (text.startsWith("INSERT INTO kiwi_schema_migrations")) {
      const [version, checksum] = values;
      if (typeof version === "string" && typeof checksum === "string") {
        this.applied.set(version, checksum);
      }
    }
    return { rows: [] };
  }

  async probe(): Promise<void> {}
  async close(): Promise<void> {}
}

const migration: Migration = {
  version: "0001_service_foundation",
  checksum: "abc123",
  sql: "CREATE TABLE service_metadata (key text PRIMARY KEY)",
};

describe("service migrations", () => {
  it("loads the versioned SQL migration with a stable checksum", async () => {
    const loaded = await loadMigrations(migrationDirectory());
    expect(loaded).toHaveLength(26);
    expect(loaded[0]?.version).toBe("0001_service_foundation");
    expect(loaded[1]?.version).toBe("0002_password_accounts");
    expect(loaded[2]?.version).toBe("0003_google_identities");
    expect(loaded[3]?.version).toBe("0004_rotating_sessions");
    expect(loaded[4]?.version).toBe("0005_account_settings");
    expect(loaded[5]?.version).toBe("0006_workspace_collaboration");
    expect(loaded[6]?.version).toBe("0007_structured_sync");
    expect(loaded[14]?.version).toBe("0015_account_emails");
    expect(loaded[17]?.version).toBe("0018_account_avatar");
    expect(loaded[18]?.version).toBe("0018_session_reauthentication");
    expect(loaded[19]?.version).toBe("0019_account_notifications");
    expect(loaded[20]?.version).toBe("0020_account_deletion_finalization");
    expect(loaded[21]?.version).toBe("0021_connected_account_refresh");
    expect(loaded[22]?.version).toBe("0022_github_device_polling");
    expect(loaded[23]?.version).toBe("0023_zotero_oauth_transactions");
    expect(loaded[24]?.version).toBe("0024_identity_authorizations");
    expect(loaded[25]?.version).toBe("0025_hosted_oidc_callbacks");
    expect(loaded[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("locks, applies, and records each migration once", async () => {
    const database = new RecordingDatabase();
    await expect(applyMigrations(database, [migration])).resolves.toBe(migration.version);
    await expect(applyMigrations(database, [migration])).resolves.toBe(migration.version);
    expect(database.queries.filter(({ text }) => text === migration.sql)).toHaveLength(1);
    expect(database.applied.get(migration.version)).toBe(migration.checksum);
  });

  it("refuses drift or a database migration unknown to this build", async () => {
    const drifted = new RecordingDatabase();
    drifted.applied.set(migration.version, "different");
    await expect(applyMigrations(drifted, [migration])).rejects.toThrow(/checksum/i);

    const future = new RecordingDatabase();
    future.applied.set("9999_future", "future");
    await expect(applyMigrations(future, [migration])).rejects.toThrow(/unknown migration/i);
  });
});
