import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Clock, IdGenerator } from "@kiwi/contracts";
import type { AccountAuthStore, StoredAccount } from "./auth-store.js";
import {
  FixtureAuthTokenGenerator,
  FixtureGoogleIdentity,
  type OidcIdentityAdapter,
} from "./auth-fixtures.js";
import { createOidcAuthService } from "./oidc-auth-service.js";
import type {
  OidcAuthStore,
  OidcIdentityResolution,
  OidcLinkResult,
  OidcUnlinkResult,
} from "./oidc-auth-store.js";

const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");
const START = {
  redirect_uri: "http://127.0.0.1:49152/oauth/callback/test",
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  code_challenge: CHALLENGE,
};

class TestIds implements IdGenerator {
  private value = 0;
  next(): string {
    this.value += 1;
    return `id-${this.value}`;
  }
}

// The fixture provider stamps its own expiry from the real clock, so the service under
// test must read the same clock.
const clock: Clock = { now: () => new Date() };

const ACCOUNT: StoredAccount = {
  id: "account-1",
  email: "researcher@example.test",
  verified: true,
  status: "active",
};

class MemoryOidcStore implements OidcAuthStore {
  transaction:
    | {
        provider: "google" | "orcid";
        linkUserId: string | null;
        reauthSessionId: string | null;
        stateHash: string;
        callbackStateHash: string;
        nonceHash: string;
        codeChallenge: string;
        redirectUri: string;
        expiresAt: Date;
        consumed: boolean;
      }
    | undefined;
  resolution: OidcIdentityResolution = { kind: "account", account: ACCOUNT };
  linkResult: OidcLinkResult = { kind: "linked" };
  unlinkResult: OidcUnlinkResult = { kind: "unlinked", revocationSecret: null };
  readonly links: Array<{ provider: string; userId: string; subject: string }> = [];
  readonly unlinks: Array<{ provider: string; userId: string }> = [];
  readonly reauthentications: Array<{
    provider: string;
    userId: string;
    sessionId: string;
    subject: string;
  }> = [];
  lastLink: Parameters<OidcAuthStore["linkIdentity"]>[0] | null = null;
  reauthenticationResult = true;
  lastResolution: Parameters<OidcAuthStore["resolveIdentity"]>[0] | null = null;

  async beginTransaction(input: Parameters<OidcAuthStore["beginTransaction"]>[0]): Promise<void> {
    this.transaction = { ...input, consumed: false };
  }

  async providerCallback(
    input: Parameters<OidcAuthStore["providerCallback"]>[0],
  ): ReturnType<OidcAuthStore["providerCallback"]> {
    const pending = this.transaction;
    return pending !== undefined &&
      !pending.consumed &&
      pending.callbackStateHash === input.callbackStateHash &&
      pending.expiresAt > input.now
      ? { provider: pending.provider, redirectUri: pending.redirectUri }
      : null;
  }

  async consumeTransaction(input: {
    stateHash: string;
    nonceHash: string;
    codeChallenge: string;
    redirectUri: string;
    now: Date;
  }): Promise<{
    provider: "google" | "orcid";
    linkUserId: string | null;
    reauthSessionId: string | null;
  } | null> {
    const pending = this.transaction;
    if (
      pending === undefined ||
      pending.consumed ||
      pending.stateHash !== input.stateHash ||
      pending.nonceHash !== input.nonceHash ||
      pending.codeChallenge !== input.codeChallenge ||
      pending.redirectUri !== input.redirectUri ||
      pending.expiresAt <= input.now
    ) {
      return null;
    }
    pending.consumed = true;
    return {
      provider: pending.provider,
      linkUserId: pending.linkUserId,
      reauthSessionId: pending.reauthSessionId,
    };
  }

  async resolveIdentity(
    input: Parameters<OidcAuthStore["resolveIdentity"]>[0],
  ): Promise<OidcIdentityResolution> {
    this.lastResolution = input;
    return this.resolution;
  }

