import { isLibraryExportFormat, type LibraryExportFormat } from "@kiwi/contracts";

export const IPC_CHANNELS = {
  publicLinksGet: "kiwi:public-links-get",
  publicLinkOpen: "kiwi:public-link-open",
  accountServiceStatus: "kiwi:account-service-status",
  accountAuthState: "kiwi:account-auth-state",
  accountCreatePassword: "kiwi:account-create-password",
  accountVerifyEmail: "kiwi:account-verify-email",
  accountResendEmailVerification: "kiwi:account-resend-email-verification",
  accountSignInPassword: "kiwi:account-sign-in-password",
  accountReauthenticatePassword: "kiwi:account-reauthenticate-password",
  accountReauthenticateProvider: "kiwi:account-reauthenticate-provider",
  accountRequestPasswordReset: "kiwi:account-request-password-reset",
  accountResetPassword: "kiwi:account-reset-password",
  accountProviderSignIn: "kiwi:account-provider-sign-in",
  accountIdentityLink: "kiwi:account-identity-link",
  accountIdentityUnlink: "kiwi:account-identity-unlink",
  connectionsList: "kiwi:connections-list",
  connectionsStart: "kiwi:connections-start",
  connectionsPoll: "kiwi:connections-poll",
  connectionsDisconnect: "kiwi:connections-disconnect",
  accountNotificationsList: "kiwi:account-notifications-list",
  accountNotificationRead: "kiwi:account-notification-read",
  accountNotificationDismiss: "kiwi:account-notification-dismiss",
  accountProviderCancel: "kiwi:account-provider-cancel",
  accountSignOutPreview: "kiwi:account-sign-out-preview",
  accountSignOut: "kiwi:account-sign-out",
  latexCompile: "kiwi:latex-compile",
  documentExport: "kiwi:document-export",
  libraryExport: "kiwi:library-export",
  accountSettingsGet: "kiwi:account-settings-get",
  accountProfileUpdate: "kiwi:account-profile-update",
  accountEmailAdd: "kiwi:account-email-add",
  accountEmailVerify: "kiwi:account-email-verify",
  accountEmailResend: "kiwi:account-email-resend",
  accountEmailPromote: "kiwi:account-email-promote",
  accountEmailNotifications: "kiwi:account-email-notifications",
  accountEmailRemove: "kiwi:account-email-remove",
  accountAvatarChoose: "kiwi:account-avatar-choose",
  accountAvatarRemove: "kiwi:account-avatar-remove",
  accountAvatarRead: "kiwi:account-avatar-read",
  accountExport: "kiwi:account-export",
  accountNotificationPreference: "kiwi:account-notification-preference",
  accountPasswordSet: "kiwi:account-password-set",
  accountPasswordRemove: "kiwi:account-password-remove",
  accountSessionRevoke: "kiwi:account-session-revoke",
  accountSessionsRevokeOthers: "kiwi:account-sessions-revoke-others",
  accountDeletionRequest: "kiwi:account-deletion-request",
  workspaceCollaboration: "kiwi:workspace-collaboration",
  workspacePresence: "kiwi:workspace-presence",
  workspaceSyncStatus: "kiwi:workspace-sync-status",
  offlineMode: "kiwi:offline-mode",
  searchEverywhere: "kiwi:search-everywhere",
  workspaceOpenById: "kiwi:workspace-open-by-id",
  capabilities: "kiwi:capabilities",
  windowAction: "kiwi:window-action",
  startupStatus: "kiwi:startup-status",
  recoveryAction: "kiwi:recovery-action",
  about: "kiwi:about",
  updateState: "kiwi:update-state",
  updateCheck: "kiwi:update-check",
  updateRestart: "kiwi:update-restart",
  commandInvoke: "kiwi:command-invoke",
  commandCancel: "kiwi:command-cancel",
  commandNames: "kiwi:command-names",
  runtimeHealth: "kiwi:runtime-health",
  workspaceSession: "kiwi:workspace-session",
  projectDirectory: "kiwi:project-directory",
  workspaceChooseFolder: "kiwi:workspace-choose-folder",
  workspaceCreate: "kiwi:workspace-create",
  workspaceOpenFolder: "kiwi:workspace-open-folder",
  workspaceOpenNewWindow: "kiwi:workspace-open-new-window",
  workspaceClose: "kiwi:workspace-close",
  detachDocument: "kiwi:detach-document",
  detachedDocument: "kiwi:detached-document",
  assetChooseManaged: "kiwi:asset-choose-managed",
  assetChooseFolder: "kiwi:asset-choose-folder",
  assetRegisterDropped: "kiwi:asset-register-dropped",
  assetCapture: "kiwi:asset-capture",
  bibliographyChooseFile: "kiwi:bibliography-choose-file",
} as const;

