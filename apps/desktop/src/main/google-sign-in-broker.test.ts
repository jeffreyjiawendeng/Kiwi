import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAuthStartRequest } from "@kiwi/contracts";
import type { AccountServiceClient } from "./account-service-client.js";
import { createGoogleSignInBroker } from "./google-sign-in-broker.js";

function testClient() {
  let started: GoogleAuthStartRequest | null = null;
  const startIdentity = vi.fn<AccountServiceClient["startIdentity"]>(async (request) => {
    started = request as GoogleAuthStartRequest;
    return {
      status: "browser_required",
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    };
  });
  const exchangeIdentity = vi.fn<AccountServiceClient["exchangeIdentity"]>(async () => ({
    status: "authenticated",
    account: { id: "account-1", email: "reader@example.test", email_verified: true },
  }));
  return {
    client: { startIdentity, exchangeIdentity } as unknown as AccountServiceClient,
    startIdentity,
    exchangeIdentity,
    started: () => started,
  };
}

function tokens(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `${String(value).padStart(2, "0")}${"x".repeat(41)}`;
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached.");
}

describe("Google system-browser broker", () => {
  it("binds a random IPv4 loopback callback and exchanges matching state and PKCE", async () => {
    const fixture = testClient();
    const openExternal = vi.fn(async () => {
      const start = fixture.started();
      if (start === null) throw new Error("Start request missing.");
      const callback = new URL(start.redirect_uri);
      callback.searchParams.set("state", start.state);
      callback.searchParams.set("code", "provider-code");
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("return to Kiwi");
    });
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      openExternal,
      randomToken: tokens(),
    });

    await expect(broker.start()).resolves.toMatchObject({ status: "authenticated" });
    const start = fixture.started();
    expect(start?.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//);
    expect(start?.state).toHaveLength(43);
    expect(start?.nonce).toHaveLength(43);
    const exchange = fixture.exchangeIdentity.mock.calls[0]?.[0] as Record<string, string>;
    expect(exchange["state"]).toBe(start?.state);
    expect(exchange["redirect_uri"]).toBe(start?.redirect_uri);
    expect(exchange["code"]).toBe("provider-code");
    expect(exchange["code_verifier"]).toHaveLength(86);
  });

  it("serves a readable signed-in page whose styles satisfy its own policy", async () => {
    const fixture = testClient();
    let page = "";
    let policy = "";
    const openExternal = vi.fn(async () => {
      const start = fixture.started();
      if (start === null) throw new Error("Start request missing.");
      const callback = new URL(start.redirect_uri);
      callback.searchParams.set("state", start.state);
      callback.searchParams.set("code", "provider-code");
      const response = await fetch(callback);
      policy = response.headers.get("content-security-policy") ?? "";
      page = await response.text();
    });
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      openExternal,
      randomToken: tokens(),
    });

    await broker.start();
    expect(page).toContain("<title>Return to Kiwi</title>");
    expect(page).toContain("You are signed in");
    expect(page).toContain("You can close this page and return to Kiwi.");

    const style = page.slice(page.indexOf("<style>") + 7, page.indexOf("</style>"));
    expect(style).toContain("prefers-color-scheme: dark");
    expect(style).toContain("forced-colors: active");
    const hash = createHash("sha256").update(style, "utf8").digest("base64");
    expect(policy).toBe(`default-src 'none'; style-src 'sha256-${hash}'`);
    expect(page).not.toContain("<script");
  });

  it("binds a registration profile to both sides of the provider exchange", async () => {
    const fixture = testClient();
    const registrationProfile = {
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    };
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => {
        const start = fixture.started();
        if (start === null) throw new Error("Start request missing.");
        const callback = new URL(start.redirect_uri);
        callback.searchParams.set("state", start.state);
        callback.searchParams.set("code", "provider-code");
        await fetch(callback);
      },
    });

    await broker.start({
      provider: "google",
      mode: "sign_in",
      registrationProfile,
    });
    expect(fixture.startIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ registration_profile: registrationProfile }),
      "sign_in",
    );
    expect(fixture.exchangeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ registration_profile: registrationProfile }),
      "sign_in",
    );
  });

  it("shows an unbranded page for a request that is not the callback", async () => {
    const fixture = testClient();
    let notFound: Response | undefined;
    const openExternal = vi.fn(async () => {
      const start = fixture.started();
      if (start === null) throw new Error("Start request missing.");
      notFound = await fetch(new URL("/", start.redirect_uri));
      const callback = new URL(start.redirect_uri);
      callback.searchParams.set("state", start.state);
      callback.searchParams.set("code", "provider-code");
      await fetch(callback);
    });
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      openExternal,
      randomToken: tokens(),
    });

    await broker.start();
    expect(notFound?.status).toBe(404);
    const body = await (notFound as Response).text();
    expect(body).toContain("Not found");
    expect(body).not.toContain("Kiwi");
  });

  it("ignores a wrong-state callback and accepts the matching callback", async () => {
    const fixture = testClient();
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => {
        const start = fixture.started();
        if (start === null) throw new Error("Start request missing.");
        const wrong = new URL(start.redirect_uri);
        wrong.searchParams.set("state", "wrong-state");
        wrong.searchParams.set("code", "intercepted");
        expect((await fetch(wrong)).status).toBe(400);

        const correct = new URL(start.redirect_uri);
        correct.searchParams.set("state", start.state);
        correct.searchParams.set("code", "provider-code");
        expect((await fetch(correct)).status).toBe(200);
      },
    });
    await expect(broker.start()).resolves.toMatchObject({ status: "authenticated" });
    expect(fixture.exchangeIdentity).toHaveBeenCalledOnce();
  });

  it("reports provider denial without exchanging a code", async () => {
    const fixture = testClient();
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => {
        const start = fixture.started();
        if (start === null) throw new Error("Start request missing.");
        const callback = new URL(start.redirect_uri);
        callback.searchParams.set("state", start.state);
        callback.searchParams.set("error", "access_denied");
        await fetch(callback);
      },
    });
    await expect(broker.start()).resolves.toEqual({
      status: "error",
      code: "provider_denied",
      message: "Sign-in was not approved.",
    });
    expect(fixture.exchangeIdentity).not.toHaveBeenCalled();
  });

  it("cancels the pending callback and allows a later attempt", async () => {
    const fixture = testClient();
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => undefined,
      timeoutMs: 5_000,
    });
    const pending = broker.start();
    await waitUntil(() => broker.pending());
    expect(broker.cancel()).toBe(true);
    await expect(pending).resolves.toEqual({
      status: "error",
      code: "provider_cancelled",
      message: "Sign-in was canceled.",
    });
    expect(broker.pending()).toBe(false);
    expect(fixture.exchangeIdentity).not.toHaveBeenCalled();
  });

  it("honors cancellation immediately after start, before the callback port is ready", async () => {
    const fixture = testClient();
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => undefined,
      timeoutMs: 5_000,
    });
    const pending = broker.start();
    expect(broker.cancel()).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: "error",
      code: "provider_cancelled",
    });
    expect(fixture.startIdentity).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent browser flow", async () => {
    const fixture = testClient();
    const broker = createGoogleSignInBroker({
      accountService: fixture.client,
      randomToken: tokens(),
      openExternal: async () => undefined,
      timeoutMs: 5_000,
    });
    const first = broker.start();
    await waitUntil(() => broker.pending());
    await expect(broker.start()).resolves.toMatchObject({
      status: "error",
      code: "invalid_callback",
    });
    broker.cancel();
    await first;
  });
});
