import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type {
  OidcAuthorizationRequest,
  OidcCodeExchange,
  OidcIdentity,
  OidcIdentityAdapter,
  OidcProviderId,
} from "./auth-fixtures.js";

const MAX_TOKEN_LENGTH = 16_384;

export interface OidcProviderDescriptor {
  id: OidcProviderId;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  issuers: readonly string[];
  canonicalIssuer: string;
  scope: string;
  // ORCID issues only the openid scope and never returns an email claim, so an account
  // cannot be created from an ORCID sign-in alone.
  providesEmail: boolean;
  revocationEndpoint?: string;
  revocationUsesClientCredentials?: boolean;
}

export const GOOGLE_OIDC: OidcProviderDescriptor = {
  id: "google",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksEndpoint: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  canonicalIssuer: "https://accounts.google.com",
  scope: "openid email profile",
  providesEmail: true,
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
};

export const ORCID_OIDC: OidcProviderDescriptor = {
  id: "orcid",
  authorizationEndpoint: "https://orcid.org/oauth/authorize",
  tokenEndpoint: "https://orcid.org/oauth/token",
  jwksEndpoint: "https://orcid.org/oauth/jwks",
  issuers: ["https://orcid.org"],
  canonicalIssuer: "https://orcid.org",
  scope: "openid",
  providesEmail: false,
  revocationEndpoint: "https://orcid.org/oauth/revoke",
  revocationUsesClientCredentials: true,
};

export const ORCID_SANDBOX_OIDC: OidcProviderDescriptor = {
  ...ORCID_OIDC,
  authorizationEndpoint: "https://sandbox.orcid.org/oauth/authorize",
  tokenEndpoint: "https://sandbox.orcid.org/oauth/token",
  jwksEndpoint: "https://sandbox.orcid.org/oauth/jwks",
  issuers: ["https://sandbox.orcid.org"],
  canonicalIssuer: "https://sandbox.orcid.org",
  revocationEndpoint: "https://sandbox.orcid.org/oauth/revoke",
};

type OidcFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OidcIdentityProviderOptions {
  descriptor: OidcProviderDescriptor;
  clientId: string;
  clientSecret?: string | null;
  request?: OidcFetch;
  now?: () => Date;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The identity provider returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function decodeSegment(value: string): Record<string, unknown> {
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new Error("The identity provider returned an invalid ID token.");
  }
  return readRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown);
}

function readText(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("The identity provider returned an invalid ID token.");
  }
  return value;
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function readNumericDate(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("The identity provider returned an invalid ID token.");
  }
  return value;
}

function readErrorCode(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "unreadable_error";
  const code = (body as Record<string, unknown>)["error"];
  return typeof code === "string" && /^[a-z_]{1,64}$/u.test(code) ? code : "unreadable_error";
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const code = readErrorCode(await response.json().catch(() => null));
    throw new Error(`The identity provider rejected the authorization exchange (${code}).`);
  }
  return readRecord(await response.json());
}

