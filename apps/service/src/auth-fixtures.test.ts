import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  FixtureEmailDelivery,
  FixtureAuthTokenGenerator,
  FixtureGoogleIdentity,
  createDevelopmentAuthAdapters,
} from "./auth-fixtures.js";

describe("development auth adapters", () => {
  it("are absent unless explicitly enabled", () => {
    expect(createDevelopmentAuthAdapters(false)).toBeNull();
  });

  it("produce deterministic synthetic email delivery", async () => {
    const adapter = new FixtureEmailDelivery();
    const delivery = {
      recipient: "researcher@example.test",
      code: "KIWI-VERIFY-000001",
      purpose: "verify_email" as const,
      expiresAt: new Date("2026-08-22T12:15:00.000Z"),
    };
    await expect(adapter.send(delivery)).resolves.toBeUndefined();
    expect(adapter.deliveries).toEqual([delivery]);
  });

  it("accepts only the documented synthetic Google code", async () => {
    const adapter = new FixtureGoogleIdentity();
    const verifier = "a".repeat(64);
    const authorizationUrl = new URL(
      adapter.authorizationUrl({
        redirectUri: "http://127.0.0.1:49152/oauth/callback/test",
        state: "s".repeat(43),
        nonce: "n".repeat(43),
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      }),
    );
    const callback = adapter.completeFixtureAuthorization(authorizationUrl);
    const code = callback?.searchParams.get("code");
    if (code === null || code === undefined) throw new Error("Fixture code missing.");
    await expect(
      adapter.exchangeAuthorizationCode({
        code,
        redirectUri: "http://127.0.0.1:49152/oauth/callback/test",
        codeVerifier: verifier,
      }),
    ).resolves.toMatchObject({
      subject: "google-fixture-user-1",
      email: "researcher@example.test",
      nonce: "n".repeat(43),
    });
    await expect(
      adapter.exchangeAuthorizationCode({
        code: "other",
        redirectUri: "http://127.0.0.1:49152/oauth/callback/test",
        codeVerifier: verifier,
      }),
    ).rejects.toThrow(/not valid/i);
  });

  it("generates deterministic, purpose-separated fixture tokens", () => {
    const tokens = new FixtureAuthTokenGenerator();
    expect(tokens.next("verify_email")).toBe("KIWI-VERIFY-000001");
    expect(tokens.next("verify_email")).toBe("KIWI-VERIFY-000002");
    expect(tokens.next("reset_password")).toBe("KIWI-RESET-000001");
  });

  it("issues deterministic email codes but never a repeatable session credential", () => {
    const first = new FixtureAuthTokenGenerator();
    const second = new FixtureAuthTokenGenerator();

    // A person retypes these, so a restart may repeat them.
    expect(first.next("verify_email")).toBe("KIWI-VERIFY-000001");
    expect(second.next("verify_email")).toBe("KIWI-VERIFY-000001");
    expect(first.next("reset_password")).toBe("KIWI-RESET-000001");

    // Session credentials are stored under a unique hash for their whole lifetime, so a
    // generator that restarted must not reissue one an earlier session already stored.
    const credentials = new Set<string>();
    for (const generator of [first, second, new FixtureAuthTokenGenerator()]) {
      credentials.add(generator.next("access_token"));
      credentials.add(generator.next("refresh_token"));
    }
    expect(credentials.size).toBe(6);
    for (const credential of credentials) {
      expect(credential).toMatch(/^kiwi_(access|refresh)_[A-Za-z0-9_-]{43}$/u);
    }
  });
});
