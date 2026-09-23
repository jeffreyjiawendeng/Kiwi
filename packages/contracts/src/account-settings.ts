export const ACCOUNT_SETTINGS_PATHS = {
  snapshot: "/v1/account/settings",
  profile: "/v1/account/profile",
  revokeSession: "/v1/account/sessions/revoke",
  revokeOtherSessions: "/v1/account/sessions/revoke-others",
  requestDeletion: "/v1/account/deletion/request",
  passwordSet: "/v1/account/password/set",
  passwordRemove: "/v1/account/password/remove",
  emailAdd: "/v1/account/emails/add",
  emailVerify: "/v1/account/emails/verify",
  emailResend: "/v1/account/emails/resend",
  emailPromote: "/v1/account/emails/promote",
  emailNotifications: "/v1/account/emails/notifications",
  emailRemove: "/v1/account/emails/remove",
  notificationPreference: "/v1/account/notifications/preference",
  export: "/v1/account/export",
  avatar: "/v1/account/avatar",
} as const;

export const AVATAR_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type AvatarMediaType = (typeof AVATAR_MEDIA_TYPES)[number];

export const MAXIMUM_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAXIMUM_AVATAR_DIMENSION = 512;
export const MAXIMUM_AVATAR_BYTES = 512 * 1024;

export const MAXIMUM_ACCOUNT_EMAILS = 3;

// A declared media type is a claim by whoever sent the bytes. These prefixes are what the
// bytes actually have to start with, and they are checked before anything is stored.
const AVATAR_SIGNATURES: ReadonlyArray<{ type: AvatarMediaType; prefix: readonly number[] }> = [
  { type: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  { type: "image/webp", prefix: [0x52, 0x49, 0x46, 0x46] },
];

// WebP writes its format after a four-byte length, so its signature is split in two.
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50] as const;

export function readAvatarMediaType(bytes: Uint8Array): AvatarMediaType | null {
  for (const candidate of AVATAR_SIGNATURES) {
    if (candidate.prefix.every((byte, index) => bytes[index] === byte)) {
      if (candidate.type !== "image/webp") return candidate.type;
      return WEBP_MARKER.every((byte, index) => bytes[8 + index] === byte) ? "image/webp" : null;
    }
  }
  return null;
}

export interface AccountAvatarSummary {
  content_hash: string;
  media_type: AvatarMediaType;
}

export interface AvatarUpload {
  media_type: AvatarMediaType;
  data: string;
}

