import type { ConnectedProviderId } from "@kiwi/contracts";
import { createHash } from "node:crypto";
import { defaultSmtpSecurity, type SmtpSecurity } from "./smtp.js";

export type ServiceEnvironment = "development" | "test" | "production";

export interface ServiceConfig {
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  publicOrigin: string;
  databaseUrl: string;
  environment: ServiceEnvironment;
  fixtureAuth: boolean;
  googleFixtureAuth: boolean;
  googleClientId: string | null;
  googleClientSecret: string | null;
  email: EmailConfig | null;
  orcid: OrcidConfig | null;
  connections: Partial<Record<ConnectedProviderId, ConnectionCredentials>>;
  connectionEncryptionKey: Uint8Array;
  retention: RetentionPolicy;
}

export interface RetentionPolicy {
  authenticationArtifactsDays: number;
  deliveredEmailDays: number;
  notificationsDays: number;
  securityEventsDays: number;
}

export interface ConnectionCredentials {
  clientId: string;
  clientSecret: string | null;
}

export interface OrcidConfig {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
}

export interface EmailConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
}

const DEVELOPMENT_DATABASE_URL =
  "postgresql://kiwi:kiwi-local-development-only@127.0.0.1:54329/kiwi";

function readEnvironment(value: string | undefined): ServiceEnvironment {
  if (value === undefined || value === "development") return "development";
  if (value === "test" || value === "production") return value;
  throw new Error("KIWI_SERVICE_ENV must be development, test, or production.");
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 4319;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KIWI_SERVICE_PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function readHost(
  value: string | undefined,
  environment: ServiceEnvironment,
): "127.0.0.1" | "0.0.0.0" {
  const host = value ?? (environment === "production" ? "0.0.0.0" : "127.0.0.1");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("KIWI_SERVICE_HOST must be 127.0.0.1 or 0.0.0.0.");
  }
  if (environment !== "production" && host !== "127.0.0.1") {
    throw new Error("The development service must bind to 127.0.0.1.");
  }
  return host;
}

