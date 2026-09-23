import { normalizePhone, type AccountEmailKind } from "./account-settings.js";

export const ACCOUNT_AUTH_PATHS = {
  create: "/v1/auth/password/accounts",
  verifyEmail: "/v1/auth/email/verify",
  resendEmailVerification: "/v1/auth/email/verify/resend",
  signIn: "/v1/auth/password/sign-in",
  requestPasswordReset: "/v1/auth/password/reset/request",
  resetPassword: "/v1/auth/password/reset/confirm",
  googleStart: "/v1/auth/google/start",
  googleExchange: "/v1/auth/google/exchange",
  googleFixtureAuthorize: "/v1/auth/google/fixture/authorize",
  identityProviderCallback: "/v1/auth/oidc/callback",
  identityLinkStart: "/v1/account/sign-in-methods/link/start",
  identityLinkExchange: "/v1/account/sign-in-methods/link/exchange",
  identityReauthenticateStart: "/v1/account/reauthenticate/provider/start",
  identityReauthenticateExchange: "/v1/account/reauthenticate/provider/exchange",
  passwordReauthenticate: "/v1/account/reauthenticate/password",
  identityUnlink: "/v1/account/sign-in-methods/unlink",
  refreshSession: "/v1/auth/session/refresh",
  signOut: "/v1/auth/session/sign-out",
} as const;

export interface PasswordAccountCreateRequest {
  email: string;
  email_kind: AccountEmailKind;
  password: string;
  given_name: string;
  family_name: string;
  phone: string;
}

export interface EmailVerificationRequest {
  email: string;
  code: string;
  device_name: string;
}

export interface PasswordSignInRequest {
  email: string;
  password: string;
  device_name: string;
}

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordReauthenticationRequest {
  password: string;
}

export type EmailVerificationResendRequest = PasswordResetRequest;

export interface PasswordResetConfirmRequest {
  email: string;
  code: string;
  new_password: string;
}

export type SignInProvider = "google" | "orcid";

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ["google", "orcid"];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return value === "google" || value === "orcid";
}

export interface AccountRegistrationProfile {
  given_name: string;
  family_name: string;
  phone: string;
}

export interface GoogleAuthStartRequest {
  provider?: SignInProvider;
  registration_profile?: AccountRegistrationProfile;
  redirect_uri: string;
  state: string;
  nonce: string;
  code_challenge: string;
}

export interface GoogleAuthExchangeRequest extends GoogleAuthStartRequest {
  code: string;
  code_verifier: string;
}

export interface SessionCredentialRequest {
  refresh_token: string;
}

export interface AccountIdentity {
  id: string;
  email: string;
  email_verified: true;
}

export type AccountAuthErrorCode =
  | "invalid_input"
  | "password_rejected"
  | "invalid_credentials"
  | "verification_required"
  | "recent_auth_required"
  | "invalid_or_expired_code"
  | "rate_limited"
  | "service_unavailable"
  | "provider_cancelled"
  | "provider_denied"
  | "invalid_callback"
  | "identity_link_required"
  | "session_expired"
  | "refresh_reuse_detected";

export type GoogleAuthStartResponse =
  | { status: "browser_required"; authorization_url: string }
  | Extract<AccountAuthServiceResponse, { status: "error" }>;

export type AccountAuthServiceResponse =
  | {
      status: "accepted";
      next: "verify_email" | "check_email";
      fixture_code?: string;
    }
  | {
      status: "authenticated";
      account: AccountIdentity;
      access_token: string;
      expires_at: string;
      refresh_token: string;
      refresh_expires_at: string;
      // Set when this authentication cancelled a scheduled deletion that was still inside
      // its recovery window. The surface that receives it MUST tell the person.
      deletion_cancelled?: true;
    }
  | { status: "password_reset" | "signed_out" }
  | { status: "identity_linked"; provider: SignInProvider }
  | {
      status: "identity_unlinked";
      provider: SignInProvider;
      provider_revocation: "confirmed" | "not_supported" | "failed";
    }
  | { status: "reauthenticated"; provider: SignInProvider | "password" }
  | {
      status: "error";
      code: AccountAuthErrorCode;
      message: string;
      retry_after_seconds?: number;
    };

export type AccountAuthResult =
  | Exclude<AccountAuthServiceResponse, { status: "authenticated" }>
  | { status: "authenticated"; account: AccountIdentity; deletion_cancelled?: true };

