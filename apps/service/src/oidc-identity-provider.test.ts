import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConfiguredOidcIdentity,
  GOOGLE_OIDC,
  ORCID_SANDBOX_OIDC,
} from "./oidc-identity-provider.js";

const CLIENT_ID = "123456789-kiwi.apps.googleusercontent.com";
const NOW = new Date("2026-08-23T20:00:00.000Z");
const EXCHANGE = {
  code: "provider-authorization-code",
  redirectUri: "http://127.0.0.1:49152/oauth/callback/test",
  codeVerifier: "v".repeat(64),
};

function signedToken(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ format: "jwk" });
  key["kid"] = "provider-test-key";
  key["alg"] = "RS256";
  key["use"] = "sig";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key["kid"] }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`, "ascii"), privateKey);
  return { idToken: `${header}.${body}.${signature.toString("base64url")}`, key };
}

// The claim set Google actually returns for the openid email profile scopes.
function googleClaims(overrides: Record<string, unknown> = {}) {
  const seconds = Math.floor(NOW.getTime() / 1_000);
  return {
    iss: "https://accounts.google.com",
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: "115625890123456789012",
    email: "researcher@example.edu",
    email_verified: true,
    at_hash: "hK3odkTaCwtLPQ8Iq3ZKzA",
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/a/photo",
    given_name: "Ada",
    family_name: "Lovelace",
    nonce: "n".repeat(43),
    iat: seconds,
    exp: seconds + 3_600,
    ...overrides,
  };
}

// ORCID issues only the openid scope and returns no email claim at all.
function orcidClaims(overrides: Record<string, unknown> = {}) {
  const seconds = Math.floor(NOW.getTime() / 1_000);
  return {
    at_hash: "3KGZTPqLLZ8xJZQ6Y8yQrw",
    aud: "APP-ORCIDTESTCLIENT1",
    sub: "0000-0002-1825-0097",
    auth_time: seconds,
    iss: "https://sandbox.orcid.org",
    given_name: "Ada",
    family_name: "Lovelace",
    nonce: "n".repeat(43),
    iat: seconds,
    exp: seconds + 3_600,
    ...overrides,
  };
}

function providerFor(
  descriptor: typeof GOOGLE_OIDC,
  claims: Record<string, unknown>,
  clientId: string,
  clientSecret: string | null = null,
  tokenBody?: unknown,
) {
  const { idToken, key } = signedToken(claims);
  const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input) === descriptor.tokenEndpoint) {
      return new Response(
        JSON.stringify(
          tokenBody ?? {
            id_token: idToken,
            access_token: "provider-access-token",
            refresh_token: "provider-refresh-token",
            scope: descriptor.scope,
          },
        ),
        {
          status: init?.method === "POST" ? 200 : 405,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ keys: [key as JsonWebKey] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    provider: new ConfiguredOidcIdentity({
      descriptor,
      clientId,
      clientSecret,
      request,
      now: () => NOW,
    }),
    request,
  };
}

describe("configured Google identity", () => {
  it("accepts the claim set Google returns and reports a verified email", async () => {
    const { provider } = providerFor(GOOGLE_OIDC, googleClaims(), CLIENT_ID, "GOCSPX-secret");

    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).resolves.toEqual({
      provider: "google",
      subject: "115625890123456789012",
      email: "researcher@example.edu",
      emailVerified: true,
      displayName: "Ada Lovelace",
      issuer: "https://accounts.google.com",
      audience: CLIENT_ID,
      nonce: "n".repeat(43),
      expiresAt: new Date(NOW.getTime() + 3_600 * 1_000),
      authorization: {
        accessToken: "provider-access-token",
        refreshToken: "provider-refresh-token",
        scopes: "openid email profile",
      },
    });
  });

  it("sends the desktop client secret Google requires", async () => {
    const { provider, request } = providerFor(
      GOOGLE_OIDC,
      googleClaims(),
      CLIENT_ID,
      "GOCSPX-secret",
    );
    await provider.exchangeAuthorizationCode(EXCHANGE);
    const body = String(request.mock.calls[0]?.[1]?.body);

    expect(body).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(body).toContain("client_secret=GOCSPX-secret");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=");
  });

  it("omits the client secret when none is configured", async () => {
    const { provider, request } = providerFor(GOOGLE_OIDC, googleClaims(), CLIENT_ID);
    await provider.exchangeAuthorizationCode(EXCHANGE);
    expect(String(request.mock.calls[0]?.[1]?.body)).not.toContain("client_secret");
  });

  it("revokes a Google authorization without sending client credentials", async () => {
    const { provider, request } = providerFor(
      GOOGLE_OIDC,
      googleClaims(),
      CLIENT_ID,
      "GOCSPX-secret",
    );

    await expect(provider.revokeAuthorization("provider-access-token")).resolves.toBe("confirmed");
    const call = request.mock.calls.find(
      ([input]) => String(input) === GOOGLE_OIDC.revocationEndpoint,
    );
    expect(String(call?.[1]?.body)).toBe("token=provider-access-token");
  });

  it("names the code Google returned when it rejects the exchange", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new ConfiguredOidcIdentity({
      descriptor: GOOGLE_OIDC,
      clientId: CLIENT_ID,
      request,
      now: () => NOW,
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).rejects.toThrow(
      "The identity provider rejected the authorization exchange (invalid_request).",
    );
  });

  it("rejects an ID token issued for another client, issuer, or party", async () => {
    for (const overrides of [
      { aud: "987654321-other.apps.googleusercontent.com" },
      { iss: "https://accounts.example.test" },
      { azp: "987654321-other.apps.googleusercontent.com" },
    ]) {
      const { provider } = providerFor(GOOGLE_OIDC, googleClaims(overrides), CLIENT_ID);
      await expect(provider.exchangeAuthorizationCode(EXCHANGE)).rejects.toThrow(/ID token/iu);
    }
  });

  it("rejects an expired token and one issued too far in the future", async () => {
    const seconds = Math.floor(NOW.getTime() / 1_000);
    for (const overrides of [{ exp: seconds - 1 }, { iat: seconds + 3_600 }]) {
      const { provider } = providerFor(GOOGLE_OIDC, googleClaims(overrides), CLIENT_ID);
      await expect(provider.exchangeAuthorizationCode(EXCHANGE)).rejects.toThrow(/ID token/iu);
    }
  });

  it("refuses an unverified Google email", async () => {
    const { provider } = providerFor(
      GOOGLE_OIDC,
      googleClaims({ email_verified: false }),
      CLIENT_ID,
    );
    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).rejects.toThrow(/unverified/iu);
  });

  it("refuses a token whose signature does not match the published key", async () => {
    const { idToken } = signedToken(googleClaims());
    const { key: otherKey } = signedToken(googleClaims());
    const request = vi.fn(async (input: string | URL) =>
      String(input) === GOOGLE_OIDC.tokenEndpoint
        ? new Response(JSON.stringify({ id_token: idToken }), { status: 200 })
        : new Response(JSON.stringify({ keys: [otherKey as JsonWebKey] }), { status: 200 }),
    );
    const provider = new ConfiguredOidcIdentity({
      descriptor: GOOGLE_OIDC,
      clientId: CLIENT_ID,
      request,
      now: () => NOW,
    });
    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).rejects.toThrow(/signature/iu);
  });
});

describe("configured ORCID identity", () => {
  it("accepts an ORCID token that carries no email claim", async () => {
    const { provider } = providerFor(
      ORCID_SANDBOX_OIDC,
      orcidClaims(),
      "APP-ORCIDTESTCLIENT1",
      "orcid-secret",
    );

    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).resolves.toMatchObject({
      provider: "orcid",
      subject: "0000-0002-1825-0097",
      email: null,
      emailVerified: false,
      displayName: "Ada Lovelace",
      issuer: "https://sandbox.orcid.org",
    });
  });

  it("requests only the openid scope from ORCID", () => {
    const { provider } = providerFor(ORCID_SANDBOX_OIDC, orcidClaims(), "APP-ORCIDTESTCLIENT1");
    const url = new URL(
      provider.authorizationUrl({
        redirectUri: EXCHANGE.redirectUri,
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://sandbox.orcid.org/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("does not reject an ORCID token for a missing email claim", async () => {
    const { provider } = providerFor(
      ORCID_SANDBOX_OIDC,
      orcidClaims({ email_verified: undefined }),
      "APP-ORCIDTESTCLIENT1",
    );
    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).resolves.toMatchObject({
      email: null,
    });
  });

  it("retains the ORCID authorization needed for revocation", async () => {
    const { provider } = providerFor(
      ORCID_SANDBOX_OIDC,
      orcidClaims(),
      "APP-ORCIDTESTCLIENT1",
      "orcid-secret",
    );

    await expect(provider.exchangeAuthorizationCode(EXCHANGE)).resolves.toMatchObject({
      authorization: {
        accessToken: "provider-access-token",
        refreshToken: "provider-refresh-token",
        scopes: "openid",
      },
    });
  });

  it("revokes an ORCID authorization through the documented endpoint", async () => {
    const { provider, request } = providerFor(
      ORCID_SANDBOX_OIDC,
      orcidClaims(),
      "APP-ORCIDTESTCLIENT1",
      "orcid-secret",
    );

    await expect(provider.revokeAuthorization("provider-refresh-token")).resolves.toBe("confirmed");
    const call = request.mock.calls.find(
      ([input]) => String(input) === ORCID_SANDBOX_OIDC.revocationEndpoint,
    );
    expect(String(call?.[1]?.body)).toContain("client_id=APP-ORCIDTESTCLIENT1");
    expect(String(call?.[1]?.body)).toContain("client_secret=orcid-secret");
    expect(String(call?.[1]?.body)).toContain("token=provider-refresh-token");
  });
});