// Security correspondence is not a preference. A sign-in from a new device, a password
// change, and a deletion request are how an account holder learns their account was taken,
// so those messages are always delivered and are not listed as a choice.
export const NOTIFICATION_CATEGORIES = [
  "workspace_invitations",
  "collaboration",
  "synchronization",
  "product",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationPreference {
  category: NotificationCategory;
  email: boolean;
}

// Kiwi is local-first: synchronization and collaboration are the categories a person
// most needs, and product mail is the one they most often do not.
export const NOTIFICATION_DEFAULTS: Record<NotificationCategory, boolean> = {
  workspace_invitations: true,
  collaboration: true,
  synchronization: true,
  product: false,
};

export interface AccountSessionSummary {
  id: string;
  device_name: string;
  current: boolean;
  started_at: string;
  last_authenticated_at: string;
  last_seen_at: string;
}

export interface AccountProfile {
  given_name: string | null;
  family_name: string | null;
  phone: string | null;
}

export type AccountEmailKind = "personal" | "institutional";

export interface AccountEmailSummary {
  id: string;
  address: string;
  kind: AccountEmailKind;
  verified: boolean;
  primary: boolean;
  receives_notifications: boolean;
}

// What deletion would actually cost, resolved before the confirmation is offered so the
// decision is made against facts rather than a warning.
export interface AccountDeletionImpact {
  sole_owner_workspaces: Array<{ id: string; title: string }>;
  shared_workspaces: number;
  addresses: number;
  connections: number;
}

export interface AccountSecurityEvent {
  id: string;
  event: string;
  outcome: string;
  occurred_at: string;
}

export interface AccountSettingsSnapshot {
  account: {
    id: string;
    email: string;
    profile: AccountProfile;
    display_name: string;
    profile_complete: boolean;
    email_verified: true;
    avatar: AccountAvatarSummary | null;
  };
  sign_in_methods: Array<"google" | "orcid" | "password">;
  emails: AccountEmailSummary[];
  sessions: AccountSessionSummary[];
  security_activity: AccountSecurityEvent[];
  notifications: NotificationPreference[];
  deletion_impact: AccountDeletionImpact;
  deletion: { status: "none" } | { status: "pending"; recover_until: string };
}

// A signed-in account changes its password by proving the current one. An account that
// has no password yet creates one from a recent sign-in alone, which is what lets an
// account created through Google or ORCID add password sign-in. No emailed code is
// involved: a code is only ever sent to prove a first email address or to recover an
// account whose password is lost.
// The export is the account's own record of itself. It is written to a file the person
// chooses and never crosses into the renderer, so no surface has to hold it in memory.
export interface AccountExport {
  format: "kiwi.account-export.v1";
  generated_at: string;
  account: {
    id: string;
    primary_email: string;
    given_name: string | null;
    family_name: string | null;
    phone: string | null;
    created_at: string;
  };
  emails: AccountEmailSummary[];
  sign_in_methods: string[];
  connected_accounts: Array<{ provider: string; account_label: string; connected_at: string }>;
  sessions: AccountSessionSummary[];
  security_activity: AccountSecurityEvent[];
  notifications: NotificationPreference[];
  workspaces: Array<{ id: string; title: string; role: string; joined_at: string }>;
}

export interface PasswordSetRequest {
  current_password: string | null;
  new_password: string;
}

export function readPasswordSetRequest(value: unknown): PasswordSetRequest | null {
  const input = record(value);
  if (
    input === null ||
    Object.keys(input).some((key) => key !== "current_password" && key !== "new_password") ||
    typeof input["new_password"] !== "string" ||
    (input["current_password"] !== null &&
      input["current_password"] !== undefined &&
      typeof input["current_password"] !== "string")
  ) {
    return null;
  }
  const current =
    typeof input["current_password"] === "string" && input["current_password"].length > 0
      ? input["current_password"]
      : null;
  const newPassword = input["new_password"];
  return (current === null || current.length <= 1024) &&
    newPassword.length >= 1 &&
    newPassword.length <= 1024
    ? { current_password: current, new_password: newPassword }
    : null;
}

export type AccountSettingsResult =
  | {
      status: "ok";
      settings: AccountSettingsSnapshot;
      email_verification?: {
        email_id: string;
        address: string;
        fixture_code?: string;
      };
    }
  | { status: "session_revoked" }
  | { status: "deletion_requested"; recover_until: string }
  | {
      status: "error";
      code:
        | "invalid_input"
        | "invalid_credentials"
        | "forbidden"
        | "recent_auth_required"
        | "service_unavailable"
        | "invalid_or_expired_code"
        | "password_rejected"
        | "rate_limited";
      message: string;
      retry_after_seconds?: number;
    };

const PROFILE_FIELDS = ["given_name", "family_name", "phone"] as const;

const PROFILE_LIMITS: Record<(typeof PROFILE_FIELDS)[number], number> = {
  given_name: 80,
  family_name: 80,
  phone: 40,
};

const E164 = /^\+[1-9]\d{6,18}$/u;

export function normalizePhone(value: string): string | null {
  const source = value.trim().normalize("NFC");
  if (!/^[+\d\s().-]+$/u.test(source)) return null;
  const compact = source.replace(/[\s().-]/gu, "");
  const international = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (international.startsWith("+")) return E164.test(international) ? international : null;

  const digits = international.replace(/\D/gu, "");
  const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return E164.test(normalized) ? normalized : null;
}

// The displayed name is always derived so no surface can disagree about how a person is
// named. No name field is verified, so a surface that attributes an action must show a
// verified anchor such as the primary email address next to this name.
export function deriveDisplayName(profile: AccountProfile, primaryEmail: string): string {
  const parts = [profile.given_name, profile.family_name].filter(
    (part): part is string => part !== null,
  );
  if (parts.length > 0) return parts.join(" ");
  return primaryEmail.split("@", 1)[0] ?? "Kiwi user";
}

export function isProfileNamed(profile: AccountProfile): boolean {
  return profile.given_name !== null || profile.family_name !== null;
}

export function isProfileComplete(profile: AccountProfile): boolean {
  return profile.given_name !== null && profile.family_name !== null && profile.phone !== null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readProfileUpdate(value: unknown): AccountProfile | null {
  const input = record(value);
  if (input === null || Object.keys(input).some((key) => !PROFILE_FIELDS.includes(key as never))) {
    return null;
  }
  const profile: AccountProfile = {
    given_name: null,
    family_name: null,
    phone: null,
  };
  for (const field of PROFILE_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") return null;
    const text = raw.trim().normalize("NFC");
    if (text.length === 0) continue;
    if (text.length > PROFILE_LIMITS[field]) return null;
    if (field === "phone") {
      const phone = normalizePhone(text);
      if (phone === null) return null;
      profile.phone = phone;
      continue;
    }
    profile[field] = text;
  }
  return profile;
}

function isReadableProfile(value: unknown): value is AccountProfile {
  const profile = record(value);
  return (
    profile !== null &&
    Object.keys(profile).every((key) => PROFILE_FIELDS.includes(key as never)) &&
    PROFILE_FIELDS.every((field) => {
      const item = profile[field];
      return item === null || (typeof item === "string" && item.length <= PROFILE_LIMITS[field]);
    })
  );
}

export function readSessionRevoke(value: unknown): { session_id: string } | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "session_id") &&
    typeof input["session_id"] === "string" &&
    input["session_id"].length >= 1 &&
    input["session_id"].length <= 100
    ? { session_id: input["session_id"] }
    : null;
}