function readPublicOrigin(
  value: string | undefined,
  environment: ServiceEnvironment,
  port: number,
): string {
  const candidate = (value ?? "").trim();
  if (candidate === "") {
    if (environment === "production") {
      throw new Error("Production requires KIWI_PUBLIC_ORIGIN.");
    }
    return `http://127.0.0.1:${port}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("KIWI_PUBLIC_ORIGIN must be one absolute service origin.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(environment !== "production" && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  ) {
    throw new Error(
      "KIWI_PUBLIC_ORIGIN must be an HTTPS origin without credentials, a path, a query, or a fragment.",
    );
  }
  return url.origin;
}

function readDatabaseUrl(value: string | undefined, environment: ServiceEnvironment): string {
  const candidate = value ?? (environment === "development" ? DEVELOPMENT_DATABASE_URL : null);
  if (candidate === null) {
    throw new Error("KIWI_DATABASE_URL is required outside local development.");
  }
  const url = new URL(candidate);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("KIWI_DATABASE_URL must use PostgreSQL.");
  }
  return candidate;
}

function readGoogleClientId(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const clientId = value.trim();
  if (clientId.length > 512 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId)) {
    throw new Error("KIWI_GOOGLE_CLIENT_ID must be a Google OAuth desktop client ID.");
  }
  return clientId;
}

function readGoogleClientSecret(value: string | undefined, clientId: string | null): string | null {
  if (value === undefined || value.trim() === "") return null;
  const secret = value.trim();
  if (clientId === null) {
    throw new Error("KIWI_GOOGLE_CLIENT_SECRET requires KIWI_GOOGLE_CLIENT_ID.");
  }
  if (secret.length > 256 || !/^[A-Za-z0-9._~-]+$/u.test(secret)) {
    throw new Error("KIWI_GOOGLE_CLIENT_SECRET must be a Google OAuth client secret.");
  }
  return secret;
}

const EMAIL_VARIABLES = [
  "KIWI_SMTP_HOST",
  "KIWI_SMTP_USERNAME",
  "KIWI_SMTP_PASSWORD",
  "KIWI_EMAIL_FROM",
] as const;

function readEmailAddress(value: string): string {
  const address = value.trim();
  if (address.length > 254 || !/^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/u.test(address)) {
    throw new Error("KIWI_EMAIL_FROM must be one plain email address.");
  }
  return address;
}

function readEmailConfig(env: NodeJS.ProcessEnv): EmailConfig | null {
  const present = EMAIL_VARIABLES.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length === 0) return null;
  if (present.length !== EMAIL_VARIABLES.length) {
    const missing = EMAIL_VARIABLES.filter((name) => !present.includes(name));
    throw new Error(`Email delivery also requires ${missing.join(", ")}.`);
  }
  const port = Number(env["KIWI_SMTP_PORT"] ?? "465");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KIWI_SMTP_PORT must be an integer from 1 through 65535.");
  }
  // The port implies the usual answer, so a provider that follows convention needs no
  // extra setting. The override exists for the ones that do not.
  const declared = (env["KIWI_SMTP_SECURITY"] ?? "").trim().toLowerCase();
  if (declared !== "" && declared !== "implicit" && declared !== "starttls") {
    throw new Error("KIWI_SMTP_SECURITY must be either implicit or starttls.");
  }
  return {
    host: (env["KIWI_SMTP_HOST"] ?? "").trim(),
    port,
    security: declared === "" ? defaultSmtpSecurity(port) : (declared as SmtpSecurity),
    username: (env["KIWI_SMTP_USERNAME"] ?? "").trim(),
    password: env["KIWI_SMTP_PASSWORD"] ?? "",
    from: readEmailAddress(env["KIWI_EMAIL_FROM"] ?? ""),
  };
}

function readOrcidConfig(env: NodeJS.ProcessEnv): OrcidConfig | null {
  const clientId = (env["KIWI_ORCID_CLIENT_ID"] ?? "").trim();
  const clientSecret = env["KIWI_ORCID_CLIENT_SECRET"] ?? "";
  if (clientId === "" && clientSecret === "") return null;
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      "ORCID sign-in requires both KIWI_ORCID_CLIENT_ID and KIWI_ORCID_CLIENT_SECRET.",
    );
  }
  if (!/^APP-[A-Z0-9]{16}$/u.test(clientId)) {
    throw new Error(
      "KIWI_ORCID_CLIENT_ID must be an ORCID client id such as APP-XXXXXXXXXXXXXXXX.",
    );
  }
  if (clientSecret.length > 256) {
    throw new Error("KIWI_ORCID_CLIENT_SECRET is not a valid ORCID client secret.");
  }
  const sandbox = env["KIWI_ORCID_SANDBOX"] !== "0";
  return { clientId, clientSecret, sandbox };
}

const CONNECTION_PROVIDERS: readonly ConnectedProviderId[] = [
  "github",
  "zotero",
  "mendeley",
  "osf",
  "figshare",
  "zenodo",
];

function readConnectionCredentials(
  env: NodeJS.ProcessEnv,
): Partial<Record<ConnectedProviderId, ConnectionCredentials>> {
  const credentials: Partial<Record<ConnectedProviderId, ConnectionCredentials>> = {};
  for (const provider of CONNECTION_PROVIDERS) {
    const prefix = `KIWI_${provider.toLocaleUpperCase("en-US")}`;
    const clientId = (env[`${prefix}_CLIENT_ID`] ?? "").trim();
    const clientSecret = env[`${prefix}_CLIENT_SECRET`] ?? "";
    if (clientId === "") {
      if (clientSecret !== "") {
        throw new Error(`${prefix}_CLIENT_SECRET requires ${prefix}_CLIENT_ID.`);
      }
      continue;
    }
    if (provider !== "github" && clientSecret === "") {
      throw new Error(`${prefix}_CLIENT_SECRET is required with ${prefix}_CLIENT_ID.`);
    }
    if (clientId.length > 255 || clientSecret.length > 512) {
      throw new Error(`${prefix}_CLIENT_ID is not a valid client credential.`);
    }
    credentials[provider] = {
      clientId,
      clientSecret: clientSecret === "" ? null : clientSecret,
    };
  }
  return credentials;
}

function readConnectionEncryptionKey(
  value: string | undefined,
  environment: ServiceEnvironment,
): Uint8Array {
  const encoded = (value ?? "").trim();
  if (encoded === "") {
    if (environment === "production") {
      throw new Error("Production requires KIWI_CONNECTION_ENCRYPTION_KEY.");
    }
    // Local-only stable key so encrypted fixture credentials remain readable across
    // restarts. Production can never use this fallback.
    return createHash("sha256").update("kiwi-local-connected-account-key-v1", "utf8").digest();
  }
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/u.test(encoded)) {
    throw new Error("KIWI_CONNECTION_ENCRYPTION_KEY must be one base64-encoded 32-byte key.");
  }
  const key = Buffer.from(encoded.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  if (key.byteLength !== 32) {
    throw new Error("KIWI_CONNECTION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function readRetentionDays(
  env: NodeJS.ProcessEnv,
  name:
    | "KIWI_AUTH_ARTIFACT_RETENTION_DAYS"
    | "KIWI_DELIVERED_EMAIL_RETENTION_DAYS"
    | "KIWI_NOTIFICATION_RETENTION_DAYS"
    | "KIWI_SECURITY_EVENT_RETENTION_DAYS",
  environment: ServiceEnvironment,
  developmentDefault: number,
): number {
  const value = (env[name] ?? "").trim();
  if (value === "") {
    if (environment === "production") {
      throw new Error(`Production requires ${name}.`);
    }
    return developmentDefault;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    throw new Error(`${name} must be an integer from 1 through 3650.`);
  }
  return days;
}

function readRetentionPolicy(
  env: NodeJS.ProcessEnv,
  environment: ServiceEnvironment,
): RetentionPolicy {
  return {
    authenticationArtifactsDays: readRetentionDays(
      env,
      "KIWI_AUTH_ARTIFACT_RETENTION_DAYS",
      environment,
      30,
    ),
    deliveredEmailDays: readRetentionDays(
      env,
      "KIWI_DELIVERED_EMAIL_RETENTION_DAYS",
      environment,
      30,
    ),
    notificationsDays: readRetentionDays(env, "KIWI_NOTIFICATION_RETENTION_DAYS", environment, 90),
    securityEventsDays: readRetentionDays(
      env,
      "KIWI_SECURITY_EVENT_RETENTION_DAYS",
      environment,
      365,
    ),
  };
}

export function readServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const environment = readEnvironment(env["KIWI_SERVICE_ENV"]);
  const port = readPort(env["KIWI_SERVICE_PORT"]);
  const fixtureAuth = env["KIWI_AUTH_FIXTURES"] === "1";
  const googleFixtureAuth = env["KIWI_GOOGLE_AUTH_FIXTURE"] === "1";
  if (fixtureAuth && environment === "production") {
    throw new Error("Fixture authentication adapters cannot run in production.");
  }
  if (googleFixtureAuth && (!fixtureAuth || environment === "production")) {
    throw new Error("The Google fixture requires non-production authentication fixtures.");
  }
  const email = readEmailConfig(env);
  if (environment === "production" && email === null) {
    throw new Error("Production requires configured email delivery.");
  }
  const googleClientId = readGoogleClientId(env["KIWI_GOOGLE_CLIENT_ID"]);
  const googleClientSecret = readGoogleClientSecret(
    env["KIWI_GOOGLE_CLIENT_SECRET"],
    googleClientId,
  );
  if (environment === "production" && (googleClientId === null || googleClientSecret === null)) {
    throw new Error("Production requires KIWI_GOOGLE_CLIENT_ID and KIWI_GOOGLE_CLIENT_SECRET.");
  }
  return {
    host: readHost(env["KIWI_SERVICE_HOST"], environment),
    port,
    publicOrigin: readPublicOrigin(env["KIWI_PUBLIC_ORIGIN"], environment, port),
    databaseUrl: readDatabaseUrl(env["KIWI_DATABASE_URL"], environment),
    environment,
    fixtureAuth,
    googleFixtureAuth,
    googleClientId,
    googleClientSecret,
    email,
    orcid: readOrcidConfig(env),
    connections: readConnectionCredentials(env),
    connectionEncryptionKey: readConnectionEncryptionKey(
      env["KIWI_CONNECTION_ENCRYPTION_KEY"],
      environment,
    ),
    retention: readRetentionPolicy(env, environment),
  };
}
