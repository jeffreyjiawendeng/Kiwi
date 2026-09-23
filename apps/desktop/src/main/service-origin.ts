import { readFileSync } from "node:fs";
import { join } from "node:path";

interface EmbeddedServiceConfig {
  version: 1;
  account_service_origin: string;
}

export interface ServiceOriginSources {
  env: NodeJS.ProcessEnv;
  isDevelopment: boolean;
  appPath: string;
  readText?: (path: string) => string;
}

function isEmbeddedServiceConfig(value: unknown): value is EmbeddedServiceConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EmbeddedServiceConfig>;
  return candidate.version === 1 && typeof candidate.account_service_origin === "string";
}

/**
 * Resolves the account service without making packaged builds depend on the
 * environment of the shell that launches them. The account client performs the
 * final transport-policy validation before using the returned value.
 */
export function resolveAccountServiceOrigin(sources: ServiceOriginSources): string | null {
  const override = sources.env["KIWI_ACCOUNT_SERVICE_ORIGIN"]?.trim();
  if (override) return override;
  if (sources.isDevelopment) return "http://127.0.0.1:4319";

  try {
    const readText = sources.readText ?? ((path: string) => readFileSync(path, "utf8"));
    const parsed: unknown = JSON.parse(
      readText(join(sources.appPath, "dist", "service-config.json")),
    );
    return isEmbeddedServiceConfig(parsed) && parsed.account_service_origin.trim()
      ? parsed.account_service_origin.trim()
      : null;
  } catch {
    return null;
  }
}
