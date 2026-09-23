import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  AccountEmailAddRequest,
  AccountEmailVerifyRequest,
  IdGenerator,
  AccountProfile,
  AccountExport,
  AccountSettingsResult,
  AvatarUpload,
  Clock,
  NotificationPreference,
  PasswordSetRequest,
  PasswordReauthenticationRequest,
  AccountAuthServiceResponse,
} from "@kiwi/contracts";
import { MAXIMUM_AVATAR_BYTES, readAvatarMediaType } from "@kiwi/contracts";
import type { AccountSettingsStore, StoredAvatar } from "./account-settings-store.js";
import type { AccountEmailsStore } from "./account-emails-store.js";
import type { EmailDeliveryAdapter, AuthTokenGenerator } from "./auth-fixtures.js";
import type { PasswordHasher } from "./password.js";
import { validateNewPassword } from "./password.js";
import type { PasswordCompromiseChecker } from "./pwned-passwords.js";
import { normalizeVerificationCode } from "./email-delivery.js";

export interface AuthenticatedAccount {
  accountId: string;
  sessionId: string;
  recentlyAuthenticated: boolean;
}

// Reusing the sign-in limiter keeps every password guess against one account counted in
// one place, whether it arrives at the sign-in screen or in Account Settings.
export interface AccountRateLimiter {
  takeRateLimit(input: {
    scope: string;
    subjectHash: string;
    maximum: number;
    windowMs: number;
    now: Date;
  }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface AccountSecurityRecorder {
  recordSecurityEvent(input: {
    id: string;
    userId: string | null;
    eventType: string;
    outcome: string;
    now: Date;
  }): Promise<void>;
}

const PASSWORD_ATTEMPT_LIMIT = { maximum: 5, windowMs: 15 * 60 * 1_000 } as const;

const RECENT_AUTH_MS = 10 * 60 * 1_000;
const DELETION_RECOVERY_MS = 30 * 24 * 60 * 60 * 1_000;
const systemClock: Clock = { now: () => new Date() };

function digestAccess(value: string): string {
  return createHash("sha256").update(`access_token\u0000${value}`, "utf8").digest("hex");
}

export interface AccountSettingsService {
  authenticatedAccountId(accessToken: string): Promise<AuthenticatedAccount | null>;
  reauthenticatePassword(
    accessToken: string,
    request: PasswordReauthenticationRequest,
  ): Promise<AccountAuthServiceResponse>;
  snapshot(accessToken: string): Promise<AccountSettingsResult>;
  updateProfile(accessToken: string, profile: AccountProfile): Promise<AccountSettingsResult>;
  revokeSession(accessToken: string, sessionId: string): Promise<AccountSettingsResult>;
  revokeOtherSessions(accessToken: string): Promise<AccountSettingsResult>;
  requestDeletion(accessToken: string): Promise<AccountSettingsResult>;
  setPassword(accessToken: string, request: PasswordSetRequest): Promise<AccountSettingsResult>;
  removePassword(accessToken: string): Promise<AccountSettingsResult>;
  addEmail(accessToken: string, request: AccountEmailAddRequest): Promise<AccountSettingsResult>;
  verifyEmail(
    accessToken: string,
    request: AccountEmailVerifyRequest,
  ): Promise<AccountSettingsResult>;
  resendEmail(accessToken: string, emailId: string): Promise<AccountSettingsResult>;
  promoteEmail(accessToken: string, emailId: string): Promise<AccountSettingsResult>;
  setNotificationEmail(accessToken: string, emailId: string): Promise<AccountSettingsResult>;
  removeEmail(accessToken: string, emailId: string): Promise<AccountSettingsResult>;
  setNotificationPreference(
    accessToken: string,
    preference: NotificationPreference,
  ): Promise<AccountSettingsResult>;
  exportAccount(
    accessToken: string,
  ): Promise<{ status: "ok"; export: AccountExport } | AccountSettingsResult>;
  setAvatar(accessToken: string, upload: AvatarUpload): Promise<AccountSettingsResult>;
  removeAvatar(accessToken: string): Promise<AccountSettingsResult>;
  readAvatar(
    accessToken: string,
  ): Promise<{ status: "ok"; avatar: StoredAvatar | null } | AccountSettingsResult>;
}

export function createAccountSettingsService(options: {
  store: AccountSettingsStore;
  emails?: AccountEmailsStore;
  email?: EmailDeliveryAdapter;
  tokens?: AuthTokenGenerator;
  ids?: IdGenerator;
  clock?: Clock;
  hasher?: PasswordHasher;
  limiter?: AccountRateLimiter;
  events?: AccountSecurityRecorder;
  passwordChecker?: PasswordCompromiseChecker;
}): AccountSettingsService {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? { next: (): string => randomUUID() };
  const EMAIL_VERIFICATION_MS = 30 * 60 * 1_000;
  const EMAIL_SEND_LIMIT = { maximum: 5, windowMs: 15 * 60 * 1_000 } as const;
  const EMAIL_RESEND_LIMIT = { maximum: 3, windowMs: 15 * 60 * 1_000 } as const;
  const EMAIL_VERIFY_LIMIT = { maximum: 8, windowMs: 15 * 60 * 1_000 } as const;

  async function authorize(accessToken: string) {
    return options.store.authenticate(digestAccess(accessToken), clock.now());
  }

  const forbidden = (): AccountSettingsResult => ({
    status: "error",
    code: "forbidden",
    message: "Your session is no longer authorized. Sign in again.",
  });
  const recentRequired = (): AccountSettingsResult => ({
    status: "error",
    code: "recent_auth_required",
    message: "Sign in again before changing account security.",
  });
  const passwordUnavailable = (): AccountSettingsResult => ({
    status: "error",
    code: "service_unavailable",
    message: "Password changes are unavailable. Try again.",
  });

  async function record(accountId: string, eventType: string, outcome: string): Promise<void> {
    await options.events?.recordSecurityEvent({
      id: ids.next(),
      userId: accountId,
      eventType,
      outcome,
      now: clock.now(),
    });
  }

  const emailsUnavailable = (): AccountSettingsResult => ({
    status: "error",
    code: "service_unavailable",
    message: "Email addresses are unavailable. Try again.",
  });

  // Adding, promoting, or removing an address changes where account recovery can be
  // proved, so each one needs a recent sign-in.
  async function emailContext(accessToken: string) {
    if (options.emails === undefined) return "unavailable" as const;
    const context = await authorize(accessToken);
    if (context === null) return "forbidden" as const;
    return clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS
      ? ("recent_required" as const)
      : context;
  }

  function emailGuard(
    context: Awaited<ReturnType<typeof emailContext>>,
  ): AccountSettingsResult | null {
    if (context === "unavailable") return emailsUnavailable();
    if (context === "forbidden") return forbidden();
    if (context === "recent_required") return recentRequired();
    return null;
  }

  async function takeEmailLimit(
    scope: string,
    subject: string,
    policy: { maximum: number; windowMs: number },
  ): Promise<AccountSettingsResult | null> {
    const result = await options.limiter?.takeRateLimit({
      scope,
      subjectHash: digestAccess(`${scope}\u0000${subject}`),
      maximum: policy.maximum,
      windowMs: policy.windowMs,
      now: clock.now(),
    });
    return result === undefined || result.allowed
      ? null
      : {
          status: "error",
          code: "rate_limited",
          message: "Too many attempts. Wait before trying again.",
          retry_after_seconds: result.retryAfterSeconds,
        };
  }

  return {
    async authenticatedAccountId(accessToken): Promise<AuthenticatedAccount | null> {
      const context = await authorize(accessToken);
      return context === null
        ? null
        : {
            accountId: context.accountId,
            sessionId: context.sessionId,
            recentlyAuthenticated:
              clock.now().getTime() - context.lastAuthenticatedAt.getTime() <= RECENT_AUTH_MS,
          };
    },

    async reauthenticatePassword(accessToken, request): Promise<AccountAuthServiceResponse> {
      const hasher = options.hasher;
      if (hasher === undefined) {
        return {
          status: "error",
          code: "service_unavailable",
          message: "Password confirmation is unavailable. Try another sign-in method.",
        };
      }
      const context = await authorize(accessToken);
      if (context === null) {
        return {
          status: "error",
          code: "session_expired",
          message: "Your session is no longer authorized. Sign in again.",
        };
      }
      const limited = await options.limiter?.takeRateLimit({
        scope: "passwordReauthenticate",
        subjectHash: digestAccess(`password_reauthenticate\u0000${context.accountId}`),
        maximum: PASSWORD_ATTEMPT_LIMIT.maximum,
        windowMs: PASSWORD_ATTEMPT_LIMIT.windowMs,
        now: clock.now(),
      });
      if (limited !== undefined && !limited.allowed) {
        return {
          status: "error",
          code: "rate_limited",
          message: "Too many attempts. Wait before trying again.",
          retry_after_seconds: limited.retryAfterSeconds,
        };
      }
      const credential = await options.store.passwordCredential(context.accountId);
      if (credential === null) {
        return {
          status: "error",
          code: "invalid_input",
          message: "This account does not use a password. Confirm with a connected sign-in method.",
        };
      }
      if (!(await hasher.verify(credential.verifier, request.password))) {
        await record(context.accountId, "account.password_reauthentication", "rejected");
        return {
          status: "error",
          code: "invalid_credentials",
          message: "The password is not correct.",
        };
      }
      const now = clock.now();
      if (!(await options.store.reauthenticateSession(context.accountId, context.sessionId, now))) {
        return {
          status: "error",
          code: "session_expired",
          message: "Your session is no longer authorized. Sign in again.",
        };
      }
      await record(context.accountId, "account.password_reauthentication", "succeeded");
      return { status: "reauthenticated", provider: "password" };
    },

    async snapshot(accessToken): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      return context === null
        ? forbidden()
        : { status: "ok", settings: await options.store.snapshot(context) };
    },

    async updateProfile(accessToken, profile): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      await options.store.updateProfile(context.accountId, profile, clock.now());
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async revokeSession(accessToken, sessionId): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      if (clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      const revoked = await options.store.revokeSession(
        context.accountId,
        context.sessionId,
        sessionId,
        clock.now(),
      );
      if (revoked) await record(context.accountId, "account.session_revoked", "succeeded");
      return revoked
        ? { status: "session_revoked" }
        : {
            status: "error",
            code: "invalid_input",
            message: "That session cannot be revoked from this control.",
          };
    },

    async revokeOtherSessions(accessToken): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      if (clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      await options.store.revokeOtherSessions(context.accountId, context.sessionId, clock.now());
      await record(context.accountId, "account.other_sessions_revoked", "succeeded");
      return { status: "session_revoked" };
    },

    async addEmail(accessToken, request): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      if (emails === undefined) return emailsUnavailable();

      const limited = await takeEmailLimit(
        "accountEmailAdd",
        `${context.accountId}\u0000${request.address}`,
        EMAIL_SEND_LIMIT,
      );
      if (limited !== null) return limited;

      const now = clock.now();
      const added = await emails.add({
        id: ids.next(),
        userId: context.accountId,
        address: request.address,
        kind: request.kind,
        now,
      });
      if (added.kind === "limit_reached") {
        await record(context.accountId, "account.email_added", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "This account already holds the maximum number of addresses.",
        };
      }
      // A claimed address and an address already on this account return the same refusal,
      // so adding one cannot be used to discover where an address is registered.
      if (added.kind !== "added") {
        await record(context.accountId, "account.email_added", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "That address cannot be added to this account.",
        };
      }

      const code = options.tokens?.next("verify_email") ?? null;
      if (code !== null) {
        await emails.issueVerification({
          id: ids.next(),
          emailId: added.emailId,
          userId: context.accountId,
          tokenHash: digestAccess(`email_verify\u0000${normalizeVerificationCode(code)}`),
          expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_MS),
          now,
        });
        try {
          await options.email?.send({
            recipient: request.address,
            purpose: "verify_email",
            code,
            expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_MS),
          });
        } catch {
          await record(context.accountId, "account.email_added", "delivery_failed");
          return {
            status: "error",
            code: "service_unavailable",
            message:
              "Kiwi saved this pending address but could not send its code. Use Send a new code to try again.",
          };
        }
      }
      await record(context.accountId, "account.email_added", "accepted");
      return {
        status: "ok",
        settings: await options.store.snapshot(context),
        email_verification: {
          email_id: added.emailId,
          address: request.address,
          ...(options.email?.kind === "fixture" && code !== null ? { fixture_code: code } : {}),
        },
      };
    },

    async verifyEmail(accessToken, request): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      if (emails === undefined) return emailsUnavailable();

      const limited = await takeEmailLimit(
        "accountEmailVerify",
        `${context.accountId}\u0000${request.email_id}`,
        EMAIL_VERIFY_LIMIT,
      );
      if (limited !== null) return limited;

      const consumed = await emails.consumeVerification({
        emailId: request.email_id,
        userId: context.accountId,
        tokenHash: digestAccess(`email_verify\u0000${normalizeVerificationCode(request.code)}`),
        now: clock.now(),
      });
      if (consumed.kind === "claimed_elsewhere") {
        await record(context.accountId, "account.additional_email_verification", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "That address is already verified on another account.",
        };
      }
      if (consumed.kind !== "verified") {
        await record(context.accountId, "account.additional_email_verification", "rejected");
        return {
          status: "error",
          code: "invalid_or_expired_code",
          message: "That verification code is invalid or has expired.",
        };
      }
      await record(context.accountId, "account.additional_email_verification", "succeeded");
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async resendEmail(accessToken, emailId): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      const delivery = options.email;
      const code = options.tokens?.next("verify_email") ?? null;
      if (emails === undefined || delivery === undefined || code === null) {
        return emailsUnavailable();
      }
      const limited = await takeEmailLimit(
        "accountEmailResend",
        `${context.accountId}\u0000${emailId}`,
        EMAIL_RESEND_LIMIT,
      );
      if (limited !== null) return limited;
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_MS);
      const address = await emails.issueVerification({
        id: ids.next(),
        emailId,
        userId: context.accountId,
        tokenHash: digestAccess(`email_verify\u0000${normalizeVerificationCode(code)}`),
        expiresAt,
        now,
      });
      if (address === null) {
        return {
          status: "error",
          code: "invalid_input",
          message: "That pending address was not found.",
        };
      }
      try {
        await delivery.send({ recipient: address, purpose: "verify_email", code, expiresAt });
      } catch {
        await record(context.accountId, "account.email_verification_resent", "delivery_failed");
        return {
          status: "error",
          code: "service_unavailable",
          message: "Kiwi could not send a new code. The pending address is unchanged. Try again.",
        };
      }
      await record(context.accountId, "account.email_verification_resent", "accepted");
      return {
        status: "ok",
        settings: await options.store.snapshot(context),
        email_verification: {
          email_id: emailId,
          address,
          ...(delivery.kind === "fixture" ? { fixture_code: code } : {}),
        },
      };
    },

    async promoteEmail(accessToken, emailId): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      if (emails === undefined) return emailsUnavailable();

      const promoted = await emails.promote({
        emailId,
        userId: context.accountId,
        now: clock.now(),
      });
      if (promoted.kind === "not_verified") {
        await record(context.accountId, "account.primary_email_changed", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "Verify this address before making it primary.",
        };
      }
      if (promoted.kind === "not_found") {
        await record(context.accountId, "account.primary_email_changed", "rejected");
        return { status: "error", code: "invalid_input", message: "That address was not found." };
      }
      await record(context.accountId, "account.primary_email_changed", "succeeded");
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async setNotificationEmail(accessToken, emailId): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      if (emails === undefined) return emailsUnavailable();

      const updated = await emails.setNotifications({ emailId, userId: context.accountId });
      if (updated.kind === "not_verified") {
        await record(context.accountId, "account.notification_email_changed", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "Verify this address before Kiwi sends notifications to it.",
        };
      }
      if (updated.kind === "not_found") {
        await record(context.accountId, "account.notification_email_changed", "rejected");
        return { status: "error", code: "invalid_input", message: "That address was not found." };
      }
      await record(context.accountId, "account.notification_email_changed", "succeeded");
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async removeEmail(accessToken, emailId): Promise<AccountSettingsResult> {
      const context = await emailContext(accessToken);
      const refused = emailGuard(context);
      if (refused !== null || typeof context === "string") return refused ?? emailsUnavailable();
      const emails = options.emails;
      if (emails === undefined) return emailsUnavailable();

      const removed = await emails.remove({ emailId, userId: context.accountId });
      if (removed.kind === "primary") {
        await record(context.accountId, "account.email_removed", "rejected");
        return {
          status: "error",
          code: "invalid_input",
          message: "Make another address primary before removing this one.",
        };
      }
      if (removed.kind === "not_found") {
        await record(context.accountId, "account.email_removed", "rejected");
        return { status: "error", code: "invalid_input", message: "That address was not found." };
      }
      await record(context.accountId, "account.email_removed", "succeeded");
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    // An avatar is decoration, so it needs a session but not a recent sign-in. The
    // declared media type is a claim: the stored type comes from the bytes themselves.
    async setAvatar(accessToken, upload): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      const bytes = Buffer.from(upload.data, "base64");
      const mediaType = readAvatarMediaType(bytes);
      if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_AVATAR_BYTES) {
        return {
          status: "error",
          code: "invalid_input",
          message: "Choose a PNG, JPEG, or WebP image under 512 KB.",
        };
      }
      if (mediaType === null || mediaType !== upload.media_type) {
        return {
          status: "error",
          code: "invalid_input",
          message: "That file is not a PNG, JPEG, or WebP image.",
        };
      }
      await options.store.setAvatar({
        accountId: context.accountId,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        mediaType,
        bytes,
        now: clock.now(),
      });
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async removeAvatar(accessToken): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      await options.store.removeAvatar(context.accountId);
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async readAvatar(
      accessToken,
    ): Promise<{ status: "ok"; avatar: StoredAvatar | null } | AccountSettingsResult> {
      const context = await authorize(accessToken);
      return context === null
        ? forbidden()
        : { status: "ok", avatar: await options.store.readAvatar(context.accountId) };
    },

    // An export is the whole personal record in one file, so it is gated like a security
    // change rather than like a read.
    async exportAccount(
      accessToken,
    ): Promise<{ status: "ok"; export: AccountExport } | AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      if (clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      const exported = await options.store.exportAccount(context, clock.now());
      await record(context.accountId, "account.data_exported", "succeeded");
      return { status: "ok", export: exported };
    },

    // Delivery preferences carry no security weight, so they need a session but not a
    // recent sign-in. Security correspondence is never a preference and cannot be changed.
    async setNotificationPreference(accessToken, preference): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      await options.store.setNotificationPreference({
        accountId: context.accountId,
        preference,
        now: clock.now(),
      });
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    // Changing a password proves the current one. Creating the first password proves a
    // recent sign-in instead, which is how an account made through Google or ORCID adds
    // password sign-in without an emailed code.
    async setPassword(accessToken, request): Promise<AccountSettingsResult> {
      const hasher = options.hasher;
      if (hasher === undefined) return passwordUnavailable();
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      if (clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      const email = await options.store.primaryEmail(context.accountId);
      if (email === null) return forbidden();
      const existing = await options.store.passwordCredential(context.accountId);

      if (existing === null) {
        if (request.current_password !== null) {
          return {
            status: "error",
            code: "invalid_input",
            message: "This account has no password to replace.",
          };
        }
      } else {
        if (request.current_password === null) {
          return {
            status: "error",
            code: "invalid_input",
            message: "Enter the current password.",
          };
        }
        const limited = await options.limiter?.takeRateLimit({
          scope: "passwordSet",
          subjectHash: digestAccess(`password_set\u0000${context.accountId}`),
          maximum: PASSWORD_ATTEMPT_LIMIT.maximum,
          windowMs: PASSWORD_ATTEMPT_LIMIT.windowMs,
          now: clock.now(),
        });
        if (limited !== undefined && !limited.allowed) {
          return {
            status: "error",
            code: "rate_limited",
            message: "Too many attempts. Wait before trying again.",
          };
        }
        if (!(await hasher.verify(existing.verifier, request.current_password))) {
          await record(context.accountId, "account.password_change", "rejected");
          return {
            status: "error",
            code: "invalid_credentials",
            message: "The current password is not correct.",
          };
        }
      }

      const policy = await validateNewPassword(
        request.new_password,
        email,
        options.passwordChecker,
      );
      if (!policy.accepted) {
        return { status: "error", code: "password_rejected", message: policy.message };
      }
      const hashed = await hasher.hash(policy.password);
      await options.store.setPassword({
        accountId: context.accountId,
        verifier: hashed.verifier,
        parameterVersion: hashed.parameterVersion,
        currentSessionId: context.sessionId,
        now: clock.now(),
      });
      await record(
        context.accountId,
        existing === null ? "account.password_created" : "account.password_change",
        "succeeded",
      );
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async removePassword(accessToken): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      if (clock.now().getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      const removed = await options.store.removePassword({ accountId: context.accountId });
      if (removed.kind === "last_method") {
        return {
          status: "error",
          code: "invalid_input",
          message: "At least one authentication method must remain configured.",
        };
      }
      if (removed.kind === "not_set") {
        return {
          status: "error",
          code: "invalid_input",
          message: "This account has no password to remove.",
        };
      }
      await record(context.accountId, "account.password_removed", "succeeded");
      return { status: "ok", settings: await options.store.snapshot(context) };
    },

    async requestDeletion(accessToken): Promise<AccountSettingsResult> {
      const context = await authorize(accessToken);
      if (context === null) return forbidden();
      const now = clock.now();
      if (now.getTime() - context.lastAuthenticatedAt.getTime() > RECENT_AUTH_MS) {
        return recentRequired();
      }
      const recoverUntil = new Date(now.getTime() + DELETION_RECOVERY_MS);
      const requested = await options.store.requestDeletion(context.accountId, now, recoverUntil);
      if (requested.kind === "ownership_required") {
        const names = requested.workspaces.join(", ");
        return {
          status: "error",
          code: "invalid_input",
          message: `Transfer ownership of these workspaces before deleting your account: ${names}.`,
        };
      }
      await record(context.accountId, "account.deletion_requested", "succeeded");
      return { status: "deletion_requested", recover_until: recoverUntil.toISOString() };
    },
  };
}
