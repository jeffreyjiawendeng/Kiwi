import { createHash, randomUUID } from "node:crypto";
import type {
  AccountAuthServiceResponse,
  Clock,
  EmailVerificationRequest,
  EmailVerificationResendRequest,
  IdGenerator,
  PasswordAccountCreateRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  PasswordSignInRequest,
} from "@kiwi/contracts";
import type { AccountAuthStore, StoredAccount } from "./auth-store.js";
import type { AuthTokenGenerator, EmailDeliveryAdapter } from "./auth-fixtures.js";
import type { PasswordHasher } from "./password.js";
import { validateNewPassword } from "./password.js";
import type { PasswordCompromiseChecker } from "./pwned-passwords.js";
import { issueDeviceSession } from "./session-service.js";
import { createSecureTokenGenerator, normalizeVerificationCode } from "./email-delivery.js";

const VERIFICATION_LIFETIME_MS = 30 * 60 * 1_000;
const RESET_LIFETIME_MS = 20 * 60 * 1_000;

const RATE_LIMITS = {
  create: { maximum: 5, windowMs: 15 * 60 * 1_000 },
  verify: { maximum: 8, windowMs: 15 * 60 * 1_000 },
  signIn: { maximum: 5, windowMs: 5 * 60 * 1_000 },
  requestReset: { maximum: 5, windowMs: 15 * 60 * 1_000 },
  resendVerification: { maximum: 3, windowMs: 15 * 60 * 1_000 },
  reset: { maximum: 8, windowMs: 15 * 60 * 1_000 },
} as const;

export interface PasswordAuthService {
  createAccount(request: PasswordAccountCreateRequest): Promise<AccountAuthServiceResponse>;
  verifyEmail(request: EmailVerificationRequest): Promise<AccountAuthServiceResponse>;
  resendEmailVerification(
    request: EmailVerificationResendRequest,
  ): Promise<AccountAuthServiceResponse>;
  signIn(request: PasswordSignInRequest): Promise<AccountAuthServiceResponse>;
  requestPasswordReset(request: PasswordResetRequest): Promise<AccountAuthServiceResponse>;
  resetPassword(request: PasswordResetConfirmRequest): Promise<AccountAuthServiceResponse>;
}

export interface PasswordAuthServiceOptions {
  store: AccountAuthStore;
  hasher: PasswordHasher;
  email: EmailDeliveryAdapter;
  tokens?: AuthTokenGenerator;
  clock?: Clock;
  ids?: IdGenerator;
  passwordChecker?: PasswordCompromiseChecker;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = { next: () => randomUUID() };
const secureTokens: AuthTokenGenerator = createSecureTokenGenerator();

function normalizeEmail(value: string): string | null {
  const email = value.trim().normalize("NFC").toLocaleLowerCase("en-US");
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return null;
  }
  return email;
}

function digest(value: string, purpose = "subject"): string {
  return createHash("sha256").update(`${purpose}\u0000${value}`, "utf8").digest("hex");
}

function error(
  code: Extract<AccountAuthServiceResponse, { status: "error" }>["code"],
  message: string,
  retryAfterSeconds?: number,
): AccountAuthServiceResponse {
  return retryAfterSeconds === undefined
    ? { status: "error", code, message }
    : { status: "error", code, message, retry_after_seconds: retryAfterSeconds };
}