  async linkIdentity(input: Parameters<OidcAuthStore["linkIdentity"]>[0]): Promise<OidcLinkResult> {
    this.lastLink = input;
    this.links.push({ provider: input.provider, userId: input.userId, subject: input.subject });
    return this.linkResult;
  }

  async reauthenticateIdentity(
    input: Parameters<OidcAuthStore["reauthenticateIdentity"]>[0],
  ): Promise<boolean> {
    this.reauthentications.push(input);
    return this.reauthenticationResult;
  }

  async unlinkIdentity(input: {
    provider: "google" | "orcid";
    userId: string;
  }): Promise<OidcUnlinkResult> {
    this.unlinks.push({ provider: input.provider, userId: input.userId });
    return this.unlinkResult;
  }
}

function accountStore(): AccountAuthStore {
  return {
    takeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    createSession: vi.fn(async () => undefined),
    recordSecurityEvent: vi.fn(async () => undefined),
  } as unknown as AccountAuthStore;
}

function orcidAdapter(subject = "0000-0002-1825-0097"): OidcIdentityAdapter {
  return {
    kind: "configured",
    provider: "orcid",
    audience: "APP-ORCIDTESTCLIENT1",
    providesEmail: false,
    authorizationUrl: (request) =>
      `https://sandbox.orcid.org/oauth/authorize?state=${request.state}`,
    completeFixtureAuthorization: () => null,
    exchangeAuthorizationCode: async () => ({
      provider: "orcid" as const,
      subject,
      email: null,
      emailVerified: false,
      displayName: "Ada Lovelace",
      issuer: "https://sandbox.orcid.org",
      audience: "APP-ORCIDTESTCLIENT1",
      nonce: "n".repeat(43),
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      authorization: {
        accessToken: "orcid-access-token",
        refreshToken: "orcid-refresh-token",
        scopes: "openid",
      },
    }),
  };
}

function setup(
  adapters: OidcIdentityAdapter[] = [new FixtureGoogleIdentity()],
  providerRedirectUris: Partial<Record<"google" | "orcid", string>> = {},
) {
  const store = new MemoryOidcStore();
  const accounts = accountStore();
  const service = createOidcAuthService({
    store,
    accounts,
    adapters,
    providerRedirectUris,
    clock,
    ids: new TestIds(),
    tokens: new FixtureAuthTokenGenerator(),
  });
  return { service, store, accounts };
}

async function authorize(
  service: ReturnType<typeof createOidcAuthService>,
  provider?: "google" | "orcid",
  linkUserId?: string,
  registrationProfile?: { given_name: string; family_name: string; phone: string },
): Promise<string> {
  const started = await service.start(
    {
      ...START,
      ...(provider === undefined ? {} : { provider }),
      ...(registrationProfile === undefined ? {} : { registration_profile: registrationProfile }),
    },
    linkUserId === undefined ? undefined : { kind: "link", userId: linkUserId },
  );
  if (started.status !== "browser_required") throw new Error("The provider did not start.");
  return new URL(started.authorization_url).searchParams.get("code") ?? "orcid-code";
}

