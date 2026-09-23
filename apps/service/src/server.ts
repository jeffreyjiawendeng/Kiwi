import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ACCOUNT_AUTH_PATHS,
  ACCOUNT_SETTINGS_PATHS,
  WORKSPACE_COLLABORATION_PATHS,
  WORKSPACE_SYNC_PATHS,
  WORKSPACE_COEDIT_PATHS,
  ACCOUNT_SERVICE_HEALTH_PATH,
  readEmailVerificationRequest,
  readEmailVerificationResendRequest,
  readGoogleAuthExchangeRequest,
  readGoogleAuthStartRequest,
  readPasswordAccountCreateRequest,
  readPasswordResetConfirmRequest,
  readPasswordResetRequest,
  readPasswordReauthenticationRequest,
  readPasswordSignInRequest,
  readSessionCredentialRequest,
  readDeletionRequest,
  MAXIMUM_AVATAR_BYTES,
  readAvatarUpload,
  readNotificationPreference,
  readPasswordSetRequest,
  CONNECTED_ACCOUNT_PATHS,
  readConnectionDisconnect,
  readConnectionPoll,
  readConnectionStart,
  readAccountEmailAdd,
  readAccountEmailSelection,
  readAccountEmailVerify,
  readIdentityUnlinkRequest,
  type ConnectedAccountsResult,
  readProfileUpdate,
  readSessionRevoke,
  readWorkspaceCollaborationRequest,
  readStructuredSyncRequest,
  readCoeditSyncRequest,
  type AccountAuthServiceResponse,
  type AccountServiceHealth,
  type GoogleAuthStartResponse,
  type AccountSettingsResult,
  ACCOUNT_NOTIFICATION_PATHS,
  readAccountNotificationSelection,
  type AccountNotificationsResult,
} from "@kiwi/contracts";
import type { PasswordAuthService } from "./auth-service.js";
import type { OidcAuthService } from "./oidc-auth-service.js";
import type { ConnectionsService } from "./connections-service.js";
import type { SessionService } from "./session-service.js";
import type { AccountSettingsService } from "./account-settings-service.js";
import type { WorkspaceCollaborationService } from "./workspace-collaboration-service.js";
import type { WorkspaceSyncService } from "./workspace-sync-service.js";
import type { WorkspaceCoeditService } from "./workspace-coedit-service.js";
import type { ServiceReadiness } from "./readiness.js";
import type { AccountNotificationsService } from "./account-notifications-service.js";

const MAX_AUTH_BODY_BYTES = 8 * 1_024;

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, RESPONSE_HEADERS);
  response.end(JSON.stringify(body));
}

function requestUrl(request: IncomingMessage): URL | null {
  if (request.url === undefined) return null;
  try {
    return new URL(request.url, "http://127.0.0.1");
  } catch {
    return null;
  }
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = MAX_AUTH_BODY_BYTES,
): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("unsupported_content_type");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximumBytes) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("invalid_json");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleWorkspaceSync(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  sync: WorkspaceSyncService,
): Promise<void> {
  const token = accessCredential(request);
  let body: unknown;
  try {
    body = await readJson(request, 1_250_000);
  } catch {
    body = null;
  }
  const parsed = readStructuredSyncRequest(path, body);
  if (token === null || parsed === null) {
    writeJson(response, token === null ? 401 : 400, {
      status: "error",
      code: token === null ? "forbidden" : "invalid_input",
      message:
        token === null ? "Your session is no longer authorized." : "The sync request is not valid.",
    });
    return;
  }
  const result =
    path === WORKSPACE_SYNC_PATHS.submit
      ? await sync.submit(token, parsed as Parameters<WorkspaceSyncService["submit"]>[1])
      : await sync.pull(token, parsed as Parameters<WorkspaceSyncService["pull"]>[1]);
  writeJson(
    response,
    result.status === "error"
      ? result.code === "forbidden"
        ? 403
        : result.code === "not_found"
          ? 404
          : 400
      : 200,
    result,
  );
}

