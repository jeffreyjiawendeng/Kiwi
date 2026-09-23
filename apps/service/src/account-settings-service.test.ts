import { describe, expect, it, vi } from "vitest";
import type { AccountExport } from "@kiwi/contracts";
import { createAccountSettingsService } from "./account-settings-service.js";
import type {
  AccountAccessContext,
  AccountSettingsStore,
  StoredAvatar,
  RemovePasswordResult,
  RequestDeletionResult,
  StoredPasswordCredential,
} from "./account-settings-store.js";

function setup(lastAuthenticatedAt = new Date("2026-08-22T11:55:00.000Z")) {
  const snapshot = {
    account: {
      id: "account-1",
      email: "reader@example.test",
      profile: {
        given_name: null,
        family_name: null,
        phone: null,
      },
      display_name: "Kiwi Reader",
      profile_complete: true,
      email_verified: true as const,
      avatar: null,
    },
    sign_in_methods: ["password" as const],
    emails: [],
    security_activity: [],
    sessions: [],
    notifications: [
      { category: "workspace_invitations" as const, email: true },
      { category: "collaboration" as const, email: true },
      { category: "synchronization" as const, email: true },
      { category: "product" as const, email: false },
    ],
    deletion_impact: {
      sole_owner_workspaces: [],
      shared_workspaces: 0,
      addresses: 0,
      connections: 0,
    },
    deletion: { status: "none" as const },
  };
  const store = {
    authenticate: vi.fn(async () => ({
      accountId: "account-1",
      sessionId: "session-current",
      lastAuthenticatedAt,
    })),
    reauthenticateSession: vi.fn(async () => true),
    snapshot: vi.fn(async () => snapshot),
    updateProfile: vi.fn(async () => undefined),
    primaryEmail: vi.fn(async () => "reader@example.test"),
    revokeSession: vi.fn(async () => true),
    revokeOtherSessions: vi.fn(async () => undefined),
    requestDeletion: vi.fn(async (): Promise<RequestDeletionResult> => ({ kind: "requested" })),
    passwordCredential: vi.fn(async (): Promise<StoredPasswordCredential | null> => ({
      verifier: "stored",
      parameterVersion: 1,
    })),
    setPassword: vi.fn(async () => undefined),
    removePassword: vi.fn(async (): Promise<RemovePasswordResult> => ({ kind: "removed" })),
    setNotificationPreference: vi.fn(async () => undefined),
    readAvatar: vi.fn(async (): Promise<StoredAvatar | null> => null),
    setAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    exportAccount: vi.fn(async (): Promise<AccountExport> => ({
      format: "kiwi.account-export.v1",
      generated_at: "2026-08-22T12:00:00.000Z",
      account: {
        id: "account-1",
        primary_email: "reader@example.test",
        given_name: null,
        family_name: null,
        phone: null,
        created_at: "2026-08-01T12:00:00.000Z",
      },
      emails: [],
      sign_in_methods: ["password"],
      connected_accounts: [],
      sessions: [],
      security_activity: [],
      notifications: [],
      workspaces: [],
    })),
  } satisfies AccountSettingsStore;
  const hasher = {
    hash: vi.fn(async () => ({ verifier: "hashed", parameterVersion: 1 })),
    verify: vi.fn(async (_verifier: string, password: string) => password === "the old one"),
  };
  const events = { recordSecurityEvent: vi.fn(async () => undefined) };
  const service = createAccountSettingsService({
    store,
    hasher,
    events,
    clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
  });
  return { service, store, hasher, events };
}