describe("provider sign-in", () => {
  it("reauthenticates the bound session without issuing another device session", async () => {
    const { service, store, accounts } = setup();
    const started = await service.start(START, {
      kind: "reauthenticate",
      sessionId: "session-current",
    });
    if (started.status !== "browser_required") throw new Error("The provider did not start.");
    const code = new URL(started.authorization_url).searchParams.get("code") ?? "";

    await expect(
      service.exchange(
        { ...START, code, code_verifier: VERIFIER },
        { userId: "account-1", sessionId: "session-current" },
      ),
    ).resolves.toEqual({ status: "reauthenticated", provider: "google" });
    expect(store.reauthentications).toEqual([
      expect.objectContaining({ userId: "account-1", sessionId: "session-current" }),
    ]);
    expect(accounts.createSession).not.toHaveBeenCalled();
  });

  it("rejects a provider identity that does not belong to the current account", async () => {
    const { service, store } = setup();
    store.reauthenticationResult = false;
    const started = await service.start(START, {
      kind: "reauthenticate",
      sessionId: "session-current",
    });
    if (started.status !== "browser_required") throw new Error("The provider did not start.");
    const code = new URL(started.authorization_url).searchParams.get("code") ?? "";

    await expect(
      service.exchange(
        { ...START, code, code_verifier: VERIFIER },
        { userId: "account-1", sessionId: "session-current" },
      ),
    ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
  });

  it("lists only the providers that were configured", () => {
    expect(setup().service.providers()).toEqual(["google"]);
    expect(setup([new FixtureGoogleIdentity(), orcidAdapter()]).service.providers()).toEqual([
      "google",
      "orcid",
    ]);
  });

  it("refuses to start a provider that is not configured", async () => {
    const { service } = setup();
    await expect(service.start({ ...START, provider: "orcid" })).resolves.toMatchObject({
      status: "error",
      code: "invalid_callback",
    });
  });

  it("signs in through the fixture provider and issues a session", async () => {
    const { service, accounts } = setup();
    const code = await authorize(service);
    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "authenticated" });
    expect(accounts.createSession).toHaveBeenCalledOnce();
  });

  it("binds a complete profile to Google account creation", async () => {
    const { service, store } = setup();
    const registration_profile = {
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    };
    const code = await authorize(service, undefined, undefined, registration_profile);

    await service.exchange({
      ...START,
      registration_profile,
      code,
      code_verifier: VERIFIER,
    });
    expect(store.lastResolution?.registrationProfile).toEqual(registration_profile);
  });

  it("directs an unregistered Google identity to Create an Account", async () => {
    const { service, store } = setup();
    store.resolution = { kind: "unknown_identity" };
    const code = await authorize(service);

    await expect(service.exchange({ ...START, code, code_verifier: VERIFIER })).resolves.toEqual({
      status: "error",
      code: "identity_link_required",
      message: "No Kiwi account is connected to this Google account. Use Create an Account first.",
    });
  });

  it("refuses to create an account from a provider that supplies no email", async () => {
    const { service, store } = setup([orcidAdapter()]);
    store.resolution = { kind: "unknown_identity" };
    const code = await authorize(service, "orcid");

    await expect(service.exchange({ ...START, code, code_verifier: VERIFIER })).resolves.toEqual({
      status: "error",
      code: "identity_link_required",
      message:
        "Sign in with your email or Google first, then connect this method in Account Settings.",
    });
  });

  it("signs in with a provider identity that is already linked", async () => {
    const { service, store } = setup([orcidAdapter()]);
    store.resolution = { kind: "account", account: ACCOUNT };
    const code = await authorize(service, "orcid");

    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "authenticated" });
  });
});

