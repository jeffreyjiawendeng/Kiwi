export interface VerificationDelivery {
  recipient: string;
  purpose: "verify_email" | "reset_password";
  code: string;
  expiresAt: Date;
}

export interface EmailDeliveryAdapter {
  readonly kind: "fixture" | "configured";
  send(delivery: VerificationDelivery): Promise<void>;
}

export interface AuthTokenGenerator {
  next(purpose: "verify_email" | "reset_password" | "access_token" | "refresh_token"): string;
}

export type OidcProviderId = "google" | "orcid";

export interface OidcIdentity {
  provider: OidcProviderId;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  issuer: string;
  audience: string;
  nonce: string;
  expiresAt: Date;
  authorization?: {
    accessToken: string;
    refreshToken: string | null;
    scopes: string;
  } | null;
}

export interface OidcAuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface OidcCodeExchange {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface OidcIdentityAdapter {
  readonly kind: "fixture" | "configured";
  readonly provider: OidcProviderId;
  readonly audience: string;
  readonly providesEmail: boolean;
  authorizationUrl(request: OidcAuthorizationRequest): string;
  completeFixtureAuthorization(url: URL): URL | null;
  exchangeAuthorizationCode(exchange: OidcCodeExchange): Promise<OidcIdentity>;
  revokeAuthorization?(token: string): Promise<"confirmed" | "failed" | "not_supported">;
}

export class FixtureEmailDelivery implements EmailDeliveryAdapter {
  readonly kind = "fixture" as const;
  readonly deliveries: VerificationDelivery[] = [];

  async send(delivery: VerificationDelivery): Promise<void> {
    this.deliveries.push({ ...delivery, expiresAt: new Date(delivery.expiresAt) });
  }
}

export class FixtureGoogleIdentity implements OidcIdentityAdapter {
  readonly kind = "fixture" as const;
  readonly provider = "google" as const;
  readonly audience = "kiwi-development-client";
  readonly providesEmail = true;
  private sequence = 0;
  private readonly pending = new Map<string, OidcAuthorizationRequest>();

  constructor(private readonly serviceOrigin = "http://127.0.0.1:4319") {}

  authorizationUrl(request: OidcAuthorizationRequest): string {
    this.sequence += 1;
    const code = `kiwi-google-success-${String(this.sequence).padStart(6, "0")}`;
    this.pending.set(code, request);
    const url = new URL(ACCOUNT_AUTH_PATHS.googleFixtureAuthorize, this.serviceOrigin);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("code", code);
    return url.toString();
  }

  completeFixtureAuthorization(url: URL): URL | null {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (code === null || state === null || redirectUri === null) return null;
    const pending = this.pending.get(code);
    if (pending === undefined || pending.state !== state || pending.redirectUri !== redirectUri) {
      return null;
    }
    const callback = new URL(redirectUri);
    if (url.searchParams.get("outcome") === "denied") {
      callback.searchParams.set("error", "access_denied");
    } else {
      callback.searchParams.set("code", code);
    }
    callback.searchParams.set("state", state);
    return callback;
  }

  async exchangeAuthorizationCode(exchange: OidcCodeExchange): Promise<OidcIdentity> {
    const pending = this.pending.get(exchange.code);
    if (pending === undefined) {
      throw new Error("The fixture authorization code is not valid.");
    }
    const challenge = createHash("sha256")
      .update(exchange.codeVerifier, "ascii")
      .digest("base64url");
    if (pending.redirectUri !== exchange.redirectUri || pending.codeChallenge !== challenge) {
      throw new Error("The fixture authorization exchange does not match its request.");
    }
    this.pending.delete(exchange.code);
    return {
      provider: "google",
      subject: "google-fixture-user-1",
      email: "researcher@example.test",
      emailVerified: true,
      displayName: "Kiwi Researcher",
      issuer: "https://accounts.google.com",
      audience: this.audience,
      nonce: pending.nonce,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      authorization: null,
    };
  }
}

export class FixtureAuthTokenGenerator implements AuthTokenGenerator {
  private readonly counters = new Map<string, number>();

  // Only the codes a person retypes are deterministic. A session credential is unique for
  // its whole lifetime in storage, and a counter that restarts with the process would
  // reissue a value an earlier session already stored.
  next(purpose: "verify_email" | "reset_password" | "access_token" | "refresh_token"): string {
    if (purpose === "access_token" || purpose === "refresh_token") {
      const prefix = purpose === "access_token" ? "kiwi_access_" : "kiwi_refresh_";
      return `${prefix}${randomBytes(32).toString("base64url")}`;
    }
    const count = (this.counters.get(purpose) ?? 0) + 1;
    this.counters.set(purpose, count);
    const label = purpose === "verify_email" ? "VERIFY" : "RESET";
    return `KIWI-${label}-${String(count).padStart(6, "0")}`;
  }
}

export interface DevelopmentAuthAdapters {
  email: EmailDeliveryAdapter;
  google: OidcIdentityAdapter;
  tokens: AuthTokenGenerator;
}

export function createDevelopmentAuthAdapters(
  enabled: boolean,
  serviceOrigin = "http://127.0.0.1:4319",
): DevelopmentAuthAdapters | null {
  if (!enabled) return null;
  return {
    email: new FixtureEmailDelivery(),
    google: new FixtureGoogleIdentity(serviceOrigin),
    tokens: new FixtureAuthTokenGenerator(),
  };
}
import { createHash, randomBytes } from "node:crypto";
import { ACCOUNT_AUTH_PATHS } from "@kiwi/contracts";
