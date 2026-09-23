import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Clock, IdGenerator } from "@kiwi/contracts";
import type {
  AccountAuthStore,
  AccountCreationResult,
  RateLimitResult,
  StoredAccount,
  StoredCredential,
} from "./auth-store.js";
import {
  FixtureAuthTokenGenerator,
  FixtureEmailDelivery,
  type EmailDeliveryAdapter,
} from "./auth-fixtures.js";
import { createPasswordAuthService } from "./auth-service.js";
import type { PasswordHasher } from "./password.js";
import type { PasswordCompromiseChecker } from "./pwned-passwords.js";

const EMAIL = "reader@example.test";
const PASSWORD = "a long orchard password";
const PROFILE = {
  given_name: "Kiwi",
  family_name: "Reader",
  phone: "+14155550134",
} as const;
const ACCOUNT_DETAILS = { ...PROFILE, email_kind: "institutional" as const };

class MutableClock implements Clock {
  constructor(private time = new Date("2026-08-22T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(milliseconds: number): void {
    this.time = new Date(this.time.getTime() + milliseconds);
  }
}

class SequenceIds implements IdGenerator {
  private value = 0;
  next(): string {
    this.value += 1;
    return `00000000-0000-4000-8000-${String(this.value).padStart(12, "0")}`;
  }
}

const fakeHasher: PasswordHasher = {
  async hash(password) {
    return {
      verifier: `test:${createHash("sha256").update(password).digest("hex")}`,
      parameterVersion: 1,
    };
  },
  async verify(verifier, password) {
    return (
      verifier === `test:${createHash("sha256").update(password.normalize("NFC")).digest("hex")}`
    );
  },
};

interface Artifact {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumed: boolean;
}

class MemoryAuthStore implements AccountAuthStore {
  readonly credentials = new Map<string, StoredCredential>();
  readonly verifications: Artifact[] = [];
  readonly resets: Artifact[] = [];
  readonly sessions: Array<{ userId: string; revoked: boolean }> = [];
  readonly rates = new Map<string, { started: Date; count: number }>();
  readonly recoverableDeletions = new Set<string>();
  lastCreatedProfile: { given_name: string; family_name: string; phone: string } | null = null;
  lastCreatedEmailKind: "personal" | "institutional" | null = null;

  async createOrReadAccount(input: {
    id: string;
    emailId: string;
    email: string;
    emailKind: "personal" | "institutional";
    givenName: string;
    familyName: string;
    phone: string;
    verifier: string;
    parameterVersion: number;
    now: Date;
  }): Promise<AccountCreationResult> {
    const existing = this.credentials.get(input.email);
    if (existing !== undefined) return { account: existing, created: false };
    this.lastCreatedProfile = {
      given_name: input.givenName,
      family_name: input.familyName,
      phone: input.phone,
    };
    this.lastCreatedEmailKind = input.emailKind;
    const account: StoredCredential = {
      id: input.id,
      email: input.email,
      verified: false,
      status: "active",
      verifier: input.verifier,
      parameterVersion: input.parameterVersion,
    };
    this.credentials.set(input.email, account);
    return { account, created: true };
  }

  async findCredential(email: string): Promise<StoredCredential | null> {
    return this.credentials.get(email) ?? null;
  }

  async findUnverifiedAccount(email: string): Promise<StoredAccount | null> {
    const account = this.credentials.get(email);
    return account !== undefined && !account.verified && account.status === "active"
      ? account
      : null;
  }

  async issueEmailVerification(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    for (const item of this.verifications) {
      if (item.userId === input.userId && !item.consumed) item.consumed = true;
    }
    this.verifications.push({ ...input, consumed: false });
  }

  async consumeEmailVerification(input: {
    email: string;
    tokenHash: string;
    now: Date;
  }): Promise<StoredAccount | null> {
    const account = this.credentials.get(input.email);
    const artifact = this.verifications.find(
      (item) =>
        item.userId === account?.id &&
        item.tokenHash === input.tokenHash &&
        !item.consumed &&
        item.expiresAt > input.now,
    );
    if (account === undefined || artifact === undefined) return null;
    artifact.consumed = true;
    account.verified = true;
    return account;
  }