export function readDeletionRequest(value: unknown): { confirmation: "DELETE" } | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "confirmation") &&
    input["confirmation"] === "DELETE"
    ? { confirmation: "DELETE" }
    : null;
}

export function isAccountSettingsResult(value: unknown): value is AccountSettingsResult {
  const result = record(value);
  if (result === null || typeof result["status"] !== "string") return false;
  if (result["status"] === "session_revoked") {
    return Object.keys(result).length === 1;
  }
  if (result["status"] === "deletion_requested") {
    return (
      Object.keys(result).every((key) => key === "status" || key === "recover_until") &&
      typeof result["recover_until"] === "string" &&
      result["recover_until"].length <= 50
    );
  }
  if (result["status"] === "error") {
    return (
      Object.keys(result).every((key) =>
        ["status", "code", "message", "retry_after_seconds"].includes(key),
      ) &&
      [
        "invalid_input",
        "invalid_credentials",
        "forbidden",
        "recent_auth_required",
        "service_unavailable",
        "invalid_or_expired_code",
        "password_rejected",
        "rate_limited",
      ].includes(String(result["code"])) &&
      typeof result["message"] === "string" &&
      result["message"].length >= 1 &&
      result["message"].length <= 500 &&
      (result["retry_after_seconds"] === undefined ||
        (Number.isInteger(result["retry_after_seconds"]) &&
          (result["retry_after_seconds"] as number) > 0))
    );
  }
  if (result["status"] !== "ok") return false;
  const settings = record(result["settings"]);
  const emailVerification =
    result["email_verification"] === undefined ? undefined : record(result["email_verification"]);
  const account = record(settings?.["account"]);
  const deletion = record(settings?.["deletion"]);
  const sessions = settings?.["sessions"];
  const methods = settings?.["sign_in_methods"];
  return (
    Object.keys(result).every(
      (key) => key === "status" || key === "settings" || key === "email_verification",
    ) &&
    (emailVerification === undefined ||
      (emailVerification !== null &&
        Object.keys(emailVerification).every((key) =>
          ["email_id", "address", "fixture_code"].includes(key),
        ) &&
        typeof emailVerification["email_id"] === "string" &&
        emailVerification["email_id"].length >= 1 &&
        emailVerification["email_id"].length <= 100 &&
        typeof emailVerification["address"] === "string" &&
        normalizeEmailAddress(emailVerification["address"]) !== null &&
        (emailVerification["fixture_code"] === undefined ||
          (typeof emailVerification["fixture_code"] === "string" &&
            emailVerification["fixture_code"].length >= 1 &&
            emailVerification["fixture_code"].length <= 100)))) &&
    settings !== null &&
    Object.keys(settings).every((key) =>
      [
        "account",
        "sign_in_methods",
        "emails",
        "sessions",
        "security_activity",
        "notifications",
        "deletion_impact",
        "deletion",
      ].includes(key),
    ) &&
    account !== null &&
    Object.keys(account).every((key) =>
      [
        "id",
        "email",
        "profile",
        "display_name",
        "profile_complete",
        "email_verified",
        "avatar",
      ].includes(key),
    ) &&
    isAvatarSummary(account["avatar"]) &&
    isReadableProfile(account["profile"]) &&
    typeof account["id"] === "string" &&
    account["id"].length <= 100 &&
    typeof account["email"] === "string" &&
    account["email"].length <= 254 &&
    typeof account["display_name"] === "string" &&
    account["display_name"].length <= 80 &&
    typeof account["profile_complete"] === "boolean" &&
    account["email_verified"] === true &&
    Array.isArray(methods) &&
    methods.every((method) => method === "google" || method === "orcid" || method === "password") &&
    Array.isArray(sessions) &&
    sessions.length <= 100 &&
    sessions.every((session) => {
      const item = record(session);
      return (
        item !== null &&
        Object.keys(item).every((key) =>
          [
            "id",
            "device_name",
            "current",
            "started_at",
            "last_authenticated_at",
            "last_seen_at",
          ].includes(key),
        ) &&
        typeof item["id"] === "string" &&
        item["id"].length <= 100 &&
        typeof item["device_name"] === "string" &&
        item["device_name"].length <= 120 &&
        typeof item["current"] === "boolean" &&
        ["started_at", "last_authenticated_at", "last_seen_at"].every(
          (key) => typeof item[key] === "string" && String(item[key]).length <= 50,
        )
      );
    }) &&
    Array.isArray(settings["emails"]) &&
    settings["emails"].length <= MAXIMUM_ACCOUNT_EMAILS &&
    settings["emails"].every((entry) => {
      const item = record(entry);
      return (
        item !== null &&
        Object.keys(item).every((key) =>
          ["id", "address", "kind", "verified", "primary", "receives_notifications"].includes(key),
        ) &&
        typeof item["id"] === "string" &&
        item["id"].length <= 100 &&
        typeof item["address"] === "string" &&
        item["address"].length <= 254 &&
        (item["kind"] === "personal" || item["kind"] === "institutional") &&
        typeof item["verified"] === "boolean" &&
        typeof item["primary"] === "boolean" &&
        typeof item["receives_notifications"] === "boolean"
      );
    }) &&
    Array.isArray(settings["security_activity"]) &&
    settings["security_activity"].length <= 50 &&
    settings["security_activity"].every((entry) => {
      const item = record(entry);
      return (
        item !== null &&
        Object.keys(item).every((key) => ["id", "event", "outcome", "occurred_at"].includes(key)) &&
        typeof item["id"] === "string" &&
        item["id"].length <= 100 &&
        typeof item["event"] === "string" &&
        item["event"].length <= 100 &&
        typeof item["outcome"] === "string" &&
        item["outcome"].length <= 60 &&
        typeof item["occurred_at"] === "string" &&
        item["occurred_at"].length <= 50
      );
    }) &&
    Array.isArray(settings["notifications"]) &&
    settings["notifications"].length === NOTIFICATION_CATEGORIES.length &&
    settings["notifications"].every((entry) => {
      const item = record(entry);
      return (
        item !== null &&
        Object.keys(item).every((key) => key === "category" || key === "email") &&
        NOTIFICATION_CATEGORIES.includes(item["category"] as NotificationCategory) &&
        typeof item["email"] === "boolean"
      );
    }) &&
    isDeletionImpact(settings["deletion_impact"]) &&
    deletion !== null &&
    ((deletion["status"] === "none" && Object.keys(deletion).length === 1) ||
      (deletion["status"] === "pending" &&
        Object.keys(deletion).every((key) => key === "status" || key === "recover_until") &&
        typeof deletion["recover_until"] === "string" &&
        deletion["recover_until"].length <= 50))
  );
}