async function handleWorkspaceCoedit(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  coedit: WorkspaceCoeditService,
): Promise<void> {
  const token = accessCredential(request);
  let body: unknown;
  try {
    body = await readJson(request, 1_250_000);
  } catch {
    body = null;
  }
  const parsed = readCoeditSyncRequest(path, body);
  if (token === null || parsed === null) {
    writeJson(response, token === null ? 401 : 400, {
      status: "error",
      code: token === null ? "forbidden" : "invalid_input",
      message:
        token === null
          ? "Your session is no longer authorized."
          : "The coediting request is not valid.",
    });
    return;
  }
  const result =
    path === WORKSPACE_COEDIT_PATHS.documents
      ? await coedit.documents(token, parsed as Parameters<WorkspaceCoeditService["documents"]>[1])
      : path === WORKSPACE_COEDIT_PATHS.push
        ? await coedit.push(token, parsed as Parameters<WorkspaceCoeditService["push"]>[1])
        : path === WORKSPACE_COEDIT_PATHS.pull
          ? await coedit.pull(token, parsed as Parameters<WorkspaceCoeditService["pull"]>[1])
          : await coedit.presence(
              token,
              parsed as Parameters<WorkspaceCoeditService["presence"]>[1],
            );
  writeJson(response, result.status === "error" ? 403 : 200, result);
}

function authStatus(result: AccountAuthServiceResponse): number {
  if (result.status === "accepted") return 202;
  if (result.status !== "error") return 200;
  if (result.code === "rate_limited") return 429;
  if (result.code === "invalid_credentials") return 401;
  if (result.code === "verification_required") return 403;
  if (result.code === "recent_auth_required") return 403;
  if (result.code === "service_unavailable") return 503;
  return 400;
}

function writeAuth(response: ServerResponse, result: AccountAuthServiceResponse): void {
  if (result.status === "error" && result.retry_after_seconds !== undefined) {
    response.setHeader("retry-after", String(result.retry_after_seconds));
  }
  writeJson(response, authStatus(result), result);
}

function writeGoogleStart(response: ServerResponse, result: GoogleAuthStartResponse): void {
  if (result.status === "browser_required") {
    writeJson(response, 200, result);
  } else {
    writeAuth(response, result);
  }
}

function accessCredential(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return token.length >= 1 && token.length <= 512 && !/\s/u.test(token) ? token : null;
}

function writeSettings(response: ServerResponse, result: AccountSettingsResult): void {
  const status =
    result.status !== "error"
      ? 200
      : result.code === "forbidden"
        ? 401
        : result.code === "recent_auth_required"
          ? 403
          : result.code === "rate_limited"
            ? 429
            : result.code === "service_unavailable"
              ? 503
              : 400;
  writeJson(response, status, result);
}

function writeConnections(response: ServerResponse, result: ConnectedAccountsResult): void {
  const status =
    result.status !== "error"
      ? 200
      : result.code === "forbidden"
        ? 403
        : result.code === "recent_auth_required"
          ? 403
          : result.code === "invalid_input"
            ? 400
            : result.code === "not_configured"
              ? 409
              : 503;
  writeJson(response, status, result);
}

function writeNotifications(response: ServerResponse, result: AccountNotificationsResult): void {
  writeJson(
    response,
    result.status === "error"
      ? result.code === "forbidden"
        ? 401
        : result.code === "invalid_input"
          ? 400
          : 503
      : 200,
    result,
  );
}

async function handleAccountNotifications(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  notifications: AccountNotificationsService,
  settings: AccountSettingsService,
): Promise<void> {
  const token = accessCredential(request);
  const account = token === null ? null : await settings.authenticatedAccountId(token);
  if (account === null) {
    writeNotifications(response, {
      status: "error",
      code: "forbidden",
      message: "Your session is no longer authorized. Sign in again.",
    });
    return;
  }
  if (path === ACCOUNT_NOTIFICATION_PATHS.list) {
    writeNotifications(response, await notifications.list(account.accountId));
    return;
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    body = null;
  }
  const selected = readAccountNotificationSelection(body);
  if (selected === null) {
    writeNotifications(response, {
      status: "error",
      code: "invalid_input",
      message: "Choose a notification.",
    });
    return;
  }
  writeNotifications(
    response,
    path === ACCOUNT_NOTIFICATION_PATHS.read
      ? await notifications.markRead(account.accountId, selected.notification_id)
      : await notifications.dismiss(account.accountId, selected.notification_id),
  );
}