describe("sign-in method linking", () => {
  it("attaches the provider identity to the account that started the link", async () => {
    const { service, store } = setup([orcidAdapter()]);
    const code = await authorize(service, "orcid", "account-7");

    await expect(service.exchange({ ...START, code, code_verifier: VERIFIER })).resolves.toEqual({
      status: "identity_linked",
      provider: "orcid",
    });
    expect(store.links).toEqual([
      { provider: "orcid", userId: "account-7", subject: "0000-0002-1825-0097" },
    ]);
    expect(store.lastLink?.authorization).toEqual({
      accessToken: "orcid-access-token",
      refreshToken: "orcid-refresh-token",
      scopes: "openid",
    });
  });

  it("refuses to link a provider identity that another account already owns", async () => {
    const { service, store } = setup([orcidAdapter()]);
    store.linkResult = { kind: "claimed_elsewhere" };
    const code = await authorize(service, "orcid", "account-7");

    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "error", code: "identity_link_required" });
  });

  it("does not issue a session when the exchange was a link", async () => {
    const { service, accounts } = setup([orcidAdapter()]);
    const code = await authorize(service, "orcid", "account-7");
    await service.exchange({ ...START, code, code_verifier: VERIFIER });
    expect(accounts.createSession).not.toHaveBeenCalled();
  });

  it("removes a linked method and reports the provider", async () => {
    const { service, store } = setup([orcidAdapter()]);
    await expect(service.unlink("account-7", "orcid")).resolves.toEqual({
      status: "identity_unlinked",
      provider: "orcid",
      provider_revocation: "not_supported",
    });
    expect(store.unlinks).toEqual([{ provider: "orcid", userId: "account-7" }]);
  });

  it("revokes the provider authorization after removing a linked method", async () => {
    const revokeAuthorization = vi.fn(async () => "confirmed" as const);
    const { service, store } = setup([{ ...orcidAdapter(), revokeAuthorization }]);
    store.unlinkResult = { kind: "unlinked", revocationSecret: "orcid-refresh-token" };

    await expect(service.unlink("account-7", "orcid")).resolves.toEqual({
      status: "identity_unlinked",
      provider: "orcid",
      provider_revocation: "confirmed",
    });
    expect(revokeAuthorization).toHaveBeenCalledWith("orcid-refresh-token");
  });

  it("keeps a completed local unlink when remote revocation fails", async () => {
    const revokeAuthorization = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const failures: string[] = [];
    const store = new MemoryOidcStore();
    store.unlinkResult = { kind: "unlinked", revocationSecret: "orcid-refresh-token" };
    const service = createOidcAuthService({
      store,
      accounts: accountStore(),
      adapters: [{ ...orcidAdapter(), revokeAuthorization }],
      clock,
      ids: new TestIds(),
      tokens: new FixtureAuthTokenGenerator(),
      reportProviderFailure: (reason) => failures.push(reason),
    });

    await expect(service.unlink("account-7", "orcid")).resolves.toEqual({
      status: "identity_unlinked",
      provider: "orcid",
      provider_revocation: "failed",
    });
    expect(failures).toEqual([
      "authorization revocation failed after orcid unlink: provider unavailable",
    ]);
  });

  it("keeps the last usable sign-in method", async () => {
    const { service, store } = setup([orcidAdapter()]);
    store.unlinkResult = { kind: "last_method" };
    await expect(service.unlink("account-7", "orcid")).resolves.toEqual({
      status: "error",
      code: "invalid_input",
      message: "At least one authentication method must remain configured.",
    });
  });

  it("reports a method that was never connected", async () => {
    const { service, store } = setup([orcidAdapter()]);
    store.unlinkResult = { kind: "not_linked" };
    await expect(service.unlink("account-7", "orcid")).resolves.toMatchObject({
      status: "error",
      code: "invalid_input",
    });
  });
});

