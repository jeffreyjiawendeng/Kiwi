import { PROTOCOL_VERSION } from "./protocol.js";

export const ACCOUNT_SERVICE_NAME = "kiwi-account";
export const ACCOUNT_SERVICE_HEALTH_PATH = "/v1/health/ready";

export type AccountServiceAvailability = "ready" | "unavailable";

export interface AccountServiceHealth {
  protocol_version: string;
  service: typeof ACCOUNT_SERVICE_NAME;
  status: AccountServiceAvailability;
  database: AccountServiceAvailability;
  migration_version: string | null;
}

export function isAccountServiceHealth(value: unknown): value is AccountServiceHealth {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !["protocol_version", "service", "status", "database", "migration_version"].includes(key),
    )
  ) {
    return false;
  }
  return (
    record["protocol_version"] === PROTOCOL_VERSION &&
    record["service"] === ACCOUNT_SERVICE_NAME &&
    (record["status"] === "ready" || record["status"] === "unavailable") &&
    (record["database"] === "ready" || record["database"] === "unavailable") &&
    (record["migration_version"] === null || typeof record["migration_version"] === "string")
  );
}