function isAvatarSummary(value: unknown): value is AccountAvatarSummary | null {
  if (value === null) return true;
  const avatar = record(value);
  return (
    avatar !== null &&
    Object.keys(avatar).every((key) => key === "content_hash" || key === "media_type") &&
    typeof avatar["content_hash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(avatar["content_hash"]) &&
    AVATAR_MEDIA_TYPES.includes(avatar["media_type"] as AvatarMediaType)
  );
}

export function readAvatarUpload(value: unknown): AvatarUpload | null {
  const input = record(value);
  if (
    input === null ||
    Object.keys(input).some((key) => key !== "media_type" && key !== "data") ||
    !AVATAR_MEDIA_TYPES.includes(input["media_type"] as AvatarMediaType) ||
    typeof input["data"] !== "string"
  ) {
    return null;
  }
  // Base64 carries three bytes in every four characters, so this bounds the decoded size
  // without decoding first.
  const data = input["data"];
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(data) &&
    data.length > 0 &&
    (data.length / 4) * 3 <= MAXIMUM_AVATAR_BYTES
    ? { media_type: input["media_type"] as AvatarMediaType, data }
    : null;
}

// An account without an avatar renders derived initials, never a stock photograph. Both
// sides derive them the same way so no surface disagrees about how a person is shown.
export function deriveInitials(displayName: string): string {
  const words = displayName
    .split(/\s+/u)
    .map((word) => [...word].find((character) => /\p{L}|\p{N}/u.test(character)))
    .filter((character): character is string => character !== undefined);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase("en-US");
}

function isDeletionImpact(value: unknown): value is AccountDeletionImpact {
  const impact = record(value);
  const workspaces = impact?.["sole_owner_workspaces"];
  return (
    impact !== null &&
    Object.keys(impact).every((key) =>
      ["sole_owner_workspaces", "shared_workspaces", "addresses", "connections"].includes(key),
    ) &&
    Array.isArray(workspaces) &&
    workspaces.length <= 100 &&
    workspaces.every((entry) => {
      const item = record(entry);
      return (
        item !== null &&
        Object.keys(item).every((key) => key === "id" || key === "title") &&
        typeof item["id"] === "string" &&
        item["id"].length <= 100 &&
        typeof item["title"] === "string" &&
        item["title"].length <= 200
      );
    }) &&
    ["shared_workspaces", "addresses", "connections"].every((key) => {
      const count = impact[key];
      return typeof count === "number" && Number.isInteger(count) && count >= 0;
    })
  );
}

export interface AccountEmailAddRequest {
  address: string;
  kind: AccountEmailKind;
}

export interface AccountEmailVerifyRequest {
  email_id: string;
  code: string;
}

export interface AccountEmailSelection {
  email_id: string;
}

// The service normalizes an address before it is stored, so the boundary only has to reject
// text that cannot be an address at all.
export function normalizeEmailAddress(value: string): string | null {
  const address = value.trim().normalize("NFC").toLocaleLowerCase("en-US");
  return address.length >= 3 && address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)
    ? address
    : null;
}