describe("account settings service", () => {
  it("reauthenticates only the current session after verifying its password", async () => {
    const { service, store, events } = setup(new Date("2026-08-22T10:00:00.000Z"));

    await expect(
      service.reauthenticatePassword("private-access-token", { password: "the old one" }),
    ).resolves.toEqual({ status: "reauthenticated", provider: "password" });

    expect(store.reauthenticateSession).toHaveBeenCalledWith(
      "account-1",
      "session-current",
      new Date("2026-08-22T12:00:00.000Z"),
    );
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "account-1",
        eventType: "account.password_reauthentication",
        outcome: "succeeded",
      }),
    );
  });

  it("does not refresh recent authentication for a wrong password", async () => {
    const { service, store } = setup();

    await expect(
      service.reauthenticatePassword("private-access-token", { password: "wrong" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
    expect(store.reauthenticateSession).not.toHaveBeenCalled();
  });

  it("authenticates with a hash and returns public account settings", async () => {
    const { service, store } = setup();
    await expect(service.snapshot("private-access-token")).resolves.toMatchObject({
      status: "ok",
      settings: { account: { email: "reader@example.test" } },
    });
    expect(store.authenticate).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Date),
    );
    expect(JSON.stringify(store.authenticate.mock.calls)).not.toContain("private-access-token");
  });

  it("updates a safe profile field and revokes only another session", async () => {
    const { service, store } = setup();
    const profile = {
      given_name: "Ada",
      family_name: "Lovelace",
      phone: "+14155550134",
    };
    await expect(service.updateProfile("access", profile)).resolves.toMatchObject({
      status: "ok",
    });
    expect(store.updateProfile).toHaveBeenCalledWith("account-1", profile, expect.any(Date));
    await expect(service.revokeSession("access", "session-other")).resolves.toEqual({
      status: "session_revoked",
    });
    expect(store.revokeSession).toHaveBeenCalledWith(
      "account-1",
      "session-current",
      "session-other",
      expect.any(Date),
    );
  });

  it("requires recent authentication before session-wide or deletion changes", async () => {
    const { service, store } = setup(new Date("2026-08-22T10:00:00.000Z"));
    await expect(service.revokeOtherSessions("access")).resolves.toMatchObject({
      status: "error",
      code: "recent_auth_required",
    });
    await expect(service.requestDeletion("access")).resolves.toMatchObject({
      status: "error",
      code: "recent_auth_required",
    });
    expect(store.revokeOtherSessions).not.toHaveBeenCalled();
    expect(store.requestDeletion).not.toHaveBeenCalled();
  });

  it("requests recoverable deletion and revokes through the store", async () => {
    const { service, store } = setup();
    await expect(service.requestDeletion("access")).resolves.toEqual({
      status: "deletion_requested",
      recover_until: "2026-09-21T12:00:00.000Z",
    });
    expect(store.requestDeletion).toHaveBeenCalledWith(
      "account-1",
      expect.any(Date),
      new Date("2026-09-21T12:00:00.000Z"),
    );
  });

  it("refuses deletion until sole-owned workspaces have another owner", async () => {
    const { service, store } = setup();
    store.requestDeletion.mockResolvedValueOnce({
      kind: "ownership_required",
      workspaces: ["Field Study"],
    });
    await expect(service.requestDeletion("access")).resolves.toEqual({
      status: "error",
      code: "invalid_input",
      message: "Transfer ownership of these workspaces before deleting your account: Field Study.",
    });
  });

  it("changes a password by proving the current one, with no emailed code", async () => {
    const { service, store, hasher } = setup();
    await expect(
      service.setPassword("access", {
        current_password: "the old one",
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(hasher.verify).toHaveBeenCalledWith("stored", "the old one");
    expect(store.setPassword).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", currentSessionId: "session-current" }),
    );
  });

  it("refuses a password change that cannot prove the current password", async () => {
    const { service, store } = setup();
    await expect(
      service.setPassword("access", {
        current_password: "not the old one",
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
    await expect(
      service.setPassword("access", {
        current_password: null,
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_input" });
    expect(store.setPassword).not.toHaveBeenCalled();
  });

  it("rejects a breached replacement password before storing it", async () => {
    const { store, hasher } = setup();
    const service = createAccountSettingsService({
      store,
      hasher,
      passwordChecker: { check: async () => "compromised" },
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setPassword("access", {
        current_password: "the old one",
        new_password: "a locally valid replacement passphrase",
      }),
    ).resolves.toMatchObject({ status: "error", code: "password_rejected" });
    expect(store.setPassword).not.toHaveBeenCalled();
  });

  it("creates a first password from a recent sign-in alone", async () => {
    const { store, hasher, events } = setup();
    // An account created through Google or ORCID holds no password credential.
    store.passwordCredential = vi.fn(async (): Promise<StoredPasswordCredential | null> => null);
    const service = createAccountSettingsService({
      store,
      hasher,
      events,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setPassword("access", {
        current_password: null,
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(store.setPassword).toHaveBeenCalled();
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.password_created", outcome: "succeeded" }),
    );
  });

  it("requires recent authentication before any password change", async () => {
    const { store, hasher } = setup(new Date("2026-08-22T10:00:00.000Z"));
    const service = createAccountSettingsService({
      store,
      hasher,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setPassword("access", {
        current_password: "the old one",
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "error", code: "recent_auth_required" });
    await expect(service.removePassword("access")).resolves.toMatchObject({
      status: "error",
      code: "recent_auth_required",
    });
    expect(store.setPassword).not.toHaveBeenCalled();
    expect(store.removePassword).not.toHaveBeenCalled();
  });

  it("rejects a password the policy refuses", async () => {
    const { service, store } = setup();
    await expect(
      service.setPassword("access", { current_password: "the old one", new_password: "short" }),
    ).resolves.toMatchObject({ status: "error", code: "password_rejected" });
    expect(store.setPassword).not.toHaveBeenCalled();
  });

  it("counts repeated current-password guesses against one limit", async () => {
    const { store, hasher } = setup();
    const limiter = {
      takeRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 60 })),
    };
    const service = createAccountSettingsService({
      store,
      hasher,
      limiter,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setPassword("access", {
        current_password: "the old one",
        new_password: "a long orchard password",
      }),
    ).resolves.toMatchObject({ status: "error", code: "rate_limited" });
    expect(limiter.takeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "passwordSet" }),
    );
    // The account identifier is hashed before it reaches the shared limiter table.
    expect(JSON.stringify(limiter.takeRateLimit.mock.calls)).not.toContain("account-1");
  });

  it("keeps the last authentication method when a password is removed", async () => {
    const { store, hasher } = setup();
    store.removePassword = vi.fn(async (): Promise<RemovePasswordResult> => ({
      kind: "last_method",
    }));
    const service = createAccountSettingsService({
      store,
      hasher,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(service.removePassword("access")).resolves.toMatchObject({
      status: "error",
      code: "invalid_input",
    });
  });

  it("refuses a password change when no hasher is configured", async () => {
    const { store } = setup();
    const service = createAccountSettingsService({ store });
    await expect(
      service.setPassword("access", { current_password: null, new_password: "a long one" }),
    ).resolves.toMatchObject({
      status: "error",
      code: "service_unavailable",
    });
  });

  it("refuses an email change when the session is not recently authenticated", async () => {
    const { store } = setup(new Date("2026-08-22T10:00:00.000Z"));
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({
        kind: "verified" as const,
        address: "new@example.test",
      })),
      promote: vi.fn(async () => ({ kind: "promoted" as const, address: "new@example.test" })),
      setNotifications: vi.fn(async () => ({
        kind: "promoted" as const,
        address: "new@example.test",
      })),
      remove: vi.fn(async () => ({ kind: "removed" as const })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await expect(
      service.addEmail("access", { address: "new@example.test", kind: "personal" }),
    ).resolves.toMatchObject({ status: "error", code: "recent_auth_required" });
    expect(emails.add).not.toHaveBeenCalled();
  });

  it("returns the pending address and fixture code after adding an email", async () => {
    const { store } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_found" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
      remove: vi.fn(async () => ({ kind: "not_found" as const })),
    };
    const email = { kind: "fixture" as const, send: vi.fn(async () => undefined) };
    const limiter = {
      takeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      email,
      limiter,
      tokens: { next: () => "KIWI-VERIFY-000002" },
      ids: { next: () => "email-artifact" },
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await expect(
      service.addEmail("access", { address: "new@example.test", kind: "institutional" }),
    ).resolves.toMatchObject({
      status: "ok",
      email_verification: {
        email_id: "email-2",
        address: "new@example.test",
        fixture_code: "KIWI-VERIFY-000002",
      },
    });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "new@example.test", purpose: "verify_email" }),
    );
    expect(limiter.takeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "accountEmailAdd", maximum: 5 }),
    );
  });

  it("resends and replaces the verification artifact for a pending address", async () => {
    const { store, events } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "already_yours" as const })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_found" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
      remove: vi.fn(async () => ({ kind: "not_found" as const })),
    };
    const email = { kind: "fixture" as const, send: vi.fn(async () => undefined) };
    const limiter = {
      takeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      email,
      events,
      limiter,
      tokens: { next: () => "KIWI-VERIFY-000004" },
      ids: { next: () => "verification-artifact" },
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await expect(service.resendEmail("access", "email-2")).resolves.toMatchObject({
      status: "ok",
      email_verification: {
        email_id: "email-2",
        address: "new@example.test",
        fixture_code: "KIWI-VERIFY-000004",
      },
    });
    expect(emails.issueVerification).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "new@example.test", purpose: "verify_email" }),
    );
    expect(limiter.takeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "accountEmailResend", maximum: 3 }),
    );
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.email_verification_resent",
        outcome: "accepted",
      }),
    );
  });

  it("preserves a pending address when verification email delivery fails", async () => {
    const { store, events } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_found" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
      remove: vi.fn(async () => ({ kind: "not_found" as const })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      email: {
        kind: "configured",
        send: vi.fn(async () => {
          throw new Error("SMTP unavailable");
        }),
      },
      events,
      tokens: { next: () => "ABCD-2345" },
      ids: { next: () => "verification-artifact" },
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await expect(
      service.addEmail("access", { address: "new@example.test", kind: "personal" }),
    ).resolves.toMatchObject({
      status: "error",
      code: "service_unavailable",
      message: expect.stringMatching(/saved this pending address/i),
    });
    expect(emails.remove).not.toHaveBeenCalled();
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.email_added", outcome: "delivery_failed" }),
    );
  });

  it("rate limits additional-address verification attempts", async () => {
    const { store } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "already_yours" as const })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_found" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
      remove: vi.fn(async () => ({ kind: "not_found" as const })),
    };
    const limiter = {
      takeRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 120 })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      limiter,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await expect(
      service.verifyEmail("access", { email_id: "email-2", code: "ABCD-2345" }),
    ).resolves.toMatchObject({
      status: "error",
      code: "rate_limited",
      retry_after_seconds: 120,
    });
    expect(emails.consumeVerification).not.toHaveBeenCalled();
    expect(limiter.takeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "accountEmailVerify", maximum: 8 }),
    );
  });

  it("gives one refusal whether an address is taken or already on this account", async () => {
    const { store } = setup();
    const responses = ["claimed_elsewhere", "already_yours"] as const;
    for (const kind of responses) {
      const emails = {
        list: vi.fn(async () => []),
        add: vi.fn(async () => ({ kind })),
        issueVerification: vi.fn(async () => null),
        consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
        promote: vi.fn(async () => ({ kind: "not_found" as const })),
        setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
        remove: vi.fn(async () => ({ kind: "not_found" as const })),
      };
      const service = createAccountSettingsService({
        store,
        emails,
        clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
      });
      await expect(
        service.addEmail("access", { address: "taken@example.test", kind: "personal" }),
      ).resolves.toEqual({
        status: "error",
        code: "invalid_input",
        message: "That address cannot be added to this account.",
      });
    }
  });

  it("refuses to remove the primary address", async () => {
    const { store } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => null),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_found" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_found" as const })),
      remove: vi.fn(async () => ({ kind: "primary" as const })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(service.removeEmail("access", "email-1")).resolves.toEqual({
      status: "error",
      code: "invalid_input",
      message: "Make another address primary before removing this one.",
    });
  });

  it("refuses to make an unverified address primary", async () => {
    const { store } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => null),
      consumeVerification: vi.fn(async () => ({ kind: "invalid_code" as const })),
      promote: vi.fn(async () => ({ kind: "not_verified" as const })),
      setNotifications: vi.fn(async () => ({ kind: "not_verified" as const })),
      remove: vi.fn(async () => ({ kind: "removed" as const })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(service.promoteEmail("access", "email-2")).resolves.toMatchObject({
      status: "error",
      message: "Verify this address before making it primary.",
    });
    await expect(service.setNotificationEmail("access", "email-2")).resolves.toMatchObject({
      status: "error",
      message: "Verify this address before Kiwi sends notifications to it.",
    });
  });

  it("records successful additional-address lifecycle changes", async () => {
    const { store, events } = setup();
    const emails = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ kind: "added" as const, emailId: "email-2" })),
      issueVerification: vi.fn(async () => "new@example.test"),
      consumeVerification: vi.fn(async () => ({
        kind: "verified" as const,
        address: "new@example.test",
      })),
      promote: vi.fn(async () => ({
        kind: "promoted" as const,
        address: "new@example.test",
      })),
      setNotifications: vi.fn(async () => ({
        kind: "promoted" as const,
        address: "new@example.test",
      })),
      remove: vi.fn(async () => ({ kind: "removed" as const })),
    };
    const service = createAccountSettingsService({
      store,
      emails,
      events,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });

    await service.verifyEmail("access", { email_id: "email-2", code: "ABCD-2345" });
    await service.promoteEmail("access", "email-2");
    await service.setNotificationEmail("access", "email-2");
    await service.removeEmail("access", "email-3");

    for (const eventType of [
      "account.additional_email_verification",
      "account.primary_email_changed",
      "account.notification_email_changed",
      "account.email_removed",
    ]) {
      expect(events.recordSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType, outcome: "succeeded" }),
      );
    }
  });

  it("stores one delivery preference without requiring a recent sign-in", async () => {
    const { store, hasher } = setup(new Date("2026-08-22T10:00:00.000Z"));
    const service = createAccountSettingsService({
      store,
      hasher,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setNotificationPreference("access", { category: "product", email: true }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(store.setNotificationPreference).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        preference: { category: "product", email: true },
      }),
    );
  });

  it("refuses a delivery preference from an unauthorized session", async () => {
    const { store, hasher } = setup();
    const unauthorized: AccountSettingsStore = {
      ...store,
      authenticate: async (): Promise<AccountAccessContext | null> => null,
      reauthenticateSession: vi.fn(async () => false),
    };
    const service = createAccountSettingsService({
      store: unauthorized,
      hasher,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(
      service.setNotificationPreference("access", { category: "product", email: true }),
    ).resolves.toMatchObject({ status: "error", code: "forbidden" });
    expect(store.setNotificationPreference).not.toHaveBeenCalled();
  });
  it("returns the export document and records that it was taken", async () => {
    const { service, store, events } = setup();
    const result = await service.exportAccount("access");

    expect(result).toMatchObject({
      status: "ok",
      export: { format: "kiwi.account-export.v1", account: { id: "account-1" } },
    });
    expect(store.exportAccount).toHaveBeenCalled();
    expect(events.recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "account.data_exported" }),
    );
  });

  it("requires a recent sign-in before releasing the whole personal record", async () => {
    const { store, hasher } = setup(new Date("2026-08-22T10:00:00.000Z"));
    const service = createAccountSettingsService({
      store,
      hasher,
      clock: { now: () => new Date("2026-08-22T12:00:00.000Z") },
    });
    await expect(service.exportAccount("access")).resolves.toMatchObject({
      status: "error",
      code: "recent_auth_required",
    });
    expect(store.exportAccount).not.toHaveBeenCalled();
  });
  it("stores an avatar under the digest of the bytes it verified", async () => {
    const { service, store } = setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    await expect(
      service.setAvatar("access", { media_type: "image/png", data: png.toString("base64") }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(store.setAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        mediaType: "image/png",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("refuses bytes that do not match the media type they claim", async () => {
    const { service, store } = setup();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    await expect(
      service.setAvatar("access", { media_type: "image/png", data: jpeg.toString("base64") }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_input" });
    expect(store.setAvatar).not.toHaveBeenCalled();
  });

  it("refuses a file that is not an image Kiwi stores", async () => {
    const { service, store } = setup();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
    await expect(
      service.setAvatar("access", { media_type: "image/png", data: svg.toString("base64") }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_input" });
    expect(store.setAvatar).not.toHaveBeenCalled();
  });

  it("removes an avatar and returns the refreshed record", async () => {
    const { service, store } = setup();
    await expect(service.removeAvatar("access")).resolves.toMatchObject({ status: "ok" });
    expect(store.removeAvatar).toHaveBeenCalledWith("account-1");
  });
});
