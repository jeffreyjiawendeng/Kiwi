import { describe, expect, it, vi } from "vitest";
import type {
  Clock,
  ConnectedAccountSummary,
  ConnectedProviderId,
  IdGenerator,
} from "@kiwi/contracts";
import { createConnectionsService } from "./connections-service.js";
import type {
  ConnectionsStore,
  RefreshableConnection,
  StoredConnectionTransaction,
} from "./connections-store.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

class TestIds implements IdGenerator {
  private value = 0;
  next(): string {
    this.value += 1;
    return `transaction-${this.value}`;
  }
}

class MemoryConnectionsStore implements ConnectionsStore {
  connections: ConnectedAccountSummary[] = [];
  transaction: StoredConnectionTransaction | null = null;
  stateHash: string | null = null;
  secret: string | null = null;
  readonly saved: Array<Record<string, unknown>> = [];
  readonly removed: Array<{ provider: string }> = [];
  refreshable: RefreshableConnection[] = [];
  readonly completedRefreshes: Array<Record<string, unknown>> = [];
  readonly failedRefreshes: Array<Record<string, unknown>> = [];
  readonly scheduledPolls: Array<{ intervalSeconds: number; nextPollAt: Date }> = [];

  async list(): Promise<ConnectedAccountSummary[]> {
    return this.connections;
  }

  async beginTransaction(input: {
    id: string;
    userId: string;
    provider: ConnectedProviderId;
    stateHash: string;
    codeVerifier: string | null;
    deviceCodeHash: string | null;
    pollIntervalSeconds: number | null;
    nextPollAt: Date | null;
    oauthRequestToken: string | null;
    oauthRequestSecret: string | null;
  }): Promise<void> {
    this.transaction = {
      id: input.id,
      userId: input.userId,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      deviceCodeHash: input.deviceCodeHash,
      pollIntervalSeconds: input.pollIntervalSeconds,
      nextPollAt: input.nextPollAt,
      oauthRequestToken: input.oauthRequestToken,
      oauthRequestSecret: input.oauthRequestSecret,
    };
    this.stateHash = input.stateHash;
  }

  async readTransaction(): Promise<StoredConnectionTransaction | null> {
    return this.transaction;
  }

  async consumeByState(input: { stateHash: string }): Promise<StoredConnectionTransaction | null> {
    if (this.stateHash !== input.stateHash) return null;
    const pending = this.transaction;
    this.transaction = null;
    return pending;
  }

  async consumeById(): Promise<boolean> {
    this.transaction = null;
    return true;
  }

  async scheduleDevicePoll(input: { intervalSeconds: number; nextPollAt: Date }): Promise<void> {
    this.scheduledPolls.push(input);
    if (this.transaction !== null) {
      this.transaction.pollIntervalSeconds = input.intervalSeconds;
      this.transaction.nextPollAt = input.nextPollAt;
    }
  }

  async save(input: Record<string, unknown>): Promise<void> {
    this.saved.push(input);
  }

  async readSecret(): Promise<string | null> {
    return this.secret;
  }

  async remove(input: { provider: ConnectedProviderId }): Promise<boolean> {
    this.removed.push({ provider: input.provider });
    return this.connections.some((entry) => entry.provider === input.provider);
  }

  async protectLegacySecrets(): Promise<number> {
    return 0;
  }

  async claimRefreshable(): Promise<RefreshableConnection[]> {
    return this.refreshable;
  }

  async completeRefresh(input: Record<string, unknown>): Promise<void> {
    this.completedRefreshes.push(input);
  }

