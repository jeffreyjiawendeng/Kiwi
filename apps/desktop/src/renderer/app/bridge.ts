import { readUndoFromResult, rememberUndo } from "./undo-stack.js";

export interface RendererCapabilities {
  protocolVersion: string;
  appVersion: string;
  commands: boolean;
  queries: boolean;
  subscriptions: boolean;
  streams: boolean;
}

export interface RendererError {
  code: string;
  message: string;
  details: Record<string, string | number | boolean>;
  retryable: boolean;
  recovery_actions: string[];
  correlation_id: string;
}

export type RendererStartupStatus =
  { status: "ready" } | { status: "failed"; error: RendererError };

export interface RendererAbout {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  installType: string;
  protocolVersion: string;
  buildIdentifier: string;
  signed: boolean;
}

/** Where an installed Kiwi is in updating itself. See `main/updater.ts`. */
export type RendererUpdateState =
  | { status: "off"; reason: "development" | "portable" | "no_feed" }
  | { status: "paused" }
  | { status: "idle"; checked_at: string | null }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "failed"; message: string; checked_at: string };

export interface RendererCommandResult {
  protocol_version: string;
  request_id: string;
  status: string;
  transaction_id?: string;
  event_ids?: string[];
  data?: Record<string, unknown>;
  warnings?: string[];
  error?: RendererError;
  replayed?: boolean;
}

export interface RendererRuntimeHealth {
  worker: string;
  workerRestarts: number;
  commandsInFlight: number;
  rendererFailure: {
    reason: string;
    exitCode: number;
    recoverable: boolean;
    occurredAt: string;
  } | null;
}

export interface RendererWorkspaceFolderSelection {
  id: string;
  displayPath: string;
  suggestedTitle: string;
  hasExistingContents: boolean;
}

export interface RendererManagedAssetSelection {
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
  declaredMediaType: string | null;
}

/**
 * A folder of PDFs, already broken into one ordinary file selection each.
 *
 * Nothing below this line can tell a file picked on its own from one of thirty picked together,
 * which is the point: importing a folder is the single-file import run once per file, not a
 * second kind of import. The folder is named, not located, like everything else that crosses.
 */
export interface RendererAssetFolderSelection {
  /** What the folder is called. Its name, not its path. */
  name: string;
  files: RendererManagedAssetSelection[];
  /** What was in the folder and is not in `files`. Counted rather than listed. */
  skipped: number;
  /** True when the folder held more PDFs than one pass takes, and the rest were left behind. */
  truncated: boolean;
}

/** One workspace and the projects inside it, as Home lists them. */
export interface RendererGlobalSearchHit {
  workspaceId: string;
  workspaceTitle: string;
  objectId: string;
  objectType: string;
  title: string;
  project: { id: string; title: string } | null;
  rank: number;
}

export interface RendererProjectDirectoryEntry {
  workspaceId: string;
  workspaceTitle: string;
  displayPath: string;
  lastOpenedAt: string;
  /** Null when the folder could not be read, which is not the same as holding no projects. */
  projects: Array<{
    id: string;
    title: string;
    description: string;
    updatedAt: string;
    archived: boolean;
    sensitivity: string;
    counts: Record<string, number>;
  }> | null;
}