export type AccountAuthState =
  | { status: "signed_out" }
  | { status: "authenticated"; account: AccountIdentity; connection: "online" | "offline" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function readAccountRegistrationProfile(value: unknown): AccountRegistrationProfile | null {
  if (!isRecord(value) || !hasOnly(value, ["given_name", "family_name", "phone"])) return null;
  const givenName = value["given_name"];
  const familyName = value["family_name"];
  const phone = value["phone"];
  if (
    typeof givenName !== "string" ||
    typeof familyName !== "string" ||
    typeof phone !== "string"
  ) {
    return null;
  }
  const normalizedGivenName = givenName.trim().normalize("NFC");
  const normalizedFamilyName = familyName.trim().normalize("NFC");
  const normalizedPhone = normalizePhone(phone);
  if (
    normalizedGivenName.length < 1 ||
    normalizedGivenName.length > 80 ||
    normalizedFamilyName.length < 1 ||
    normalizedFamilyName.length > 80 ||
    normalizedPhone === null
  ) {
    return null;
  }
  return {
    given_name: normalizedGivenName,
    family_name: normalizedFamilyName,
    phone: normalizedPhone,
  };
}

function readPasswordRequest(
  value: unknown,
  passwordKey: "password" | "new_password",
  extraKeys: readonly string[] = [],
): { email: string; password: string; record: Record<string, unknown> } | null {
  if (!isRecord(value) || !hasOnly(value, ["email", passwordKey, ...extraKeys])) return null;
  if (!isBoundedString(value["email"], 254) || !isBoundedString(value[passwordKey], 4096)) {
    return null;
  }
  return { email: value["email"], password: value[passwordKey], record: value };
}

export function readPasswordAccountCreateRequest(
  value: unknown,
): PasswordAccountCreateRequest | null {
  const request = readPasswordRequest(value, "password", [
    "email_kind",
    "given_name",
    "family_name",
    "phone",
  ]);
  if (request === null) return null;
  const emailKind = request.record["email_kind"];
  if (emailKind !== "personal" && emailKind !== "institutional") return null;
  const profile = readAccountRegistrationProfile({
    given_name: request.record["given_name"],
    family_name: request.record["family_name"],
    phone: request.record["phone"],
  });
  if (profile === null) return null;
  return {
    email: request.email,
    email_kind: emailKind,
    password: request.password,
    ...profile,
  };
}

export function readPasswordSignInRequest(value: unknown): PasswordSignInRequest | null {
  const request = readPasswordRequest(value, "password", ["device_name"]);
  const deviceName = request?.record["device_name"];
  if (request === null || !isBoundedString(deviceName, 120)) return null;
  return { email: request.email, password: request.password, device_name: deviceName };
}

export function readEmailVerificationRequest(value: unknown): EmailVerificationRequest | null {
  if (!isRecord(value) || !hasOnly(value, ["email", "code", "device_name"])) return null;
  if (
    !isBoundedString(value["email"], 254) ||
    !isBoundedString(value["code"], 256) ||
    !isBoundedString(value["device_name"], 120)
  ) {
    return null;
  }
  return { email: value["email"], code: value["code"], device_name: value["device_name"] };
}

export function readPasswordResetRequest(value: unknown): PasswordResetRequest | null {
  if (!isRecord(value) || !hasOnly(value, ["email"]) || !isBoundedString(value["email"], 254)) {
    return null;
  }
  return { email: value["email"] };
}

export function readPasswordReauthenticationRequest(
  value: unknown,
): PasswordReauthenticationRequest | null {
  if (!isRecord(value) || !hasOnly(value, ["password"])) return null;
  return isBoundedString(value["password"], 4_096) ? { password: value["password"] } : null;
}

export const readEmailVerificationResendRequest = readPasswordResetRequest;

export function readPasswordResetConfirmRequest(
  value: unknown,
): PasswordResetConfirmRequest | null {
  const request = readPasswordRequest(value, "new_password", ["code"]);
  const code = request?.record["code"];
  if (request === null || !isBoundedString(code, 256)) return null;
  return { email: request.email, code, new_password: request.password };
}

function readGoogleBase(value: unknown): GoogleAuthStartRequest | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value["redirect_uri"], 500) ||
    !isBoundedString(value["state"], 256) ||
    !isBoundedString(value["nonce"], 256) ||
    !isBoundedString(value["code_challenge"], 128)
  ) {
    return null;
  }
  const provider = value["provider"];
  if (provider !== undefined && !isSignInProvider(provider)) return null;
  const registrationProfile = value["registration_profile"];
  let parsedProfile: AccountRegistrationProfile | undefined;
  if (registrationProfile !== undefined) {
    const parsed = readAccountRegistrationProfile(registrationProfile);
    if (parsed === null) return null;
    parsedProfile = parsed;
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(parsedProfile === undefined ? {} : { registration_profile: parsedProfile }),
    redirect_uri: value["redirect_uri"],
    state: value["state"],
    nonce: value["nonce"],
    code_challenge: value["code_challenge"],
  };
}

export function readGoogleAuthStartRequest(value: unknown): GoogleAuthStartRequest | null {
  if (
    !isRecord(value) ||
    !hasOnly(value, [
      "provider",
      "registration_profile",
      "redirect_uri",
      "state",
      "nonce",
      "code_challenge",
    ])
  ) {
    return null;
  }
  return readGoogleBase(value);
}