  async failRefresh(input: Record<string, unknown>): Promise<void> {
    this.failedRefreshes.push(input);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formResponse(body: Record<string, string>, status = 200): Response {
  return new Response(new URLSearchParams(body), {
    status,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

function setup(
  handler: (url: string, init?: RequestInit) => Response,
  githubClientSecret: string | null = null,
) {
  const store = new MemoryConnectionsStore();
  const events = { recordSecurityEvent: vi.fn(async () => undefined) };
  const request = vi.fn(async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  const service = createConnectionsService({
    store,
    credentials: {
      github: { clientId: "Iv1.kiwitest", clientSecret: githubClientSecret },
      figshare: { clientId: "figshare-client", clientSecret: "figshare-secret" },
      zotero: { clientId: "zotero-client", clientSecret: "zotero-secret" },
      mendeley: { clientId: "mendeley-client", clientSecret: "mendeley-secret" },
      osf: { clientId: "osf-client", clientSecret: "osf-secret" },
      zenodo: { clientId: "zenodo-client", clientSecret: "zenodo-secret" },
    },
    serviceOrigin: "http://127.0.0.1:4319",
    request,
    clock,
    ids: new TestIds(),
    events,
  });
  return { service, store, request, events };
}

describe("connected accounts", () => {
  it("lists only the providers this service has credentials for", async () => {
    const { service } = setup(() => jsonResponse({}));
    await expect(service.list("account-1")).resolves.toEqual({
      status: "ok",
      connections: {
        connections: [],
        available: ["github", "figshare", "zotero", "mendeley", "osf", "zenodo"],
      },
    });
  });

  it("refuses a provider that has no credentials configured", async () => {
    const unconfigured = createConnectionsService({
      store: new MemoryConnectionsStore(),
      credentials: {},
      serviceOrigin: "http://127.0.0.1:4319",
    });
    await expect(unconfigured.start("account-1", "figshare")).resolves.toMatchObject({
      status: "error",
      code: "not_configured",
    });
  });

  it("starts Zotero's signed OAuth 1.0a key exchange with read-only permissions", async () => {
    const { service, request } = setup(() =>
      formResponse({
        oauth_token: "temporary-token",
        oauth_token_secret: "temporary-secret",
        oauth_callback_confirmed: "true",
      }),
    );
    const started = await service.start("account-1", "zotero");
    if (started.status !== "browser_required") throw new Error("Zotero did not start.");
    const url = new URL(started.authorization_url);
    expect(url.origin + url.pathname).toBe("https://www.zotero.org/oauth/authorize");
    expect(url.searchParams.get("oauth_token")).toBe("temporary-token");
    expect(url.searchParams.get("library_access")).toBe("1");
    expect(url.searchParams.get("write_access")).toBe("0");
    const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["authorization"]).toContain("oauth_callback=");
    expect(headers["authorization"]).toContain("oauth_signature=");
  });

  it("exchanges Zotero's verifier for an API key and stores its user identity", async () => {
    const { service, store } = setup((url) =>
      url.endsWith("/oauth/request")
        ? formResponse({
            oauth_token: "temporary-token",
            oauth_token_secret: "temporary-secret",
            oauth_callback_confirmed: "true",
          })
        : formResponse({
            oauth_token: "zotero-api-key",
            oauth_token_secret: "zotero-api-key",
            userID: "12345",
            username: "kiwi-researcher",
          }),
    );
    await service.start("account-1", "zotero");
    await expect(
      service.completeCallback(
        new URL(
          "http://127.0.0.1:4319/v1/connections/callback?oauth_token=temporary-token&oauth_verifier=verified",
        ),
      ),
    ).resolves.toEqual({ provider: "zotero" });
    expect(store.saved[0]).toMatchObject({
      provider: "zotero",
      externalAccountId: "12345",
      externalAccountLabel: "kiwi-researcher",
      scopes: "library:read notes:read groups:read",
      accessSecret: "zotero-api-key",
    });
  });

  it("starts a browser connection at the provider with the service callback", async () => {
    const { service } = setup(() => jsonResponse({}));
    const started = await service.start("account-1", "zenodo");
    if (started.status !== "browser_required") throw new Error("Zenodo did not start.");
    const url = new URL(started.authorization_url);

    expect(url.origin + url.pathname).toBe("https://zenodo.org/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("zenodo-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4319/v1/connections/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("deposit:write deposit:actions");
    expect(url.searchParams.get("state")).toHaveLength(43);
    expect(started.transaction_id).toBe("transaction-1");
  });

  it("exchanges the callback code and stores the account without returning a token", async () => {
    const { service, store, events } = setup((url) =>
      url.startsWith("https://zenodo.org/oauth/token")
        ? jsonResponse({
            access_token: "zenodo-access",
            refresh_token: "zenodo-refresh",
            expires_in: 3_600,
            scope: "deposit:write deposit:actions",
          })
        : jsonResponse({ id: 42, email: "researcher@example.test" }),
    );
    const started = await service.start("account-1", "zenodo");
    if (started.status !== "browser_required") throw new Error("Zenodo did not start.");
    const state = new URL(started.authorization_url).searchParams.get("state") ?? "";

    const outcome = await service.completeCallback(
      new URL(`http://127.0.0.1:4319/v1/connections/callback?code=abc&state=${state}`),
    );
    expect(outcome).toEqual({ provider: "zenodo" });
    expect(store.saved[0]).toMatchObject({
      provider: "zenodo",
      externalAccountId: "42",
      externalAccountLabel: "researcher@example.test",
      scopes: "deposit:write deposit:actions",
      accessSecret: "zenodo-access",
      refreshSecret: "zenodo-refresh",
      accessExpiresAt: new Date("2026-08-23T13:00:00.000Z"),
    });
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.connection_zenodo_added",
        outcome: "succeeded",
      }),
    );
  });

  it("uses Mendeley's confidential authorization-code exchange and versioned profile API", async () => {
    const { service, store, request } = setup((url) =>
      url.endsWith("/oauth/token")
        ? jsonResponse({
            access_token: "mendeley-access",
            refresh_token: "mendeley-refresh",
            expires_in: 3_600,
          })
        : jsonResponse({ id: "profile-1", display_name: "Kiwi Researcher" }),
    );
    const started = await service.start("account-1", "mendeley");
    if (started.status !== "browser_required") throw new Error("Mendeley did not start.");
    const authorizationUrl = new URL(started.authorization_url);
    const state = authorizationUrl.searchParams.get("state") ?? "";
    expect(authorizationUrl.searchParams.get("scope")).toBe("all");

    await expect(
      service.completeCallback(
        new URL(`http://127.0.0.1:4319/v1/connections/callback?code=abc&state=${state}`),
      ),
    ).resolves.toEqual({ provider: "mendeley" });

    const exchange = request.mock.calls[0]?.[1];
    expect(exchange?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("mendeley-client:mendeley-secret").toString("base64")}`,
    });
    expect(String(exchange?.body)).not.toContain("client_secret");
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      accept: "application/vnd.mendeley-profiles.1+json",
    });
    expect(store.saved[0]).toMatchObject({
      provider: "mendeley",
      externalAccountId: "profile-1",
      externalAccountLabel: "Kiwi Researcher",
      scopes: "all",
      accessSecret: "mendeley-access",
      refreshSecret: "mendeley-refresh",
      accessExpiresAt: new Date("2026-08-23T13:00:00.000Z"),
    });
  });

  it("connects OSF with its narrow profile scope and JSON:API identity", async () => {
    const { service, store, request } = setup((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse({
            access_token: "osf-access",
            refresh_token: "osf-refresh",
            expires_in: 3_600,
            scope: "osf.users.profile_read",
          })
        : jsonResponse({
            data: {
              id: "abc12",
              type: "users",
              attributes: { full_name: "Ada Researcher" },
            },
          }),
    );
    const started = await service.start("account-1", "osf");
    if (started.status !== "browser_required") throw new Error("OSF did not start.");
    const authorizationUrl = new URL(started.authorization_url);
    const state = authorizationUrl.searchParams.get("state") ?? "";
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.osf.io/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("osf.users.profile_read");

    await expect(
      service.completeCallback(
        new URL(`http://127.0.0.1:4319/v1/connections/callback?code=abc&state=${state}`),
      ),
    ).resolves.toEqual({ provider: "osf" });

    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("client_id=osf-client");
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("client_secret=osf-secret");
    expect(store.saved[0]).toMatchObject({
      provider: "osf",
      externalAccountId: "abc12",
      externalAccountLabel: "Ada Researcher",
      scopes: "osf.users.profile_read",
      accessSecret: "osf-access",
      refreshSecret: "osf-refresh",
    });
  });

  it("connects figshare with its required full scope and token authorization scheme", async () => {
    const { service, store, request } = setup((url) =>
      url.endsWith("/v2/token")
        ? jsonResponse({
            access_token: "figshare-access",
            refresh_token: "figshare-refresh",
            expires_in: 3_600,
          })
        : jsonResponse({ id: 42, email: "researcher@example.test" }),
    );
    const started = await service.start("account-1", "figshare");
    if (started.status !== "browser_required") throw new Error("figshare did not start.");
    const authorizationUrl = new URL(started.authorization_url);
    const state = authorizationUrl.searchParams.get("state") ?? "";
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://figshare.com/account/applications/authorize",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("all");

    await expect(
      service.completeCallback(
        new URL(`http://127.0.0.1:4319/v1/connections/callback?code=abc&state=${state}`),
      ),
    ).resolves.toEqual({ provider: "figshare" });

    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("client_id=figshare-client");
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "token figshare-access",
    });
    expect(store.saved[0]).toMatchObject({
      provider: "figshare",
      externalAccountId: "42",
      externalAccountLabel: "researcher@example.test",
      scopes: "all",
      accessSecret: "figshare-access",
      refreshSecret: "figshare-refresh",
    });
  });