function composeName(claims: Record<string, unknown>): string | null {
  const full = optionalText(claims, "name", 80);
  if (full !== null) return full;
  const given = optionalText(claims, "given_name", 80);
  const family = optionalText(claims, "family_name", 80);
  const parts = [given, family].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export class ConfiguredOidcIdentity implements OidcIdentityAdapter {
  readonly kind = "configured" as const;
  readonly provider: OidcProviderId;
  readonly audience: string;
  readonly providesEmail: boolean;
  private readonly descriptor: OidcProviderDescriptor;
  private readonly clientSecret: string | null;
  private readonly request: OidcFetch;
  private readonly now: () => Date;

  constructor(options: OidcIdentityProviderOptions) {
    this.descriptor = options.descriptor;
    this.provider = options.descriptor.id;
    this.providesEmail = options.descriptor.providesEmail;
    this.audience = options.clientId;
    this.clientSecret = options.clientSecret ?? null;
    this.request = options.request ?? fetch;
    this.now = options.now ?? ((): Date => new Date());
  }

  authorizationUrl(request: OidcAuthorizationRequest): string {
    const url = new URL(this.descriptor.authorizationEndpoint);
    url.searchParams.set("client_id", this.audience);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.descriptor.scope);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    return url.toString();
  }

  completeFixtureAuthorization(): URL | null {
    return null;
  }

  async exchangeAuthorizationCode(exchange: OidcCodeExchange): Promise<OidcIdentity> {
    const body = new URLSearchParams({
      client_id: this.audience,
      code: exchange.code,
      code_verifier: exchange.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: exchange.redirectUri,
    });
    if (this.clientSecret !== null) body.set("client_secret", this.clientSecret);
    const tokenResponse = await this.request(this.descriptor.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = await readJson(tokenResponse);
    const idToken = readText(tokenBody, "id_token", MAX_TOKEN_LENGTH);
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("The identity provider returned an invalid ID token.");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedClaims === undefined ||
      encodedSignature === undefined
    ) {
      throw new Error("The identity provider returned an invalid ID token.");
    }

    const header = decodeSegment(encodedHeader);
    const claims = decodeSegment(encodedClaims);
    if (header["alg"] !== "RS256") {
      throw new Error("The identity provider returned an invalid ID token.");
    }
    const keyId = readText(header, "kid", 256);
    const keysResponse = await this.request(this.descriptor.jwksEndpoint, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const keysBody = await readJson(keysResponse);
    const keys = keysBody["keys"];
    if (!Array.isArray(keys)) {
      throw new Error("The identity provider returned invalid signing keys.");
    }
    const signingKey = keys.find(
      (candidate): candidate is JsonWebKey =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>)["kid"] === keyId &&
        (candidate as Record<string, unknown>)["kty"] === "RSA",
    );
    if (signingKey === undefined) {
      throw new Error("The identity provider returned no matching signing key.");
    }
    const validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
      createPublicKey({ key: signingKey, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature) {
      throw new Error("The identity provider returned an invalid ID token signature.");
    }

    const issuer = readText(claims, "iss", 64);
    const audience = readText(claims, "aud", 512);
    const authorizedParty = claims["azp"];
    const expiresAtSeconds = readNumericDate(claims, "exp");
    const issuedAtSeconds = readNumericDate(claims, "iat");
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (
      !this.descriptor.issuers.includes(issuer) ||
      audience !== this.audience ||
      (authorizedParty !== undefined && authorizedParty !== this.audience) ||
      expiresAtSeconds <= nowSeconds ||
      issuedAtSeconds > nowSeconds + 300
    ) {
      throw new Error("The identity provider returned an invalid ID token.");
    }

    const email = this.descriptor.providesEmail ? readText(claims, "email", 254) : null;
    if (this.descriptor.providesEmail && claims["email_verified"] !== true) {
      throw new Error("The identity provider returned an unverified email address.");
    }

    return {
      provider: this.descriptor.id,
      subject: readText(claims, "sub", 255),
      email,
      emailVerified: email !== null,
      displayName: composeName(claims),
      issuer: this.descriptor.canonicalIssuer,
      audience,
      nonce: readText(claims, "nonce", 256),
      expiresAt: new Date(expiresAtSeconds * 1_000),
      authorization: {
        accessToken: readText(tokenBody, "access_token", MAX_TOKEN_LENGTH),
        refreshToken: optionalText(tokenBody, "refresh_token", MAX_TOKEN_LENGTH),
        scopes: optionalText(tokenBody, "scope", 1_000) ?? this.descriptor.scope,
      },
    };
  }

  async revokeAuthorization(token: string): Promise<"confirmed" | "failed" | "not_supported"> {
    const endpoint = this.descriptor.revocationEndpoint;
    if (
      endpoint === undefined ||
      (this.descriptor.revocationUsesClientCredentials === true && this.clientSecret === null)
    ) {
      return "not_supported";
    }
    try {
      const body = new URLSearchParams({ token });
      if (this.descriptor.revocationUsesClientCredentials === true) {
        body.set("client_id", this.audience);
        body.set("client_secret", this.clientSecret!);
      }
      const response = await this.request(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? "confirmed" : "failed";
    } catch {
      return "failed";
    }
  }
}
