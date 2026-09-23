import {
  ACCOUNT_AUTH_PATHS,
  ACCOUNT_SETTINGS_PATHS,
  WORKSPACE_COLLABORATION_PATHS,
  WORKSPACE_COEDIT_PATHS,
  WORKSPACE_SYNC_PATHS,
  ACCOUNT_SERVICE_HEALTH_PATH,
  isAccountAuthServiceResponse,
  isAccountServiceHealth,
  isGoogleAuthStartResponse,
  isAccountSettingsResult,
  readEmailVerificationRequest,
  readEmailVerificationResendRequest,
  readDeletionRequest,
  readGoogleAuthExchangeRequest,
  readGoogleAuthStartRequest,
  readPasswordAccountCreateRequest,
  readPasswordResetConfirmRequest,
  readPasswordResetRequest,
  readPasswordSignInRequest,
  readPasswordReauthenticationRequest,
  AVATAR_MEDIA_TYPES,
  MAXIMUM_AVATAR_BYTES,
  readAvatarMediaType,
  readAvatarUpload,
  readNotificationPreference,
  readPasswordSetRequest,
  CONNECTED_ACCOUNT_PATHS,
  isConnectedAccountsResult,
  readConnectionDisconnect,
  readConnectionPoll,
  readConnectionStart,
  readAccountEmailAdd,
  readAccountEmailSelection,
  readAccountEmailVerify,
  readIdentityUnlinkRequest,
  readProfileUpdate,
  readSessionRevoke,
  readSessionCredentialRequest,
  type AccountAuthResult,
  type AccountAuthServiceResponse,
  type AccountAuthState,
  type AccountIdentity,
  type AccountSettingsResult,
  type ConnectedAccountsResult,
  type WorkspaceCollaborationResult,
  type CoeditSyncResult,
  type StructuredSyncResult,
  type GoogleAuthStartResponse,
  ACCOUNT_NOTIFICATION_PATHS,
  readAccountNotificationSelection,
  isAccountNotificationsResult,
  type AccountNotificationsResult,
} from "@kiwi/contracts";
import {
  createMemorySessionVault,
  type PersistedSession,
  type SessionVault,
} from "./session-vault.js";

export type DesktopAccountServiceStatus =
  { status: "ready" } | { status: "unavailable"; retryable: true };

const CONNECTION_HOSTS = new Set([
  "github.com",
  "accounts.osf.io",
  "figshare.com",
  "zenodo.org",
  "api.mendeley.com",
  "www.zotero.org",
]);

export type IdentityMode = "sign_in" | "link" | "reauthenticate";

export interface AccountAvatarImage {
  media_type: string;
  data: string;
}

export type AccountExportResult =
  { status: "ok"; document: string } | { status: "error"; message: string; code?: string };

// A personal record is text, not a stream. One megabyte is far above any real account and
// far below anything worth holding in memory by accident.
const MAXIMUM_EXPORT_BYTES = 1_000_000;