  async issuePasswordReset(input: {
    id: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string | null> {
    const account = this.credentials.get(input.email);
    if (account === undefined || !account.verified || account.status !== "active") return null;
    for (const item of this.resets) {
      if (item.userId === account.id && !item.consumed) item.consumed = true;
    }
    this.resets.push({
      userId: account.id,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      consumed: false,
    });
    return account.id;
  }

  async consumePasswordReset(input: {
    email: string;
    tokenHash: string;
    verifier: string;
    parameterVersion: number;
    now: Date;
  }): Promise<StoredAccount | null> {
    const account = this.credentials.get(input.email);
    const artifact = this.resets.find(
      (item) =>
        item.userId === account?.id &&
        item.tokenHash === input.tokenHash &&
        !item.consumed &&
        item.expiresAt > input.now,
    );
    if (account === undefined || artifact === undefined) return null;
    artifact.consumed = true;
    account.verifier = input.verifier;
    account.parameterVersion = input.parameterVersion;
    for (const session of this.sessions) {
      if (session.userId === account.id) session.revoked = true;
    }
    return account;
  }

  async createSession(input: { userId: string }): Promise<void> {
    this.sessions.push({ userId: input.userId, revoked: false });
  }

  async rotateSession(): Promise<{ kind: "invalid" }> {
    return { kind: "invalid" };
  }

  async revokeSession(): Promise<boolean> {
    return false;
  }

  async takeRateLimit(input: {
    scope: string;
    subjectHash: string;
    maximum: number;
    windowMs: number;
    now: Date;
  }): Promise<RateLimitResult> {
    const key = `${input.scope}:${input.subjectHash}`;
    const previous = this.rates.get(key);
    const current =
      previous === undefined || previous.started.getTime() + input.windowMs <= input.now.getTime()
        ? { started: input.now, count: 1 }
        : { started: previous.started, count: previous.count + 1 };
    this.rates.set(key, current);
    return {
      allowed: current.count <= input.maximum,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.started.getTime() + input.windowMs - input.now.getTime()) / 1_000),
      ),
    };
  }

  async recordSecurityEvent(): Promise<void> {}

  async cancelRecoverableDeletion(userId: string): Promise<boolean> {
    if (!this.recoverableDeletions.has(userId)) return false;
    this.recoverableDeletions.delete(userId);
    for (const account of this.credentials.values()) {
      if (account.id === userId) account.status = "active";
    }
    return true;
  }
}

async function setup(
  passwordChecker?: PasswordCompromiseChecker,
  email: EmailDeliveryAdapter = new FixtureEmailDelivery(),
) {
  const store = new MemoryAuthStore();
  const clock = new MutableClock();
  const service = await createPasswordAuthService({
    store,
    email,
    clock,
    ids: new SequenceIds(),
    tokens: new FixtureAuthTokenGenerator(),
    hasher: fakeHasher,
    ...(passwordChecker === undefined ? {} : { passwordChecker }),
  });
  return { service, store, email, clock };
}

async function createAndVerify() {
  const state = await setup();
  const created = await state.service.createAccount({
    email: EMAIL,
    password: PASSWORD,
    ...ACCOUNT_DETAILS,
  });
  if (created.status !== "accepted" || created.fixture_code === undefined) {
    throw new Error("Expected fixture verification code.");
  }
  const verified = await state.service.verifyEmail({
    email: EMAIL,
    code: created.fixture_code,
    device_name: "Test device",
  });
  return { ...state, verified };
}