describe("hosted provider callback", () => {
  const hostedCallback = "https://api.kiwi.example/v1/auth/oidc/callback";

  it("returns ORCID to the exact desktop listener and exchanges against the hosted URI", async () => {
    const adapter = orcidAdapter();
    const authorizationUrl = vi.fn(adapter.authorizationUrl);
    const exchangeAuthorizationCode = vi.fn(adapter.exchangeAuthorizationCode);
    const { service } = setup([{ ...adapter, authorizationUrl, exchangeAuthorizationCode }], {
      orcid: hostedCallback,
    });
    const started = await service.start({ ...START, provider: "orcid" });
    if (started.status !== "browser_required") throw new Error("ORCID did not start.");
    expect(authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: hostedCallback }),
    );

    const callback = await service.completeProviderCallback(
      new URL(`${hostedCallback}?state=${START.state}&code=orcid-provider-code`),
    );
    expect(callback).not.toBeNull();
    expect(callback!.origin + callback!.pathname).toBe(
      "http://127.0.0.1:49152/oauth/callback/test",
    );
    expect(callback?.searchParams.get("state")).toBe(START.state);
    expect(callback?.searchParams.get("code")).toBe("orcid-provider-code");

    await expect(
      service.exchange({
        ...START,
        provider: "orcid",
        code: "orcid-provider-code",
        code_verifier: VERIFIER,
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: hostedCallback }),
    );
  });

  it("refuses forged callback state and forwards a provider denial without a code", async () => {
    const { service } = setup([orcidAdapter()], { orcid: hostedCallback });
    await service.start({ ...START, provider: "orcid" });

    await expect(
      service.completeProviderCallback(
        new URL(`${hostedCallback}?state=${"x".repeat(43)}&code=forged`),
      ),
    ).resolves.toBeNull();
    const denied = await service.completeProviderCallback(
      new URL(`${hostedCallback}?state=${START.state}&error=access_denied`),
    );
    expect(denied?.searchParams.get("state")).toBe(START.state);
    expect(denied?.searchParams.get("error")).toBe("access_denied");
    expect(denied?.searchParams.has("code")).toBe(false);
  });
});

describe("provider exchange guards", () => {
  it("rejects transaction and authorization-code replay", async () => {
    const { service } = setup();
    const code = await authorize(service);
    await service.exchange({ ...START, code, code_verifier: VERIFIER });
    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_callback" });
  });

  it("rejects a verifier that does not match the recorded challenge", async () => {
    const { service } = setup();
    const code = await authorize(service);
    await expect(
      service.exchange({ ...START, code, code_verifier: "w".repeat(64) }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_callback" });
  });

  it("rejects a registration profile that was not present when the transaction started", async () => {
    const { service } = setup();
    const code = await authorize(service);
    await expect(
      service.exchange({
        ...START,
        registration_profile: {
          given_name: "Kiwi",
          family_name: "Reader",
          phone: "+14155550134",
        },
        code,
        code_verifier: VERIFIER,
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_callback" });
  });

  it("rejects a provider nonce that does not match the request", async () => {
    const wrongNonce = orcidAdapter();
    const service = setup([
      {
        ...wrongNonce,
        exchangeAuthorizationCode: async () => ({
          ...(await wrongNonce.exchangeAuthorizationCode({
            code: "c",
            redirectUri: START.redirect_uri,
            codeVerifier: VERIFIER,
          })),
          nonce: "wrong".repeat(12),
        }),
      },
    ]).service;
    const code = await authorize(service, "orcid");
    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_callback" });
  });

  it("refuses a redirect that is not a loopback callback", async () => {
    const { service } = setup();
    await expect(
      service.start({ ...START, redirect_uri: "https://example.test/oauth/callback/x" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_callback" });
  });

  it("reports a session failure after a verified sign-in instead of throwing", async () => {
    const store = new MemoryOidcStore();
    const failures: string[] = [];
    const accounts = {
      takeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      createSession: vi.fn(async () => {
        throw new Error(
          'duplicate key value violates unique constraint "session_refresh_tokens_token_hash_key"',
        );
      }),
      recordSecurityEvent: vi.fn(async () => undefined),
    } as unknown as AccountAuthStore;
    const service = createOidcAuthService({
      store,
      accounts,
      adapters: [new FixtureGoogleIdentity()],
      clock,
      ids: new TestIds(),
      tokens: new FixtureAuthTokenGenerator(),
      reportProviderFailure: (reason) => failures.push(reason),
    });
    const started = await service.start(START);
    if (started.status !== "browser_required") throw new Error("The provider did not start.");
    const code = new URL(started.authorization_url).searchParams.get("code") ?? "";

    await expect(
      service.exchange({ ...START, code, code_verifier: VERIFIER }),
    ).resolves.toMatchObject({ status: "error", code: "service_unavailable" });
    expect(failures[0]).toContain("session issue failed after a verified google sign-in");
    expect(accounts.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "session_failed" }),
    );
  });
});