  it("rejects a callback whose state was never issued", async () => {
    const { service } = setup(() => jsonResponse({}));
    await expect(
      service.completeCallback(
        new URL("http://127.0.0.1:4319/v1/connections/callback?code=abc&state=forged"),
      ),
    ).resolves.toEqual({ error: "This response did not match a Kiwi request." });
  });

  it("reports a declined browser connection without storing anything", async () => {
    const { service, store } = setup(() => jsonResponse({}));
    const started = await service.start("account-1", "zenodo");
    if (started.status !== "browser_required") throw new Error("Zenodo did not start.");
    const state = new URL(started.authorization_url).searchParams.get("state") ?? "";

    await expect(
      service.completeCallback(
        new URL(`http://127.0.0.1:4319/v1/connections/callback?error=access_denied&state=${state}`),
      ),
    ).resolves.toEqual({ error: "The connection was not approved." });
    expect(store.saved).toHaveLength(0);
  });

  it("asks GitHub for a device code and shows the user its prompt", async () => {
    const { service } = setup(() =>
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 899,
      }),
    );
    await expect(service.start("account-1", "github")).resolves.toEqual({
      status: "device_required",
      transaction_id: "transaction-1",
      prompt: {
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-1234",
        expires_in_seconds: 899,
      },
    });
  });

  it("keeps polling while GitHub reports the authorization is pending", async () => {
    const { service, store } = setup((url) =>
      url.includes("/login/device/code")
        ? jsonResponse({
            device_code: "device-secret",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
          })
        : jsonResponse({ error: "authorization_pending" }),
    );
    await service.start("account-1", "github");
    if (store.transaction !== null) store.transaction.nextPollAt = NOW;
    await expect(service.poll("account-1", "transaction-1")).resolves.toEqual({
      status: "pending",
    });
  });

  it("stores the GitHub account once the device flow completes", async () => {
    const { service, store } = setup((url) =>
      url.includes("/login/device/code")
        ? jsonResponse({
            device_code: "device-secret",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
          })
        : url.includes("/login/oauth/access_token")
          ? jsonResponse({ access_token: "github-access", scope: "read:user" })
          : jsonResponse({ id: 7, login: "kiwi-researcher" }),
    );
    await service.start("account-1", "github");
    if (store.transaction !== null) store.transaction.nextPollAt = NOW;
    await expect(service.poll("account-1", "transaction-1")).resolves.toEqual({
      status: "connected",
      provider: "github",
    });
    expect(store.saved[0]).toMatchObject({
      provider: "github",
      externalAccountId: "7",
      externalAccountLabel: "kiwi-researcher",
    });
  });

  it("reports a denied device authorization", async () => {
    const { service, store } = setup((url) =>
      url.includes("/login/device/code")
        ? jsonResponse({
            device_code: "device-secret",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
          })
        : jsonResponse({ error: "access_denied" }),
    );
    await service.start("account-1", "github");
    if (store.transaction !== null) store.transaction.nextPollAt = NOW;
    await expect(service.poll("account-1", "transaction-1")).resolves.toMatchObject({
      status: "error",
      code: "provider_denied",
    });
  });

  it("enforces GitHub's device polling interval and increases it after slow_down", async () => {
    const { service, store, request } = setup((url) =>
      url.includes("/login/device/code")
        ? jsonResponse({
            device_code: "device-secret",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 5,
          })
        : jsonResponse({ error: "slow_down" }),
    );
    await service.start("account-1", "github");
    await expect(service.poll("account-1", "transaction-1")).resolves.toEqual({
      status: "pending",
    });
    expect(request).toHaveBeenCalledTimes(1);
    if (store.transaction !== null) store.transaction.nextPollAt = NOW;
    await expect(service.poll("account-1", "transaction-1")).resolves.toEqual({
      status: "pending",
    });
    expect(store.scheduledPolls.at(-1)).toMatchObject({
      intervalSeconds: 10,
      nextPollAt: new Date("2026-08-23T12:00:10.000Z"),
    });
  });

  it("removes a connection and reports one that was never connected", async () => {
    const { service, store, events } = setup(() => jsonResponse({}));
    store.connections = [
      {
        provider: "github",
        account_label: "kiwi-researcher",
        scopes: "read:user",
        connected_at: NOW.toISOString(),
        authorization_status: "active",
      },
    ];
    await expect(service.disconnect("account-1", "github")).resolves.toEqual({
      status: "disconnected",
      provider: "github",
      provider_revocation: "not_supported",
    });
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.connection_github_removed" }),
    );
    await expect(service.disconnect("account-1", "zenodo")).resolves.toMatchObject({
      status: "error",
      code: "invalid_input",
    });
  });

  it("confirms GitHub token revocation when the app secret is configured", async () => {
    const { service, store, request } = setup(() => new Response(null, { status: 204 }), "secret");
    store.connections = [
      {
        provider: "github",
        account_label: "kiwi-researcher",
        scopes: "read:user",
        connected_at: NOW.toISOString(),
        authorization_status: "active",
      },
    ];
    store.secret = "github-access";
    await expect(service.disconnect("account-1", "github")).resolves.toEqual({
      status: "disconnected",
      provider: "github",
      provider_revocation: "confirmed",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/applications/Iv1.kiwitest/token",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deletes the Zotero API key at the provider before removing the local connection", async () => {
    const { service, store, request } = setup(() => new Response(null, { status: 204 }));
    store.connections = [
      {
        provider: "zotero",
        account_label: "kiwi-researcher",
        scopes: "library:read notes:read groups:read",
        connected_at: NOW.toISOString(),
        authorization_status: "active",
      },
    ];
    store.secret = "zotero-api-key";
    await expect(service.disconnect("account-1", "zotero")).resolves.toEqual({
      status: "disconnected",
      provider: "zotero",
      provider_revocation: "confirmed",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.zotero.org/keys/zotero-api-key",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "zotero-api-version": "3" }),
      }),
    );
  });

  it("never puts a provider token in a listed connection", async () => {
    const { service, store } = setup(() => jsonResponse({}));
    store.connections = [
      {
        provider: "github",
        account_label: "kiwi-researcher",
        scopes: "read:user",
        connected_at: NOW.toISOString(),
        authorization_status: "active",
      },
    ];
    store.secret = "github-access";
    const listed = await service.list("account-1");
    expect(JSON.stringify(listed)).not.toContain("github-access");
  });

  it("refreshes an expiring OAuth authorization and accepts refresh-token rotation", async () => {
    const { service, store, request } = setup(() =>
      jsonResponse({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "deposit:write deposit:actions",
      }),
    );
    store.refreshable = [
      {
        id: "connection-1",
        userId: "account-1",
        provider: "zenodo",
        refreshSecret: "original-refresh",
      },
    ];
    await expect(service.refreshExpiring()).resolves.toEqual({
      refreshed: 1,
      reauthorization_required: 0,
    });
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("refresh_token=original-refresh");
    expect(store.completedRefreshes[0]).toMatchObject({
      id: "connection-1",
      accessSecret: "rotated-access",
      refreshSecret: "rotated-refresh",
      accessExpiresAt: new Date("2026-08-23T13:00:00.000Z"),
    });
  });

  it("refreshes an expiring GitHub device token without requiring a client secret", async () => {
    const { service, store } = setup(() =>
      jsonResponse({
        access_token: "github-rotated-access",
        refresh_token: "github-rotated-refresh",
        expires_in: 28_800,
      }),
    );
    store.refreshable = [
      {
        id: "connection-1",
        userId: "account-1",
        provider: "github",
        refreshSecret: "github-refresh",
      },
    ];
    await expect(service.refreshExpiring()).resolves.toEqual({
      refreshed: 1,
      reauthorization_required: 0,
    });
    expect(store.completedRefreshes[0]).toMatchObject({
      accessSecret: "github-rotated-access",
      refreshSecret: "github-rotated-refresh",
    });
  });

  it("refreshes Mendeley with Basic client authentication and the registered callback", async () => {
    const { service, store, request } = setup(() =>
      jsonResponse({
        access_token: "mendeley-rotated-access",
        refresh_token: "mendeley-rotated-refresh",
        expires_in: 3_600,
      }),
    );
    store.refreshable = [
      {
        id: "connection-1",
        userId: "account-1",
        provider: "mendeley",
        refreshSecret: "mendeley-original-refresh",
      },
    ];

    await expect(service.refreshExpiring()).resolves.toEqual({
      refreshed: 1,
      reauthorization_required: 0,
    });
    const refresh = request.mock.calls[0]?.[1];
    expect(refresh?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("mendeley-client:mendeley-secret").toString("base64")}`,
    });
    expect(String(refresh?.body)).toContain("refresh_token=mendeley-original-refresh");
    expect(String(refresh?.body)).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A4319%2Fv1%2Fconnections%2Fcallback",
    );
    expect(String(refresh?.body)).not.toContain("client_secret");
  });

  it("marks a revoked refresh authorization for reconnection and records the event", async () => {
    const { service, store, events } = setup(() => jsonResponse({ error: "invalid_grant" }, 400));
    store.refreshable = [
      {
        id: "connection-1",
        userId: "account-1",
        provider: "zenodo",
        refreshSecret: "revoked-refresh",
      },
    ];
    await expect(service.refreshExpiring()).resolves.toEqual({
      refreshed: 0,
      reauthorization_required: 1,
    });
    expect(store.failedRefreshes[0]).toMatchObject({
      id: "connection-1",
      permanent: true,
    });
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "account-1",
        eventType: "account.connection_zenodo_reauthorization_required",
        outcome: "attention_required",
      }),
    );
  });
});