export async function createPasswordAuthService(
  options: PasswordAuthServiceOptions,
): Promise<PasswordAuthService> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIds;
  const tokens = options.tokens ?? secureTokens;
  const dummy = await options.hasher.hash("kiwi timing verifier only");

  async function takeLimit(
    scope: keyof typeof RATE_LIMITS,
    email: string,
  ): Promise<AccountAuthServiceResponse | null> {
    const policy = RATE_LIMITS[scope];
    const limited = await options.store.takeRateLimit({
      scope,
      subjectHash: digest(email),
      maximum: policy.maximum,
      windowMs: policy.windowMs,
      now: clock.now(),
    });
    return limited.allowed
      ? null
      : error(
          "rate_limited",
          "Too many attempts. Wait before trying again.",
          limited.retryAfterSeconds,
        );
  }

  async function record(userId: string | null, eventType: string, outcome: string): Promise<void> {
    await options.store.recordSecurityEvent({
      id: ids.next(),
      userId,
      eventType,
      outcome,
      now: clock.now(),
    });
  }

  async function authenticated(
    account: StoredAccount,
    deviceName: string,
    eventType: string,
    deletionCancelled = false,
  ): Promise<AccountAuthServiceResponse> {
    const now = clock.now();
    const response = await issueDeviceSession({
      store: options.store,
      account,
      deviceName,
      now,
      ids,
      tokens,
    });
    await record(account.id, eventType, "succeeded");
    if (!deletionCancelled || response.status !== "authenticated") return response;
    await record(account.id, "account.deletion_cancelled", "succeeded");
    return { ...response, deletion_cancelled: true };
  }

  return {
    async createAccount(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      if (email === null) return error("invalid_input", "Enter a valid email address.");
      const limited = await takeLimit("create", email);
      if (limited !== null) return limited;
      const password = await validateNewPassword(request.password, email, options.passwordChecker);
      if (!password.accepted) return error("password_rejected", password.message);

      const storedPassword = await options.hasher.hash(password.password);
      const now = clock.now();
      const result = await options.store.createOrReadAccount({
        id: ids.next(),
        emailId: ids.next(),
        email,
        emailKind: request.email_kind,
        givenName: request.given_name,
        familyName: request.family_name,
        phone: request.phone,
        verifier: storedPassword.verifier,
        parameterVersion: storedPassword.parameterVersion,
        now,
      });
      const code = tokens.next("verify_email");
      const expiresAt = new Date(now.getTime() + VERIFICATION_LIFETIME_MS);
      let deliveryFailed = false;
      if (!result.account.verified) {
        await options.store.issueEmailVerification({
          id: ids.next(),
          userId: result.account.id,
          tokenHash: digest(normalizeVerificationCode(code), "verify_email"),
          expiresAt,
          now,
        });
        try {
          await options.email.send({ recipient: email, purpose: "verify_email", code, expiresAt });
        } catch {
          // The pending account and hashed code remain valid. Returning the same accepted
          // shape avoids account discovery and lets the verification surface offer resend.
          deliveryFailed = true;
        }
      }
      await record(
        result.account.id,
        "account.registration_requested",
        deliveryFailed ? "delivery_failed" : "accepted",
      );
      return options.email.kind === "fixture"
        ? { status: "accepted", next: "verify_email", fixture_code: code }
        : { status: "accepted", next: "verify_email" };
    },

    async verifyEmail(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      const subject = email ?? request.email.trim().toLocaleLowerCase("en-US").slice(0, 254);
      const limited = await takeLimit("verify", subject);
      if (limited !== null) return limited;
      const account =
        email === null
          ? null
          : await options.store.consumeEmailVerification({
              email,
              tokenHash: digest(normalizeVerificationCode(request.code), "verify_email"),
              now: clock.now(),
            });
      if (account === null) {
        await record(null, "account.email_verification", "rejected");
        return error(
          "invalid_or_expired_code",
          "That verification code is invalid or has expired.",
        );
      }
      return authenticated(account, request.device_name, "account.email_verification");
    },

    async resendEmailVerification(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      if (email === null) return error("invalid_input", "Enter a valid email address.");
      const limited = await takeLimit("resendVerification", email);
      if (limited !== null) return limited;
      const account = await options.store.findUnverifiedAccount(email);
      const now = clock.now();
      const code = tokens.next("verify_email");
      const expiresAt = new Date(now.getTime() + VERIFICATION_LIFETIME_MS);
      if (account !== null) {
        await options.store.issueEmailVerification({
          id: ids.next(),
          userId: account.id,
          tokenHash: digest(normalizeVerificationCode(code), "verify_email"),
          expiresAt,
          now,
        });
        try {
          await options.email.send({ recipient: email, purpose: "verify_email", code, expiresAt });
        } catch {
          await record(account.id, "account.email_verification_resent", "delivery_failed");
          return error(
            "service_unavailable",
            "Kiwi could not send a new code. Your account is unchanged. Try again.",
          );
        }
        await record(account.id, "account.email_verification_resent", "accepted");
      }
      return options.email.kind === "fixture" && account !== null
        ? { status: "accepted", next: "verify_email", fixture_code: code }
        : { status: "accepted", next: "verify_email" };
    },

    async signIn(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      const subject = email ?? request.email.trim().toLocaleLowerCase("en-US").slice(0, 254);
      const limited = await takeLimit("signIn", subject);
      if (limited !== null) return limited;
      const credential = email === null ? null : await options.store.findCredential(email);
      const matches = await options.hasher.verify(
        credential?.verifier ?? dummy.verifier,
        request.password,
      );
      if (credential === null || !matches) {
        await record(credential?.id ?? null, "account.password_sign_in", "rejected");
        return error("invalid_credentials", "The email or password is not correct.");
      }
      // A scheduled deletion is reversible until its window closes, and proving the
      // password inside that window is what reverses it.
      const restored =
        credential.status === "deleting" &&
        (await options.store.cancelRecoverableDeletion(credential.id, clock.now()));
      if (credential.status !== "active" && !restored) {
        await record(credential.id, "account.password_sign_in", "rejected");
        return error("invalid_credentials", "The email or password is not correct.");
      }
      if (!credential.verified) {
        await record(credential.id, "account.password_sign_in", "verification_required");
        return error("verification_required", "Verify your email before signing in.");
      }
      return authenticated(credential, request.device_name, "account.password_sign_in", restored);
    },

    async requestPasswordReset(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      if (email === null) return error("invalid_input", "Enter a valid email address.");
      const limited = await takeLimit("requestReset", email);
      if (limited !== null) return limited;
      const now = clock.now();
      const code = tokens.next("reset_password");
      const expiresAt = new Date(now.getTime() + RESET_LIFETIME_MS);
      const userId = await options.store.issuePasswordReset({
        id: ids.next(),
        email,
        tokenHash: digest(normalizeVerificationCode(code), "reset_password"),
        expiresAt,
        now,
      });
      let deliveryFailed = false;
      if (userId !== null) {
        try {
          await options.email.send({
            recipient: email,
            purpose: "reset_password",
            code,
            expiresAt,
          });
        } catch {
          // Recovery requests deliberately have the same public response for every address.
          // The private event still gives operators evidence of a mail outage.
          deliveryFailed = true;
        }
      }
      await record(
        userId,
        "account.password_reset_requested",
        deliveryFailed ? "delivery_failed" : "accepted",
      );
      return options.email.kind === "fixture"
        ? { status: "accepted", next: "check_email", fixture_code: code }
        : { status: "accepted", next: "check_email" };
    },

    async resetPassword(request): Promise<AccountAuthServiceResponse> {
      const email = normalizeEmail(request.email);
      const subject = email ?? request.email.trim().toLocaleLowerCase("en-US").slice(0, 254);
      const limited = await takeLimit("reset", subject);
      if (limited !== null) return limited;
      const password = await validateNewPassword(
        request.new_password,
        subject,
        options.passwordChecker,
      );
      if (!password.accepted) return error("password_rejected", password.message);
      const storedPassword = await options.hasher.hash(password.password);
      const account =
        email === null
          ? null
          : await options.store.consumePasswordReset({
              email,
              tokenHash: digest(normalizeVerificationCode(request.code), "reset_password"),
              verifier: storedPassword.verifier,
              parameterVersion: storedPassword.parameterVersion,
              now: clock.now(),
            });
      if (account === null) {
        await record(null, "account.password_reset", "rejected");
        return error("invalid_or_expired_code", "That reset code is invalid or has expired.");
      }
      await record(account.id, "account.password_reset", "succeeded");
      return { status: "password_reset" };
    },
  };
}