export interface RendererBridge {
  readonly version: string;
  getPublicLinks(): Promise<{ terms: boolean; privacy: boolean; support: boolean }>;
  openPublicLink(key: "terms" | "privacy" | "support"): Promise<boolean>;
  getCapabilities(): Promise<RendererCapabilities>;
  getAccountServiceStatus(): Promise<RendererAccountServiceStatus>;
  getAccountAuthState(): Promise<RendererAccountAuthState>;
  createPasswordAccount(input: {
    email: string;
    email_kind: "personal" | "institutional";
    password: string;
    given_name: string;
    family_name: string;
    phone: string;
  }): Promise<RendererAccountAuthResult>;
  verifyAccountEmail(input: { email: string; code: string }): Promise<RendererAccountAuthResult>;
  resendAccountEmailVerification(input: { email: string }): Promise<RendererAccountAuthResult>;
  signInWithPassword(input: {
    email: string;
    password: string;
  }): Promise<RendererAccountAuthResult>;
  reauthenticateWithPassword(input: { password: string }): Promise<RendererAccountAuthResult>;
  reauthenticateWithProvider(input: {
    provider: "google" | "orcid";
  }): Promise<RendererAccountAuthResult>;
  requestPasswordReset(input: { email: string }): Promise<RendererAccountAuthResult>;
  resetPassword(input: {
    email: string;
    code: string;
    new_password: string;
  }): Promise<RendererAccountAuthResult>;
  signInWithProvider(input: {
    provider: "google" | "orcid";
    registration_profile?: {
      given_name: string;
      family_name: string;
      phone: string;
    };
  }): Promise<RendererAccountAuthResult>;
  cancelProviderSignIn(): Promise<boolean>;
  previewSignOut(): Promise<RendererAccountSignOutPreview>;
  signOut(): Promise<RendererAccountAuthResult>;
  getAccountSettings(): Promise<RendererAccountSettingsResult>;
  updateAccountProfile(input: RendererAccountProfile): Promise<RendererAccountSettingsResult>;
  linkSignInMethod(input: { provider: "google" | "orcid" }): Promise<RendererAccountAuthResult>;
  unlinkSignInMethod(input: { provider: "google" | "orcid" }): Promise<RendererAccountAuthResult>;
  listConnections(): Promise<RendererConnectionsResult>;
  startConnection(input: { provider: string }): Promise<RendererConnectionsResult>;
  pollConnection(input: { transaction_id: string }): Promise<RendererConnectionsResult>;
  disconnectConnection(input: { provider: string }): Promise<RendererConnectionsResult>;
  listAccountNotifications(): Promise<RendererAccountNotificationsResult>;
  markAccountNotificationRead(input: {
    notification_id: string;
  }): Promise<RendererAccountNotificationsResult>;
  dismissAccountNotification(input: {
    notification_id: string;
  }): Promise<RendererAccountNotificationsResult>;
  addAccountEmail(input: {
    address: string;
    kind: "personal" | "institutional";
  }): Promise<RendererAccountSettingsResult>;
  verifyAccountEmailAddress(input: {
    email_id: string;
    code: string;
  }): Promise<RendererAccountSettingsResult>;
  resendAccountEmail(input: { email_id: string }): Promise<RendererAccountSettingsResult>;
  promoteAccountEmail(input: { email_id: string }): Promise<RendererAccountSettingsResult>;
  setAccountNotificationEmail(input: { email_id: string }): Promise<RendererAccountSettingsResult>;
  removeAccountEmail(input: { email_id: string }): Promise<RendererAccountSettingsResult>;
  chooseAccountAvatar(): Promise<RendererAccountSettingsResult | null>;
  removeAccountAvatar(): Promise<RendererAccountSettingsResult>;
  readAccountAvatar(): Promise<string | null>;
  compileLatex(input: {
    workspace_id: string;
    source: string;
    engine: string;
    files: Array<{ name: string; asset_id?: string; text?: string }>;
    prefer?: "cloud" | "local";
  }): Promise<RendererCompileOutcome>;
  exportDocument(input: {
    workspace_id: string;
    format: "tex" | "docx";
    title: string;
    source: string;
    files: Array<{ name: string; asset_id?: string; text?: string }>;
    document?: unknown;
    references?: string[];
    citation_labels?: Record<string, string>;
  }): Promise<RendererDocumentExportOutcome>;
  exportLibrary(input: {
    workspace_id: string;
    format: "bibtex" | "ris" | "csv";
    /** The chosen Papers. An empty list means the whole library. */
    object_ids: string[];
  }): Promise<RendererLibraryExportOutcome>;
  listProjectDirectory(): Promise<RendererProjectDirectoryEntry[]>;
  captureManagedAsset(input: {
    bytes: string;
    name: string;
  }): Promise<RendererManagedAssetSelection | null>;
  exportAccountData(): Promise<RendererAccountExportOutcome>;
  setAccountNotificationPreference(input: {
    category: string;
    email: boolean;
  }): Promise<RendererAccountSettingsResult>;
  setAccountPassword(input: {
    current_password: string | null;
    new_password: string;
  }): Promise<RendererAccountSettingsResult>;
  removeAccountPassword(): Promise<RendererAccountSettingsResult>;
  revokeAccountSession(input: { session_id: string }): Promise<RendererAccountSettingsResult>;
  revokeOtherAccountSessions(): Promise<RendererAccountSettingsResult>;
  requestAccountDeletion(input: { confirmation: "DELETE" }): Promise<RendererAccountSettingsResult>;
  manageWorkspaceCollaboration(input: {
    action:
      | "snapshot"
      | "invite"
      | "revoke_invitation"
      | "update_member"
      | "remove_member"
      | "create_project"
      | "update_project";
    input: Record<string, unknown>;
  }): Promise<RendererWorkspaceCollaborationResult>;
  readWorkspacePresence(input: {
    documentId: string;
    cursor: number;
  }): Promise<RendererWorkspacePresenceResult>;
  readWorkspaceSyncStatus(): Promise<RendererWorkspaceSyncStatusResult>;
  closeWorkspace(): Promise<boolean>;
  /** Every workspace Kiwi has opened, searched at once, each result placed. */
  searchEverywhere(input: { query: string }): Promise<RendererGlobalSearchHit[]>;
  /** Opens another workspace, named by id, in a window of its own. */
  openWorkspaceById(input: { workspaceId: string }): Promise<boolean>;
  readOfflineMode(): Promise<boolean>;
  setOfflineMode(input: { offline: boolean }): Promise<boolean>;
  getStartupStatus(): Promise<RendererStartupStatus>;
  getAbout(): Promise<RendererAbout>;
  getUpdateState(): Promise<RendererUpdateState>;
  /** Checks now rather than at the next scheduled time, and answers what it found. */
  checkForUpdates(): Promise<RendererUpdateState>;
  /** Quits and installs a downloaded update. False when there is nothing to install. */
  restartToUpdate(): Promise<boolean>;
  listCommands(): Promise<string[]>;
  invokeCommand(envelope: unknown): Promise<RendererCommandResult>;
  cancelCommand(requestId: string): Promise<boolean>;
  getRuntimeHealth(): Promise<RendererRuntimeHealth>;
  chooseManagedAsset(): Promise<RendererManagedAssetSelection | null>;
  /**
   * Asks for a folder to import PDFs from.
   *
   * The folder that was picked and not the tree under it, and the PDFs in it and not everything
   * in it. What else the folder held comes back as a count, so a folder of thirty files that
   * yields twenty rows can say so rather than leaving the other ten to be noticed later.
   */
  chooseAssetFolder(): Promise<RendererAssetFolderSelection | null>;
  registerDroppedManagedAsset(file: File): Promise<RendererManagedAssetSelection | null>;
  /**
   * Asks for a reference library to import from.
   *
   * What comes back names the file and says how big it is, so the import can show which file it
   * is about to read. Where the file is stays on the other side, and the identifier is what goes
   * back with the import as `selection_id`.
   */
  chooseReferenceFile(): Promise<RendererManagedAssetSelection | null>;
  chooseWorkspaceFolder(): Promise<RendererWorkspaceFolderSelection | null>;
  createWorkspace(input: { selectionId: string; title: string }): Promise<RendererCommandResult>;
  openWorkspaceFolder(): Promise<RendererCommandResult | null>;
  openWorkspaceInNewWindow(): Promise<RendererCommandResult | null>;
  detachDocument(request: {
    objectId: string;
    kind: "document" | "reader";
    /** Which file of the object to open. A Reader is opened on one; a document has only itself. */
    assetId?: string;
  }): Promise<RendererCommandResult | null>;
  /** What this window was opened to show, or null in an ordinary window. */
  getDetachedDocument(): Promise<{
    objectId: string;
    kind: "document" | "reader";
    assetId?: string;
  } | null>;
  getWorkspaceSession(): Promise<{ summary: RendererWorkspaceSummary } | null>;
  performWindowAction(action: string): Promise<void>;
  performRecoveryAction(action: string): Promise<void>;
}