const CONNECTION_PAGE_STYLE =
  ":root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;" +
  "align-items:center;justify-content:center;padding:2rem;background:#f6f8f5;color:#182019;" +
  'font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:14px}' +
  "main{max-width:26rem;text-align:center}h1{margin:0;font-size:1.25rem;font-weight:600;" +
  "color:#2f713d}h1.problem{color:#c42b1c}p{margin:.5rem 0 0;line-height:1.5;color:#657066}" +
  "@media(prefers-color-scheme:dark){body{background:#151a16;color:#edf3ed}h1{color:#63a96f}" +
  "h1.problem{color:#e88b82}p{color:#aab6ab}}@media(forced-colors:active){body{" +
  "forced-color-adjust:none;background:Canvas;color:CanvasText}h1,h1.problem,p{color:CanvasText}}";

const CONNECTION_STYLE_HASH = createHash("sha256")
  .update(CONNECTION_PAGE_STYLE, "utf8")
  .digest("base64");

function writeConnectionPage(
  response: ServerResponse,
  status: number,
  heading: string,
  detail: string,
  problem: boolean,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'sha256-${CONNECTION_STYLE_HASH}'`,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>Return to Kiwi</title><style>${CONNECTION_PAGE_STYLE}</style></head><body><main>` +
      `<h1${problem ? ' class="problem"' : ""}>${heading}</h1><p>${detail}</p>` +
      `</main></body></html>`,
  );
}

async function handleConnections(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  connections: ConnectionsService,
  settings: AccountSettingsService,
): Promise<void> {
  const token = accessCredential(request);
  if (token === null) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  const account = await settings.authenticatedAccountId(token);
  if (account === null) {
    writeConnections(response, {
      status: "error",
      code: "forbidden",
      message: "Your session is no longer authorized. Sign in again.",
    });
    return;
  }
  if (path === CONNECTED_ACCOUNT_PATHS.list) {
    writeConnections(response, await connections.list(account.accountId));
    return;
  }
  // Authorizing or revoking an external service changes what this account can reach, so it
  // needs a recent sign-in rather than only a live session. Polling reports an in-progress
  // authorization and changes nothing on its own.
  if (path !== CONNECTED_ACCOUNT_PATHS.poll && !account.recentlyAuthenticated) {
    writeConnections(response, {
      status: "error",
      code: "recent_auth_required",
      message: "Sign in again before changing connected accounts.",
    });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    body = null;
  }
  if (path === CONNECTED_ACCOUNT_PATHS.start) {
    const parsed = readConnectionStart(body);
    writeConnections(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a service to connect." }
        : await connections.start(account.accountId, parsed.provider),
    );
    return;
  }
  if (path === CONNECTED_ACCOUNT_PATHS.poll) {
    const parsed = readConnectionPoll(body);
    writeConnections(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "That connection is not in progress." }
        : await connections.poll(account.accountId, parsed.transaction_id),
    );
    return;
  }
  const parsed = readConnectionDisconnect(body);
  writeConnections(
    response,
    parsed === null
      ? { status: "error", code: "invalid_input", message: "Choose a service to disconnect." }
      : await connections.disconnect(account.accountId, parsed.provider),
  );
}