export function readGoogleAuthExchangeRequest(value: unknown): GoogleAuthExchangeRequest | null {
  if (
    !isRecord(value) ||
    !hasOnly(value, [
      "provider",
      "registration_profile",
      "redirect_uri",
      "state",
      "nonce",
      "code_challenge",
      "code",
      "code_verifier",
    ])
  ) {
    return null;
  }
  const base = readGoogleBase(value);
  if (
    base === null ||
    !isBoundedString(value["code"], 512) ||
    !isBoundedString(value["code_verifier"], 128)
  ) {
    return null;
  }
  return { ...base, code: value["code"], code_verifier: value["code_verifier"] };
}

export function readSessionCredentialRequest(value: unknown): SessionCredentialRequest | null {
  if (
    !isRecord(value) ||
    !hasOnly(value, ["refresh_token"]) ||
    !isBoundedString(value["refresh_token"], 512)
  ) {
    return null;
  }
  return { refresh_token: value["refresh_token"] };
}

function isAccountIdentity(value: unknown): value is AccountIdentity {
  return (
    isRecord(value) &&
    hasOnly(value, ["id", "email", "email_verified"]) &&
    isBoundedString(value["id"], 100) &&
    isBoundedString(value["email"], 254) &&
    value["email_verified"] === true
  );
}

const AUTH_ERROR_CODES: readonly AccountAuthErrorCode[] = [
  "invalid_input",
  "password_rejected",
  "invalid_credentials",
  "verification_required",
  "recent_auth_required",
  "invalid_or_expired_code",
  "rate_limited",
  "service_unavailable",
  "provider_cancelled",
  "provider_denied",
  "invalid_callback",
  "identity_link_required",
  "session_expired",
  "refresh_reuse_detected",
];

export function isAccountAuthServiceResponse(value: unknown): value is AccountAuthServiceResponse {
  if (!isRecord(value) || typeof value["status"] !== "string") return false;
  if (value["status"] === "accepted") {
    return (
      hasOnly(value, ["status", "next", "fixture_code"]) &&
      (value["next"] === "verify_email" || value["next"] === "check_email") &&
      (value["fixture_code"] === undefined || isBoundedString(value["fixture_code"], 256))
    );
  }
  if (value["status"] === "authenticated") {
    return (
      hasOnly(value, [
        "status",
        "account",
        "access_token",
        "expires_at",
        "refresh_token",
        "refresh_expires_at",
        "deletion_cancelled",
      ]) &&
      isAccountIdentity(value["account"]) &&
      isBoundedString(value["access_token"], 512) &&
      isBoundedString(value["expires_at"], 50) &&
      isBoundedString(value["refresh_token"], 512) &&
      isBoundedString(value["refresh_expires_at"], 50) &&
      (value["deletion_cancelled"] === undefined || value["deletion_cancelled"] === true)
    );
  }
  if (value["status"] === "password_reset" || value["status"] === "signed_out") {
    return hasOnly(value, ["status"]);
  }
  if (value["status"] === "identity_linked") {
    return hasOnly(value, ["status", "provider"]) && isSignInProvider(value["provider"]);
  }
  if (value["status"] === "identity_unlinked") {
    return (
      hasOnly(value, ["status", "provider", "provider_revocation"]) &&
      isSignInProvider(value["provider"]) &&
      ["confirmed", "not_supported", "failed"].includes(String(value["provider_revocation"]))
    );
  }
  if (value["status"] === "reauthenticated") {
    return (
      hasOnly(value, ["status", "provider"]) &&
      (isSignInProvider(value["provider"]) || value["provider"] === "password")
    );
  }
  if (value["status"] === "error") {
    return (
      hasOnly(value, ["status", "code", "message", "retry_after_seconds"]) &&
      typeof value["code"] === "string" &&
      AUTH_ERROR_CODES.includes(value["code"] as AccountAuthErrorCode) &&
      isBoundedString(value["message"], 500) &&
      (value["retry_after_seconds"] === undefined ||
        (Number.isInteger(value["retry_after_seconds"]) &&
          (value["retry_after_seconds"] as number) > 0))
    );
  }
  return false;
}

export function isGoogleAuthStartResponse(value: unknown): value is GoogleAuthStartResponse {
  return (
    (isRecord(value) &&
      value["status"] === "browser_required" &&
      hasOnly(value, ["status", "authorization_url"]) &&
      isBoundedString(value["authorization_url"], 2_048)) ||
    (isAccountAuthServiceResponse(value) && value.status === "error")
  );
}

export interface IdentityUnlinkRequest {
  provider: SignInProvider;
}

export function readIdentityUnlinkRequest(value: unknown): IdentityUnlinkRequest | null {
  return isRecord(value) && hasOnly(value, ["provider"]) && isSignInProvider(value["provider"])
    ? { provider: value["provider"] }
    : null;
}
