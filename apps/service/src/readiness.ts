import { ACCOUNT_SERVICE_NAME, PROTOCOL_VERSION, type AccountServiceHealth } from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";
import { applyMigrations, loadMigrations } from "./migrations.js";

export interface ServiceReadiness {
  check(): Promise<AccountServiceHealth>;
}

function unavailableHealth(): AccountServiceHealth {
  return {
    protocol_version: PROTOCOL_VERSION,
    service: ACCOUNT_SERVICE_NAME,
    status: "unavailable",
    database: "unavailable",
    migration_version: null,
  };
}

export function createServiceReadiness(
  database: ServiceDatabase,
  migrationsDirectory: string,
): ServiceReadiness {
  let migrationVersion: string | null = null;
  let initialization: Promise<string> | null = null;

  async function initialize(): Promise<string> {
    initialization ??= loadMigrations(migrationsDirectory)
      .then((migrations) => applyMigrations(database, migrations))
      .finally(() => {
        initialization = null;
      });
    return initialization;
  }

  return {
    async check(): Promise<AccountServiceHealth> {
      try {
        migrationVersion ??= await initialize();
        await database.probe();
        return {
          protocol_version: PROTOCOL_VERSION,
          service: ACCOUNT_SERVICE_NAME,
          status: "ready",
          database: "ready",
          migration_version: migrationVersion,
        };
      } catch {
        migrationVersion = null;
        return unavailableHealth();
      }
    },
  };
}