// A malformed refusal body is still a refusal, so parsing it must not throw.
function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export interface AccountServiceClient {
  check(): Promise<DesktopAccountServiceStatus>;
  authState(): AccountAuthState;
  restore(): Promise<AccountAuthState>;
  ensureSession(): Promise<AccountAuthState>;
  signOut(): Promise<AccountAuthResult>;
  getAccountSettings(): Promise<AccountSettingsResult>;
  updateAccountProfile(input: unknown): Promise<AccountSettingsResult>;
  revokeAccountSession(input: unknown): Promise<AccountSettingsResult>;
  revokeOtherAccountSessions(): Promise<AccountSettingsResult>;
  requestAccountDeletion(input: unknown): Promise<AccountSettingsResult>;
  workspaceCollaboration(path: string, input: unknown): Promise<WorkspaceCollaborationResult>;
  workspaceSync(path: string, input: unknown): Promise<StructuredSyncResult>;
  workspaceCoedit(path: string, input: unknown): Promise<CoeditSyncResult>;
  createPasswordAccount(input: unknown): Promise<AccountAuthResult>;
  verifyEmail(input: unknown): Promise<AccountAuthResult>;
  resendEmailVerification(input: unknown): Promise<AccountAuthResult>;
  signInWithPassword(input: unknown): Promise<AccountAuthResult>;
  reauthenticateWithPassword(input: unknown): Promise<AccountAuthResult>;
  requestPasswordReset(input: unknown): Promise<AccountAuthResult>;
  resetPassword(input: unknown): Promise<AccountAuthResult>;
  startIdentity(input: unknown, mode: IdentityMode): Promise<GoogleAuthStartResponse>;
  exchangeIdentity(input: unknown, mode: IdentityMode): Promise<AccountAuthResult>;
  unlinkIdentity(input: unknown): Promise<AccountAuthResult>;
  listConnections(): Promise<ConnectedAccountsResult>;
  startConnection(input: unknown): Promise<ConnectedAccountsResult>;
  pollConnection(input: unknown): Promise<ConnectedAccountsResult>;
  disconnectConnection(input: unknown): Promise<ConnectedAccountsResult>;
  listAccountNotifications(): Promise<AccountNotificationsResult>;
  markAccountNotificationRead(input: unknown): Promise<AccountNotificationsResult>;
  dismissAccountNotification(input: unknown): Promise<AccountNotificationsResult>;
  addAccountEmail(input: unknown): Promise<AccountSettingsResult>;
  verifyAccountEmail2(input: unknown): Promise<AccountSettingsResult>;
  resendAccountEmail(input: unknown): Promise<AccountSettingsResult>;
  promoteAccountEmail(input: unknown): Promise<AccountSettingsResult>;
  setAccountNotificationEmail(input: unknown): Promise<AccountSettingsResult>;
  removeAccountEmail(input: unknown): Promise<AccountSettingsResult>;
  readAccountExport(): Promise<AccountExportResult>;
  setAccountAvatar(input: { media_type: string; data: string }): Promise<AccountSettingsResult>;
  removeAccountAvatar(): Promise<AccountSettingsResult>;
  readAccountAvatar(): Promise<AccountAvatarImage | null>;
  setAccountNotificationPreference(input: unknown): Promise<AccountSettingsResult>;
  setAccountPassword(input: unknown): Promise<AccountSettingsResult>;
  removeAccountPassword(): Promise<AccountSettingsResult>;
}

export interface AccountServiceClientOptions {
  origin: string | null;
  allowInsecureLoopback: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  deviceName?: string;
  sessionVault?: SessionVault;
  // Called with the reason a session could not be refreshed, so a window that opens
  // offline can be explained from the log instead of guessed at.
  reportSessionFailure?: (reason: string) => void;
  // Called with the reason the service was judged unreachable. Without it every cause of
  // an offline window collapses into the same silent answer.
  reportServiceUnavailable?: (reason: string) => void;
}

interface PrivateSession {
  account: AccountIdentity;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  connection: "online" | "offline";
}

const UNAVAILABLE: AccountAuthResult = {
  status: "error",
  code: "service_unavailable",
  message: "Account access is unavailable. Try again.",
};

const INVALID_INPUT: AccountAuthResult = {
  status: "error",
  code: "invalid_input",
  message: "Check the account details and try again.",
};

const INVALID_GOOGLE_START: GoogleAuthStartResponse = {
  status: "error",
  code: "invalid_callback",
  message: "Google sign-in could not start safely.",
};

const INVALID_SETTINGS: AccountSettingsResult = {
  status: "error",
  code: "invalid_input",
  message: "Check the account setting and try again.",
};

export function validateAccountServiceOrigin(
  candidate: string,
  allowInsecureLoopback: boolean,
): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  if (url.protocol === "https:") return url;
  if (allowInsecureLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1") {
    return url;
  }
  return null;
}

