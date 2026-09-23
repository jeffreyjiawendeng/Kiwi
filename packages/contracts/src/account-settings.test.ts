import { describe, expect, it } from "vitest";
import {
  deriveDisplayName,
  deriveInitials,
  MAXIMUM_ACCOUNT_EMAILS,
  MAXIMUM_AVATAR_BYTES,
  isAccountSettingsResult,
  isProfileComplete,
  isProfileNamed,
  readAvatarMediaType,
  readAvatarUpload,
  readDeletionRequest,
  readNotificationPreference,
  readPasswordSetRequest,
  readProfileUpdate,
  readSessionRevoke,
} from "./account-settings.js";

const EMPTY_PROFILE = {
  given_name: null,
  family_name: null,
  phone: null,
};

describe("account settings contracts", () => {
  it("bounds an account to three email addresses", () => {
    expect(MAXIMUM_ACCOUNT_EMAILS).toBe(3);
  });

  it("accepts bounded exact mutation shapes", () => {
    expect(readProfileUpdate({ given_name: " Ada " })).toEqual({
      ...EMPTY_PROFILE,
      given_name: "Ada",
    });
    expect(
      readProfileUpdate({
        given_name: "Ada",
        family_name: "Lovelace",
      }),
    ).toEqual({
      given_name: "Ada",
      family_name: "Lovelace",
      phone: null,
    });
    expect(readSessionRevoke({ session_id: "session-1" })).toEqual({ session_id: "session-1" });
    expect(readDeletionRequest({ confirmation: "DELETE" })).toEqual({ confirmation: "DELETE" });
  });

  it("treats a blank profile field as cleared rather than empty text", () => {
    expect(readProfileUpdate({ given_name: "   ", family_name: "" })).toEqual(EMPTY_PROFILE);
  });

  it("accepts common phone formats and stores one international form", () => {
    expect(readProfileUpdate({ phone: "+1 (415) 555-0134" })).toEqual({
      ...EMPTY_PROFILE,
      phone: "+14155550134",
    });
    expect(readProfileUpdate({ phone: "415-555-0134" })).toEqual({
      ...EMPTY_PROFILE,
      phone: "+14155550134",
    });
    expect(readProfileUpdate({ phone: "00 44 20 7946 0958" })).toEqual({
      ...EMPTY_PROFILE,
      phone: "+442079460958",
    });
    expect(readProfileUpdate({ phone: "+0155550134" })).toBeNull();
    expect(readProfileUpdate({ phone: "+1234" })).toBeNull();
  });

  it("reads a password change that proves the current password", () => {
    expect(
      readPasswordSetRequest({ current_password: "the old one", new_password: "a long one" }),
    ).toEqual({ current_password: "the old one", new_password: "a long one" });
  });

  it("reads a first password as one with no current password to prove", () => {
    expect(readPasswordSetRequest({ new_password: "a long one" })).toEqual({
      current_password: null,
      new_password: "a long one",
    });
    // An empty current password is the absent one, not a password that is the empty string.
    expect(readPasswordSetRequest({ current_password: "", new_password: "a long one" })).toEqual({
      current_password: null,
      new_password: "a long one",
    });
  });

  it("rejects a password request that carries a code or an unknown field", () => {
    // No emailed code takes part in a password change. Only account creation and
    // recovery send one, and both are handled outside Account Settings.
    expect(readPasswordSetRequest({ code: "KIWI-RESET-1", new_password: "a long one" })).toBeNull();
    expect(readPasswordSetRequest({ new_password: "" })).toBeNull();
    expect(readPasswordSetRequest({ new_password: "a".repeat(1025) })).toBeNull();
    expect(readPasswordSetRequest({ current_password: 7, new_password: "a long one" })).toBeNull();
  });

  it("rejects expanded or ambiguous mutations", () => {
    expect(readProfileUpdate({ display_name: "Reader" })).toBeNull();
    expect(readProfileUpdate({ preferred_name: "Reader" })).toBeNull();
    expect(readProfileUpdate({ given_name: "Reader", role: "owner" })).toBeNull();
    expect(readProfileUpdate({ pronouns: "they/them" })).toBeNull();
    expect(readProfileUpdate({ given_name: "g".repeat(81) })).toBeNull();
    expect(readProfileUpdate({ given_name: 7 })).toBeNull();
    expect(readSessionRevoke({ session_id: "" })).toBeNull();
    expect(readDeletionRequest({ confirmation: "delete" })).toBeNull();
  });

  it("derives one display name for every profile shape", () => {
    const email = "reader@example.test";
    expect(
      deriveDisplayName({ ...EMPTY_PROFILE, given_name: "Ada", family_name: "Lovelace" }, email),
    ).toBe("Ada Lovelace");
    expect(deriveDisplayName({ ...EMPTY_PROFILE, given_name: "Ada" }, email)).toBe("Ada");
    expect(deriveDisplayName({ ...EMPTY_PROFILE, family_name: "Lovelace" }, email)).toBe(
      "Lovelace",
    );
    expect(deriveDisplayName(EMPTY_PROFILE, email)).toBe("reader");
  });

  it("reports profile completion only when a name was entered", () => {
    expect(isProfileNamed(EMPTY_PROFILE)).toBe(false);
    expect(isProfileNamed({ ...EMPTY_PROFILE, phone: "+14155550134" })).toBe(false);
    expect(isProfileNamed({ ...EMPTY_PROFILE, family_name: "Lovelace" })).toBe(true);
  });

  it("requires both names and a phone number for a complete initial profile", () => {
    expect(isProfileComplete(EMPTY_PROFILE)).toBe(false);
    expect(
      isProfileComplete({
        given_name: "Kiwi",
        family_name: "Reader",
        phone: "+14155550134",
      }),
    ).toBe(true);
    expect(isProfileComplete({ ...EMPTY_PROFILE, given_name: "Kiwi", family_name: "Reader" })).toBe(
      false,
    );
  });

  it("accepts a public settings snapshot", () => {
    expect(
      isAccountSettingsResult({
        status: "ok",
        email_verification: {
          email_id: "email-2",
          address: "reader@university.test",
          fixture_code: "KIWI-VERIFY-000002",
        },
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
          sessions: [],
          emails: [],
          security_activity: [
            {
              id: "event-1",
              event: "account.signed_in",
              outcome: "succeeded",
              occurred_at: "2026-08-23T12:00:00.000Z",
            },
          ],
          notifications: [
            { category: "workspace_invitations", email: true },
            { category: "collaboration", email: true },
            { category: "synchronization", email: true },
            { category: "product", email: false },
          ],
          deletion_impact: {
            sole_owner_workspaces: [{ id: "workspace-1", title: "Photocatalysis" }],
            shared_workspaces: 2,
            addresses: 2,
            connections: 1,
          },
          deletion: { status: "none" },
        },
      }),
    ).toBe(true);
  });

  it("rejects a snapshot whose deletion impact is missing or malformed", () => {
    const withImpact = (impact: unknown): unknown => ({
      status: "ok",
      settings: {
        account: {
          id: "account-1",
          email: "reader@example.test",
          profile: EMPTY_PROFILE,
          display_name: "Reader",
          profile_complete: true,
          email_verified: true,
          avatar: null,
        },
        sign_in_methods: ["password"],
        sessions: [],
        emails: [],
        security_activity: [],
        notifications: [
          { category: "workspace_invitations", email: true },
          { category: "collaboration", email: true },
          { category: "synchronization", email: true },
          { category: "product", email: false },
        ],
        deletion_impact: impact,
        deletion: { status: "none" },
      },
    });
    const valid = {
      sole_owner_workspaces: [],
      shared_workspaces: 0,
      addresses: 1,
      connections: 0,
    };
    expect(isAccountSettingsResult(withImpact(valid))).toBe(true);
    expect(isAccountSettingsResult(withImpact(undefined))).toBe(false);
    expect(isAccountSettingsResult(withImpact({ ...valid, shared_workspaces: -1 }))).toBe(false);
    expect(isAccountSettingsResult(withImpact({ ...valid, owner: "reader" }))).toBe(false);
    expect(
      isAccountSettingsResult(withImpact({ ...valid, sole_owner_workspaces: ["workspace-1"] })),
    ).toBe(false);
  });

  it("rejects a snapshot whose profile is missing or overlong", () => {
    const snapshot = (profile: unknown): unknown => ({
      status: "ok",
      settings: {
        account: {
          id: "account-1",
          email: "reader@example.test",
          profile,
          display_name: "Reader",
          profile_complete: true,
          email_verified: true,
          avatar: null,
        },
        sign_in_methods: ["password"],
        sessions: [],
        security_activity: [],
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
    });
    expect(isAccountSettingsResult(snapshot(undefined))).toBe(false);
    expect(
      isAccountSettingsResult(
        snapshot({ ...EMPTY_PROFILE, phone: "p".repeat(21) as unknown as string }),
      ),
    ).toBe(false);
    expect(isAccountSettingsResult(snapshot({ ...EMPTY_PROFILE, nickname: "Reader" }))).toBe(false);
  });
  it("reads a delivery preference and refuses one that is not a category", () => {
    expect(readNotificationPreference({ category: "collaboration", email: false })).toEqual({
      category: "collaboration",
      email: false,
    });
    // Security correspondence is always delivered, so it is not a category at all.
    expect(readNotificationPreference({ category: "security", email: false })).toBeNull();
    expect(readNotificationPreference({ category: "product", email: "yes" })).toBeNull();
    expect(
      readNotificationPreference({ category: "product", email: true, scope: "all" }),
    ).toBeNull();
  });
  it("reads an avatar media type from the bytes, not from a claim about them", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(readAvatarMediaType(png)).toBe("image/png");
    expect(readAvatarMediaType(jpeg)).toBe("image/jpeg");
    expect(readAvatarMediaType(webp)).toBe("image/webp");
    // A RIFF container that is not WebP is not an image Kiwi will store.
    expect(
      readAvatarMediaType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]),
      ),
    ).toBeNull();
    expect(readAvatarMediaType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
    expect(readAvatarMediaType(new Uint8Array())).toBeNull();
  });

  it("bounds an avatar upload before any of it is decoded", () => {
    expect(readAvatarUpload({ media_type: "image/png", data: "iVBORw0KGgo=" })).toEqual({
      media_type: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(readAvatarUpload({ media_type: "image/svg+xml", data: "PHN2Zz4=" })).toBeNull();
    expect(readAvatarUpload({ media_type: "image/png", data: "" })).toBeNull();
    expect(readAvatarUpload({ media_type: "image/png", data: "not base64!" })).toBeNull();
    expect(
      readAvatarUpload({ media_type: "image/png", data: "A".repeat(4 * MAXIMUM_AVATAR_BYTES) }),
    ).toBeNull();
    expect(
      readAvatarUpload({ media_type: "image/png", data: "iVBORw0KGgo=", user_id: "account-2" }),
    ).toBeNull();
  });

  it("derives initials from the first and last word of a displayed name", () => {
    expect(deriveInitials("Ada Lovelace")).toBe("AL");
    expect(deriveInitials("Ada Byron King Lovelace")).toBe("AL");
    expect(deriveInitials("Ada")).toBe("A");
    expect(deriveInitials("reader")).toBe("R");
    expect(deriveInitials("  ")).toBe("?");
  });
});
