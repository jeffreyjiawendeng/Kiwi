import { describe, expect, it } from "vitest";
import {
  isAccountAuthServiceResponse,
  isGoogleAuthStartResponse,
  readAccountRegistrationProfile,
  readEmailVerificationRequest,
  readEmailVerificationResendRequest,
  readPasswordAccountCreateRequest,
  readPasswordResetConfirmRequest,
  readPasswordResetRequest,
  readPasswordSignInRequest,
  readPasswordReauthenticationRequest,
  readGoogleAuthExchangeRequest,
  readGoogleAuthStartRequest,
  readSessionCredentialRequest,
} from "./account-auth.js";

describe("account authentication requests", () => {
  it("accepts exact bounded request shapes", () => {
    expect(
      readPasswordAccountCreateRequest({
        email: "reader@example.test",
        email_kind: "institutional",
        password: "a long orchard password",
        given_name: " Kiwi ",
        family_name: " Reader ",
        phone: "(415) 555-0134",
      }),
    ).toEqual({
      email: "reader@example.test",
      email_kind: "institutional",
      password: "a long orchard password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    });
    expect(
      readEmailVerificationRequest({
        email: "reader@example.test",
        code: "code",
        device_name: "Kiwi desktop",
      }),
    ).not.toBeNull();
    expect(
      readPasswordSignInRequest({
        email: "reader@example.test",
        password: "password",
        device_name: "Kiwi desktop",
      }),
    ).not.toBeNull();
    expect(readPasswordResetRequest({ email: "reader@example.test" })).not.toBeNull();
    expect(readPasswordReauthenticationRequest({ password: "password" })).toEqual({
      password: "password",
    });
    expect(readEmailVerificationResendRequest({ email: "reader@example.test" })).not.toBeNull();
    expect(
      readPasswordResetConfirmRequest({
        email: "reader@example.test",
        code: "code",
        new_password: "a different orchard password",
      }),
    ).not.toBeNull();
    expect(
      readGoogleAuthStartRequest({
        provider: "google",
        registration_profile: {
          given_name: " Kiwi ",
          family_name: " Reader ",
          phone: "415.555.0134",
        },
        redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
        state: "state",
        nonce: "nonce",
        code_challenge: "challenge",
      }),
    ).toMatchObject({
      registration_profile: {
        given_name: "Kiwi",
        family_name: "Reader",
        phone: "+14155550134",
      },
    });
    expect(
      readGoogleAuthExchangeRequest({
        redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
        state: "state",
        nonce: "nonce",
        code_challenge: "challenge",
        code: "provider-code",
        code_verifier: "verifier",
      }),
    ).not.toBeNull();
    expect(readSessionCredentialRequest({ refresh_token: "refresh" })).toEqual({
      refresh_token: "refresh",
    });
    expect(
      readAccountRegistrationProfile({
        given_name: "Kiwi",
        family_name: "Reader",
        phone: "+44 20 7946 0958",
      }),
    ).toEqual({
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+442079460958",
    });
  });

  it("rejects expanded Google request shapes", () => {
    expect(
      readGoogleAuthStartRequest({
        redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
        state: "state",
        nonce: "nonce",
        code_challenge: "challenge",
        access_token: "leak",
      }),
    ).toBeNull();
    expect(
      readGoogleAuthStartRequest({
        provider: "google",
        registration_profile: {
          given_name: "Kiwi",
          family_name: "Reader",
          phone: "not a phone",
        },
        redirect_uri: "http://127.0.0.1:54321/oauth/callback/random",
        state: "state",
        nonce: "nonce",
        code_challenge: "challenge",
      }),
    ).toBeNull();
  });

  it.each([
    null,
    {},
    {
      email: "reader@example.test",
      password: "password",
      admin: true,
    },
    {
      email: "reader@example.test",
      email_kind: "personal",
      password: "password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
      role: "owner",
    },
    {
      email: "reader@example.test",
      email_kind: "work",
      password: "password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    },
    {
      email: "reader@example.test",
      email_kind: "personal",
      password: "password",
      given_name: "",
      family_name: "Reader",
      phone: "+14155550134",
    },
    {
      email: "reader@example.test",
      email_kind: "personal",
      password: "password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "not a number",
    },
    { email: "reader@example.test", password: "" },
  ])("rejects malformed or expanded account creation input %o", (input) => {
    expect(readPasswordAccountCreateRequest(input)).toBeNull();
  });
});

describe("account authentication responses", () => {
  it("accepts the authenticated service shape", () => {
    expect(
      isAccountAuthServiceResponse({
        status: "authenticated",
        account: { id: "account-1", email: "reader@example.test", email_verified: true },
        access_token: "opaque-access-token",
        expires_at: "2026-08-22T12:15:00.000Z",
        refresh_token: "opaque-refresh-token",
        refresh_expires_at: "2026-09-21T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("accepts only a bounded reauthentication result", () => {
    expect(isAccountAuthServiceResponse({ status: "reauthenticated", provider: "password" })).toBe(
      true,
    );
    expect(
      isAccountAuthServiceResponse({
        status: "reauthenticated",
        provider: "password",
        access_token: "leak",
      }),
    ).toBe(false);
  });

  it("accepts only the bounded Google browser handoff response", () => {
    expect(
      isGoogleAuthStartResponse({
        status: "browser_required",
        authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=kiwi",
      }),
    ).toBe(true);
    expect(
      isGoogleAuthStartResponse({
        status: "browser_required",
        authorization_url: "https://accounts.google.com/",
        access_token: "leak",
      }),
    ).toBe(false);
  });

  it.each([
    { status: "authenticated", account: {}, access_token: "token", expires_at: "later" },
    { status: "error", code: "database_failed", message: "SQL" },
    { status: "accepted", next: "verify_email", verifier: "secret" },
    { status: "password_reset", access_token: "secret" },
  ])("rejects malformed, unknown, or secret-bearing response %o", (response) => {
    expect(isAccountAuthServiceResponse(response)).toBe(false);
  });
});