async function handleIdentityAccount(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  identity: OidcAuthService | null,
  settings: AccountSettingsService,
): Promise<void> {
  const token = accessCredential(request);
  if (token === null) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    body = null;
  }
  const account = await settings.authenticatedAccountId(token);
  if (account === null) {
    writeAuth(response, {
      status: "error",
      code: "session_expired",
      message: "Your session is no longer authorized. Sign in again.",
    });
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.passwordReauthenticate) {
    const parsed = readPasswordReauthenticationRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Enter your password." }
        : await settings.reauthenticatePassword(token, parsed),
    );
    return;
  }
  if (identity === null) {
    writeAuth(response, {
      status: "error",
      code: "service_unavailable",
      message: "Provider confirmation is unavailable. Try another sign-in method.",
    });
    return;
  }
  // ADR-0031 requires recent authentication before a sign-in method changes.
  const isReauthentication =
    path === ACCOUNT_AUTH_PATHS.identityReauthenticateStart ||
    path === ACCOUNT_AUTH_PATHS.identityReauthenticateExchange;
  if (!isReauthentication && !account.recentlyAuthenticated) {
    writeAuth(response, {
      status: "error",
      code: "recent_auth_required",
      message: "Sign in again before changing a sign-in method.",
    });
    return;
  }

  if (path === ACCOUNT_AUTH_PATHS.identityUnlink) {
    const parsed = readIdentityUnlinkRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a sign-in method." }
        : await identity.unlink(account.accountId, parsed.provider),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.identityLinkStart) {
    const parsed = readGoogleAuthStartRequest(body);
    const started =
      parsed === null
        ? null
        : await identity.start(parsed, { kind: "link", userId: account.accountId });
    if (started === null) {
      writeAuth(response, {
        status: "error",
        code: "invalid_callback",
        message: "Sign-in could not start safely.",
      });
      return;
    }
    if (started.status === "browser_required") {
      writeJson(response, 200, started);
      return;
    }
    writeAuth(response, started);
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.identityReauthenticateStart) {
    const parsed = readGoogleAuthStartRequest(body);
    const started =
      parsed === null
        ? null
        : await identity.start(parsed, { kind: "reauthenticate", sessionId: account.sessionId });
    if (started === null) {
      writeAuth(response, {
        status: "error",
        code: "invalid_callback",
        message: "Sign-in could not start safely.",
      });
      return;
    }
    writeGoogleStart(response, started);
    return;
  }
  const parsed = readGoogleAuthExchangeRequest(body);
  writeAuth(
    response,
    parsed === null
      ? { status: "error", code: "invalid_callback", message: "Sign-in could not be verified." }
      : await identity.exchange(
          parsed,
          path === ACCOUNT_AUTH_PATHS.identityReauthenticateExchange
            ? { userId: account.accountId, sessionId: account.sessionId }
            : undefined,
        ),
  );
}

const EMAIL_PATHS: readonly string[] = [
  ACCOUNT_SETTINGS_PATHS.emailAdd,
  ACCOUNT_SETTINGS_PATHS.emailVerify,
  ACCOUNT_SETTINGS_PATHS.emailResend,
  ACCOUNT_SETTINGS_PATHS.emailPromote,
  ACCOUNT_SETTINGS_PATHS.emailNotifications,
  ACCOUNT_SETTINGS_PATHS.emailRemove,
  ACCOUNT_SETTINGS_PATHS.notificationPreference,
];