export type RendererAccountServiceStatus =
  { status: "ready" } | { status: "unavailable"; retryable: true };

export interface RendererAccountSignOutPreview {
  pending_workspace_registrations: number;
  pending_structured_changes: number;
  pending_document_operations: number;
  total: number;
}

export interface RendererAccountIdentity {
  id: string;
  email: string;
  email_verified: true;
}

export type RendererAccountAuthState =
  | { status: "signed_out" }
  | {
      status: "authenticated";
      account: RendererAccountIdentity;
      connection: "online" | "offline";
    };

export type RendererAccountAuthResult =
  | { status: "accepted"; next: "verify_email" | "check_email"; fixture_code?: string }
  | { status: "authenticated"; account: RendererAccountIdentity; deletion_cancelled?: true }
  | { status: "password_reset" }
  | { status: "signed_out" }
  | { status: "identity_linked"; provider: "google" | "orcid" }
  | {
      status: "identity_unlinked";
      provider: "google" | "orcid";
      provider_revocation: "confirmed" | "not_supported" | "failed";
    }
  | { status: "reauthenticated"; provider: "google" | "orcid" | "password" }
  | {
      status: "error";
      code: string;
      message: string;
      retry_after_seconds?: number;
    };

export interface RendererConnectionSummary {
  provider: string;
  account_label: string;
  scopes: string;
  connected_at: string;
  authorization_status: "active" | "reauthorization_required";
}