export type { DesktopAccountServiceStatus } from "./account-service-client.js";

export const WINDOW_ACTIONS = [
  "minimize",
  "maximize",
  "unmaximize",
  "toggle-maximize",
  "close",
] as const;

export type AllowedWindowAction = (typeof WINDOW_ACTIONS)[number];

export interface BridgeCapabilities {
  protocolVersion: string;
  appVersion: string;
  commands: boolean;
  queries: boolean;
  subscriptions: boolean;
  streams: boolean;
}

export interface AccountSignOutPreview {
  pending_workspace_registrations: number;
  pending_structured_changes: number;
  pending_document_operations: number;
  total: number;
}

export type { PublicLinkAvailability, PublicLinkKey } from "./public-links.js";
export type { DetachedKind, DetachRequest, DetachedAssignment } from "./detached-windows.js";

export interface WorkspaceFolderSelection {
  id: string;
  displayPath: string;
  suggestedTitle: string;
  hasExistingContents: boolean;
}

export interface WorkspaceCreateRequest {
  selectionId: string;
  title: string;
}

export interface ManagedAssetSelection {
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
  declaredMediaType: string | null;
}

export interface DroppedAssetRequest {
  path: string;
  declaredMediaType: string | null;
}

/**
 * A folder of PDFs somebody picked, already broken into one ordinary file selection each.
 *
 * Nothing here is a new kind of thing. Every file is the same selection the single-file picker
 * issues, held under the same identifier for the same ten minutes, so the import that follows
 * cannot tell a file picked on its own from one of thirty picked together -- and the renderer has
 * still never been told where any of them are.
 *
 * The folder itself is named and not located, for the same reason. What the count of skipped
 * files is for: a folder of thirty that yields twenty rows should say so on the way in, rather
 * than leaving somebody to work out afterwards which ten went missing.
 */
export interface AssetFolderSelection {
  /** What the folder is called. Its name, not its path. */
  name: string;
  files: ManagedAssetSelection[];
  /** What was in the folder and is not in `files`. Counted rather than listed. */
  skipped: number;
  /** True when the folder held more PDFs than one pass takes, and the rest were left behind. */
  truncated: boolean;
}

/**
 * The reference library a person picked, held under an identifier until the import spends it.
 *
 * The same shape a managed asset selection has, and deliberately the same broker behind it: what
 * is being kept either way is a file this window's person chose a moment ago, and which command
 * they go on to spend it on is their business. The renderer is told what the file is called and
 * how big it is, because both belong on screen. It is not told where the file is.
 */
export type ReferenceFileSelection = ManagedAssetSelection;

/**
 * What a bibliography import is allowed to say about the file it wants read.
 *
 * The import commands take a path, because a library of any size is past what one command may
 * carry and the command has to open the file itself. The renderer is not the thing that may name
 * that path. It picks a file through a dialog this side opens and gets an identifier back, so a
 * `source_path` arriving from the renderer is either a mistake or an attempt; either way it is
 * refused rather than quietly dropped, so that a mistake is visible instead of silent.
 *
 * Everything else in the arguments is left alone. The rows a person corrected in the preview go
 * through untouched, and so does a file small enough to have been pasted in whole.
 */
export type ReferenceImportRequest =
  | { status: "ready"; selectionId: string | null; args: Record<string, unknown> }
  | { status: "path_named" }
  | { status: "malformed" };