describe("password account service", () => {
  it("rejects a breached password before creating an account", async () => {
    const { service, store } = await setup({ check: async () => "compromised" });
    await expect(
      service.createAccount({ email: EMAIL, password: PASSWORD, ...ACCOUNT_DETAILS }),
    ).resolves.toMatchObject({ status: "error", code: "password_rejected" });
    expect(store.credentials).toHaveLength(0);
  });

  it("creates an unverified account without retaining the plaintext password", async () => {
    const { service, store, email } = await setup();
    const result = await service.createAccount({
      email: " Reader@Example.Test ",
      password: PASSWORD,
      ...ACCOUNT_DETAILS,
    });

    expect(result).toEqual({
      status: "accepted",
      next: "verify_email",
      fixture_code: "KIWI-VERIFY-000001",
    });
    expect(store.credentials.get(EMAIL)?.verifier).not.toContain(PASSWORD);
    expect(store.lastCreatedProfile).toEqual(PROFILE);
    expect(store.lastCreatedEmailKind).toBe("institutional");
    if (!(email instanceof FixtureEmailDelivery)) throw new Error("Expected fixture delivery.");
    expect(email.deliveries).toMatchObject([{ recipient: EMAIL, purpose: "verify_email" }]);
  });

  it("keeps a pending account recoverable when initial email delivery fails", async () => {
    const delivery: EmailDeliveryAdapter = {
      kind: "configured",
      send: async () => {
        throw new Error("mail transport unavailable");
      },
    };
    const { service, store } = await setup(undefined, delivery);

    await expect(
      service.createAccount({ email: EMAIL, password: PASSWORD, ...ACCOUNT_DETAILS }),
    ).resolves.toEqual({ status: "accepted", next: "verify_email" });
    expect(store.credentials.get(EMAIL)?.verified).toBe(false);
    expect(store.verifications).toHaveLength(1);
  });

  it("consumes verification once and creates a memory-only access session", async () => {
    const { service, store, verified } = await createAndVerify();
    expect(verified).toMatchObject({
      status: "authenticated",
      account: { email: EMAIL, email_verified: true },
    });
    if (verified.status !== "authenticated") throw new Error("Verification did not authenticate.");
    expect(verified.access_token).toMatch(/^kiwi_access_[A-Za-z0-9_-]{43}$/u);
    expect(store.sessions).toHaveLength(1);

    const replay = await service.verifyEmail({
      email: EMAIL,
      code: "KIWI-VERIFY-000001",
      device_name: "Test device",
    });
    expect(replay).toMatchObject({ status: "error", code: "invalid_or_expired_code" });
  });

  it("replaces an unconsumed verification code when the user requests another", async () => {
    const { service } = await setup();
    const created = await service.createAccount({
      email: EMAIL,
      password: PASSWORD,
      ...ACCOUNT_DETAILS,
    });
    const resent = await service.resendEmailVerification({ email: EMAIL });
    if (
      created.status !== "accepted" ||
      created.fixture_code === undefined ||
      resent.status !== "accepted" ||
      resent.fixture_code === undefined
    ) {
      throw new Error("Expected fixture verification codes.");
    }

    await expect(
      service.verifyEmail({
        email: EMAIL,
        code: created.fixture_code,
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_or_expired_code" });
    await expect(
      service.verifyEmail({
        email: EMAIL,
        code: resent.fixture_code,
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
  });

  it("rate limits verification-code resends", async () => {
    const { service } = await setup();
    await service.createAccount({ email: EMAIL, password: PASSWORD, ...ACCOUNT_DETAILS });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.resendEmailVerification({ email: EMAIL });
    }
    await expect(service.resendEmailVerification({ email: EMAIL })).resolves.toMatchObject({
      status: "error",
      code: "rate_limited",
      retry_after_seconds: 900,
    });
  });

  it("returns the same sign-in error for an unknown email and a wrong password", async () => {
    const { service } = await createAndVerify();
    const wrong = await service.signIn({
      email: EMAIL,
      password: "a wrong orchard password",
      device_name: "Test device",
    });
    const missing = await service.signIn({
      email: "missing@example.test",
      password: "a wrong orchard password",
      device_name: "Test device",
    });
    expect(wrong).toEqual(missing);
    expect(wrong).toEqual({
      status: "error",
      code: "invalid_credentials",
      message: "The email or password is not correct.",
    });
  });

  it("signs in only after verification", async () => {
    const { service } = await setup();
    await service.createAccount({ email: EMAIL, password: PASSWORD, ...ACCOUNT_DETAILS });
    await expect(
      service.signIn({ email: EMAIL, password: PASSWORD, device_name: "Test device" }),
    ).resolves.toMatchObject({ status: "error", code: "verification_required" });

    const verified = await createAndVerify();
    await expect(
      verified.service.signIn({
        email: EMAIL,
        password: PASSWORD,
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "authenticated", account: { email: EMAIL } });
  });

  it("expires verification codes", async () => {
    const { service, clock } = await setup();
    const created = await service.createAccount({
      email: EMAIL,
      password: PASSWORD,
      ...ACCOUNT_DETAILS,
    });
    if (created.status !== "accepted" || created.fixture_code === undefined)
      throw new Error("code");
    clock.advance(31 * 60 * 1_000);
    await expect(
      service.verifyEmail({
        email: EMAIL,
        code: created.fixture_code,
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_or_expired_code" });
  });

  it("rate limits repeated sign-in attempts without changing the error shape by account", async () => {
    const { service } = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.signIn({
        email: "limited@example.test",
        password: "a wrong orchard password",
        device_name: "Test device",
      });
    }
    await expect(
      service.signIn({
        email: "limited@example.test",
        password: "a wrong orchard password",
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({
      status: "error",
      code: "rate_limited",
      retry_after_seconds: 300,
    });
  });

  it("resets the password once and revokes existing sessions", async () => {
    const { service, store } = await createAndVerify();
    const requested = await service.requestPasswordReset({ email: EMAIL });
    if (requested.status !== "accepted" || requested.fixture_code === undefined) {
      throw new Error("Expected reset fixture code.");
    }
    const reset = await service.resetPassword({
      email: EMAIL,
      code: requested.fixture_code,
      new_password: "a different orchard password",
    });
    expect(reset).toEqual({ status: "password_reset" });
    expect(store.sessions.every((session) => session.revoked)).toBe(true);

    await expect(
      service.resetPassword({
        email: EMAIL,
        code: requested.fixture_code,
        new_password: "another different password",
      }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_or_expired_code" });
    await expect(
      service.signIn({
        email: EMAIL,
        password: "a different orchard password",
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
  });

  it("keeps password-reset requests generic for unknown accounts", async () => {
    const { service } = await createAndVerify();
    const existing = await service.requestPasswordReset({ email: EMAIL });
    const missing = await service.requestPasswordReset({ email: "missing@example.test" });
    expect(existing.status).toBe("accepted");
    expect(missing.status).toBe("accepted");
    if (existing.status === "accepted" && missing.status === "accepted") {
      expect(Object.keys(existing)).toEqual(Object.keys(missing));
      expect(existing.next).toBe(missing.next);
    }
  });

  it("keeps password-reset responses generic when delivery fails", async () => {
    const state = await createAndVerify();
    const delivery: EmailDeliveryAdapter = {
      kind: "configured",
      send: async () => {
        throw new Error("mail transport unavailable");
      },
    };
    const service = await createPasswordAuthService({
      store: state.store,
      email: delivery,
      clock: state.clock,
      ids: new SequenceIds(),
      tokens: new FixtureAuthTokenGenerator(),
      hasher: fakeHasher,
    });

    const existing = await service.requestPasswordReset({ email: EMAIL });
    const missing = await service.requestPasswordReset({ email: "missing@example.test" });
    expect(existing).toEqual({ status: "accepted", next: "check_email" });
    expect(missing).toEqual(existing);
  });

  it("accepts a verification code retyped in lowercase with stray spacing", async () => {
    const { service } = await setup();
    const created = await service.createAccount({
      email: "reader@example.test",
      password: "a long orchard password",
      ...ACCOUNT_DETAILS,
    });
    if (created.status !== "accepted" || created.fixture_code === undefined) {
      throw new Error("The account did not receive a fixture code.");
    }
    await expect(
      service.verifyEmail({
        email: "reader@example.test",
        code: ` ${created.fixture_code.toLocaleLowerCase("en-US")} `,
        device_name: "Test device",
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
  });
  it("cancels a recoverable deletion when the password still proves the account", async () => {
    const { service, store } = await createAndVerify();
    const account = store.credentials.get(EMAIL)!;
    account.status = "deleting";
    store.recoverableDeletions.add(account.id);

    const result = await service.signIn({
      email: EMAIL,
      password: PASSWORD,
      device_name: "Recovery device",
    });

    expect(result).toMatchObject({ status: "authenticated", deletion_cancelled: true });
    expect(account.status).toBe("active");
  });

  it("refuses a deletion whose recovery window has already closed", async () => {
    const { service, store } = await createAndVerify();
    const account = store.credentials.get(EMAIL)!;
    account.status = "deleting";
    // No recoverable request is registered, so the window is past.

    await expect(
      service.signIn({ email: EMAIL, password: PASSWORD, device_name: "Late device" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
    expect(account.status).toBe("deleting");
  });

  it("does not cancel a deletion for a password that does not match", async () => {
    const { service, store } = await createAndVerify();
    const account = store.credentials.get(EMAIL)!;
    account.status = "deleting";
    store.recoverableDeletions.add(account.id);

    await expect(
      service.signIn({ email: EMAIL, password: "the wrong password", device_name: "Device" }),
    ).resolves.toMatchObject({ status: "error", code: "invalid_credentials" });
    expect(store.recoverableDeletions.has(account.id)).toBe(true);
    expect(account.status).toBe("deleting");
  });
});