export type RendererConnectionsResult =
  | {
      status: "ok";
      connections: { connections: RendererConnectionSummary[]; available: string[] };
    }
  | { status: "browser_required"; authorization_url: string; transaction_id: string }
  | {
      status: "device_required";
      transaction_id: string;
      prompt: { verification_uri: string; user_code: string; expires_in_seconds: number };
    }
  | { status: "pending" }
  | { status: "connected"; provider: string }
  | {
      status: "disconnected";
      provider: string;
      provider_revocation: "confirmed" | "not_supported" | "failed";
    }
  | { status: "error"; code: string; message: string };

export interface RendererAccountNotification {
  id: string;
  category: string;
  title: string;
  detail: string;
  workspace_id?: string;
  created_at: string;
  read: boolean;
}

export type RendererAccountNotificationsResult =
  | {
      status: "ok";
      notifications: RendererAccountNotification[];
      unread_count: number;
    }
  | { status: "updated" }
  | { status: "error"; code: string; message: string };

export interface RendererAccountProfile {
  given_name: string | null;
  family_name: string | null;
  phone: string | null;
}

export interface RendererAccountSettingsSnapshot {
  account: {
    id: string;
    email: string;
    profile: RendererAccountProfile;
    display_name: string;
    profile_complete: boolean;
    email_verified: true;
    avatar: { content_hash: string; media_type: string } | null;
  };
  sign_in_methods: Array<"google" | "orcid" | "password">;
  emails: Array<{
    id: string;
    address: string;
    kind: "personal" | "institutional";
    verified: boolean;
    primary: boolean;
    receives_notifications: boolean;
  }>;
  notifications: Array<{ category: string; email: boolean }>;
  deletion_impact: {
    sole_owner_workspaces: Array<{ id: string; title: string }>;
    shared_workspaces: number;
    addresses: number;
    connections: number;
  };
  security_activity: Array<{
    id: string;
    event: string;
    outcome: string;
    occurred_at: string;
  }>;
  sessions: Array<{
    id: string;
    device_name: string;
    current: boolean;
    started_at: string;
    last_authenticated_at: string;
    last_seen_at: string;
  }>;
  deletion: { status: "none" } | { status: "pending"; recover_until: string };
}

// Only the outcome crosses the boundary. The exported record itself is written by the
// main process to the file the person chose and never reaches this side.
export type RendererAccountExportOutcome =
  | { status: "written"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string; code?: string };

export type RendererAccountSettingsResult =
  | {
      status: "ok";
      settings: RendererAccountSettingsSnapshot;
      email_verification?: {
        email_id: string;
        address: string;
        fixture_code?: string;
      };
    }
  | { status: "session_revoked" }
  | { status: "deletion_requested"; recover_until: string }
  | { status: "error"; code: string; message: string; retry_after_seconds?: number };