export function readAccountEmailAdd(value: unknown): AccountEmailAddRequest | null {
  const input = record(value);
  if (
    input === null ||
    Object.keys(input).some((key) => key !== "address" && key !== "kind") ||
    typeof input["address"] !== "string" ||
    (input["kind"] !== "personal" && input["kind"] !== "institutional")
  ) {
    return null;
  }
  const address = normalizeEmailAddress(input["address"]);
  return address === null ? null : { address, kind: input["kind"] };
}

export function readAccountEmailVerify(value: unknown): AccountEmailVerifyRequest | null {
  const input = record(value);
  if (
    input === null ||
    Object.keys(input).some((key) => key !== "email_id" && key !== "code") ||
    typeof input["email_id"] !== "string" ||
    typeof input["code"] !== "string"
  ) {
    return null;
  }
  const code = input["code"].trim();
  return input["email_id"].length >= 1 &&
    input["email_id"].length <= 100 &&
    code.length >= 1 &&
    code.length <= 100
    ? { email_id: input["email_id"], code }
    : null;
}

export function readNotificationPreference(value: unknown): NotificationPreference | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "category" || key === "email") &&
    NOTIFICATION_CATEGORIES.includes(input["category"] as NotificationCategory) &&
    typeof input["email"] === "boolean"
    ? { category: input["category"] as NotificationCategory, email: input["email"] }
    : null;
}

export function readAccountEmailSelection(value: unknown): AccountEmailSelection | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "email_id") &&
    typeof input["email_id"] === "string" &&
    input["email_id"].length >= 1 &&
    input["email_id"].length <= 100
    ? { email_id: input["email_id"] }
    : null;
}
