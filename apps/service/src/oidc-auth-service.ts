import { createHash, randomUUID } from "node:crypto";
import type {
  AccountAuthServiceResponse,
  Clock,
  GoogleAuthExchangeRequest,
  GoogleAuthStartRequest,
  GoogleAuthStartResponse,
  IdGenerator,
  SignInProvider,
} from "@kiwi/contracts";
import type { AccountAuthStore } from "./auth-store.js";
import type { AuthTokenGenerator, OidcIdentityAdapter } from "./auth-fixtures.js";
import type { OidcAuthStore } from "./oidc-auth-store.js";
import { issueDeviceSession } from "./session-service.js";
import { createSecureTokenGenerator } from "./email-delivery.js";

const TRANSACTION_LIFETIME_MS = 5 * 60 * 1_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface OidcAuthService {
  providers(): readonly SignInProvider[];
  start(
    request: GoogleAuthStartRequest,
    accountAction?:
      { kind: "link"; userId: string } | { kind: "reauthenticate"; sessionId: string },
  ): Promise<GoogleAuthStartResponse>;
  exchange(
    request: GoogleAuthExchangeRequest,
    reauthentication?: { userId: string; sessionId: string },
  ): Promise<AccountAuthServiceResponse>;
  unlink(userId: string, provider: SignInProvider): Promise<AccountAuthServiceResponse>;
  completeProviderCallback(url: URL): Promise<URL | null>;
  completeFixtureAuthorization(url: URL): URL | null;
}

