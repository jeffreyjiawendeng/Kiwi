import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { PROTOCOL_VERSION, type AccountServiceHealth } from "@kiwi/contracts";
import { createAccountServiceServer, type AccountServiceServerOptions } from "./server.js";
import type { PasswordAuthService } from "./auth-service.js";
import type { OidcAuthService } from "./oidc-auth-service.js";
import type { SessionService } from "./session-service.js";
import type { AccountSettingsService } from "./account-settings-service.js";
import type { WorkspaceCollaborationService } from "./workspace-collaboration-service.js";
import type { AccountNotificationsService } from "./account-notifications-service.js";

const servers: ReturnType<typeof createAccountServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function authStub(overrides: Partial<PasswordAuthService> = {}): PasswordAuthService {
  return {
    createAccount: async () => ({ status: "accepted", next: "verify_email" }),
    verifyEmail: async () => ({
      status: "error",
      code: "invalid_or_expired_code",
      message: "That verification code is invalid or has expired.",
    }),
    resendEmailVerification: async () => ({ status: "accepted", next: "verify_email" }),
    signIn: async () => ({
      status: "error",
      code: "invalid_credentials",
      message: "The email or password is not correct.",
    }),
    requestPasswordReset: async () => ({ status: "accepted", next: "check_email" }),
    resetPassword: async () => ({ status: "password_reset" }),
    ...overrides,
  };
}

function identityStub(overrides: Partial<OidcAuthService> = {}): OidcAuthService {
  return {
    providers: () => ["google"],
    unlink: async () => ({
      status: "error",
      code: "invalid_input",
      message: "That sign-in method is not connected.",
    }),
    start: async () => ({
      status: "browser_required",
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=kiwi",
    }),
    exchange: async () => ({
      status: "error",
      code: "invalid_callback",
      message: "Google sign-in could not be verified.",
    }),
    completeProviderCallback: async () => null,
    completeFixtureAuthorization: () => null,
    ...overrides,
  };
}

function sessionStub(overrides: Partial<SessionService> = {}): SessionService {
  return {
    refresh: async () => ({
      status: "error",
      code: "session_expired",
      message: "Your session ended. Sign in again.",
    }),
    signOut: async () => ({ status: "signed_out" }),
    ...overrides,
  };
}

function settingsStub(overrides: Partial<AccountSettingsService> = {}): AccountSettingsService {
  const unavailable = async () => ({
    status: "error" as const,
    code: "service_unavailable" as const,
    message: "Account settings are unavailable. Try again.",
  });
  return {
    snapshot: unavailable,
    updateProfile: unavailable,
    revokeSession: unavailable,
    revokeOtherSessions: unavailable,
    authenticatedAccountId: async () => null,
    reauthenticatePassword: async () => ({
      status: "error",
      code: "service_unavailable",
      message: "Password confirmation is unavailable.",
    }),
    requestDeletion: unavailable,
    addEmail: unavailable,
    verifyEmail: unavailable,
    resendEmail: unavailable,
    promoteEmail: unavailable,
    setNotificationEmail: unavailable,
    removeEmail: unavailable,
    exportAccount: unavailable,
    setAvatar: unavailable,
    removeAvatar: unavailable,
    readAvatar: unavailable,
    setNotificationPreference: unavailable,
    setPassword: unavailable,
    removePassword: unavailable,
    ...overrides,
  };
}

