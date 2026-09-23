import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

const MIGRATION_NAME = /^(?<version>[0-9]{4}_[a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK_ID = 1_260_718_921;

export interface Migration {
  version: string;
  checksum: string;
  sql: string;
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: Migration[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_NAME.exec(entry.name);
    if (match?.groups?.["version"] === undefined) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }
    const sql = await readFile(join(directory, entry.name), "utf8");
    migrations.push({
      version: match.groups["version"],
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    });
  }
  migrations.sort((left, right) => left.version.localeCompare(right.version));
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error("Migration versions must be unique.");
  }
  if (migrations.length === 0) throw new Error("At least one service migration is required.");
  return migrations;
}

async function readApplied(executor: SqlExecutor): Promise<Map<string, string>> {
  const result = await executor.query(
    "SELECT version, checksum FROM kiwi_schema_migrations ORDER BY version",
  );
  const applied = new Map<string, string>();
  for (const row of result.rows) {
    const version = row["version"];
    const checksum = row["checksum"];
    if (typeof version !== "string" || typeof checksum !== "string") {
      throw new Error("The migration ledger contains an invalid row.");
    }
    applied.set(version, checksum);
  }
  return applied;
}

export async function applyMigrations(
  database: ServiceDatabase,
  migrations: readonly Migration[],
): Promise<string> {
  return database.transaction(async (executor) => {
    await executor.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await executor.query(`
      CREATE TABLE IF NOT EXISTS kiwi_schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )
    `);
    const applied = await readApplied(executor);
    const available = new Map(migrations.map((migration) => [migration.version, migration]));

    for (const [version, checksum] of applied) {
      const migration = available.get(version);
      if (migration === undefined) {
        throw new Error(`The database has unknown migration ${version}.`);
      }
      if (migration.checksum !== checksum) {
        throw new Error(`Migration ${version} no longer matches its applied checksum.`);
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await executor.query(migration.sql);
      await executor.query(
        "INSERT INTO kiwi_schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
    }

    const latest = migrations.at(-1);
    if (latest === undefined) throw new Error("At least one service migration is required.");
    return latest.version;
  });
}

export function migrationDirectory(): string {
  return join(import.meta.dirname, "..", "migrations");
}