export interface OidcAuthServiceOptions {
  store: OidcAuthStore;
  accounts: AccountAuthStore;
  adapters: readonly OidcIdentityAdapter[];
  clock?: Clock;
  ids?: IdGenerator;
  tokens?: AuthTokenGenerator;
  reportProviderFailure?: (reason: string) => void;
  providerRedirectUris?: Partial<Record<SignInProvider, string>>;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = { next: () => randomUUID() };

function digest(value: string, purpose: string): string {
  return createHash("sha256").update(`${purpose}\u0000${value}`, "utf8").digest("hex");
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validEntropy(value: string, maximum = 128): boolean {
  return value.length >= 43 && value.length <= maximum && BASE64URL.test(value);
}

function validLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/oauth/callback/") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validHostedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/v1/auth/oidc/callback" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function normalizeProviderEmail(value: string): string | null {
  const email = value.trim().normalize("NFC").toLocaleLowerCase("en-US");
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

function registrationBinding(request: GoogleAuthStartRequest): string {
  const profile = request.registration_profile;
  return profile === undefined
    ? "sign-in"
    : JSON.stringify([profile.given_name, profile.family_name, profile.phone]);
}

function boundStateHash(request: GoogleAuthStartRequest): string {
  return digest(`${request.state}\u0000${registrationBinding(request)}`, "state");
}

type AuthError = Extract<AccountAuthServiceResponse, { status: "error" }>;

function error(code: AuthError["code"], message: string): AuthError {
  return { status: "error", code, message };
}

export function createOidcAuthService(options: OidcAuthServiceOptions): OidcAuthService {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIds;
  const tokens = options.tokens ?? createSecureTokenGenerator();
  const adapters = new Map<SignInProvider, OidcIdentityAdapter>(
    options.adapters.map((adapter) => [adapter.provider, adapter]),
  );

  async function record(userId: string | null, eventType: string, outcome: string): Promise<void> {
    await options.accounts.recordSecurityEvent({
      id: ids.next(),
      userId,
      eventType,
      outcome,
      now: clock.now(),
    });
  }

  return {
    providers(): readonly SignInProvider[] {
      return [...adapters.keys()];
    },

    async start(request, accountAction): Promise<GoogleAuthStartResponse> {
      const provider = request.provider ?? "google";
      const adapter = adapters.get(provider);
      if (adapter === undefined) {
        return error("invalid_callback", "That sign-in method is not available.");
      }
      if (
        request.registration_profile !== undefined &&
        (provider !== "google" || accountAction !== undefined)
      ) {
        return error("invalid_input", "That account-creation request is not valid.");
      }
      if (
        !validLoopbackRedirect(request.redirect_uri) ||
        !validEntropy(request.state, 256) ||
        !validEntropy(request.nonce, 256) ||
        !validEntropy(request.code_challenge)
      ) {
        return error("invalid_callback", "Sign-in could not start safely.");
      }
      const now = clock.now();
      const providerRedirectUri = options.providerRedirectUris?.[provider] ?? request.redirect_uri;
      if (
        providerRedirectUri !== request.redirect_uri &&
        !validHostedRedirect(providerRedirectUri)
      ) {
        return error("invalid_callback", "Sign-in could not start safely.");
      }
      const rate = await options.accounts.takeRateLimit({
        scope: "googleStart",
        subjectHash: digest(request.redirect_uri, "redirect"),
        maximum: 10,
        windowMs: 5 * 60 * 1_000,
        now,
      });
      if (!rate.allowed) {
        return {
          status: "error",
          code: "rate_limited",
          message: "Too many attempts. Wait before trying again.",
          retry_after_seconds: rate.retryAfterSeconds,
        };
      }
      await options.store.beginTransaction({
        id: ids.next(),
        provider,
        linkUserId: accountAction?.kind === "link" ? accountAction.userId : null,
        reauthSessionId: accountAction?.kind === "reauthenticate" ? accountAction.sessionId : null,
        stateHash: boundStateHash(request),
        callbackStateHash: digest(request.state, "provider-callback-state"),
        nonceHash: digest(request.nonce, "nonce"),
        codeChallenge: request.code_challenge,
        redirectUri: request.redirect_uri,
        expiresAt: new Date(now.getTime() + TRANSACTION_LIFETIME_MS),
        now,
      });
      return {
        status: "browser_required",
        authorization_url: adapter.authorizationUrl({
          redirectUri: providerRedirectUri,
          state: request.state,
          nonce: request.nonce,
          codeChallenge: request.code_challenge,
        }),
      };
    },

    async exchange(request, reauthentication): Promise<AccountAuthServiceResponse> {
      if (
        !validLoopbackRedirect(request.redirect_uri) ||
        !validEntropy(request.state, 256) ||
        !validEntropy(request.nonce, 256) ||
        !validEntropy(request.code_challenge) ||
        !validEntropy(request.code_verifier) ||
        challenge(request.code_verifier) !== request.code_challenge
      ) {
        return error("invalid_callback", "Sign-in could not be verified.");
      }
      const now = clock.now();
      const consumed = await options.store.consumeTransaction({
        stateHash: boundStateHash(request),
        nonceHash: digest(request.nonce, "nonce"),
        codeChallenge: request.code_challenge,
        redirectUri: request.redirect_uri,
        now,
      });
      if (consumed === null) return error("invalid_callback", "Sign-in could not be verified.");
      if (
        (consumed.reauthSessionId === null && reauthentication !== undefined) ||
        (consumed.reauthSessionId !== null &&
          (reauthentication === undefined ||
            consumed.reauthSessionId !== reauthentication.sessionId))
      ) {
        return error("invalid_callback", "Sign-in could not be verified.");
      }
      const adapter = adapters.get(consumed.provider);
      if (adapter === undefined) {
        return error("invalid_callback", "That sign-in method is not available.");
      }

      let identity;
      try {
        const providerRedirectUri =
          options.providerRedirectUris?.[consumed.provider] ?? request.redirect_uri;
        identity = await adapter.exchangeAuthorizationCode({
          code: request.code,
          redirectUri: providerRedirectUri,
          codeVerifier: request.code_verifier,
        });
      } catch (cause) {
        options.reportProviderFailure?.(
          cause instanceof Error ? cause.message : "The provider exchange failed.",
        );
        await record(null, `account.${consumed.provider}_sign_in`, "rejected");
        return error("invalid_callback", "Sign-in could not be verified.");
      }

      const email = identity.email === null ? null : normalizeProviderEmail(identity.email);
      if (
        identity.provider !== consumed.provider ||
        identity.audience !== adapter.audience ||
        digest(identity.nonce, "nonce") !== digest(request.nonce, "nonce") ||
        identity.expiresAt <= now ||
        (adapter.providesEmail && (email === null || !identity.emailVerified))
      ) {
        await record(null, `account.${consumed.provider}_sign_in`, "rejected");
        return error("invalid_callback", "Sign-in could not be verified.");
      }

      if (consumed.linkUserId !== null) {
        const linked = await options.store.linkIdentity({
          provider: consumed.provider,
          identityId: ids.next(),
          userId: consumed.linkUserId,
          subject: identity.subject,
          email,
          displayLabel: identity.displayName,
          authorization: identity.authorization ?? null,
          now,
        });
        if (linked.kind === "claimed_elsewhere") {
          await record(consumed.linkUserId, `account.${consumed.provider}_link`, "rejected");
          return error(
            "identity_link_required",
            "That account is already connected to a different Kiwi account.",
          );
        }
        await record(consumed.linkUserId, `account.${consumed.provider}_link`, "succeeded");
        return { status: "identity_linked", provider: consumed.provider };
      }

      if (consumed.reauthSessionId !== null && reauthentication !== undefined) {
        const confirmed = await options.store.reauthenticateIdentity({
          provider: consumed.provider,
          subject: identity.subject,
          userId: reauthentication.userId,
          sessionId: reauthentication.sessionId,
          authorization: identity.authorization ?? null,
          now,
        });
        if (!confirmed) {
          await record(
            reauthentication.userId,
            `account.${consumed.provider}_reauthentication`,
            "rejected",
          );
          return error(
            "invalid_credentials",
            "That provider account does not match this Kiwi account.",
          );
        }
        await record(
          reauthentication.userId,
          `account.${consumed.provider}_reauthentication`,
          "succeeded",
        );
        return { status: "reauthenticated", provider: consumed.provider };
      }

      const resolved = await options.store.resolveIdentity({
        provider: consumed.provider,
        accountId: ids.next(),
        emailId: ids.next(),
        identityId: ids.next(),
        subject: identity.subject,
        email,
        displayLabel: identity.displayName,
        registrationProfile: request.registration_profile ?? null,
        authorization: identity.authorization ?? null,
        now,
      });
      if (resolved.kind === "unknown_identity") {
        await record(null, `account.${consumed.provider}_sign_in`, "unknown_identity");
        return error(
          "identity_link_required",
          consumed.provider === "google"
            ? "No Kiwi account is connected to this Google account. Use Create an Account first."
            : "Sign in with your email or Google first, then connect this method in Account Settings.",
        );
      }
      if (resolved.kind === "link_required") {
        await record(null, `account.${consumed.provider}_sign_in`, "link_required");
        return error(
          "identity_link_required",
          "Sign in with your existing method, then link it in Account Settings.",
        );
      }
      // A scheduled deletion is reversible until its window closes, and a verified
      // provider identity inside that window is what reverses it.
      const restored =
        resolved.account.status === "deleting" &&
        (await options.accounts.cancelRecoverableDeletion(resolved.account.id, now));
      if ((resolved.account.status !== "active" && !restored) || !resolved.account.verified) {
        await record(resolved.account.id, `account.${consumed.provider}_sign_in`, "rejected");
        return error("invalid_callback", "Sign-in could not be verified.");
      }

      // A failure here already passed every provider check, so it is a Kiwi-side fault.
      // Reporting it keeps it out of the silent path that a bare throw would take.
      try {
        const response = await issueDeviceSession({
          store: options.accounts,
          account: resolved.account,
          deviceName:
            consumed.provider === "google" ? "Kiwi desktop (Google)" : "Kiwi desktop (ORCID)",
          now,
          ids,
          tokens,
        });
        await record(resolved.account.id, `account.${consumed.provider}_sign_in`, "succeeded");
        if (!restored || response.status !== "authenticated") return response;
        await record(resolved.account.id, "account.deletion_cancelled", "succeeded");
        return { ...response, deletion_cancelled: true };
      } catch (cause) {
        options.reportProviderFailure?.(
          `session issue failed after a verified ${consumed.provider} sign-in: ${
            cause instanceof Error ? cause.message : "unknown cause"
          }`,
        );
        await record(resolved.account.id, `account.${consumed.provider}_sign_in`, "session_failed");
        return error("service_unavailable", "Kiwi could not start a session. Try again.");
      }
    },

    async unlink(userId, provider): Promise<AccountAuthServiceResponse> {
      const result = await options.store.unlinkIdentity({ provider, userId });
      if (result.kind === "last_method") {
        await record(userId, `account.${provider}_unlink`, "rejected");
        return error("invalid_input", "At least one authentication method must remain configured.");
      }
      if (result.kind === "not_linked") {
        return error("invalid_input", "That sign-in method is not connected.");
      }
      const adapter = adapters.get(provider);
      let providerRevocation: "confirmed" | "failed" | "not_supported" = "not_supported";
      if (result.revocationSecret !== null && adapter?.revokeAuthorization !== undefined) {
        try {
          providerRevocation = await adapter.revokeAuthorization(result.revocationSecret);
        } catch (cause) {
          providerRevocation = "failed";
          options.reportProviderFailure?.(
            `authorization revocation failed after ${provider} unlink: ${
              cause instanceof Error ? cause.message : "unknown cause"
            }`,
          );
        }
      }
      await record(
        userId,
        `account.${provider}_unlink`,
        providerRevocation === "failed" ? "provider_revocation_failed" : "succeeded",
      );
      return {
        status: "identity_unlinked",
        provider,
        provider_revocation: providerRevocation,
      };
    },

    async completeProviderCallback(url): Promise<URL | null> {
      const state = url.searchParams.get("state");
      if (state === null || !validEntropy(state, 256)) return null;
      const pending = await options.store.providerCallback({
        callbackStateHash: digest(state, "provider-callback-state"),
        now: clock.now(),
      });
      if (
        pending === null ||
        options.providerRedirectUris?.[pending.provider] === undefined ||
        !validLoopbackRedirect(pending.redirectUri)
      ) {
        return null;
      }
      const code = url.searchParams.get("code");
      const providerError = url.searchParams.get("error");
      if (
        (code === null && providerError === null) ||
        (code !== null && providerError !== null) ||
        (code !== null && (code.length === 0 || code.length > 512)) ||
        (providerError !== null && (providerError.length === 0 || providerError.length > 128))
      ) {
        return null;
      }
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("state", state);
      if (code !== null) redirect.searchParams.set("code", code);
      else
        redirect.searchParams.set(
          "error",
          providerError === "access_denied" ? providerError : "invalid_response",
        );
      return redirect;
    },

    completeFixtureAuthorization(url): URL | null {
      for (const adapter of adapters.values()) {
        if (adapter.kind !== "fixture") continue;
        const callback = adapter.completeFixtureAuthorization(url);
        if (callback !== null) return callback;
      }
      return null;
    },
  };
}