export function readReferenceImportRequest(value: unknown): ReferenceImportRequest {
  if (value === undefined) return { status: "ready", selectionId: null, args: {} };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { status: "malformed" };
  const record = value as Record<string, unknown>;
  if ("source_path" in record) return { status: "path_named" };
  if (!("selection_id" in record)) return { status: "ready", selectionId: null, args: record };
  const selectionId = record["selection_id"];
  if (typeof selectionId !== "string" || selectionId === "" || selectionId.length > 100)
    return { status: "malformed" };
  const args: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) if (key !== "selection_id") args[key] = entry;
  return { status: "ready", selectionId, args };
}

/**
 * A picture the renderer made rather than a file somebody chose.
 *
 * An area capture crops what is already on screen, so there is no path to hand over. The bytes
 * come across, the main process writes them to a scratch file, and the ordinary import path
 * takes it from there, hashing, deduplication and type sniffing all still apply, which they
 * would not if the renderer were allowed a second way in.
 */
export interface CapturedAssetRequest {
  /** PNG bytes, base64. */
  bytes: string;
  name: string;
}

/** Roughly 12 MB of PNG once decoded. A crop of one page cannot legitimately exceed it. */
export const CAPTURED_ASSET_LIMIT = 16_000_000;

export function readCapturedAssetRequest(value: unknown): CapturedAssetRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "bytes" && key !== "name")) return null;
  const bytes = record["bytes"];
  const name = record["name"];
  if (typeof bytes !== "string" || bytes === "" || bytes.length > CAPTURED_ASSET_LIMIT) return null;
  // Base64 and nothing else. The string reaches a file name and a decoder, so anything that is
  // not base64 is rejected here rather than further in.
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(bytes)) return null;
  if (typeof name !== "string" || name === "" || name.length > 120) return null;
  // The name becomes a file on disk. Only what a capture legitimately produces is allowed.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.png$/u.test(name)) return null;
  return { bytes, name };
}

export function readDroppedAssetRequest(value: unknown): DroppedAssetRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path" && key !== "declaredMediaType")) return null;
  if (typeof record["path"] !== "string" || record["path"] === "" || record["path"].length > 32_767)
    return null;
  if (
    record["declaredMediaType"] !== null &&
    (typeof record["declaredMediaType"] !== "string" || record["declaredMediaType"].length > 255)
  )
    return null;
  return {
    path: record["path"],
    declaredMediaType: record["declaredMediaType"] as string | null,
  };
}

export const WORKSPACE_COLLABORATION_ACTIONS = [
  "snapshot",
  "invite",
  "revoke_invitation",
  "update_member",
  "remove_member",
  "create_project",
  "update_project",
] as const;

export interface WorkspaceCollaborationRequest {
  action: (typeof WORKSPACE_COLLABORATION_ACTIONS)[number];
  input: Record<string, unknown>;
}

export function readWorkspaceCollaborationAction(
  value: unknown,
): WorkspaceCollaborationRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "action" && key !== "input")) return null;
  if (
    typeof record["action"] !== "string" ||
    !WORKSPACE_COLLABORATION_ACTIONS.includes(record["action"] as never)
  )
    return null;
  if (
    record["input"] === null ||
    typeof record["input"] !== "object" ||
    Array.isArray(record["input"])
  )
    return null;
  return {
    action: record["action"] as WorkspaceCollaborationRequest["action"],
    input: record["input"] as Record<string, unknown>,
  };
}

export interface WorkspacePresenceRequest {
  documentId: string;
  cursor: number;
}

/**
 * Two states, because there are only two things to do about it. Offline, signed out, no workspace
 * bound to this window, a refused request and a request that never came back are all `unavailable`:
 * none of them is a state the renderer can act on differently, and each of them means the same
 * thing on screen, which is that presence is not being shown right now.
 */
export type WorkspacePresenceResult =
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
 * A presence poll says which document and where the caret is, and nothing else. The workspace is
 * not asked for: the main process fills it in from the session this window is actually looking at,
 * the same way it does for every command, so a renderer cannot report itself into a workspace it
 * does not have open.
 */
export function readWorkspacePresenceRequest(value: unknown): WorkspacePresenceRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "documentId" && key !== "cursor")) return null;
  const documentId = record["documentId"];
  const cursor = record["cursor"];
  if (typeof documentId !== "string" || documentId === "" || documentId.length > 200) return null;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) return null;
  return { documentId, cursor };
}