async function handleAccountSettings(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  settings: AccountSettingsService,
): Promise<void> {
  const accessToken = accessCredential(request);
  if (accessToken === null) {
    writeSettings(response, {
      status: "error",
      code: "forbidden",
      message: "Your session is no longer authorized. Sign in again.",
    });
    return;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.snapshot && request.method === "GET") {
    writeSettings(response, await settings.snapshot(accessToken));
    return;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.avatar) {
    if (request.method === "GET") {
      const read = await settings.readAvatar(accessToken);
      if (!("avatar" in read)) writeSettings(response, read);
      else if (read.avatar === null) writeJson(response, 404, { error: "not_found" });
      else {
        response.writeHead(200, {
          ...RESPONSE_HEADERS,
          "content-type": read.avatar.mediaType,
          "content-length": String(read.avatar.bytes.byteLength),
          etag: `"${read.avatar.contentHash}"`,
        });
        response.end(read.avatar.bytes);
      }
      return;
    }
    if (request.method === "DELETE") {
      writeSettings(response, await settings.removeAvatar(accessToken));
      return;
    }
    if (request.method === "POST") {
      let avatarBody: unknown;
      try {
        // Base64 costs a third more than the bytes it carries, so the body cap is the
        // image cap grown by that ratio plus room for the surrounding JSON.
        avatarBody = await readJson(request, Math.ceil(MAXIMUM_AVATAR_BYTES * 1.4));
      } catch {
        avatarBody = null;
      }
      const parsed = readAvatarUpload(avatarBody);
      writeSettings(
        response,
        parsed === null
          ? {
              status: "error",
              code: "invalid_input",
              message: "Choose a PNG, JPEG, or WebP image under 512 KB.",
            }
          : await settings.setAvatar(accessToken, parsed),
      );
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.export && request.method === "GET") {
    const exported = await settings.exportAccount(accessToken);
    // The export document is not a settings result. It leaves as its own body so the
    // desktop can write it straight to the chosen file.
    if ("export" in exported) writeJson(response, 200, exported.export);
    else writeSettings(response, exported);
    return;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.revokeOtherSessions && request.method === "POST") {
    writeSettings(response, await settings.revokeOtherSessions(accessToken));
    return;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.passwordRemove && request.method === "POST") {
    writeSettings(response, await settings.removePassword(accessToken));
    return;
  }
  if (!(
    (path === ACCOUNT_SETTINGS_PATHS.profile && request.method === "PATCH") ||
    (path === ACCOUNT_SETTINGS_PATHS.revokeSession && request.method === "POST") ||
    (path === ACCOUNT_SETTINGS_PATHS.requestDeletion && request.method === "POST") ||
    (path === ACCOUNT_SETTINGS_PATHS.passwordSet && request.method === "POST") ||
    (EMAIL_PATHS.includes(path) && request.method === "POST")
  )) {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    body = null;
  }
  if (path === ACCOUNT_SETTINGS_PATHS.profile) {
    const parsed = readProfileUpdate(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Check the profile fields." }
        : await settings.updateProfile(accessToken, parsed),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailAdd) {
    const parsed = readAccountEmailAdd(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Enter a valid email address." }
        : await settings.addEmail(accessToken, parsed),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailVerify) {
    const parsed = readAccountEmailVerify(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Enter the verification code." }
        : await settings.verifyEmail(accessToken, parsed),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailResend) {
    const parsed = readAccountEmailSelection(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a pending address." }
        : await settings.resendEmail(accessToken, parsed.email_id),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailPromote) {
    const parsed = readAccountEmailSelection(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose an address." }
        : await settings.promoteEmail(accessToken, parsed.email_id),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailNotifications) {
    const parsed = readAccountEmailSelection(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose an address." }
        : await settings.setNotificationEmail(accessToken, parsed.email_id),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.emailRemove) {
    const parsed = readAccountEmailSelection(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose an address." }
        : await settings.removeEmail(accessToken, parsed.email_id),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.notificationPreference) {
    const parsed = readNotificationPreference(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a notification category." }
        : await settings.setNotificationPreference(accessToken, parsed),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.passwordSet) {
    const parsed = readPasswordSetRequest(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Enter a new password." }
        : await settings.setPassword(accessToken, parsed),
    );
  } else if (path === ACCOUNT_SETTINGS_PATHS.revokeSession) {
    const parsed = readSessionRevoke(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Choose a valid session." }
        : await settings.revokeSession(accessToken, parsed.session_id),
    );
  } else {
    const parsed = readDeletionRequest(body);
    writeSettings(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "Type DELETE to confirm." }
        : await settings.requestDeletion(accessToken),
    );
  }
}

async function handleWorkspaceCollaboration(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  collaboration: WorkspaceCollaborationService,
): Promise<void> {
  const token = accessCredential(request);
  let input: unknown;
  try {
    input = await readJson(request);
  } catch {
    input = null;
  }
  const parsed = readWorkspaceCollaborationRequest(input);
  if (token === null || parsed === null) {
    writeJson(response, token === null ? 401 : 400, {
      status: "error",
      code: token === null ? "forbidden" : "invalid_input",
      message:
        token === null
          ? "Your session is no longer authorized."
          : "The workspace request is not valid.",
    });
    return;
  }
  const result = await collaboration.execute(path, token, parsed);
  writeJson(
    response,
    result.status === "error" ? (result.code === "forbidden" ? 403 : 400) : 200,
    result,
  );
}

async function handleAuth(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  auth: PasswordAuthService,
  identity: OidcAuthService | null,
  sessions: SessionService | null,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    writeAuth(response, {
      status: "error",
      code: "invalid_input",
      message: "The account request is not valid.",
    });
    return;
  }

  if (path === ACCOUNT_AUTH_PATHS.create) {
    const parsed = readPasswordAccountCreateRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.createAccount(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.verifyEmail) {
    const parsed = readEmailVerificationRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.verifyEmail(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.resendEmailVerification) {
    const parsed = readEmailVerificationResendRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.resendEmailVerification(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.signIn) {
    const parsed = readPasswordSignInRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.signIn(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.requestPasswordReset) {
    const parsed = readPasswordResetRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.requestPasswordReset(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.resetPassword) {
    const parsed = readPasswordResetConfirmRequest(body);
    writeAuth(
      response,
      parsed === null
        ? { status: "error", code: "invalid_input", message: "The account request is not valid." }
        : await auth.resetPassword(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.googleStart) {
    const parsed = readGoogleAuthStartRequest(body);
    writeGoogleStart(
      response,
      parsed === null || identity === null
        ? {
            status: "error",
            code: identity === null ? "service_unavailable" : "invalid_input",
            message:
              identity === null
                ? "Google sign-in is unavailable. Try another method."
                : "The Google sign-in request is not valid.",
          }
        : await identity.start(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.googleExchange) {
    const parsed = readGoogleAuthExchangeRequest(body);
    writeAuth(
      response,
      parsed === null || identity === null
        ? {
            status: "error",
            code: identity === null ? "service_unavailable" : "invalid_input",
            message:
              identity === null
                ? "Google sign-in is unavailable. Try another method."
                : "The Google sign-in request is not valid.",
          }
        : await identity.exchange(parsed),
    );
    return;
  }
  if (path === ACCOUNT_AUTH_PATHS.refreshSession || path === ACCOUNT_AUTH_PATHS.signOut) {
    const parsed = readSessionCredentialRequest(body);
    writeAuth(
      response,
      parsed === null || sessions === null
        ? {
            status: "error",
            code: sessions === null ? "service_unavailable" : "invalid_input",
            message:
              sessions === null
                ? "Session access is unavailable. Try again."
                : "The session request is not valid.",
          }
        : path === ACCOUNT_AUTH_PATHS.refreshSession
          ? await sessions.refresh(parsed)
          : await sessions.signOut(parsed),
    );
  }
}

function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (host === undefined) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      allowedHosts.has(url.hostname.toLocaleLowerCase("en-US"))
    );
  } catch {
    return false;
  }
}

export interface AccountServiceServerOptions {
  allowedHosts?: readonly string[];
}

export function createAccountServiceServer(
  readiness: ServiceReadiness,
  auth: PasswordAuthService | null = null,
  identity: OidcAuthService | null = null,
  sessions: SessionService | null = null,
  settings: AccountSettingsService | null = null,
  collaboration: WorkspaceCollaborationService | null = null,
  sync: WorkspaceSyncService | null = null,
  coedit: WorkspaceCoeditService | null = null,
  connections: ConnectionsService | null = null,
  notifications: AccountNotificationsService | null = null,
  options: AccountServiceServerOptions = {},
): Server {
  const allowedHosts = new Set(
    (options.allowedHosts ?? ["127.0.0.1"]).map((host) => host.toLocaleLowerCase("en-US")),
  );
  return createServer((request, response) => {
    if (!isAllowedHost(request.headers.host, allowedHosts)) {
      writeJson(response, 400, { error: "invalid_host" });
      return;
    }
    const url = requestUrl(request);
    if (url === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const path = url.pathname;
    if ((Object.values(WORKSPACE_COEDIT_PATHS) as readonly string[]).includes(path)) {
      if (url.search !== "" || request.method !== "POST" || coedit === null) {
        writeJson(response, coedit === null ? 503 : 405, {
          error: coedit === null ? "service_unavailable" : "method_not_allowed",
        });
        return;
      }
      void handleWorkspaceCoedit(request, response, path, coedit).catch(() =>
        writeJson(response, 503, {
          status: "error",
          code: "service_unavailable",
          message: "Live collaboration is unavailable.",
        }),
      );
      return;
    }
    if ((Object.values(WORKSPACE_SYNC_PATHS) as readonly string[]).includes(path)) {
      if (url.search !== "" || request.method !== "POST" || sync === null) {
        writeJson(response, sync === null ? 503 : 405, {
          error: sync === null ? "service_unavailable" : "method_not_allowed",
        });
        return;
      }
      void handleWorkspaceSync(request, response, path, sync).catch(() =>
        writeJson(response, 503, {
          status: "error",
          code: "service_unavailable",
          message: "Workspace synchronization is unavailable.",
        }),
      );
      return;
    }
    if ((Object.values(WORKSPACE_COLLABORATION_PATHS) as readonly string[]).includes(path)) {
      if (url.search !== "" || request.method !== "POST" || collaboration === null) {
        writeJson(response, collaboration === null ? 503 : 405, {
          error: collaboration === null ? "service_unavailable" : "method_not_allowed",
        });
        return;
      }
      void handleWorkspaceCollaboration(request, response, path, collaboration).catch(() =>
        writeJson(response, 503, {
          status: "error",
          code: "service_unavailable",
          message: "Workspace collaboration is unavailable.",
        }),
      );
      return;
    }
    if (path === CONNECTED_ACCOUNT_PATHS.callback) {
      if (connections === null) {
        writeConnectionPage(
          response,
          503,
          "Connections are unavailable",
          "Close this page and try again from Kiwi.",
          true,
        );
        return;
      }
      void connections
        .completeCallback(url)
        .then((outcome) => {
          if ("provider" in outcome) {
            writeConnectionPage(
              response,
              200,
              "Service connected",
              "You can close this page and return to Kiwi.",
              false,
            );
            return;
          }
          writeConnectionPage(response, 400, "Connection not completed", outcome.error, true);
        })
        .catch(() =>
          writeConnectionPage(
            response,
            503,
            "Connection not completed",
            "Close this page and try again from Kiwi.",
            true,
          ),
        );
      return;
    }
    if (path === ACCOUNT_AUTH_PATHS.identityProviderCallback) {
      if (request.method !== "GET" || identity === null) {
        writeConnectionPage(
          response,
          identity === null ? 404 : 405,
          "Sign-in not completed",
          "Close this page and try again from Kiwi.",
          true,
        );
        return;
      }
      void identity
        .completeProviderCallback(url)
        .then((callback) => {
          if (callback === null) {
            writeConnectionPage(
              response,
              400,
              "Sign-in not completed",
              "This response did not match a pending Kiwi sign-in.",
              true,
            );
            return;
          }
          response.writeHead(302, {
            "cache-control": "no-store",
            location: callback.toString(),
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          });
          response.end();
        })
        .catch(() =>
          writeConnectionPage(
            response,
            503,
            "Sign-in not completed",
            "Close this page and try again from Kiwi.",
            true,
          ),
        );
      return;
    }
    if ((Object.values(CONNECTED_ACCOUNT_PATHS) as readonly string[]).includes(path)) {
      const listing = path === CONNECTED_ACCOUNT_PATHS.list;
      if (url.search !== "" || request.method !== (listing ? "GET" : "POST")) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (connections === null || settings === null) {
        writeConnections(response, {
          status: "error",
          code: "service_unavailable",
          message: "Connected accounts are unavailable. Try again.",
        });
        return;
      }
      void handleConnections(request, response, path, connections, settings).catch(() =>
        writeConnections(response, {
          status: "error",
          code: "service_unavailable",
          message: "Connected accounts are unavailable. Try again.",
        }),
      );
      return;
    }
    if ((Object.values(ACCOUNT_NOTIFICATION_PATHS) as readonly string[]).includes(path)) {
      const listing = path === ACCOUNT_NOTIFICATION_PATHS.list;
      if (url.search !== "" || request.method !== (listing ? "GET" : "POST")) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (notifications === null || settings === null) {
        writeNotifications(response, {
          status: "error",
          code: "service_unavailable",
          message: "Notifications are unavailable. Try again.",
        });
        return;
      }
      void handleAccountNotifications(request, response, path, notifications, settings).catch(() =>
        writeNotifications(response, {
          status: "error",
          code: "service_unavailable",
          message: "Notifications are unavailable. Try again.",
        }),
      );
      return;
    }
    if (
      path === ACCOUNT_AUTH_PATHS.identityLinkStart ||
      path === ACCOUNT_AUTH_PATHS.identityLinkExchange ||
      path === ACCOUNT_AUTH_PATHS.identityUnlink ||
      path === ACCOUNT_AUTH_PATHS.identityReauthenticateStart ||
      path === ACCOUNT_AUTH_PATHS.identityReauthenticateExchange ||
      path === ACCOUNT_AUTH_PATHS.passwordReauthenticate
    ) {
      if (url.search !== "" || request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (
        settings === null ||
        (identity === null && path !== ACCOUNT_AUTH_PATHS.passwordReauthenticate)
      ) {
        writeAuth(response, {
          status: "error",
          code: "service_unavailable",
          message: "Sign-in methods are unavailable. Try again.",
        });
        return;
      }
      void handleIdentityAccount(request, response, path, identity, settings).catch(() =>
        writeAuth(response, {
          status: "error",
          code: "service_unavailable",
          message: "Sign-in methods are unavailable. Try again.",
        }),
      );
      return;
    }
    if ((Object.values(ACCOUNT_SETTINGS_PATHS) as readonly string[]).includes(path)) {
      if (url.search !== "" || url.hash !== "") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (settings === null) {
        writeSettings(response, {
          status: "error",
          code: "service_unavailable",
          message: "Account settings are unavailable. Try again.",
        });
        return;
      }
      void handleAccountSettings(request, response, path, settings).catch(() => {
        if (!response.headersSent) {
          writeSettings(response, {
            status: "error",
            code: "service_unavailable",
            message: "Account settings are unavailable. Try again.",
          });
        } else {
          response.destroy();
        }
      });
      return;
    }
    if (path === ACCOUNT_AUTH_PATHS.googleFixtureAuthorize) {
      if (request.method !== "GET" || identity === null) {
        writeJson(response, identity === null ? 404 : 405, {
          error: identity === null ? "not_found" : "method_not_allowed",
        });
        return;
      }
      const callback = identity.completeFixtureAuthorization(url);
      if (callback === null) {
        writeJson(response, 400, { error: "invalid_authorization_request" });
        return;
      }
      response.writeHead(302, {
        "cache-control": "no-store",
        location: callback.toString(),
        "x-content-type-options": "nosniff",
      });
      response.end();
      return;
    }
    if (url.search !== "" || url.hash !== "") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (path !== ACCOUNT_SERVICE_HEALTH_PATH) {
      if (!(Object.values(ACCOUNT_AUTH_PATHS) as readonly string[]).includes(path)) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (auth === null) {
        writeAuth(response, {
          status: "error",
          code: "service_unavailable",
          message: "Account access is unavailable. Try again.",
        });
        return;
      }
      void handleAuth(request, response, path, auth, identity, sessions).catch(() => {
        if (!response.headersSent) {
          writeAuth(response, {
            status: "error",
            code: "service_unavailable",
            message: "Account access is unavailable. Try again.",
          });
        } else {
          response.destroy();
        }
      });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    readiness.check().then(
      (health: AccountServiceHealth) => {
        writeJson(response, health.status === "ready" ? 200 : 503, health);
      },
      () => {
        writeJson(response, 503, { error: "service_unavailable" });
      },
    );
  });
}