export interface RendererWorkspaceCollaborationSnapshot {
  workspace: { id: string; title: string; role: string };
  members: Array<{
    user_id: string;
    email: string;
    display_name: string;
    phone: string | null;
    role: string;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    expires_at: string;
  }>;
  projects: Array<{
    id: string;
    name: string;
    sensitivity: string;
    review_required: boolean;
    member_overrides: Array<{
      user_id: string;
      display_name: string;
      workspace_role: string;
      project_role: string;
    }>;
  }>;
}

export interface RendererWorkspaceSummary {
  workspaceId: string;
  title: string;
  root: string;
  formatVersion: string;
  status: string;
  trust: string;
  writable: boolean;
  problems: Array<{ rule: string; path: string; detail: string; severity: string }>;
}

export type RendererWorkspaceCollaborationResult =
  | { status: "ok"; settings: RendererWorkspaceCollaborationSnapshot }
  | { status: "queued" }
  | { status: "error"; code: string; message: string };

/**
 * Presence is either being read or it is not. The main process folds offline, signed out, no
 * workspace on this window, a refusal, and a request that never came back into the one answer,
 * because none of them is something the renderer could do anything different about.
 */
export type RendererWorkspacePresenceResult =
  | {
      status: "present";
      collaborators: Array<{
        actor_id: string;
        sequence: number;
        cursor: number;
        expires_at: string;
      }>;
    }
  | { status: "unavailable" };

/**
 * What is waiting to be sent for the open workspace, and how the last attempt went.
 *
 * `unknown` is not the same as nothing pending. Nobody signed in, or no workspace on this window,
 * means there is no state of sharing to report -- and a status reading "synchronized" because
 * nothing is being asked would be the worst thing this could say.
 */
export type RendererWorkspaceSyncStatusResult =
  | {
      status: "known";
      connection: "online" | "offline";
      /** Offline because somebody chose it, rather than because nothing answered. */
      working_offline: boolean;
      pending: {
        registrations: number;
        structured_changes: number;
        document_operations: number;
        total: number;
      };
      conflicts: number;
      last_succeeded_at: string | null;
      last_failure: { at: string; reason: string } | null;
    }
  | { status: "unknown" };

declare global {
  interface Window {
    kiwiDesktop?: RendererBridge;
  }
}

/**
 * The bridge, with one thing watched on the way past.
 *
 * Every command in the renderer goes through here, which makes it the only place an undo offer
 * can be noticed without every call site having to remember to. The wrapper delegates to the
 * same functions and is memoized against the underlying bridge, so it is one extra object per
 * bridge rather than one per call, and anything holding the real function still sees it called.
 */
const wrapped = new WeakMap<RendererBridge, RendererBridge>();

export function readBridge(): RendererBridge | null {
  const bridge = window.kiwiDesktop ?? null;
  if (bridge === null) return null;
  const existing = wrapped.get(bridge);
  if (existing !== undefined) return existing;
  const watched: RendererBridge = {
    ...bridge,
    async invokeCommand(envelope: unknown): Promise<RendererCommandResult> {
      const result = await bridge.invokeCommand(envelope);
      const command =
        envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)
          ? (envelope as Record<string, unknown>)["command"]
          : null;
      if (typeof command === "string") {
        rememberUndo(readUndoFromResult(command, result, Date.now()));
      }
      return result;
    },
  };
  wrapped.set(bridge, watched);
  return watched;
}

export interface RendererCompileProblem {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
}

export interface RendererCompileOutcome {
  status: "ok" | "failed";
  ran: "cloud" | "local";
  pdf: string | null;
  problems: RendererCompileProblem[];
}

// The files themselves are written by the main process into the place the person chose. Only
// the names come back, so the summary can say what was written without this side knowing where.
export type RendererDocumentExportOutcome =
  | { status: "written"; destination: string; files: string[]; notes: string[] }
  | { status: "cancelled" }
  | { status: "error"; message: string };

// The file is written by the main process where the person chose to put it. Only its name and
// how many references reached it come back.
export type RendererLibraryExportOutcome =
  | { status: "written"; path: string; count: number }
  | { status: "cancelled" }
  | { status: "error"; message: string };