/**
 * The service refreshes a presence row only for a sequence above the one it already holds, so a
 * sequence that does not climb is a way of quietly expiring yourself while you are still typing.
 * Wall-clock milliseconds climb on their own, except across a clock correction; and two windows of
 * one account on one document share a row and take turns raising it. Both are handled by never
 * going backwards. This lives here rather than in the renderer because the renderer has no reason
 * to know the transport has a rule about it.
 */
export function presenceSequence(previous: number, now: number): number {
  return Math.max(Math.trunc(now), Math.trunc(previous) + 1, 1);
}

/**
 * What is waiting to be sent for the workspace this window has open, and how the last attempt went.
 *
 * Like presence, the workspace is not asked for: it is the one bound to this window. Unlike
 * presence, an answer that cannot be given is worth telling apart from an answer that says nothing
 * is pending, because the second is a claim and the first is not -- a status that reads
 * "synchronized" while nothing is being asked is the one thing this must never do.
 */
export interface WorkspaceSyncStatus {
  /** Whether this window can reach the service at all. */
  connection: "online" | "offline";
  /**
   * Offline because somebody chose it, rather than because nothing answered.
   *
   * Worth telling apart: one of them ends when the network comes back and the other ends when
   * a person says so, and a status that told somebody to wait for a connection they had switched
   * off themselves would be telling them to wait forever.
   */
  working_offline: boolean;
  pending: {
    /** Workspaces the service has not been told about yet. */
    registrations: number;
    /** Saved changes to objects, waiting to be accepted. */
    structured_changes: number;
    /** Keystrokes in shared documents, waiting to be accepted. */
    document_operations: number;
    total: number;
  };
  /** Saves the service refused because somebody else had changed the same object. */
  conflicts: number;
  last_succeeded_at: string | null;
  last_failure: { at: string; reason: string } | null;
}

export type WorkspaceSyncStatusResult =
  ({ status: "known" } & WorkspaceSyncStatus) | { status: "unknown" };

export function readWorkspaceCreateRequest(value: unknown): WorkspaceCreateRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "selectionId" && key !== "title")) return null;
  if (typeof record["selectionId"] !== "string" || record["selectionId"].length > 100) return null;
  if (typeof record["title"] !== "string" || record["title"].length > 200) return null;
  if (record["selectionId"] === "" || record["title"].trim() === "") return null;
  return { selectionId: record["selectionId"], title: record["title"] };
}

export function isAllowedWindowAction(value: unknown): value is AllowedWindowAction {
  return typeof value === "string" && (WINDOW_ACTIONS as readonly string[]).includes(value);
}

export interface LatexCompileProblem {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
}

/**
 * What Home shows: every workspace this account has opened, with the projects inside it.
 *
 * Assembled in the main process because it reads several workspace folders at once, and the
 * renderer is never allowed to name a folder. The renderer picks a workspace id and a project
 * id; the paths stay on this side.
 */
export interface ProjectDirectoryEntry {
  workspaceId: string;
  workspaceTitle: string;
  /** Shown so a reader can tell two workspaces with the same name apart. */
  displayPath: string;
  lastOpenedAt: string;
  /** Null when the folder could not be read: moved, renamed, or on a drive that is not here. */
  projects: Array<{
    id: string;
    title: string;
    description: string;
    updatedAt: string;
    archived: boolean;
    /** How the project says its material should be treated, so Home can show the marking. */
    sensitivity: string;
    counts: Record<string, number>;
  }> | null;
}

/**
 * One thing found by a search across every workspace.
 *
 * The project and the workspace are on the row rather than looked up afterwards: a result
 * somebody cannot place is a result they cannot use, and only this side knows which folder each
 * projection belongs to.
 */
export interface GlobalSearchHit {
  workspaceId: string;
  workspaceTitle: string;
  objectId: string;
  objectType: string;
  title: string;
  project: { id: string; title: string } | null;
  rank: number;
}

