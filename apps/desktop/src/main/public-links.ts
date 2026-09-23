import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLIC_LINK_KEYS = ["terms", "privacy", "support"] as const;
export type PublicLinkKey = (typeof PUBLIC_LINK_KEYS)[number];
export type PublicLinks = Record<PublicLinkKey, string | null>;
export type PublicLinkAvailability = Record<PublicLinkKey, boolean>;

interface EmbeddedPublicLinkConfig {
  version: 1;
  public_links?: Partial<Record<PublicLinkKey, unknown>>;
}

export interface PublicLinkSources {
  env: NodeJS.ProcessEnv;
  appPath: string;
  readText?: (path: string) => string;
}

const ENVIRONMENT_KEYS: Record<PublicLinkKey, string> = {
  terms: "KIWI_TERMS_URL",
  privacy: "KIWI_PRIVACY_URL",
  support: "KIWI_SUPPORT_URL",
};

export function readPublicLinkKey(value: unknown): PublicLinkKey | null {
  return typeof value === "string" && PUBLIC_LINK_KEYS.includes(value as PublicLinkKey)
    ? (value as PublicLinkKey)
    : null;
}

export function readPublicHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function embeddedLinks(sources: PublicLinkSources): Partial<Record<PublicLinkKey, unknown>> {
  try {
    const readText = sources.readText ?? ((path: string) => readFileSync(path, "utf8"));
    const parsed: unknown = JSON.parse(
      readText(join(sources.appPath, "dist", "service-config.json")),
    );
    if (parsed === null || typeof parsed !== "object") return {};
    const config = parsed as EmbeddedPublicLinkConfig;
    return config.version === 1 && config.public_links !== null ? (config.public_links ?? {}) : {};
  } catch {
    return {};
  }
}

export function resolvePublicLinks(sources: PublicLinkSources): PublicLinks {
  const embedded = embeddedLinks(sources);
  return Object.fromEntries(
    PUBLIC_LINK_KEYS.map((key) => [
      key,
      readPublicHttpsUrl(sources.env[ENVIRONMENT_KEYS[key]]) ?? readPublicHttpsUrl(embedded[key]),
    ]),
  ) as PublicLinks;
}

export function publicLinkAvailability(links: PublicLinks): PublicLinkAvailability {
  return Object.fromEntries(
    PUBLIC_LINK_KEYS.map((key) => [key, links[key] !== null]),
  ) as PublicLinkAvailability;
}
