import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AccountAuthServiceResponse,
  Clock,
  IdGenerator,
  SessionCredentialRequest,
} from "@kiwi/contracts";
import type { AccountAuthStore, StoredAccount } from "./auth-store.js";
import type { AuthTokenGenerator } from "./auth-fixtures.js";

const ACCESS_LIFETIME_MS = 15 * 60 * 1_000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = { next: () => randomUUID() };
const secureTokens: AuthTokenGenerator = {
  next(purpose) {
    const prefix = purpose === "access_token" ? "kiwi_access_" : "kiwi_refresh_";
    return `${prefix}${randomBytes(32).toString("base64url")}`;
  },
};

function digest(value: string, purpose: string): string {
  return createHash("sha256").update(`${purpose}\u0000${value}`, "utf8").digest("hex");
}

export async function issueDeviceSession(input: {
  store: AccountAuthStore;
  account: StoredAccount;
  deviceName: string;
  now: Date;
  ids: IdGenerator;
  tokens: AuthTokenGenerator;
}): Promise<AccountAuthServiceResponse> {
  const accessToken = input.tokens.next("access_token");
  const refreshToken = input.tokens.next("refresh_token");
  const accessExpiresAt = new Date(input.now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = new Date(input.now.getTime() + REFRESH_LIFETIME_MS);
  await input.store.createSession({
    id: input.ids.next(),
    refreshId: input.ids.next(),
    userId: input.account.id,
    deviceName: input.deviceName,
    accessTokenHash: digest(accessToken, "access_token"),
    expiresAt: accessExpiresAt,
    refreshTokenHash: digest(refreshToken, "refresh_token"),
    refreshExpiresAt,
    now: input.now,
  });
  return {
    status: "authenticated",
    account: { id: input.account.id, email: input.account.email, email_verified: true },
    access_token: accessToken,
    expires_at: accessExpiresAt.toISOString(),
    refresh_token: refreshToken,
    refresh_expires_at: refreshExpiresAt.toISOString(),
  };
}

export interface SessionService {
  refresh(request: SessionCredentialRequest): Promise<AccountAuthServiceResponse>;
  signOut(request: SessionCredentialRequest): Promise<AccountAuthServiceResponse>;
}

export function createSessionService(options: {
  store: AccountAuthStore;
  clock?: Clock;
  ids?: IdGenerator;
  tokens?: AuthTokenGenerator;
}): SessionService {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIds;
  const tokens = options.tokens ?? secureTokens;

  return {
    async refresh(request): Promise<AccountAuthServiceResponse> {
      const now = clock.now();
      const accessToken = tokens.next("access_token");
      const refreshToken = tokens.next("refresh_token");
      const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
      const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
      const rotated = await options.store.rotateSession({
        refreshTokenHash: digest(request.refresh_token, "refresh_token"),
        nextRefreshId: ids.next(),
        nextRefreshTokenHash: digest(refreshToken, "refresh_token"),
        nextRefreshExpiresAt: refreshExpiresAt,
        accessTokenHash: digest(accessToken, "access_token"),
        accessExpiresAt,
        now,
      });
      if (rotated.kind === "reuse") {
        return {
          status: "error",
          code: "refresh_reuse_detected",
          message: "This session was revoked because an old credential was reused.",
        };
      }
      if (rotated.kind === "invalid") {
        return {
          status: "error",
          code: "session_expired",
          message: "Your session ended. Sign in again.",
        };
      }
      return {
        status: "authenticated",
        account: { id: rotated.account.id, email: rotated.account.email, email_verified: true },
        access_token: accessToken,
        expires_at: accessExpiresAt.toISOString(),
        refresh_token: refreshToken,
        refresh_expires_at: refreshExpiresAt.toISOString(),
      };
    },

    async signOut(request): Promise<AccountAuthServiceResponse> {
      await options.store.revokeSession(
        digest(request.refresh_token, "refresh_token"),
        clock.now(),
      );
      return { status: "signed_out" };
    },
  };
}
