import { describe, expect, it, vi } from "vitest";
import {
  createAccountServiceClient,
  validateAccountServiceOrigin,
} from "./account-service-client.js";
import { createMemorySessionVault } from "./session-vault.js";

describe("account service origin", () => {
  it("accepts HTTPS and the explicit development loopback exception", () => {
    expect(validateAccountServiceOrigin("https://accounts.kiwi.example", false)?.origin).toBe(
      "https://accounts.kiwi.example",
    );
    expect(validateAccountServiceOrigin("http://127.0.0.1:4319", true)?.origin).toBe(
      "http://127.0.0.1:4319",
    );
  });

  it.each([
    "http://accounts.example",
    "http://localhost:4319",
    "file:///service",
    "https://user:password@accounts.example",
    "https://accounts.example/path",
    "https://accounts.example/?target=other",
  ])("rejects %s", (origin) => {
    expect(validateAccountServiceOrigin(origin, false)).toBeNull();
  });
});

describe("account service client", () => {
  it("accepts only a successful validated ready response", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            protocol_version: "1.0.0",
            service: "kiwi-account",
            status: "ready",
            database: "ready",
            migration_version: "0001_service_foundation",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await expect(client.check()).resolves.toEqual({ status: "ready" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    new Response("not-json", { status: 200 }),
    new Response(
      JSON.stringify({
        protocol_version: "1.0.0",
        service: "kiwi-account",
        status: "unavailable",
        database: "unavailable",
        migration_version: null,
      }),
      { status: 503 },
    ),
  ])("turns an invalid or unavailable response into a safe state", async (response) => {
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(async () => response),
    });
    await expect(client.check()).resolves.toEqual({ status: "unavailable", retryable: true });
  });

  it("records why the service was judged unreachable", async () => {
    const reasons: string[] = [];
    const refused = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
      }),
      reportServiceUnavailable: (reason) => reasons.push(reason),
    });
    await expect(refused.check()).resolves.toEqual({ status: "unavailable", retryable: true });

    const unhealthy = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocol_version: "1.0.0",
              service: "kiwi-account",
              status: "unavailable",
              database: "unavailable",
              migration_version: null,
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      ),
      reportServiceUnavailable: (reason) => reasons.push(reason),
    });
    await expect(unhealthy.check()).resolves.toEqual({ status: "unavailable", retryable: true });

    const missing = createAccountServiceClient({
      origin: null,
      allowInsecureLoopback: false,
      fetch: vi.fn(),
      reportServiceUnavailable: (reason) => reasons.push(reason),
    });
    await expect(missing.check()).resolves.toEqual({ status: "unavailable", retryable: true });

    // A refused connection, a service that answers while unwell, and a missing origin are
    // one status but three different problems, so each has to name itself.
    expect(reasons).toEqual([
      "https://accounts.kiwi.example/ could not be reached: connect ECONNREFUSED 127.0.0.1:4319",
      "https://accounts.kiwi.example/ answered 503 and reported unavailable",
      "no account service origin is configured",
    ]);
  });

  it("does not issue a request for a missing or rejected origin", async () => {
    const request = vi.fn();
    const client = createAccountServiceClient({
      origin: "http://accounts.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await expect(client.check()).resolves.toEqual({ status: "unavailable", retryable: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the access token private while exposing the authenticated identity", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "authenticated",
          account: { id: "account-1", email: "reader@example.test", email_verified: true },
          access_token: "private-access-token",
          expires_at: "2099-08-22T12:15:00.000Z",
          refresh_token: "private-refresh-token",
          refresh_expires_at: "2099-09-22T12:15:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
      deviceName: "Test device",
    });

    const result = await client.signInWithPassword({
      email: "reader@example.test",
      password: "a long orchard password",
    });
    expect(result).toEqual({
      status: "authenticated",
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
    });
    expect(JSON.stringify(result)).not.toContain("private-access-token");
    expect(client.authState()).toEqual({
      status: "authenticated",
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
      connection: "online",
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://accounts.kiwi.example/v1/auth/password/sign-in"),
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      email: "reader@example.test",
      password: "a long orchard password",
      device_name: "Test device",
    });
  });

  it("reauthenticates the current session through authenticated password and provider routes", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/auth/password/sign-in") {
        return new Response(
          JSON.stringify({
            status: "authenticated",
            account: { id: "account-1", email: "reader@example.test", email_verified: true },
            access_token: "private-access-token",
            expires_at: "2099-08-22T12:15:00.000Z",
            refresh_token: "private-refresh-token",
            refresh_expires_at: "2099-09-22T12:15:00.000Z",
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/start")) {
        return new Response(
          JSON.stringify({
            status: "browser_required",
            authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=kiwi",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          status: "reauthenticated",
          provider: path.includes("provider") ? "google" : "password",
        }),
        { status: 200 },
      );
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await client.signInWithPassword({ email: "reader@example.test", password: "password" });

    await expect(client.reauthenticateWithPassword({ password: "password" })).resolves.toEqual({
      status: "reauthenticated",
      provider: "password",
    });
    await expect(
      client.startIdentity(
        {
          redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
          state: "s".repeat(43),
          nonce: "n".repeat(43),
          code_challenge: "c".repeat(43),
        },
        "reauthenticate",
      ),
    ).resolves.toMatchObject({ status: "browser_required" });

    expect(request).toHaveBeenCalledWith(
      new URL("https://accounts.kiwi.example/v1/account/reauthenticate/password"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer private-access-token" }),
      }),
    );
    expect(request).toHaveBeenCalledWith(
      new URL("https://accounts.kiwi.example/v1/account/reauthenticate/provider/start"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer private-access-token" }),
      }),
    );
  });

  it("rejects malformed renderer input before any network request", async () => {
    const request = vi.fn();
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await expect(
      client.createPasswordAccount({ email: "reader@example.test", password: "", role: "admin" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_input" });
    expect(request).not.toHaveBeenCalled();
  });

  it("turns malformed auth responses into a redacted unavailable result", async () => {
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(async () => new Response(JSON.stringify({ sql: "secret" }), { status: 500 })),
    });
    await expect(client.requestPasswordReset({ email: "reader@example.test" })).resolves.toEqual({
      status: "error",
      code: "service_unavailable",
      message: "Account access is unavailable. Try again.",
    });
  });

  it("accepts only the exact Google or development-fixture authorization origin", async () => {
    const startRequest = {
      redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      code_challenge: "c".repeat(43),
    };
    const malicious = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "browser_required",
              authorization_url: "https://attacker.example/authorize",
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(malicious.startIdentity(startRequest, "sign_in")).resolves.toMatchObject({
      status: "error",
      code: "invalid_callback",
    });

    const fixture = createAccountServiceClient({
      origin: "http://127.0.0.1:4319",
      allowInsecureLoopback: true,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "browser_required",
              authorization_url:
                "http://127.0.0.1:4319/v1/auth/google/fixture/authorize?request=opaque",
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(fixture.startIdentity(startRequest, "sign_in")).resolves.toMatchObject({
      status: "browser_required",
    });
  });

  it("rotates a protected refresh credential while restoring after restart", async () => {
    const vault = createMemorySessionVault({
      version: 1,
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
      refreshToken: "refresh-before-restart",
      refreshExpiresAt: Date.parse("2099-09-22T12:15:00.000Z"),
    });
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            status: "authenticated",
            account: { id: "account-1", email: "reader@example.test", email_verified: true },
            access_token: "new-private-access",
            expires_at: "2099-08-22T12:15:00.000Z",
            refresh_token: "refresh-after-restart",
            refresh_expires_at: "2099-09-22T12:15:00.000Z",
          }),
          { status: 200 },
        ),
    );
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
      sessionVault: vault,
    });

    await expect(client.restore()).resolves.toMatchObject({
      status: "authenticated",
      connection: "online",
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      refresh_token: "refresh-before-restart",
    });
    await expect(vault.load()).resolves.toMatchObject({
      refreshToken: "refresh-after-restart",
    });
  });

  it("keeps a valid cached grant offline and clears it after explicit sign-out", async () => {
    const vault = createMemorySessionVault({
      version: 1,
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
      refreshToken: "offline-refresh",
      refreshExpiresAt: Date.parse("2099-09-22T12:15:00.000Z"),
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      sessionVault: vault,
    });

    await expect(client.restore()).resolves.toEqual({
      status: "authenticated",
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
      connection: "offline",
    });
    await expect(client.signOut()).resolves.toEqual({ status: "signed_out" });
    await expect(vault.load()).resolves.toBeNull();
    expect(client.authState()).toEqual({ status: "signed_out" });
  });

  it("reports why a restored session could not reach the service", async () => {
    const reasons: string[] = [];
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      sessionVault: createMemorySessionVault({
        version: 1,
        account: { id: "account-1", email: "reader@example.test", email_verified: true },
        refreshToken: "offline-refresh",
        refreshExpiresAt: Date.parse("2099-09-22T12:15:00.000Z"),
      }),
      reportSessionFailure: (reason) => reasons.push(reason),
    });

    await expect(client.restore()).resolves.toMatchObject({ connection: "offline" });
    expect(reasons).toEqual([
      "refresh refused: service_unavailable (origin https://accounts.kiwi.example/)",
    ]);
  });

  it("names an unconfigured origin as the reason rather than reporting a network fault", async () => {
    const reasons: string[] = [];
    const client = createAccountServiceClient({
      origin: null,
      allowInsecureLoopback: false,
      sessionVault: createMemorySessionVault({
        version: 1,
        account: { id: "account-1", email: "reader@example.test", email_verified: true },
        refreshToken: "offline-refresh",
        refreshExpiresAt: Date.parse("2099-09-22T12:15:00.000Z"),
      }),
      reportSessionFailure: (reason) => reasons.push(reason),
    });

    await expect(client.restore()).resolves.toMatchObject({ connection: "offline" });
    expect(reasons).toEqual(["refresh refused: service_unavailable (origin not configured)"]);
  });

  it("returns online once a restored session refreshes successfully", async () => {
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "authenticated",
              account: { id: "account-1", email: "reader@example.test", email_verified: true },
              access_token: "private-access-token",
              expires_at: "2099-08-22T12:15:00.000Z",
              refresh_token: "rotated-refresh-token",
              refresh_expires_at: "2099-09-22T12:15:00.000Z",
            }),
            { status: 200 },
          ),
      ),
      sessionVault: createMemorySessionVault({
        version: 1,
        account: { id: "account-1", email: "reader@example.test", email_verified: true },
        refreshToken: "stored-refresh",
        refreshExpiresAt: Date.parse("2099-09-22T12:15:00.000Z"),
      }),
    });

    // A window that opens on a working service must not report itself offline.
    await expect(client.restore()).resolves.toEqual({
      status: "authenticated",
      account: { id: "account-1", email: "reader@example.test", email_verified: true },
      connection: "online",
    });
  });

  it("renews an expired credential before polling for notifications", async () => {
    // Notifications are polled on a timer, so this is usually the first call made after an access
    // token expires. Sending the expired one and taking the refusal would leave the poll refused
    // once a minute for as long as the window stays open, with nothing asking for a new token.
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/auth/password/sign-in" || path === "/v1/auth/session/refresh") {
        return new Response(
          JSON.stringify({
            status: "authenticated",
            account: { id: "account-1", email: "reader@example.test", email_verified: true },
            access_token: path === "/v1/auth/session/refresh" ? "renewed-token" : "expired-token",
            expires_at:
              path === "/v1/auth/session/refresh"
                ? "2099-08-22T12:15:00.000Z"
                : "2020-01-01T00:00:00.000Z",
            refresh_token: "private-refresh-token",
            refresh_expires_at: "2099-09-22T12:15:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "ok", notifications: [], unread_count: 0 }), {
        status: 200,
      });
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await client.signInWithPassword({
      email: "reader@example.test",
      password: "a long orchard password",
    });

    await expect(client.listAccountNotifications()).resolves.toMatchObject({ status: "ok" });
    const paths = request.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(paths).toEqual([
      "/v1/auth/password/sign-in",
      "/v1/auth/session/refresh",
      "/v1/account/notifications",
    ]);
    expect(request.mock.calls[2]?.[1]?.headers).toMatchObject({
      authorization: "Bearer renewed-token",
    });
  });

  it("brokers account settings with the private access credential", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      return path === "/v1/auth/password/sign-in"
        ? new Response(
            JSON.stringify({
              status: "authenticated",
              account: { id: "account-1", email: "reader@example.test", email_verified: true },
              access_token: "private-access-token",
              expires_at: "2099-08-22T12:15:00.000Z",
              refresh_token: "private-refresh-token",
              refresh_expires_at: "2099-09-22T12:15:00.000Z",
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              status: "ok",
              settings: {
                account: {
                  id: "account-1",
                  email: "reader@example.test",
                  profile: {
                    given_name: null,
                    family_name: null,
                    phone: null,
                  },
                  display_name: "Reader",
                  profile_complete: true,
                  email_verified: true,
                  avatar: null,
                },
                sign_in_methods: ["password"],
                emails: [],
                security_activity: [],
                sessions: [],
                notifications: [
                  { category: "workspace_invitations", email: true },
                  { category: "collaboration", email: true },
                  { category: "synchronization", email: true },
                  { category: "product", email: false },
                ],
                deletion_impact: {
                  sole_owner_workspaces: [],
                  shared_workspaces: 0,
                  addresses: 0,
                  connections: 0,
                },
                deletion: { status: "none" },
              },
            }),
            { status: 200 },
          );
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await client.signInWithPassword({
      email: "reader@example.test",
      password: "a long orchard password",
    });
    const settings = await client.getAccountSettings();
    expect(settings).toMatchObject({
      status: "ok",
      settings: { account: { display_name: "Reader" } },
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer private-access-token",
    });
    expect(JSON.stringify(settings)).not.toContain("private-access-token");

    await expect(
      client.updateAccountProfile({ preferred_name: "Reader", role: "owner" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_input" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("submits structured synchronization with the private access credential", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      return path === "/v1/auth/password/sign-in"
        ? new Response(
            JSON.stringify({
              status: "authenticated",
              account: { id: "account-1", email: "reader@example.test", email_verified: true },
              access_token: "private-sync-access",
              expires_at: "2099-08-22T12:15:00.000Z",
              refresh_token: "private-sync-refresh",
              refresh_expires_at: "2099-09-22T12:15:00.000Z",
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              status: "accepted",
              sequence: 1,
              actor_id: "account-1",
              object_id: "object-1",
              version: 1,
              content_hash: `sha256:${"a".repeat(64)}`,
              replayed: false,
            }),
            { status: 200 },
          );
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await client.signInWithPassword({
      email: "reader@example.test",
      password: "a long orchard password",
    });
    await expect(
      client.workspaceSync("/v1/sync/structured/submit", { workspace_id: "workspace-1" }),
    ).resolves.toMatchObject({ status: "accepted", sequence: 1 });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer private-sync-access",
    });
  });

  it("sends coediting requests with the private access credential", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      return path === "/v1/auth/password/sign-in"
        ? new Response(
            JSON.stringify({
              status: "authenticated",
              account: { id: "account-1", email: "reader@example.test", email_verified: true },
              access_token: "private-coedit-access",
              expires_at: "2099-08-22T12:15:00.000Z",
              refresh_token: "private-coedit-refresh",
              refresh_expires_at: "2099-09-22T12:15:00.000Z",
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ status: "documents", document_ids: ["document-1"] }), {
            status: 200,
          });
    });
    const client = createAccountServiceClient({
      origin: "https://accounts.kiwi.example",
      allowInsecureLoopback: false,
      fetch: request,
    });
    await client.signInWithPassword({
      email: "reader@example.test",
      password: "a long orchard password",
    });
    await expect(
      client.workspaceCoedit("/v1/sync/coedit/documents", { workspace_id: "workspace-1" }),
    ).resolves.toEqual({ status: "documents", document_ids: ["document-1"] });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer private-coedit-access",
    });
  });
});