export function createAccountServiceClient(
  options: AccountServiceClientOptions,
): AccountServiceClient {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const deviceName = options.deviceName ?? "Kiwi desktop";
  const vault = options.sessionVault ?? createMemorySessionVault();
  const origin =
    options.origin === null
      ? null
      : validateAccountServiceOrigin(options.origin, options.allowInsecureLoopback);
  let session: PrivateSession | null = null;
  let restoreOperation: Promise<AccountAuthState> | null = null;

  async function clearSession(): Promise<void> {
    session = null;
    await vault.clear();
  }

  async function acceptAuthenticated(
    result: Extract<AccountAuthServiceResponse, { status: "authenticated" }>,
  ): Promise<AccountAuthResult> {
    session = {
      account: result.account,
      accessToken: result.access_token,
      expiresAt: Date.parse(result.expires_at),
      refreshToken: result.refresh_token,
      refreshExpiresAt: Date.parse(result.refresh_expires_at),
      connection: "online",
    };
    const persisted: PersistedSession = {
      version: 1,
      account: result.account,
      refreshToken: result.refresh_token,
      refreshExpiresAt: Date.parse(result.refresh_expires_at),
    };
    await vault.save(persisted).catch(() => undefined);
    return { status: "authenticated", account: result.account };
  }

  async function invokeAuth(path: string, body: unknown): Promise<AccountAuthResult> {
    if (origin === null) return UNAVAILABLE;
    try {
      const response = await request(new URL(path, origin), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (!isAccountAuthServiceResponse(result)) return UNAVAILABLE;
      if (result.status !== "authenticated") return result;
      return acceptAuthenticated(result);
    } catch {
      return UNAVAILABLE;
    }
  }

  // Linking and unlinking act on the signed-in account, so they carry the access
  // credential while still returning an account-auth shaped result.
  async function invokeAuthenticated(path: string, body: unknown): Promise<AccountAuthResult> {
    if (origin === null || session === null || session.accessToken === "") return UNAVAILABLE;
    try {
      const response = await request(new URL(path, origin), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (!isAccountAuthServiceResponse(result)) return UNAVAILABLE;
      if (result.status !== "authenticated") return result;
      return acceptAuthenticated(result);
    } catch {
      return UNAVAILABLE;
    }
  }

  const INVALID_CONNECTION: ConnectedAccountsResult = {
    status: "error",
    code: "invalid_input",
    message: "That connection request is not valid.",
  };

  const CONNECTIONS_UNAVAILABLE: ConnectedAccountsResult = {
    status: "error",
    code: "service_unavailable",
    message: "Connected accounts are unavailable. Try again.",
  };

  const NOTIFICATIONS_UNAVAILABLE: AccountNotificationsResult = {
    status: "error",
    code: "service_unavailable",
    message: "Notifications are unavailable. Try again.",
  };

  async function invokeNotifications(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<AccountNotificationsResult> {
    /*
      The credential is renewed first if it has run out, as it is everywhere else here.

      Notifications are polled on a timer rather than asked for by anybody, so this is the call
      most likely to be the first one made after an access token expires. Without this the poll
      sends the expired token every minute for as long as the window is open, is refused every
      time, and nothing ever asks for a new one.
    */
    if (session !== null && (session.accessToken === "" || session.expiresAt <= Date.now())) {
      await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, { refresh_token: session.refreshToken });
    }
    if (origin === null || session === null || session.accessToken === "") {
      return NOTIFICATIONS_UNAVAILABLE;
    }
    try {
      const response = await request(new URL(path, origin), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      return isAccountNotificationsResult(result) ? result : NOTIFICATIONS_UNAVAILABLE;
    } catch {
      return NOTIFICATIONS_UNAVAILABLE;
    }
  }

  // Only the provider identifier, label, and connection state cross this boundary. A
  // provider token stays in the service and is never returned to the desktop.
  async function invokeConnections(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<ConnectedAccountsResult> {
    if (origin === null || session === null || session.accessToken === "") {
      return CONNECTIONS_UNAVAILABLE;
    }
    try {
      const response = await request(new URL(path, origin), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (!isConnectedAccountsResult(result)) return CONNECTIONS_UNAVAILABLE;
      if (result.status === "browser_required" && !allowedConnectionUrl(result.authorization_url)) {
        return INVALID_CONNECTION;
      }
      return result;
    } catch {
      return CONNECTIONS_UNAVAILABLE;
    }
  }

  async function invokeSettings(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<AccountSettingsResult> {
    if (session !== null && (session.accessToken === "" || session.expiresAt <= Date.now())) {
      const refreshed = await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, {
        refresh_token: session.refreshToken,
      });
      if (refreshed.status !== "authenticated") {
        return {
          status: "error",
          code: "service_unavailable",
          message: "Account settings are unavailable. Try again.",
        };
      }
    }
    if (origin === null || session === null || session.accessToken === "") {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Account settings are unavailable. Try again.",
      };
    }
    try {
      const response = await request(new URL(path, origin), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      return isAccountSettingsResult(result)
        ? result
        : {
            status: "error",
            code: "service_unavailable",
            message: "Account settings are unavailable. Try again.",
          };
    } catch {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Account settings are unavailable. Try again.",
      };
    }
  }

  async function invokeCollaboration(
    path: string,
    input: unknown,
  ): Promise<WorkspaceCollaborationResult> {
    if (
      !(Object.values(WORKSPACE_COLLABORATION_PATHS) as readonly string[]).includes(path) ||
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return {
        status: "error",
        code: "invalid_input",
        message: "The workspace request is not valid.",
      };
    }
    if (session !== null && (session.accessToken === "" || session.expiresAt <= Date.now())) {
      await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, { refresh_token: session.refreshToken });
    }
    if (origin === null || session === null || session.accessToken === "") {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Workspace collaboration is unavailable.",
      };
    }
    try {
      const response = await request(new URL(path, origin), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || Array.isArray(result))
        throw new Error("invalid");
      const status = (result as Record<string, unknown>)["status"];
      if (status !== "ok" && status !== "queued" && status !== "error") throw new Error("invalid");
      return result as WorkspaceCollaborationResult;
    } catch {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Workspace collaboration is unavailable.",
      };
    }
  }

  async function invokeWorkspaceSync(path: string, input: unknown): Promise<StructuredSyncResult> {
    if (
      !(Object.values(WORKSPACE_SYNC_PATHS) as readonly string[]).includes(path) ||
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return { status: "error", code: "invalid_input", message: "The sync request is not valid." };
    }
    if (session !== null && (session.accessToken === "" || session.expiresAt <= Date.now())) {
      await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, { refresh_token: session.refreshToken });
    }
    if (origin === null || session === null || session.accessToken === "") {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Workspace synchronization is unavailable.",
      };
    }
    try {
      const response = await request(new URL(path, origin), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || Array.isArray(result))
        throw new Error("invalid");
      const status = (result as Record<string, unknown>)["status"];
      if (!["accepted", "conflict", "changes", "error"].includes(String(status)))
        throw new Error("invalid");
      return result as StructuredSyncResult;
    } catch {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Workspace synchronization is unavailable.",
      };
    }
  }

  async function invokeWorkspaceCoedit(path: string, input: unknown): Promise<CoeditSyncResult> {
    if (
      !(Object.values(WORKSPACE_COEDIT_PATHS) as readonly string[]).includes(path) ||
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return {
        status: "error",
        code: "invalid_input",
        message: "The coediting request is not valid.",
      };
    }
    if (session !== null && (session.accessToken === "" || session.expiresAt <= Date.now())) {
      await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, { refresh_token: session.refreshToken });
    }
    if (origin === null || session === null || session.accessToken === "") {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Live collaboration is unavailable.",
      };
    }
    try {
      const response = await request(new URL(path, origin), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || Array.isArray(result))
        throw new Error("invalid");
      const status = (result as Record<string, unknown>)["status"];
      if (
        !["operations_accepted", "operations", "presence", "documents", "error"].includes(
          String(status),
        )
      )
        throw new Error("invalid");
      return result as CoeditSyncResult;
    } catch {
      return {
        status: "error",
        code: "service_unavailable",
        message: "Live collaboration is unavailable.",
      };
    }
  }

  // A connection authorization page must be an https page at the provider itself.
  function allowedConnectionUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        CONNECTION_HOSTS.has(url.hostname)
      );
    } catch {
      return false;
    }
  }

  function allowedGoogleAuthorizationUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
      if (
        url.protocol === "https:" &&
        url.hostname === "accounts.google.com" &&
        url.pathname === "/o/oauth2/v2/auth"
      ) {
        return true;
      }
      if (
        url.protocol === "https:" &&
        (url.hostname === "orcid.org" || url.hostname === "sandbox.orcid.org") &&
        url.pathname === "/oauth/authorize"
      ) {
        return true;
      }
      return (
        options.allowInsecureLoopback &&
        origin !== null &&
        url.origin === origin.origin &&
        url.pathname === ACCOUNT_AUTH_PATHS.googleFixtureAuthorize
      );
    } catch {
      return false;
    }
  }

  return {
    async check(): Promise<DesktopAccountServiceStatus> {
      if (origin === null) {
        options.reportServiceUnavailable?.("no account service origin is configured");
        return { status: "unavailable", retryable: true };
      }
      try {
        const response = await request(new URL(ACCOUNT_SERVICE_HEALTH_PATH, origin), {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body: unknown = await response.json();
        if (!isAccountServiceHealth(body) || !response.ok || body.status !== "ready") {
          options.reportServiceUnavailable?.(
            `${origin.toString()} answered ${String(response.status)}${
              isAccountServiceHealth(body) ? ` and reported ${body.status}` : " with no health body"
            }`,
          );
          return { status: "unavailable", retryable: true };
        }
        return { status: "ready" };
      } catch (cause) {
        // A refused connection during the first second of a launch and a service that is
        // genuinely absent are the same result here, and only the message tells them apart.
        options.reportServiceUnavailable?.(
          `${origin.toString()} could not be reached: ${
            cause instanceof Error ? cause.message : "unknown error"
          }`,
        );
        return { status: "unavailable", retryable: true };
      }
    },

    authState(): AccountAuthState {
      if (
        session === null ||
        !Number.isFinite(session.refreshExpiresAt) ||
        session.refreshExpiresAt <= Date.now()
      ) {
        session = null;
        return { status: "signed_out" };
      }
      return {
        status: "authenticated",
        account: session.account,
        connection: session.connection,
      };
    },

    async restore(): Promise<AccountAuthState> {
      if (restoreOperation !== null) return restoreOperation;
      restoreOperation = (async () => {
        if (session === null) {
          const persisted = await vault.load();
          if (persisted === null || persisted.refreshExpiresAt <= Date.now()) {
            await clearSession();
            return { status: "signed_out" } as AccountAuthState;
          }
          session = {
            account: persisted.account,
            accessToken: "",
            expiresAt: 0,
            refreshToken: persisted.refreshToken,
            refreshExpiresAt: persisted.refreshExpiresAt,
            connection: "offline",
          };
        }
        return this.ensureSession();
      })().finally(() => {
        restoreOperation = null;
      });
      return restoreOperation;
    },

    async ensureSession(): Promise<AccountAuthState> {
      if (session === null || session.refreshExpiresAt <= Date.now()) {
        await clearSession();
        return { status: "signed_out" };
      }
      if (session.accessToken !== "" && session.expiresAt > Date.now()) return this.authState();
      const credential = readSessionCredentialRequest({ refresh_token: session.refreshToken });
      if (credential === null) {
        await clearSession();
        return { status: "signed_out" };
      }
      const result = await invokeAuth(ACCOUNT_AUTH_PATHS.refreshSession, credential);
      if (result.status === "authenticated") return this.authState();
      // Offline and signed-out look the same from the window but mean opposite things.
      // Recording which one happened, and why, is what makes the difference diagnosable.
      options.reportSessionFailure?.(
        result.status === "error"
          ? `refresh refused: ${result.code} (origin ${origin ?? "not configured"})`
          : `refresh returned ${result.status} (origin ${origin ?? "not configured"})`,
      );
      if (result.status === "error" && result.code === "service_unavailable") {
        session.connection = "offline";
        return this.authState();
      }
      await clearSession();
      return { status: "signed_out" };
    },

    async signOut(): Promise<AccountAuthResult> {
      const refreshToken = session?.refreshToken;
      if (refreshToken !== undefined && origin !== null) {
        await invokeAuth(ACCOUNT_AUTH_PATHS.signOut, { refresh_token: refreshToken });
      }
      await clearSession();
      return { status: "signed_out" };
    },

    async getAccountSettings(): Promise<AccountSettingsResult> {
      return invokeSettings(ACCOUNT_SETTINGS_PATHS.snapshot, "GET");
    },

    async listConnections(): Promise<ConnectedAccountsResult> {
      return invokeConnections(CONNECTED_ACCOUNT_PATHS.list, "GET");
    },

    async startConnection(input): Promise<ConnectedAccountsResult> {
      const parsed = readConnectionStart(input);
      return parsed === null
        ? INVALID_CONNECTION
        : invokeConnections(CONNECTED_ACCOUNT_PATHS.start, "POST", parsed);
    },

    async pollConnection(input): Promise<ConnectedAccountsResult> {
      const parsed = readConnectionPoll(input);
      return parsed === null
        ? INVALID_CONNECTION
        : invokeConnections(CONNECTED_ACCOUNT_PATHS.poll, "POST", parsed);
    },

    async disconnectConnection(input): Promise<ConnectedAccountsResult> {
      const parsed = readConnectionDisconnect(input);
      return parsed === null
        ? INVALID_CONNECTION
        : invokeConnections(CONNECTED_ACCOUNT_PATHS.disconnect, "POST", parsed);
    },

    async addAccountEmail(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailAdd(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailAdd, "POST", parsed);
    },

    async verifyAccountEmail2(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailVerify(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailVerify, "POST", parsed);
    },

    async resendAccountEmail(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailSelection(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailResend, "POST", parsed);
    },

    async promoteAccountEmail(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailSelection(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailPromote, "POST", parsed);
    },

    async setAccountNotificationEmail(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailSelection(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailNotifications, "POST", parsed);
    },

    async removeAccountEmail(input): Promise<AccountSettingsResult> {
      const parsed = readAccountEmailSelection(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.emailRemove, "POST", parsed);
    },

    async removeAccountPassword(): Promise<AccountSettingsResult> {
      return invokeSettings(ACCOUNT_SETTINGS_PATHS.passwordRemove, "POST", {});
    },

    async setAccountAvatar(input): Promise<AccountSettingsResult> {
      const parsed = readAvatarUpload(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.avatar, "POST", parsed);
    },

    async removeAccountAvatar(): Promise<AccountSettingsResult> {
      return invokeSettings(ACCOUNT_SETTINGS_PATHS.avatar, "DELETE");
    },

    // The image comes back as bytes. It becomes a data URL in the main process, so the
    // renderer receives a picture and never a path or a handle it could ask more of.
    async readAccountAvatar(): Promise<AccountAvatarImage | null> {
      if (origin === null || session === null || session.accessToken === "") return null;
      try {
        const response = await request(new URL(ACCOUNT_SETTINGS_PATHS.avatar, origin), {
          method: "GET",
          headers: { accept: "image/*", authorization: `Bearer ${session.accessToken}` },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const mediaType = response.headers.get("content-type") ?? "";
        if (!response.ok || !AVATAR_MEDIA_TYPES.includes(mediaType as never)) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_AVATAR_BYTES) return null;
        // The declared type is checked against the bytes here too, because this value is
        // about to become a data URL the renderer will hand to the image decoder.
        return readAvatarMediaType(bytes) === mediaType
          ? { media_type: mediaType, data: Buffer.from(bytes).toString("base64") }
          : null;
      } catch {
        return null;
      }
    },

    // The export is returned as text. It is written straight to the chosen file and is
    // never parsed into a shape the renderer could ask for.
    async readAccountExport(): Promise<AccountExportResult> {
      if (origin === null || session === null || session.accessToken === "") {
        return { status: "error", message: "Account settings are unavailable. Try again." };
      }
      try {
        const response = await request(new URL(ACCOUNT_SETTINGS_PATHS.export, origin), {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${session.accessToken}`,
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.text();
        if (!response.ok || body.length > MAXIMUM_EXPORT_BYTES) {
          const refused: unknown = response.ok ? null : safeParse(body);
          return {
            status: "error",
            message:
              isAccountSettingsResult(refused) && refused.status === "error"
                ? refused.message
                : "Kiwi could not assemble the export. Try again.",
            ...(isAccountSettingsResult(refused) && refused.status === "error"
              ? { code: refused.code }
              : {}),
          };
        }
        return { status: "ok", document: body };
      } catch {
        return { status: "error", message: "Account settings are unavailable. Try again." };
      }
    },

    async setAccountNotificationPreference(input): Promise<AccountSettingsResult> {
      const parsed = readNotificationPreference(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.notificationPreference, "POST", parsed);
    },

    async setAccountPassword(input): Promise<AccountSettingsResult> {
      const parsed = readPasswordSetRequest(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.passwordSet, "POST", parsed);
    },

    async updateAccountProfile(input): Promise<AccountSettingsResult> {
      const parsed = readProfileUpdate(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.profile, "PATCH", parsed);
    },

    async revokeAccountSession(input): Promise<AccountSettingsResult> {
      const parsed = readSessionRevoke(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.revokeSession, "POST", parsed);
    },

    async revokeOtherAccountSessions(): Promise<AccountSettingsResult> {
      return invokeSettings(ACCOUNT_SETTINGS_PATHS.revokeOtherSessions, "POST");
    },

    async requestAccountDeletion(input): Promise<AccountSettingsResult> {
      const parsed = readDeletionRequest(input);
      return parsed === null
        ? INVALID_SETTINGS
        : invokeSettings(ACCOUNT_SETTINGS_PATHS.requestDeletion, "POST", parsed);
    },

    async workspaceCollaboration(path, input): Promise<WorkspaceCollaborationResult> {
      return invokeCollaboration(path, input);
    },

    async workspaceSync(path, input): Promise<StructuredSyncResult> {
      return invokeWorkspaceSync(path, input);
    },

    async workspaceCoedit(path, input): Promise<CoeditSyncResult> {
      return invokeWorkspaceCoedit(path, input);
    },

    async createPasswordAccount(input): Promise<AccountAuthResult> {
      const parsed = readPasswordAccountCreateRequest(input);
      return parsed === null ? INVALID_INPUT : invokeAuth(ACCOUNT_AUTH_PATHS.create, parsed);
    },

    async verifyEmail(input): Promise<AccountAuthResult> {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return INVALID_INPUT;
      const parsed = readEmailVerificationRequest({
        ...(input as Record<string, unknown>),
        device_name: deviceName,
      });
      return parsed === null ? INVALID_INPUT : invokeAuth(ACCOUNT_AUTH_PATHS.verifyEmail, parsed);
    },

    async resendEmailVerification(input): Promise<AccountAuthResult> {
      const parsed = readEmailVerificationResendRequest(input);
      return parsed === null
        ? INVALID_INPUT
        : invokeAuth(ACCOUNT_AUTH_PATHS.resendEmailVerification, parsed);
    },

    async signInWithPassword(input): Promise<AccountAuthResult> {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return INVALID_INPUT;
      const parsed = readPasswordSignInRequest({
        ...(input as Record<string, unknown>),
        device_name: deviceName,
      });
      return parsed === null ? INVALID_INPUT : invokeAuth(ACCOUNT_AUTH_PATHS.signIn, parsed);
    },

    async reauthenticateWithPassword(input): Promise<AccountAuthResult> {
      const parsed = readPasswordReauthenticationRequest(input);
      return parsed === null
        ? INVALID_INPUT
        : invokeAuthenticated(ACCOUNT_AUTH_PATHS.passwordReauthenticate, parsed);
    },

    async requestPasswordReset(input): Promise<AccountAuthResult> {
      const parsed = readPasswordResetRequest(input);
      return parsed === null
        ? INVALID_INPUT
        : invokeAuth(ACCOUNT_AUTH_PATHS.requestPasswordReset, parsed);
    },

    async resetPassword(input): Promise<AccountAuthResult> {
      const parsed = readPasswordResetConfirmRequest(input);
      const result =
        parsed === null
          ? INVALID_INPUT
          : await invokeAuth(ACCOUNT_AUTH_PATHS.resetPassword, parsed);
      if (result.status === "password_reset") session = null;
      return result;
    },

    async startIdentity(input, mode): Promise<GoogleAuthStartResponse> {
      const parsed = readGoogleAuthStartRequest(input);
      if (parsed === null || origin === null) return INVALID_GOOGLE_START;
      const path =
        mode === "link"
          ? ACCOUNT_AUTH_PATHS.identityLinkStart
          : mode === "reauthenticate"
            ? ACCOUNT_AUTH_PATHS.identityReauthenticateStart
            : ACCOUNT_AUTH_PATHS.googleStart;
      try {
        const response = await request(new URL(path, origin), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(mode !== "sign_in" && session !== null
              ? { authorization: `Bearer ${session.accessToken}` }
              : {}),
          },
          body: JSON.stringify(parsed),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const result: unknown = await response.json();
        if (!isGoogleAuthStartResponse(result)) return INVALID_GOOGLE_START;
        if (
          result.status === "browser_required" &&
          !allowedGoogleAuthorizationUrl(result.authorization_url)
        ) {
          return INVALID_GOOGLE_START;
        }
        return result;
      } catch {
        return {
          status: "error",
          code: "service_unavailable",
          message: "Google sign-in is unavailable. Try another method.",
        };
      }
    },

    async exchangeIdentity(input, mode): Promise<AccountAuthResult> {
      const parsed = readGoogleAuthExchangeRequest(input);
      if (parsed === null) return INVALID_INPUT;
      return mode === "link"
        ? invokeAuthenticated(ACCOUNT_AUTH_PATHS.identityLinkExchange, parsed)
        : mode === "reauthenticate"
          ? invokeAuthenticated(ACCOUNT_AUTH_PATHS.identityReauthenticateExchange, parsed)
          : invokeAuth(ACCOUNT_AUTH_PATHS.googleExchange, parsed);
    },

    async unlinkIdentity(input): Promise<AccountAuthResult> {
      const parsed = readIdentityUnlinkRequest(input);
      return parsed === null
        ? INVALID_INPUT
        : invokeAuthenticated(ACCOUNT_AUTH_PATHS.identityUnlink, parsed);
    },

    async listAccountNotifications(): Promise<AccountNotificationsResult> {
      return invokeNotifications(ACCOUNT_NOTIFICATION_PATHS.list, "GET");
    },

    async markAccountNotificationRead(input): Promise<AccountNotificationsResult> {
      const parsed = readAccountNotificationSelection(input);
      return parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a notification." }
        : invokeNotifications(ACCOUNT_NOTIFICATION_PATHS.read, "POST", parsed);
    },

    async dismissAccountNotification(input): Promise<AccountNotificationsResult> {
      const parsed = readAccountNotificationSelection(input);
      return parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a notification." }
        : invokeNotifications(ACCOUNT_NOTIFICATION_PATHS.dismiss, "POST", parsed);
    },
  };
}