export interface LatexCompileOutcome {
  status: "ok" | "failed";
  /** Where the compile ran, so the interface can say so rather than guessing. */
  ran: "cloud" | "local";
  /** The document as a data URL, or null when none was produced. */
  pdf: string | null;
  problems: LatexCompileProblem[];
}

/**
 * The formats a manuscript can leave Kiwi in, besides the PDF the compiler already makes.
 *
 * `tex` is written from the source and lands as a folder somebody else can compile. `docx` is
 * written from the node tree and lands as one file, because that is the shape a co-author or a
 * journal expects to be sent.
 */
export const DOCUMENT_EXPORT_FORMATS = ["tex", "docx"] as const;

export type DocumentExportFormat = (typeof DOCUMENT_EXPORT_FORMATS)[number];

export interface DocumentExportRequest {
  workspace_id: string;
  format: DocumentExportFormat;
  /** The manuscript's title. It becomes a folder or a file name, never a path. */
  title: string;
  source: string;
  files: Array<{ name: string; asset_id?: string; text?: string }>;
  /** The node tree, for a format rendered from the document rather than from the source. */
  document?: unknown;
  /** The reference list, already formatted in the project's style, in its printed order. */
  references?: string[];
  /** What each cited object currently reads as, so Word gets the style that is on screen. */
  citation_labels?: Record<string, string>;
}

/**
 * What an export did, in the words the summary uses.
 *
 * `destination` is a folder for one format and a file for another, so it is named for what it
 * means rather than for either shape. `notes` carries what the format could not carry: every
 * export says what it wrote and what it left behind, because an export that quietly drops
 * something reaches a journal before anyone notices.
 */
export type DocumentExportOutcome =
  | { status: "written"; destination: string; files: string[]; notes: string[] }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** A list of short strings from the renderer, bounded so a bad one cannot fill memory. */
function readStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length <= 2_000)
    .slice(0, limit);
}

function readLabels(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value).slice(0, 5_000)) {
    if (typeof label === "string" && label.length <= 500) labels[key] = label;
  }
  return labels;
}

export function readDocumentExportRequest(value: unknown): DocumentExportRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const format = record["format"];
  if (typeof format !== "string" || !DOCUMENT_EXPORT_FORMATS.includes(format as never)) return null;
  const workspaceId = record["workspace_id"];
  const title = record["title"];
  const source = record["source"];
  const document = record["document"];
  if (typeof workspaceId !== "string" || workspaceId === "") return null;
  if (typeof title !== "string" || title.length > 500) return null;
  if (typeof source !== "string" || source.length > 4_000_000) return null;
  // Each format has one thing it cannot be written without, and an empty one of either is a
  // person exporting a manuscript they have not started.
  if (format === "tex" && source.trim() === "") return null;
  if (format === "docx" && (document === null || typeof document !== "object")) return null;
  return {
    workspace_id: workspaceId,
    format: format as DocumentExportFormat,
    title,
    source,
    files: Array.isArray(record["files"])
      ? (record["files"] as DocumentExportRequest["files"])
      : [],
    document,
    references: readStrings(record["references"], 5_000),
    citation_labels: readLabels(record["citation_labels"]),
  };
}

/**
 * A request to write chosen Papers out as a reference file.
 *
 * The renderer names the papers and the format and nothing else. Where the file goes is the
 * person's answer to a save dialog, and which folder the papers are read from is the window's
 * open workspace, so neither ever crosses this boundary.
 */
export interface LibraryExportRequest {
  workspace_id: string;
  format: LibraryExportFormat;
  /** The chosen Papers. An empty list means every Paper that has a record. */
  object_ids: string[];
}

/** What a library export did. `count` is how many Papers reached the file. */
export type LibraryExportOutcome =
  | { status: "written"; path: string; count: number }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export function readLibraryExportRequest(value: unknown): LibraryExportRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const workspaceId = record["workspace_id"];
  if (typeof workspaceId !== "string" || workspaceId === "") return null;
  if (!isLibraryExportFormat(record["format"])) return null;
  const ids = record["object_ids"];
  if (ids !== undefined && !Array.isArray(ids)) return null;
  return {
    workspace_id: workspaceId,
    format: record["format"],
    object_ids: readStrings(ids, 5_000),
  };
}