async function listen(
  health: AccountServiceHealth,
  auth: PasswordAuthService | null = null,
  google: OidcAuthService | null = null,
  sessions: SessionService | null = null,
  settings: AccountSettingsService | null = null,
  collaboration: WorkspaceCollaborationService | null = null,
  notifications: AccountNotificationsService | null = null,
  options: AccountServiceServerOptions = {},
): Promise<string> {
  const server = createAccountServiceServer(
    { check: async () => health },
    auth,
    google,
    sessions,
    settings,
    collaboration,
    null,
    null,
    null,
    notifications,
    options,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function requestWithHost(origin: string, host: string): Promise<number> {
  const url = new URL("/v1/health/ready", origin);
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { method: "GET", headers: { host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("account service HTTP boundary", () => {
  it("lists and updates only the authenticated account's notifications", async () => {
    const list = vi.fn<AccountNotificationsService["list"]>(async () => ({
      status: "ok",
      notifications: [],
      unread_count: 0,
    }));
    const markRead = vi.fn<AccountNotificationsService["markRead"]>(async () => ({
      status: "updated",
    }));
    const notifications = {
      list,
      markRead,
      dismiss: vi.fn(async () => ({ status: "updated" as const })),
      deliverPending: vi.fn(async () => 0),
    };
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0019_account_notifications",
      },
      null,
      null,
      null,
      settingsStub({
        authenticatedAccountId: async () => ({
          accountId: "account-1",
          sessionId: "session-1",
          recentlyAuthenticated: true,
        }),
      }),
      null,
      notifications,
    );

    const listed = await fetch(`${origin}/v1/account/notifications`, {
      headers: { authorization: "Bearer private-access" },
    });
    expect(listed.status).toBe(200);
    expect(list).toHaveBeenCalledWith("account-1");
    const read = await fetch(`${origin}/v1/account/notifications/read`, {
      method: "POST",
      headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: JSON.stringify({ notification_id: "notification-1" }),
    });
    expect(read.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith("account-1", "notification-1");
  });

  it("reports ready without exposing provider or database details", async () => {
    const health: AccountServiceHealth = {
      protocol_version: PROTOCOL_VERSION,
      service: "kiwi-account",
      status: "ready",
      database: "ready",
      migration_version: "0001_service_foundation",
    };
    const origin = await listen(health);
    const response = await fetch(`${origin}/v1/health/ready`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(health);
  });

  it("stays observable with a redacted 503 while the database is unavailable", async () => {
    const origin = await listen({
      protocol_version: PROTOCOL_VERSION,
      service: "kiwi-account",
      status: "unavailable",
      database: "unavailable",
      migration_version: null,
    });
    const response = await fetch(`${origin}/v1/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("password");
  });

  it("rejects unknown routes, mutation methods, and hostile Host headers", async () => {
    const origin = await listen({
      protocol_version: PROTOCOL_VERSION,
      service: "kiwi-account",
      status: "ready",
      database: "ready",
      migration_version: "0001_service_foundation",
    });
    expect((await fetch(`${origin}/other`)).status).toBe(404);
    expect((await fetch(`${origin}/v1/health/ready`, { method: "POST" })).status).toBe(405);
    await expect(requestWithHost(origin, "hostile.example")).resolves.toBe(400);
  });

  it("accepts only the configured public service hostname behind a proxy", async () => {
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0024_identity_authorizations",
      },
      null,
      null,
      null,
      null,
      null,
      null,
      { allowedHosts: ["api.kiwi.example"] },
    );
    await expect(requestWithHost(origin, "api.kiwi.example")).resolves.toBe(200);
    await expect(requestWithHost(origin, "API.KIWI.EXAMPLE:443")).resolves.toBe(200);
    await expect(requestWithHost(origin, "127.0.0.1")).resolves.toBe(400);
  });

  it("returns a hosted provider callback to the exact pending desktop listener", async () => {
    const completeProviderCallback = vi.fn(
      async () =>
        new URL("http://127.0.0.1:54321/oauth/callback/desktop?state=matching&code=provider-code"),
    );
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0025_hosted_oidc_callbacks",
      },
      null,
      identityStub({ completeProviderCallback }),
    );
    const response = await fetch(
      `${origin}/v1/auth/oidc/callback?state=${"s".repeat(43)}&code=provider-code`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:54321/oauth/callback/desktop?state=matching&code=provider-code",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(completeProviderCallback).toHaveBeenCalledOnce();
  });

  it("accepts bounded JSON on the password account route", async () => {
    const createAccount = vi.fn<PasswordAuthService["createAccount"]>(async () => ({
      status: "accepted",
      next: "verify_email",
      fixture_code: "KIWI-VERIFY-000001",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0002_password_accounts",
      },
      authStub({ createAccount }),
    );
    const response = await fetch(`${origin}/v1/auth/password/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reader@example.test",
        email_kind: "institutional",
        password: "a long orchard password",
        given_name: "Kiwi",
        family_name: "Reader",
        phone: "+14155550134",
      }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      next: "verify_email",
      fixture_code: "KIWI-VERIFY-000001",
    });
    expect(createAccount).toHaveBeenCalledWith({
      email: "reader@example.test",
      email_kind: "institutional",
      password: "a long orchard password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    });
  });

  it("rejects invalid content, oversized expansion, and unsupported methods", async () => {
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0002_password_accounts",
      },
      authStub(),
    );
    const wrongType = await fetch(`${origin}/v1/auth/password/accounts`, {
      method: "POST",
      body: "not-json",
    });
    expect(wrongType.status).toBe(400);
    await expect(wrongType.json()).resolves.toMatchObject({
      status: "error",
      code: "invalid_input",
    });

    const expanded = await fetch(`${origin}/v1/auth/password/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reader@example.test",
        password: "a long orchard password",
        given_name: "Kiwi",
        family_name: "Reader",
        phone: "+14155550134",
        role: "owner",
      }),
    });
    expect(expanded.status).toBe(400);
    expect((await fetch(`${origin}/v1/auth/password/accounts`)).status).toBe(405);
  });

  it("returns a redacted unavailable response when auth adapters are disabled", async () => {
    const origin = await listen({
      protocol_version: PROTOCOL_VERSION,
      service: "kiwi-account",
      status: "ready",
      database: "ready",
      migration_version: "0002_password_accounts",
    });
    const response = await fetch(`${origin}/v1/auth/password/reset/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.test" }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/postgres|sql|password verifier/i);
  });

  it("sets Retry-After for throttled authentication", async () => {
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0002_password_accounts",
      },
      authStub({
        signIn: async () => ({
          status: "error",
          code: "rate_limited",
          message: "Too many attempts. Wait before trying again.",
          retry_after_seconds: 300,
        }),
      }),
    );
    const response = await fetch(`${origin}/v1/auth/password/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reader@example.test",
        password: "a long orchard password",
        device_name: "Test device",
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
  });

  it("starts a bounded Google handoff without returning provider tokens", async () => {
    const start = vi.fn<OidcAuthService["start"]>(async () => ({
      status: "browser_required",
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=kiwi",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0003_google_identities",
      },
      authStub(),
      identityStub({ start }),
    );
    const body = {
      redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      code_challenge: "c".repeat(43),
    };
    const response = await fetch(`${origin}/v1/auth/google/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "browser_required",
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=kiwi",
    });
    expect(start).toHaveBeenCalledWith(body);
  });

  it("redirects the development provider fixture only through its validated callback", async () => {
    const callback = new URL(
      "http://127.0.0.1:54321/oauth/callback/random?state=matching&code=fixture-code",
    );
    const completeFixtureAuthorization = vi.fn(() => callback);
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0003_google_identities",
      },
      authStub(),
      identityStub({ completeFixtureAuthorization }),
    );
    const response = await fetch(`${origin}/v1/auth/google/fixture/authorize?request=opaque`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(callback.toString());
    expect(completeFixtureAuthorization).toHaveBeenCalledOnce();
  });

  it("accepts only a bounded refresh credential and supports explicit sign-out", async () => {
    const refresh = vi.fn<SessionService["refresh"]>(async () => ({
      status: "error",
      code: "session_expired",
      message: "Your session ended. Sign in again.",
    }));
    const signOut = vi.fn<SessionService["signOut"]>(async () => ({ status: "signed_out" }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0004_rotating_sessions",
      },
      authStub(),
      identityStub(),
      sessionStub({ refresh, signOut }),
    );
    const refreshResponse = await fetch(`${origin}/v1/auth/session/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "private-refresh" }),
    });
    expect(refreshResponse.status).toBe(400);
    expect(refresh).toHaveBeenCalledWith({ refresh_token: "private-refresh" });

    const signOutResponse = await fetch(`${origin}/v1/auth/session/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "private-refresh" }),
    });
    expect(signOutResponse.status).toBe(200);
    await expect(signOutResponse.json()).resolves.toEqual({ status: "signed_out" });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("requires a bearer session for account settings and validates profile input", async () => {
    const updateProfile = vi.fn<AccountSettingsService["updateProfile"]>(async () => ({
      status: "error",
      code: "recent_auth_required",
      message: "Sign in again before changing account security.",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0005_account_settings",
      },
      authStub(),
      identityStub(),
      sessionStub(),
      settingsStub({ updateProfile }),
    );
    expect((await fetch(`${origin}/v1/account/settings`)).status).toBe(401);
    const response = await fetch(`${origin}/v1/account/profile`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer private-access",
        "content-type": "application/json",
      },
      body: JSON.stringify({ given_name: "Research Lead", family_name: "Reader" }),
    });
    expect(response.status).toBe(403);
    expect(updateProfile).toHaveBeenCalledWith("private-access", {
      given_name: "Research Lead",
      family_name: "Reader",
      phone: null,
    });

    const rejected = await fetch(`${origin}/v1/account/profile`, {
      method: "PATCH",
      headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Research Lead" }),
    });
    expect(rejected.status).toBe(400);
    expect(updateProfile).toHaveBeenCalledTimes(1);
  });

  it("routes a bounded pending-address resend request through account settings", async () => {
    const resendEmail = vi.fn<AccountSettingsService["resendEmail"]>(async () => ({
      status: "error",
      code: "rate_limited",
      message: "Too many attempts. Wait before trying again.",
      retry_after_seconds: 120,
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0015_account_emails",
      },
      authStub(),
      identityStub(),
      sessionStub(),
      settingsStub({ resendEmail }),
    );
    const response = await fetch(`${origin}/v1/account/emails/resend`, {
      method: "POST",
      headers: {
        authorization: "Bearer private-access",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email_id: "email-pending" }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      code: "rate_limited",
      retry_after_seconds: 120,
    });
    expect(resendEmail).toHaveBeenCalledWith("private-access", "email-pending");
  });

  it("keeps workspace collaboration behind a bearer-authenticated typed boundary", async () => {
    const execute = vi.fn<WorkspaceCollaborationService["execute"]>(async () => ({
      status: "error",
      code: "forbidden",
      message: "Your workspace role cannot make this change.",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0006_workspace_collaboration",
      },
      authStub(),
      identityStub(),
      sessionStub(),
      settingsStub(),
      { execute },
    );
    const path = "/v1/workspaces/members/update";
    expect(
      (
        await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace_id: "workspace-1" }),
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer private-access",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace_id: "workspace-1", user_id: "member-1", role: "viewer" }),
    });
    expect(response.status).toBe(403);
    expect(execute).toHaveBeenCalledWith(path, "private-access", {
      workspace_id: "workspace-1",
      user_id: "member-1",
      role: "viewer",
    });
  });

  it("refuses a sign-in method change when the session is not recently authenticated", async () => {
    const unlink = vi.fn<OidcAuthService["unlink"]>(async () => ({
      status: "identity_unlinked",
      provider: "google",
      provider_revocation: "not_supported",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0014_drop_pronouns",
      },
      authStub(),
      identityStub({ unlink }),
      sessionStub(),
      settingsStub({
        authenticatedAccountId: async () => ({
          accountId: "account-1",
          sessionId: "session-1",
          recentlyAuthenticated: false,
        }),
      }),
    );
    const response = await fetch(`${origin}/v1/account/sign-in-methods/unlink`, {
      method: "POST",
      headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      code: "recent_auth_required",
    });
    expect(unlink).not.toHaveBeenCalled();
  });

  it("allows a sign-in method change when the session was recently authenticated", async () => {
    const unlink = vi.fn<OidcAuthService["unlink"]>(async () => ({
      status: "identity_unlinked",
      provider: "google",
      provider_revocation: "not_supported",
    }));
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0014_drop_pronouns",
      },
      authStub(),
      identityStub({ unlink }),
      sessionStub(),
      settingsStub({
        authenticatedAccountId: async () => ({
          accountId: "account-1",
          sessionId: "session-1",
          recentlyAuthenticated: true,
        }),
      }),
    );
    const response = await fetch(`${origin}/v1/account/sign-in-methods/unlink`, {
      method: "POST",
      headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    });

    await expect(response.json()).resolves.toEqual({
      status: "identity_unlinked",
      provider: "google",
      provider_revocation: "not_supported",
    });
    expect(unlink).toHaveBeenCalledWith("account-1", "google");
  });

  it("allows password reauthentication on a live stale session", async () => {
    const reauthenticatePassword = vi.fn<AccountSettingsService["reauthenticatePassword"]>(
      async () => ({ status: "reauthenticated", provider: "password" }),
    );
    const origin = await listen(
      {
        protocol_version: PROTOCOL_VERSION,
        service: "kiwi-account",
        status: "ready",
        database: "ready",
        migration_version: "0018_session_reauthentication",
      },
      authStub(),
      null,
      sessionStub(),
      settingsStub({
        authenticatedAccountId: async () => ({
          accountId: "account-1",
          sessionId: "session-current",
          recentlyAuthenticated: false,
        }),
        reauthenticatePassword,
      }),
    );
    const response = await fetch(`${origin}/v1/account/reauthenticate/password`, {
      method: "POST",
      headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: JSON.stringify({ password: "the old one" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "reauthenticated",
      provider: "password",
    });
    expect(reauthenticatePassword).toHaveBeenCalledWith("private-access", {
      password: "the old one",
    });
  });
});
