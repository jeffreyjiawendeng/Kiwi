import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";
import {
  PROTOCOL_VERSION,
  WORKSPACE_COLLABORATION_PATHS,
  WORKSPACE_COEDIT_PATHS,
  WORKSPACE_SYNC_PATHS,
  documentToDocxParts,
  isRecoveryAction,
  isWorkspaceSummary,
  type CommandResult,
  type ErrorCode,
  type RecoveryAction,
  type StructuredSyncChange,
  type StructuredSyncSubmitRequest,
  type CoeditWireOperation,
  type WorkspaceSummary,
} from "@kiwi/contracts";
import { describeCause, toKiwiError, type Logger } from "@kiwi/diagnostics";
import {
  APP_ORIGIN,
  APP_SCHEME,
  hardenSession,
  hardenWebContents,
  researchWindowOptions,
} from "./security.js";
import {
  IPC_CHANNELS,
  isAllowedWindowAction,
  readDroppedAssetRequest,
  readCapturedAssetRequest,
  readReferenceImportRequest,
  readDocumentExportRequest,
  readLibraryExportRequest,
  readWorkspaceCreateRequest,
  readWorkspaceCollaborationAction,
  readWorkspacePresenceRequest,
  presenceSequence,
  type BridgeCapabilities,
  type DocumentExportOutcome,
  type LibraryExportOutcome,
  type LatexCompileOutcome,
  type ManagedAssetSelection,
  type ProjectDirectoryEntry,
  type GlobalSearchHit,
  type WorkspaceSyncStatusResult,
} from "./ipc.js";
import { listPdfFolder } from "./pdf-folder.js";
import { exportFolderName, resolveBundleFiles, writeDocumentBundle } from "./document-bundle.js";
import { writeZip } from "./zip.js";
import { buildAboutInfo, type AboutInfo } from "./about.js";
import { createMainLogger, fileSink, logDirectory } from "./logging.js";
import {
  shouldPersistAccountSession,
  throwIfFaultRequested,
  type StartupStatus,
} from "./startup.js";
import { createCommandService, readRequestId, type CommandService } from "./command-service.js";
import { createWorkerHost, workerEntry, type WorkerHost } from "./worker-host.js";
import { classifyRendererExit, type RendererFailure } from "./supervisor.js";
import {
  createSessionRegistry,
  electronSessionPaths,
  type SessionRegistry,
} from "./workspace-session.js";
import { uuidV7 } from "./uuid-v7.js";
import { createWorkspaceFolderBroker } from "./workspace-folder-broker.js";
import { createAssetFileBroker } from "./asset-file-broker.js";
import {
  createDetachedWindows,
  isDetachRequest,
  type DetachedAssignment,
} from "./detached-windows.js";
import { createAccountServiceClient, type AccountServiceClient } from "./account-service-client.js";
import { resolveAccountServiceOrigin } from "./service-origin.js";
import {
  publicLinkAvailability,
  readPublicLinkKey,
  resolvePublicLinks,
  type PublicLinks,
} from "./public-links.js";
import { createGoogleSignInBroker, type GoogleSignInBroker } from "./google-sign-in-broker.js";
import {
  DEFAULT_LATEX_ENGINE,
  isLatexEngine,
  isSignInProvider,
  MAXIMUM_AVATAR_SOURCE_BYTES,
  readAccountRegistrationProfile,
  readAvatarMediaType,
  type SignInProvider,
} from "@kiwi/contracts";
import { createMemorySessionVault, createProtectedSessionVault } from "./session-vault.js";
import { createCollaborationOutbox, type CollaborationOutbox } from "./collaboration-outbox.js";
import { createStructuredSyncStore, type StructuredSyncStore } from "./structured-sync-store.js";
import { createCoeditSyncStore, type CoeditSyncStore } from "./coedit-sync-store.js";
import { summarizePendingSynchronization } from "./sign-out-preview.js";
import { createSyncJournal } from "./sync-journal.js";
import { createProjectionService, type ProjectionService } from "./projection.js";
import { createRecoveryDraftStore } from "./recovery-draft-store.js";
import { createOfflineMode, type OfflineModeStore } from "./offline-mode.js";
import { isReadOnlyWorkspaceCommand, needsWorkspaceRoot } from "./workspace-command-gate.js";
import {
  createUpdateController,
  describeUpdateFailure,
  updatesOffReason,
  type UpdateController,
  type UpdateFeed,
  type UpdateState,
} from "./updater.js";
import { prepareAvatarImage } from "./avatar-image.js";
import { ASSET_SCHEME, createAssetResponder, readWorkspaceAsset } from "./asset-protocol.js";
import { SELECTION_SCHEME, createSelectionResponder } from "./selection-protocol.js";
import { compileDocument, type CloudCompiler } from "./latex-compiler.js";
import {
  applyCoeditNoteOperations,
  applyStructuredSyncChange,
  listCoeditNotes,
  listProjects,
  listCanonicalRelations,
  IN_PROJECT_RELATION,
} from "@kiwi/workspace";

// app.getAppPath() resolves to the application root in development and inside the
// packaged archive, so the same path arithmetic works in both.
const distRoot = resolve(app.getAppPath(), "dist");
const rendererRoot = join(distRoot, "renderer");
const preloadPath = join(distRoot, "preload", "index.cjs");

const devServerOrigin = process.env["KIWI_DEV_SERVER"] ?? null;
const isDevelopment = devServerOrigin !== null;

// An installed Kiwi keeps its sign-in, recent workspaces, and logs in %APPDATA%\Kiwi. A run from
// the repository keeps them in a folder of its own, so that developing Kiwi on a machine that also
// has it installed does not hand one copy the other's session for a different service. Set before
// anything asks for a path, because Electron fixes them on first use.
if (!app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), "Kiwi Development"));
}

// A module script is refused unless it arrives as JavaScript, so .mjs has to be here: PDF.js
// ships its worker as one, and served as application/octet-stream it never loaded, which left
// every document unreadable.
const CONTENT_TYPES = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);

let startupStatus: StartupStatus = { status: "ready" };
let logger: Logger | null = null;
let commands: CommandService | null = null;
let workerHost: WorkerHost | null = null;
let lastRendererFailure: RendererFailure | null = null;
let sessions: SessionRegistry | null = null;
// The hosted compiler, once the service offers one. Null means every compile is local.
const latexCloudCompiler: CloudCompiler | null = null;
let accountService: AccountServiceClient | null = null;
let googleSignIn: GoogleSignInBroker | null = null;
let collaborationOutbox: CollaborationOutbox | null = null;
let structuredSyncStore: StructuredSyncStore | null = null;
let coeditSyncStore: CoeditSyncStore | null = null;
let offlineMode: OfflineModeStore | null = null;
let updates: UpdateController | null = null;
// Nothing to construct and nothing on disk, so it is made here rather than wired up at startup.
const syncJournal = createSyncJournal();
let projection: ProjectionService | null = null;
let publicLinks: PublicLinks = { terms: null, privacy: null, support: null };
const workspaceFolders = createWorkspaceFolderBroker({ newId: uuidV7 });
const assetFiles = createAssetFileBroker({ newId: uuidV7 });
const detachedWindows = createDetachedWindows();

async function issueAssetSelection(
  windowId: number,
  path: string,
  declaredMediaType: string | null,
) {
  const details = await lstat(path).catch(() => null);
  if (details === null || !details.isFile() || details.isSymbolicLink()) return null;
  return assetFiles.issue({
    windowId,
    path,
    name: basename(path),
    size: details.size,
    modifiedAt: details.mtime.toISOString(),
    declaredMediaType,
  });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    // PDF.js reads the document with fetch and ranged requests, so the scheme has to support
    // the fetch API and count as secure.
    //
    // corsEnabled is required, not a relaxation. The window is a page on the application scheme
    // and a document is on this one, so every read of a document is a cross-origin request;
    // without this Chromium refuses it before the handler runs, with "Cross origin requests are
    // only supported for protocol schemes", and no PDF could ever be opened. What may read it is
    // decided by the one origin the responder names in access-control-allow-origin.
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    // The same privileges, for the same reason, one step earlier: this is how PDF.js reads a
    // file that has been picked and is still being reviewed, before anything has imported it.
    scheme: SELECTION_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function resolveRendererFile(pathname: string): string | null {
  const requested = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const candidate = normalize(join(rendererRoot, decodeURIComponent(requested)));
  // Reject any path that escapes the packaged renderer directory.
  if (candidate !== rendererRoot && !candidate.startsWith(rendererRoot + sep)) {
    return null;
  }
  return candidate;
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveRendererFile(new URL(request.url).pathname);
    if (filePath === null) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await readFile(filePath);
      const extension = filePath.slice(filePath.lastIndexOf("."));
      const contentType = CONTENT_TYPES.get(extension) ?? "application/octet-stream";
      return new Response(new Uint8Array(body), { headers: { "content-type": contentType } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

/** The origin the window itself runs on, which is the only one allowed to read a document. */
const windowOrigin = devServerOrigin ?? APP_ORIGIN;

function registerAssetProtocol(): void {
  const respond = createAssetResponder({
    rootFor: (workspaceId) => sessions?.rootFor(workspaceId) ?? null,
    allowOrigin: windowOrigin,
  });
  protocol.handle(ASSET_SCHEME, (request) => respond(request.url));
}

function registerSelectionProtocol(): void {
  const respond = createSelectionResponder({
    peek: (id) => assetFiles.peek(id),
    allowOrigin: windowOrigin,
  });
  protocol.handle(SELECTION_SCHEME, (request) => respond(request.url));
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null) {
    return null;
  }
  return BrowserWindow.fromWebContents(event.sender);
}

function requireSender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = senderWindow(event);
  if (window === null) {
    throw new Error("Denied: unrecognized sender");
  }
  return window;
}

function rejectedCommand(
  code: ErrorCode,
  message: string,
  recoveryActions: RecoveryAction[] = ["correct_input"],
): CommandResult {
  const requestId = uuidV7();
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    status: "failed",
    error: toKiwiError({
      code,
      message,
      correlationId: requestId,
      recoveryActions,
    }),
  };
}

function structuredChangesFromResult(
  envelope: unknown,
  result: CommandResult,
): StructuredSyncSubmitRequest[] {
  if (result.status !== "committed" || result.transaction_id === undefined) return [];
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return [];
  const request = envelope as Record<string, unknown>;
  const command = request["command"];
  const workspaceId = request["workspace_id"];
  if (typeof workspaceId !== "string") return [];
  if (command === "kiwi.object.bulk-add-tag" || command === "kiwi.object.bulk-remove-tag") {
    const receipt = result.data?.["receipt"];
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return [];
    const changes = (receipt as Record<string, unknown>)["changes"];
    if (!Array.isArray(changes)) return [];
    return changes.flatMap((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const change = value as Record<string, unknown>;
      const object = change["object"];
      if (object === null || typeof object !== "object" || Array.isArray(object)) return [];
      const snapshot = object as Record<string, unknown>;
      if (
        typeof snapshot["id"] !== "string" ||
        typeof snapshot["version"] !== "number" ||
        typeof snapshot["content_hash"] !== "string" ||
        typeof change["base_version"] !== "number" ||
        typeof change["base_hash"] !== "string"
      )
        return [];
      return [
        {
          workspace_id: workspaceId,
          command_id: `${result.transaction_id}:${index + 1}`,
          object_id: snapshot["id"],
          base_version: change["base_version"],
          base_hash: change["base_hash"],
          proposed: {
            version: snapshot["version"],
            content_hash: snapshot["content_hash"],
            snapshot,
          },
        },
      ];
    });
  }
  if (
    command !== "kiwi.object.create-inbox" &&
    command !== "kiwi.object.save" &&
    command !== "kiwi.object.restore-version" &&
    command !== "kiwi.object.rename" &&
    command !== "kiwi.object.tag" &&
    command !== "kiwi.object.duplicate" &&
    command !== "kiwi.conflict.resolve"
  )
    return [];
  const args = request["args"];
  const object = result.data?.["object"];
  if (
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    object === null ||
    typeof object !== "object" ||
    Array.isArray(object)
  )
    return [];
  const argument = args as Record<string, unknown>;
  const snapshot = object as Record<string, unknown>;
  if (
    typeof snapshot["id"] !== "string" ||
    typeof snapshot["version"] !== "number" ||
    typeof snapshot["content_hash"] !== "string"
  )
    return [];
  const creating = command === "kiwi.object.create-inbox" || command === "kiwi.object.duplicate";
  return [
    {
      workspace_id: workspaceId,
      command_id: result.transaction_id,
      object_id: snapshot["id"],
      base_version: creating ? 0 : Number(argument["expected_version"]),
      base_hash: creating ? null : String(argument["expected_hash"]),
      proposed: {
        version: snapshot["version"],
        content_hash: snapshot["content_hash"],
        snapshot,
      },
    },
  ];
}

function coeditChangeFromResult(
  envelope: unknown,
  result: CommandResult,
): { workspace_id: string; document_id: string; operations: CoeditWireOperation[] } | null {
  if (result.status !== "committed") return null;
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const request = envelope as Record<string, unknown>;
  if (request["command"] !== "kiwi.note.create" && request["command"] !== "kiwi.note.replace-text")
    return null;
  const note = result.data?.["note"];
  const operations = result.data?.["operations"];
  if (
    typeof request["workspace_id"] !== "string" ||
    note === null ||
    typeof note !== "object" ||
    Array.isArray(note) ||
    typeof (note as Record<string, unknown>)["document_id"] !== "string" ||
    !Array.isArray(operations)
  )
    return null;
  return {
    workspace_id: request["workspace_id"],
    document_id: String((note as Record<string, unknown>)["document_id"]),
    operations: operations as CoeditWireOperation[],
  };
}

/**
 * One pass over the queues, recording whether it got through.
 *
 * The queues themselves cannot say that. An empty outbox after a run that was refused looks the
 * same as an empty outbox after a run that worked, and the status in the top bar is mostly about
 * telling those two apart.
 */
async function synchronizeWorkspace(
  workspace: WorkspaceSummary,
  accountId: string,
): Promise<{ status: "synchronized" | "pending" | "conflict"; pending: number }> {
  if (offlineMode?.offline() === true) {
    // Not a failure and not a success: nothing was tried. Writing either into the journal would
    // put a time on the status bar that describes a run that never happened.
    const waiting = await structuredSyncStore?.pending(accountId, workspace.workspaceId);
    return { status: "pending", pending: waiting?.length ?? 0 };
  }
  const outcome = await runSynchronization(workspace, accountId);
  const at = new Date();
  if (outcome.failure === null) syncJournal.succeeded(workspace.workspaceId, at);
  else syncJournal.failed(workspace.workspaceId, outcome.failure, at);
  return { status: outcome.status, pending: outcome.pending };
}

async function runSynchronization(
  workspace: WorkspaceSummary,
  accountId: string,
): Promise<{
  status: "synchronized" | "pending" | "conflict";
  pending: number;
  /** Why it stopped, or null if it did not. */
  failure: string | null;
}> {
  if (structuredSyncStore === null || coeditSyncStore === null || accountService === null)
    return { status: "pending", pending: 0, failure: "Synchronization is not ready yet." };
  const actor = `account:${accountId}`;
  let conflictCount = 0;
  let failure: string | null = null;
  for (const change of await structuredSyncStore.pending(accountId, workspace.workspaceId)) {
    const result = await accountService.workspaceSync(WORKSPACE_SYNC_PATHS.submit, change);
    if (result.status === "error") {
      failure = result.message;
      break;
    }
    if (result.status === "conflict") {
      conflictCount += 1;
      await structuredSyncStore.recordConflict(accountId, workspace.workspaceId, result);
      const remote: StructuredSyncChange = {
        sequence: result.sequence,
        workspace_id: workspace.workspaceId,
        command_id: change.command_id,
        object_id: result.object_id,
        base_version: result.base_version,
        base_hash: result.base_hash,
        proposed: result.current,
        actor_id: "account:remote",
        accepted_at: new Date().toISOString(),
      };
      await applyStructuredSyncChange({
        root: workspace.root,
        workspaceId: workspace.workspaceId,
        change: remote,
        actor,
        requestId: change.command_id,
        now: new Date().toISOString(),
        newId: uuidV7,
      });
    }
    await structuredSyncStore.complete(accountId, change.command_id);
  }

  let cursor = await structuredSyncStore.cursor(accountId, workspace.workspaceId);
  while (true) {
    const pulled = await accountService.workspaceSync(WORKSPACE_SYNC_PATHS.pull, {
      workspace_id: workspace.workspaceId,
      after_sequence: cursor,
      limit: 100,
    });
    if (pulled.status !== "changes") {
      if (pulled.status === "error") failure = pulled.message;
      break;
    }
    for (const change of pulled.changes) {
      const applied = await applyStructuredSyncChange({
        root: workspace.root,
        workspaceId: workspace.workspaceId,
        change,
        actor,
        requestId: change.command_id,
        now: new Date().toISOString(),
        newId: uuidV7,
      });
      if (applied.status === "conflict") conflictCount += 1;
      cursor = change.sequence;
      await structuredSyncStore.setCursor(accountId, workspace.workspaceId, cursor);
    }
    if (pulled.changes.length < 100) break;
  }

  for (const batch of await coeditSyncStore.pending(accountId, workspace.workspaceId)) {
    const pushed = await accountService.workspaceCoedit(WORKSPACE_COEDIT_PATHS.push, batch);
    if (pushed.status === "error") {
      failure = pushed.message;
      break;
    }
    if (pushed.status === "operations_accepted") {
      await coeditSyncStore.complete(
        accountId,
        pushed.accepted.map((item) => item.operation_id),
      );
    }
  }
  for (const note of await listCoeditNotes(workspace.root)) {
    await coeditSyncStore.rememberDocument(accountId, workspace.workspaceId, note.document_id);
  }
  const remoteDocuments = await accountService.workspaceCoedit(WORKSPACE_COEDIT_PATHS.documents, {
    workspace_id: workspace.workspaceId,
  });
  if (remoteDocuments.status === "documents") {
    for (const documentId of remoteDocuments.document_ids)
      await coeditSyncStore.rememberDocument(accountId, workspace.workspaceId, documentId);
  }
  for (const documentId of await coeditSyncStore.documents(accountId, workspace.workspaceId)) {
    let coeditCursor = await coeditSyncStore.cursor(accountId, workspace.workspaceId, documentId);
    while (true) {
      const pulled = await accountService.workspaceCoedit(WORKSPACE_COEDIT_PATHS.pull, {
        workspace_id: workspace.workspaceId,
        document_id: documentId,
        after_sequence: coeditCursor,
        limit: 500,
      });
      if (pulled.status !== "operations") {
        if (pulled.status === "error") failure = pulled.message;
        break;
      }
      if (pulled.operations.length > 0) {
        await applyCoeditNoteOperations({
          root: workspace.root,
          workspaceId: workspace.workspaceId,
          documentId,
          operations: pulled.operations.map((item) => item.operation),
          actor,
          requestId: uuidV7(),
          now: new Date().toISOString(),
          transactionId: uuidV7(),
          preparedEventId: uuidV7(),
          domainEventId: uuidV7(),
          committedEventId: uuidV7(),
        });
      }
      coeditCursor = pulled.next_sequence;
      await coeditSyncStore.setCursor(accountId, workspace.workspaceId, documentId, coeditCursor);
      if (pulled.operations.length < 500) break;
    }
  }
  const pending =
    (await structuredSyncStore.pending(accountId, workspace.workspaceId)).length +
    (await coeditSyncStore.pending(accountId, workspace.workspaceId)).reduce(
      (total, item) => total + item.operations.length,
      0,
    );
  return {
    status: conflictCount > 0 ? "conflict" : pending > 0 ? "pending" : "synchronized",
    pending,
    failure,
  };
}

async function invokeAndBind(window: BrowserWindow, envelope: unknown): Promise<CommandResult> {
  const authState = await accountService?.ensureSession();
  if (authState?.status !== "authenticated") {
    return rejectedCommand("KIWI_FORBIDDEN", "Sign in to use Kiwi.");
  }
  if (commands === null) {
    return rejectedCommand("KIWI_UNAVAILABLE", "The command service is not available.", ["retry"]);
  }

  let result = await commands.invoke(
    envelope,
    readRequestId(envelope),
    `account:${authState.account.id}`,
  );
  const commandName =
    envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>)["command"]
      : null;
  const activeBefore = sessions?.forWindow(window.id)?.summary;
  if (
    result.status !== "failed" &&
    activeBefore !== undefined &&
    projection !== null &&
    commandName === "kiwi.workspace.health"
  ) {
    const projectionStatus = await projection.status(activeBefore);
    const health = result.data?.["health"];
    if (health !== null && typeof health === "object" && !Array.isArray(health)) {
      result = {
        ...result,
        data: { ...result.data, health: { ...health, projection: projectionStatus } },
      };
    }
  }
  const queued = structuredChangesFromResult(envelope, result);
  const coeditQueued = coeditChangeFromResult(envelope, result);
  for (const change of queued) await structuredSyncStore?.queue(authState.account.id, change);
  if (coeditQueued !== null) {
    await coeditSyncStore?.queue(authState.account.id, coeditQueued);
  }
  if (queued.length > 0 || coeditQueued !== null) {
    const active = sessions?.forWindow(window.id)?.summary;
    const sync =
      active !== undefined && authState.connection === "online"
        ? await synchronizeWorkspace(active, authState.account.id).catch(() => ({
            status: "pending" as const,
            pending: 1,
          }))
        : { status: "pending" as const, pending: 1 };
    const presence =
      coeditQueued !== null && active !== undefined && authState.connection === "online"
        ? await accountService
            ?.workspaceCoedit(WORKSPACE_COEDIT_PATHS.presence, {
              workspace_id: coeditQueued.workspace_id,
              document_id: coeditQueued.document_id,
              sequence: Date.now(),
              cursor:
                envelope !== null && typeof envelope === "object"
                  ? String(
                      (
                        (envelope as Record<string, unknown>)["args"] as
                          Record<string, unknown> | undefined
                      )?.["content"] ?? "",
                    ).length
                  : 0,
            })
            .catch(() => null)
        : null;
    result = {
      ...result,
      data: {
        ...result.data,
        sync: {
          ...sync,
          collaborators: presence?.status === "presence" ? presence.collaborators.length : 1,
          presence: presence?.status === "presence" ? presence.collaborators : [],
        },
      },
    };
  }
  if (
    result.status !== "failed" &&
    activeBefore !== undefined &&
    projection !== null &&
    typeof commandName === "string" &&
    (commandName.startsWith("kiwi.asset.") ||
      commandName.startsWith("kiwi.object.") ||
      commandName.startsWith("kiwi.relation.") ||
      commandName.startsWith("kiwi.conflict.") ||
      commandName.startsWith("kiwi.thread.") ||
      commandName.startsWith("kiwi.task.") ||
      commandName.startsWith("kiwi.protocol.") ||
      commandName.startsWith("kiwi.claim.") ||
      commandName.startsWith("kiwi.note.")) &&
    !new Set([
      "kiwi.asset.open-managed",
      "kiwi.asset.reveal-managed",
      "kiwi.object.list",
      "kiwi.object.read",
      "kiwi.object.read-version",
      "kiwi.object.history",
      "kiwi.object.validate-save",
      "kiwi.object.validate-restore",
      "kiwi.object.validate-trash",
      "kiwi.object.trash-list",
      "kiwi.object.trash-policy",
      "kiwi.object.validate-trash-policy",
      "kiwi.object.validate-trash-purge",
      "kiwi.relation.for-object",
      "kiwi.conflict.list",
      "kiwi.thread.list",
      "kiwi.task.list",
      "kiwi.protocol.read",
      "kiwi.claim.list",
      "kiwi.note.list",
      "kiwi.note.read",
    ]).has(commandName)
  ) {
    const projectionStatus = await projection.ensure(activeBefore).catch(() => null);
    if (projectionStatus !== null)
      result = { ...result, data: { ...result.data, projection: projectionStatus } };
  }
  const workspace = result.data?.["workspace"];
  if (result.status === "failed" || sessions === null || !isWorkspaceSummary(workspace)) {
    return result;
  }

  const bind = await sessions.bind(window.id, workspace);
  if (bind.bound) {
    const projectionStatus =
      projection !== null && workspace.trust === "trusted" && workspace.workspaceId !== ""
        ? await projection.ensure(workspace).catch(() => null)
        : null;
    if (projectionStatus !== null)
      result = { ...result, data: { ...result.data, projection: projectionStatus } };
    const registration = await accountService?.workspaceCollaboration(
      WORKSPACE_COLLABORATION_PATHS.register,
      { workspace_id: workspace.workspaceId, title: workspace.title },
    );
    if (registration?.status === "ok") {
      const sync =
        authState.connection === "online"
          ? await synchronizeWorkspace(workspace, authState.account.id).catch(() => ({
              status: "pending" as const,
              pending: 0,
            }))
          : { status: "pending" as const, pending: 0 };
      return { ...result, data: { ...result.data, registration: "registered", sync } };
    }
    await collaborationOutbox?.queueRegistration({
      account_id: authState.account.id,
      workspace_id: workspace.workspaceId,
      title: workspace.title,
    });
    return {
      ...result,
      data: { ...result.data, registration: "pending" },
      warnings: [...(result.warnings ?? []), "Workspace ownership registration is pending."],
    };
  }
  return {
    ...result,
    status: "failed",
    error: {
      code: "KIWI_WORKSPACE_LOCKED",
      message: "Another Kiwi process already has this workspace open.",
      details: { held_by_pid: bind.heldByPid },
      retryable: true,
      recovery_actions: ["retry"],
      correlation_id: result.request_id,
    },
  };
}

async function performRecovery(action: RecoveryAction, window: BrowserWindow): Promise<void> {
  switch (action) {
    case "retry":
    case "restart_application":
      app.relaunch();
      app.exit(0);
      return;
    case "open_logs":
      await shell.openPath(logDirectory());
      return;
    case "quit":
      window.close();
      return;
    case "copy_diagnostic_reference":
      return;
  }
}

/**
 * What to say about figures the workspace could not hand over.
 *
 * The export goes ahead without them, because a manuscript missing one picture is still worth
 * having, and the sentence that refers to it is still in the text. What must not happen is the
 * export looking complete.
 */
function missingFigureNotes(missing: string[]): string[] {
  if (missing.length === 0) return [];
  const one = missing.length === 1;
  return [
    `${String(missing.length)} ${one ? "figure" : "figures"} could not be read and ${one ? "was" : "were"} left out. The manuscript still refers to ${one ? "it" : "them"}.`,
  ];
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.publicLinksGet, (event) => {
    requireSender(event);
    return publicLinkAvailability(publicLinks);
  });

  ipcMain.handle(IPC_CHANNELS.publicLinkOpen, async (event, value: unknown) => {
    requireSender(event);
    const key = readPublicLinkKey(value);
    if (key === null || publicLinks[key] === null) return false;
    try {
      await shell.openExternal(publicLinks[key]);
      return true;
    } catch (cause) {
      logger?.warn("public_link.open_failed", { key, ...describeCause(cause) });
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.accountServiceStatus, async (event) => {
    requireSender(event);
    return accountService?.check() ?? { status: "unavailable", retryable: true };
  });

  ipcMain.handle(IPC_CHANNELS.accountAuthState, async (event) => {
    const window = requireSender(event);
    const state = (await accountService?.restore()) ?? { status: "signed_out" as const };
    if (state.status === "authenticated" && state.connection === "online") {
      await collaborationOutbox?.flush(state.account.id, async (value) => {
        const result = await accountService!.workspaceCollaboration(
          WORKSPACE_COLLABORATION_PATHS.register,
          value,
        );
        return result.status === "ok";
      });
      const active = sessions?.forWindow(window.id)?.summary;
      if (active !== undefined) {
        await synchronizeWorkspace(active, state.account.id).catch(() => undefined);
      }
    }
    return state;
  });

  ipcMain.handle(IPC_CHANNELS.accountCreatePassword, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.createPasswordAccount(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountVerifyEmail, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.verifyEmail(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountResendEmailVerification, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.resendEmailVerification(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountSignInPassword, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.signInWithPassword(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountReauthenticatePassword, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.reauthenticateWithPassword(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Password confirmation is unavailable. Try another sign-in method.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountReauthenticateProvider, async (event, input: unknown) => {
    requireSender(event);
    const provider = isSignInProvider((input as { provider?: unknown } | null)?.provider)
      ? (input as { provider: SignInProvider }).provider
      : null;
    if (provider === null) {
      return { status: "error", code: "invalid_input", message: "Choose a sign-in method." };
    }
    return (
      (await googleSignIn?.start({ provider, mode: "reauthenticate" })) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Provider confirmation is unavailable. Try another sign-in method.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountRequestPasswordReset, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.requestPasswordReset(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountResetPassword, async (event, input: unknown) => {
    requireSender(event);
    return (
      accountService?.resetPassword(input) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Account access is unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountIdentityLink, async (event, input: unknown) => {
    requireSender(event);
    const provider = isSignInProvider((input as { provider?: unknown } | null)?.provider)
      ? (input as { provider: SignInProvider }).provider
      : null;
    if (provider === null) {
      return {
        status: "error",
        code: "invalid_input",
        message: "Choose a sign-in method.",
      };
    }
    return (
      (await googleSignIn?.start({ provider, mode: "link" })) ?? {
        status: "error",
        code: "service_unavailable",
        message: "Sign-in methods are unavailable. Try again.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.connectionsList, async (event) => {
    requireSender(event);
    return accountService?.listConnections();
  });

  ipcMain.handle(IPC_CHANNELS.connectionsStart, async (event, input: unknown) => {
    requireSender(event);
    const started = await accountService?.startConnection(input);
    // The renderer never opens an external page itself. The trusted process checks the
    // provider host before handing the page to the system browser.
    if (started?.status === "browser_required") {
      try {
        await shell.openExternal(started.authorization_url);
      } catch {
        return {
          status: "error",
          code: "provider_unavailable",
          message: "Kiwi could not open the system browser.",
        };
      }
    }
    if (started?.status === "device_required") {
      try {
        await shell.openExternal(started.prompt.verification_uri);
      } catch {
        // The dialog still shows the address and code, so the flow can continue.
      }
    }
    return started;
  });

  ipcMain.handle(IPC_CHANNELS.connectionsPoll, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.pollConnection(input);
  });

  ipcMain.handle(IPC_CHANNELS.connectionsDisconnect, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.disconnectConnection(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountNotificationsList, async (event) => {
    requireSender(event);
    return accountService?.listAccountNotifications();
  });

  ipcMain.handle(IPC_CHANNELS.accountNotificationRead, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.markAccountNotificationRead(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountNotificationDismiss, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.dismissAccountNotification(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountIdentityUnlink, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.unlinkIdentity(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountProviderSignIn, async (event, input: unknown) => {
    requireSender(event);
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const provider = record?.["provider"];
    const rawProfile = record?.["registration_profile"];
    let registrationProfile: ReturnType<typeof readAccountRegistrationProfile> | undefined;
    if (rawProfile !== undefined) {
      registrationProfile = readAccountRegistrationProfile(rawProfile);
    }
    if (
      record === null ||
      !Object.keys(record).every((key) => key === "provider" || key === "registration_profile") ||
      !isSignInProvider(provider) ||
      registrationProfile === null ||
      (provider !== "google" && registrationProfile !== undefined)
    ) {
      return {
        status: "error",
        code: "invalid_input",
        message: "Choose a valid sign-in method.",
      };
    }
    return (
      (await googleSignIn?.start({
        provider,
        mode: "sign_in",
        ...(registrationProfile === undefined ? {} : { registrationProfile }),
      })) ?? {
        status: "error",
        code: "service_unavailable",
        message: "That sign-in method is unavailable. Try another method.",
      }
    );
  });

  ipcMain.handle(IPC_CHANNELS.accountProviderCancel, (event): boolean => {
    requireSender(event);
    return googleSignIn?.cancel() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.accountSignOutPreview, async (event) => {
    requireSender(event);
    const state = await accountService?.ensureSession();
    if (state?.status !== "authenticated") {
      return {
        pending_workspace_registrations: 0,
        pending_structured_changes: 0,
        pending_document_operations: 0,
        total: 0,
      };
    }
    return summarizePendingSynchronization(state.account.id, {
      registrations: collaborationOutbox,
      structured: structuredSyncStore,
      documents: coeditSyncStore,
    });
  });

  ipcMain.handle(IPC_CHANNELS.accountSignOut, async (event) => {
    requireSender(event);
    // What synchronization did for this account is not something the next one should be told.
    syncJournal.forget();
    return (await accountService?.signOut()) ?? { status: "signed_out" };
  });

  ipcMain.handle(IPC_CHANNELS.latexCompile, async (event, raw): Promise<LatexCompileOutcome> => {
    requireSender(event);
    const request = raw as {
      workspace_id?: unknown;
      source?: unknown;
      engine?: unknown;
      files?: unknown;
      prefer?: unknown;
    };
    const workspaceId = typeof request.workspace_id === "string" ? request.workspace_id : "";
    const source = typeof request.source === "string" ? request.source : "";
    const engine = isLatexEngine(request.engine) ? request.engine : DEFAULT_LATEX_ENGINE;
    const prefer = request.prefer === "local" ? "local" : "cloud";
    const root = sessions?.rootFor(workspaceId) ?? null;

    if (root === null || source.trim() === "") {
      return {
        status: "failed",
        ran: prefer,
        pdf: null,
        problems: [
          {
            severity: "error",
            file: null,
            line: null,
            message: "Open the workspace and write something before compiling.",
          },
        ],
      };
    }

    // Figures are read here rather than in the renderer: the renderer names an asset id and
    // the main process is the only thing that turns one into a path.
    const { files } = await resolveBundleFiles(request.files, (assetId) =>
      readWorkspaceAsset(root, assetId),
    );

    const outcome = await compileDocument(
      { source, engine, files },
      { prefer, cloud: latexCloudCompiler },
    ).catch((cause: unknown) => {
      logger?.warn("latex.compile_failed", {
        reason: cause instanceof Error ? cause.message : "unknown error",
      });
      return null;
    });

    if (outcome === null) {
      return {
        status: "failed",
        ran: prefer,
        pdf: null,
        problems: [
          {
            severity: "error",
            file: null,
            line: null,
            message: "Kiwi could not run a compiler. Try again, or check the logs.",
          },
        ],
      };
    }

    logger?.info("latex.compiled", {
      ran: outcome.ran,
      status: outcome.status,
      problem_count: outcome.problems.length,
    });

    // The PDF crosses to the renderer as a data URL because the renderer cannot read a file
    // and the document is transient, it is not a managed asset unless someone saves it.
    return {
      status: outcome.status,
      ran: outcome.ran,
      pdf:
        outcome.pdf === null
          ? null
          : `data:application/pdf;base64,${Buffer.from(outcome.pdf).toString("base64")}`,
      problems: outcome.problems,
    };
  });

  /**
   * Writes a manuscript out as source somebody else can open.
   *
   * The renderer sends the rendered source and the ids of the figures it refers to. This side
   * chooses the folder, reads the assets, and writes the files; the renderer never learns where
   * any of it went beyond the folder's own name.
   */
  ipcMain.handle(
    IPC_CHANNELS.documentExport,
    async (event, raw): Promise<DocumentExportOutcome> => {
      const window = requireSender(event);
      const request = readDocumentExportRequest(raw);
      if (request === null) {
        return { status: "error", message: "Write something before exporting." };
      }
      const root = sessions?.rootFor(request.workspace_id) ?? null;
      if (root === null) {
        return { status: "error", message: "Open the workspace before exporting." };
      }
      const name = exportFolderName(request.title);
      const { files, missing } = await resolveBundleFiles(request.files, (assetId) =>
        readWorkspaceAsset(root, assetId),
      );

      // A LaTeX export is a folder of files that have to sit beside each other to compile. A
      // Word export is one file, which is the thing a person attaches to an email. The dialog
      // has to match, so each format asks for the place it is going to write.
      if (request.format === "docx") {
        const chosen = await dialog.showSaveDialog(window, {
          title: "Export manuscript",
          buttonLabel: "Export",
          defaultPath: `${name}.docx`,
          filters: [{ name: "Word document", extensions: ["docx"] }],
        });
        if (chosen.canceled || chosen.filePath === undefined) return { status: "cancelled" };
        try {
          const { parts, notes } = documentToDocxParts(request.document, {
            title: request.title,
            figures: files,
            references: request.references ?? [],
            citationLabels: request.citation_labels ?? {},
          });
          const encoder = new TextEncoder();
          const archive = writeZip(
            parts.map((part) => ({
              name: part.name,
              data: typeof part.data === "string" ? encoder.encode(part.data) : part.data,
            })),
          );
          await writeFile(chosen.filePath, archive);
          logger?.info("document.exported", {
            format: request.format,
            file_count: parts.length,
            missing_count: missing.length,
          });
          return {
            status: "written",
            destination: basename(chosen.filePath),
            files: [],
            notes: [...notes, ...missingFigureNotes(missing)],
          };
        } catch (cause) {
          logger?.warn("document.export_failed", describeCause(cause));
          return {
            status: "error",
            message: "Kiwi could not write that file. Choose another location.",
          };
        }
      }

      const choice = await dialog.showOpenDialog(window, {
        title: "Export manuscript",
        buttonLabel: "Export here",
        properties: ["openDirectory", "createDirectory"],
      });
      const directory = choice.filePaths[0];
      if (choice.canceled || directory === undefined) return { status: "cancelled" };

      try {
        const written = await writeDocumentBundle({
          directory,
          folder: name,
          sourceName: `${name}.tex`,
          source: request.source,
          files,
        });
        logger?.info("document.exported", {
          format: request.format,
          file_count: written.files.length,
          missing_count: missing.length,
        });
        return {
          status: "written",
          destination: written.folder,
          files: written.files,
          notes: missingFigureNotes(missing),
        };
      } catch (cause) {
        logger?.warn("document.export_failed", describeCause(cause));
        return {
          status: "error",
          message: "Kiwi could not write into that folder. Choose another location.",
        };
      }
    },
  );

  /**
   * A library leaves as a file somebody chose a place for, not as text through the renderer.
   *
   * The Papers are read here, from the workspace this window has open, so the renderer names
   * which Papers and which format and never names a folder.
   */
  ipcMain.handle(IPC_CHANNELS.libraryExport, async (event, raw): Promise<LibraryExportOutcome> => {
    const window = requireSender(event);
    const request = readLibraryExportRequest(raw);
    if (request === null) {
      return { status: "error", message: "Choose a format before exporting." };
    }
    const active = sessions?.forWindow(window.id)?.summary;
    if (active === undefined) {
      return { status: "error", message: "Open the workspace before exporting." };
    }

    const result = await invokeAndBind(window, {
      protocol_version: PROTOCOL_VERSION,
      request_id: uuidV7(),
      idempotency_key: uuidV7(),
      workspace_id: active.workspaceId,
      command: "kiwi.bibliography.export",
      args: {
        root: active.root,
        format: request.format,
        // No chosen Papers means the whole library, which is what the command already does
        // when it is not given a list.
        ...(request.object_ids.length === 0 ? {} : { object_ids: request.object_ids }),
      },
    });
    const text = result.data?.["text"];
    const extension = result.data?.["extension"];
    if (result.status === "failed" || typeof text !== "string" || typeof extension !== "string") {
      return {
        status: "error",
        message: result.error?.message ?? "Kiwi could not read the library.",
      };
    }
    const count = Number(result.data?.["count"] ?? 0);
    // Said before the dialog opens rather than after somebody has named a file for nothing.
    if (count === 0) {
      return { status: "error", message: "None of those items has a reference record yet." };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const chosen = await dialog.showSaveDialog(window, {
      title: "Export references",
      buttonLabel: "Export",
      defaultPath: `kiwi-library-${stamp}.${extension}`,
      filters: [
        {
          name: { bibtex: "BibTeX", ris: "RIS", csv: "CSV" }[request.format],
          extensions: [extension],
        },
      ],
    });
    if (chosen.canceled || chosen.filePath === undefined) return { status: "cancelled" };
    try {
      await writeFile(chosen.filePath, text, "utf8");
      logger?.info("library.exported", { format: request.format, count });
      return { status: "written", path: basename(chosen.filePath), count };
    } catch (cause) {
      logger?.warn("library.export_failed", describeCause(cause));
      return {
        status: "error",
        message: "Kiwi could not write that file. Choose another location.",
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.accountSettingsGet, async (event) => {
    requireSender(event);
    return accountService?.getAccountSettings();
  });

  ipcMain.handle(IPC_CHANNELS.accountProfileUpdate, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.updateAccountProfile(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailAdd, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.addAccountEmail(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailVerify, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.verifyAccountEmail2(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailResend, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.resendAccountEmail(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailPromote, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.promoteAccountEmail(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailNotifications, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.setAccountNotificationEmail(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountEmailRemove, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.removeAccountEmail(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountPasswordRemove, async (event) => {
    requireSender(event);
    return accountService?.removeAccountPassword();
  });

  // The renderer never names the file. The dialog runs here, the bytes are read here,
  // and only the refreshed settings return.
  ipcMain.handle(IPC_CHANNELS.accountAvatarChoose, async (event) => {
    const window = requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") return null;
    const choice = await dialog.showOpenDialog(window, {
      title: "Choose a profile picture",
      buttonLabel: "Choose image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    const path = choice.filePaths[0];
    if (choice.canceled || path === undefined) return null;
    const stats = await lstat(path).catch(() => null);
    if (stats === null || !stats.isFile() || stats.size > MAXIMUM_AVATAR_SOURCE_BYTES) {
      return {
        status: "error",
        code: "invalid_input",
        message: "Choose a PNG, JPEG, or WebP image no larger than 10 MB.",
      };
    }
    const bytes = await readFile(path).catch(() => null);
    const mediaType = bytes === null ? null : readAvatarMediaType(bytes);
    if (bytes === null || mediaType === null) {
      return {
        status: "error",
        code: "invalid_input",
        message: "That file is not a PNG, JPEG, or WebP image.",
      };
    }
    const prepared = prepareAvatarImage(nativeImage.createFromBuffer(bytes), bytes, mediaType);
    if (prepared === null) {
      return {
        status: "error",
        code: "invalid_input",
        message: "Kiwi could not prepare that image. Choose another PNG, JPEG, or WebP image.",
      };
    }
    return accountService?.setAccountAvatar({
      media_type: prepared.mediaType,
      data: prepared.bytes.toString("base64"),
    });
  });

  ipcMain.handle(IPC_CHANNELS.accountAvatarRemove, async (event) => {
    requireSender(event);
    return accountService?.removeAccountAvatar();
  });

  ipcMain.handle(IPC_CHANNELS.accountAvatarRead, async (event) => {
    requireSender(event);
    const image = (await accountService?.readAccountAvatar()) ?? null;
    return image === null ? null : `data:${image.media_type};base64,${image.data}`;
  });

  // The export never enters the renderer. The renderer asks for it, the main process
  // fetches it and writes it to the file the person chose, and only the path comes back.
  ipcMain.handle(IPC_CHANNELS.accountExport, async (event) => {
    const window = requireSender(event);
    const exported = await accountService?.readAccountExport();
    if (exported === undefined) {
      return { status: "error", message: "Account settings are unavailable. Try again." };
    }
    if (exported.status !== "ok") return exported;
    const stamp = new Date().toISOString().slice(0, 10);
    const choice = await dialog.showSaveDialog(window, {
      title: "Export account data",
      buttonLabel: "Export",
      defaultPath: `kiwi-account-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (choice.canceled || choice.filePath === undefined) return { status: "cancelled" };
    try {
      await writeFile(choice.filePath, exported.document, "utf8");
      return { status: "written", path: basename(choice.filePath) };
    } catch {
      return {
        status: "error",
        message: "Kiwi could not write that file. Choose another location.",
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.accountNotificationPreference, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.setAccountNotificationPreference(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountPasswordSet, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.setAccountPassword(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountSessionRevoke, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.revokeAccountSession(input);
  });

  ipcMain.handle(IPC_CHANNELS.accountSessionsRevokeOthers, async (event) => {
    requireSender(event);
    return accountService?.revokeOtherAccountSessions();
  });

  ipcMain.handle(IPC_CHANNELS.accountDeletionRequest, async (event, input: unknown) => {
    requireSender(event);
    return accountService?.requestAccountDeletion(input);
  });

  ipcMain.handle(IPC_CHANNELS.capabilities, (event): BridgeCapabilities => {
    requireSender(event);
    return {
      protocolVersion: PROTOCOL_VERSION,
      appVersion: app.getVersion(),
      commands: commands !== null,
      queries: false,
      subscriptions: false,
      streams: false,
    };
  });

  ipcMain.handle(IPC_CHANNELS.about, (event): AboutInfo => {
    requireSender(event);
    return buildAboutInfo({
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node,
      },
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      env: process.env,
    });
  });

  ipcMain.handle(IPC_CHANNELS.updateState, (event): UpdateState => {
    requireSender(event);
    return updates?.state() ?? { status: "off", reason: "development" };
  });

  ipcMain.handle(IPC_CHANNELS.updateCheck, async (event): Promise<UpdateState> => {
    requireSender(event);
    return (await updates?.checkNow()) ?? { status: "off", reason: "development" };
  });

  ipcMain.handle(IPC_CHANNELS.updateRestart, (event): boolean => {
    requireSender(event);
    return updates?.restart() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.commandInvoke, async (event, envelope: unknown) => {
    const window = requireSender(event);
    const envelopeRecord =
      envelope !== null && typeof envelope === "object"
        ? (envelope as Record<string, unknown>)
        : null;
    const commandName = envelopeRecord?.["command"];
    let trustedEnvelope = envelope;
    if (commandName === "kiwi.asset.import-managed") {
      const active = sessions?.forWindow(window.id)?.summary;
      if (active === undefined || !active.writable)
        return rejectedCommand(
          "KIWI_FORBIDDEN",
          "Open a writable workspace before adding a managed file.",
        );
      const args = envelopeRecord?.["args"];
      const argsRecord =
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : null;
      const selectionId = argsRecord?.["selection_id"];
      if (
        argsRecord === null ||
        Object.keys(argsRecord).some((key) => key !== "selection_id") ||
        typeof selectionId !== "string" ||
        selectionId === "" ||
        selectionId.length > 100
      )
        return rejectedCommand("KIWI_INVALID_REQUEST", "Choose one file before importing it.");
      const selected = assetFiles.consume(window.id, selectionId);
      if (selected === null)
        return rejectedCommand(
          "KIWI_PATH_DENIED",
          "Choose the file again. The prior file selection expired.",
          ["retry"],
        );
      trustedEnvelope = {
        ...envelopeRecord,
        workspace_id: active.workspaceId,
        args: {
          root: active.root,
          source_path: selected.path,
          declared_media_type: selected.declaredMediaType,
        },
      };
    }
    /**
     * Swaps the file a person picked for where that file actually is.
     *
     * A reference library is routinely larger than a command may be, so the import commands are
     * told where the file is and open it themselves. That path is this side's to supply: the
     * renderer picked the file through a dialog this process opened, and what it holds is an
     * identifier for that choice. The same substitution a managed asset import already relies on,
     * for the same reason -- a path in the renderer is a path in the least trustworthy part of
     * the application.
     */
    if (
      commandName === "kiwi.bibliography.import-preview" ||
      commandName === "kiwi.bibliography.import"
    ) {
      const request = readReferenceImportRequest(envelopeRecord?.["args"]);
      if (request.status === "path_named")
        return rejectedCommand(
          "KIWI_PATH_DENIED",
          "Choose the file again through the import window.",
        );
      if (request.status === "malformed")
        return rejectedCommand("KIWI_INVALID_REQUEST", "Choose one file before importing it.");
      if (request.selectionId !== null) {
        const selected = assetFiles.consume(window.id, request.selectionId);
        if (selected === null)
          return rejectedCommand(
            "KIWI_PATH_DENIED",
            "Choose the file again. The prior file selection expired.",
            ["retry"],
          );
        trustedEnvelope = {
          ...envelopeRecord,
          args: { ...request.args, source_path: selected.path },
        };
      }
    }
    if (
      commandName === "kiwi.workspace.rename" ||
      commandName === "kiwi.workspace.recover-transactions"
    ) {
      const args = envelopeRecord?.["args"];
      const root =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)["root"]
          : null;
      const active = sessions?.forWindow(window.id)?.summary;
      if (active === undefined || active.root !== root || !active.writable) {
        return rejectedCommand(
          "KIWI_FORBIDDEN",
          commandName === "kiwi.workspace.rename"
            ? "Only the active writable workspace can be renamed."
            : "Only the active writable workspace can be recovered.",
        );
      }
      if (commandName === "kiwi.workspace.recover-transactions" && active !== undefined) {
        trustedEnvelope = { ...(envelopeRecord ?? {}), workspace_id: active.workspaceId };
      }
    }
    if (typeof commandName === "string" && commandName.startsWith("kiwi.draft.")) {
      const active = sessions?.forWindow(window.id)?.summary;
      if (active === undefined) {
        return rejectedCommand("KIWI_FORBIDDEN", "Open a workspace before using recovery drafts.");
      }
      trustedEnvelope = { ...(envelopeRecord ?? {}), workspace_id: active.workspaceId };
    }
    if (typeof commandName === "string" && needsWorkspaceRoot(commandName)) {
      const active = sessions?.forWindow(window.id)?.summary;
      const readOnlyCommand = isReadOnlyWorkspaceCommand(commandName);
      if (active === undefined || (!readOnlyCommand && !active.writable)) {
        return rejectedCommand(
          "KIWI_FORBIDDEN",
          readOnlyCommand
            ? "Open a workspace before reading research objects."
            : "Open a writable workspace before changing research objects.",
        );
      }
      if (commandName !== "kiwi.asset.import-managed") {
        // Whatever an earlier step settled, rather than what arrived: a path substituted in above
        // has to survive the root override, and an identifier taken out has to stay out.
        const trustedRecord =
          trustedEnvelope !== null && typeof trustedEnvelope === "object"
            ? (trustedEnvelope as Record<string, unknown>)
            : null;
        const suppliedArgs = trustedRecord?.["args"];
        trustedEnvelope = {
          ...(trustedRecord ?? {}),
          workspace_id: active.workspaceId,
          args: {
            ...(suppliedArgs !== null && typeof suppliedArgs === "object"
              ? (suppliedArgs as Record<string, unknown>)
              : {}),
            root: active.root,
          },
        };
      }
    }
    if (envelopeRecord?.["command"] === "kiwi.workspace.create") {
      return rejectedCommand(
        "KIWI_FORBIDDEN",
        "Choose a folder through the workspace creation form.",
      );
    }
    return invokeAndBind(window, trustedEnvelope);
  });

  ipcMain.handle(IPC_CHANNELS.workspaceChooseFolder, async (event) => {
    const window = requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") return null;
    const choice = await dialog.showOpenDialog(window, {
      title: "Choose a folder for the workspace",
      buttonLabel: "Choose folder",
      properties: ["openDirectory", "createDirectory"],
    });
    const root = choice.filePaths[0];
    if (choice.canceled || root === undefined) return null;
    const contents = await readdir(root).catch(() => [] as string[]);
    return workspaceFolders.issue(window.id, root, contents.length > 0);
  });

  ipcMain.handle(IPC_CHANNELS.assetChooseManaged, async (event) => {
    const window = requireSender(event);
    const active = sessions?.forWindow(window.id)?.summary;
    if ((await accountService?.ensureSession())?.status !== "authenticated" || !active?.writable)
      return null;
    const choice = await dialog.showOpenDialog(window, {
      title: "Add a managed file",
      buttonLabel: "Choose file",
      properties: ["openFile"],
    });
    const path = choice.filePaths[0];
    if (choice.canceled || path === undefined) return null;
    return issueAssetSelection(window.id, path, null);
  });

  /**
   * Opens the picker for a folder of PDFs, and answers with one selection per file.
   *
   * The dialog takes a folder; everything after it is the single-file route run once per PDF, so
   * an import of thirty papers is thirty of the imports that already work rather than a second
   * kind of import. A file that vanished between being listed and being asked about, or that
   * turned out not to be a plain file, is counted with the rest that were passed over: it is one
   * missing row, and one missing row should not cost the other twenty-nine.
   */
  ipcMain.handle(IPC_CHANNELS.assetChooseFolder, async (event) => {
    const window = requireSender(event);
    const active = sessions?.forWindow(window.id)?.summary;
    if ((await accountService?.ensureSession())?.status !== "authenticated" || !active?.writable)
      return null;
    const choice = await dialog.showOpenDialog(window, {
      title: "Import a folder of PDFs",
      buttonLabel: "Choose folder",
      properties: ["openDirectory"],
    });
    const root = choice.filePaths[0];
    if (choice.canceled || root === undefined) return null;

    const listing = await listPdfFolder(root);
    const files: ManagedAssetSelection[] = [];
    let skipped = listing.skipped;
    for (const path of listing.paths) {
      // Declared, not determined: the name says PDF, and the import settles what the bytes are.
      const selection = await issueAssetSelection(window.id, path, "application/pdf");
      if (selection === null) skipped += 1;
      else files.push(selection);
    }
    return { name: basename(root), files, skipped, truncated: listing.truncated };
  });

  /**
   * Opens the picker for a reference library, and answers with an identifier rather than a path.
   *
   * The two extensions are offered first and everything else second, because an export saved as
   * `.txt` is common enough that a filter which hid it would look like the file had gone. The
   * format is settled by reading the file, not by what it is called, so nothing rests on the
   * person picking the right filter.
   */
  ipcMain.handle(IPC_CHANNELS.bibliographyChooseFile, async (event) => {
    const window = requireSender(event);
    const active = sessions?.forWindow(window.id)?.summary;
    if ((await accountService?.ensureSession())?.status !== "authenticated" || !active?.writable)
      return null;
    const choice = await dialog.showOpenDialog(window, {
      title: "Import references",
      buttonLabel: "Choose file",
      filters: [
        { name: "Reference libraries", extensions: ["bib", "ris"] },
        { name: "All files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    const path = choice.filePaths[0];
    if (choice.canceled || path === undefined) return null;
    return issueAssetSelection(window.id, path, null);
  });

  ipcMain.handle(IPC_CHANNELS.assetRegisterDropped, async (event, value: unknown) => {
    const window = requireSender(event);
    const active = sessions?.forWindow(window.id)?.summary;
    if ((await accountService?.ensureSession())?.status !== "authenticated" || !active?.writable)
      return null;
    const request = readDroppedAssetRequest(value);
    if (request === null) return null;
    return issueAssetSelection(window.id, request.path, request.declaredMediaType);
  });

  /**
   * Takes the bytes of a region cropped from a page and turns them into an ordinary file
   * selection, so the existing import path does the rest.
   *
   * Written into the operating system's temporary directory rather than anywhere in the
   * workspace: if the import is abandoned, nothing is left in somebody's research folder.
   */
  ipcMain.handle(IPC_CHANNELS.assetCapture, async (event, value: unknown) => {
    const window = requireSender(event);
    const active = sessions?.forWindow(window.id)?.summary;
    if ((await accountService?.ensureSession())?.status !== "authenticated" || !active?.writable)
      return null;
    const request = readCapturedAssetRequest(value);
    if (request === null) return null;

    const bytes = Buffer.from(request.bytes, "base64");
    // A PNG and nothing else. The renderer states the type; this checks it.
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC))
      return null;

    const directory = await mkdtemp(join(tmpdir(), "kiwi-capture-"));
    const path = join(directory, request.name);
    await writeFile(path, bytes);
    const selection = await issueAssetSelection(window.id, path, "image/png");
    if (selection === null)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return selection;
  });

  ipcMain.handle(IPC_CHANNELS.workspaceCreate, async (event, value: unknown) => {
    const window = requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") {
      return rejectedCommand("KIWI_FORBIDDEN", "Sign in to use Kiwi.");
    }
    const request = readWorkspaceCreateRequest(value);
    if (request === null) {
      return rejectedCommand("KIWI_INVALID_REQUEST", "The workspace request is not valid.");
    }
    const root = workspaceFolders.consume(window.id, request.selectionId);
    if (root === null) {
      return rejectedCommand(
        "KIWI_PATH_DENIED",
        "Choose the workspace folder again. The prior folder selection expired.",
      );
    }
    return invokeAndBind(window, {
      protocol_version: PROTOCOL_VERSION,
      request_id: uuidV7(),
      command: "kiwi.workspace.create",
      args: { root, title: request.title, profiles: [] },
    });
  });

  ipcMain.handle(IPC_CHANNELS.workspaceOpenFolder, async (event) => {
    const window = requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") {
      return rejectedCommand("KIWI_FORBIDDEN", "Sign in to use Kiwi.");
    }
    const choice = await dialog.showOpenDialog(window, {
      title: "Open a Kiwi workspace",
      buttonLabel: "Open workspace",
      properties: ["openDirectory"],
    });
    const root = choice.filePaths[0];
    if (choice.canceled || root === undefined) return null;
    return invokeAndBind(window, {
      protocol_version: PROTOCOL_VERSION,
      request_id: uuidV7(),
      command: "kiwi.workspace.open",
      args: { root },
    });
  });

  ipcMain.handle(IPC_CHANNELS.workspaceOpenNewWindow, async (event) => {
    const window = requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") {
      return rejectedCommand("KIWI_FORBIDDEN", "Sign in to use Kiwi.");
    }
    const choice = await dialog.showOpenDialog(window, {
      title: "Open a Kiwi workspace in a new window",
      buttonLabel: "Open new window",
      properties: ["openDirectory"],
    });
    const root = choice.filePaths[0];
    if (choice.canceled || root === undefined) return null;
    return (await createResearchWindow(root)).initialResult;
  });

  /**
   * Opens one object in a window of its own.
   *
   * The child is an ordinary research window opened on the parent's workspace root, so it binds
   * the same workspace session, takes a share of the same lock, and obeys the same `root`
   * override on every command. Nothing about the request names a folder: the renderer asks for
   * an object by id, and this side is what knows where that object lives.
   */
  ipcMain.handle(IPC_CHANNELS.detachDocument, async (event, value: unknown) => {
    const parent = requireSender(event);
    if (!isDetachRequest(value)) throw new Error("Denied: unsupported detach request");

    const session = sessions?.forWindow(parent.id) ?? null;
    if (session === null || session.summary.root === "") {
      return rejectedCommand("KIWI_FORBIDDEN", "Open a workspace before detaching a document.");
    }

    // Detaching the same document twice returns to the window that already has it. Two windows
    // editing one document would be two editors racing each other's saves.
    const existing = detachedWindows.windowShowing(parent.id, value);
    if (existing !== null) {
      const window = BrowserWindow.fromId(existing);
      if (window !== null && !window.isDestroyed()) {
        window.show();
        window.focus();
        return null;
      }
      detachedWindows.clearWindow(existing);
    }

    logger?.info("document.detached", { kind: value.kind });
    const opened = await createResearchWindow(session.summary.root, {
      ...value,
      parentWindowId: parent.id,
    });
    return opened.initialResult;
  });

  ipcMain.handle(IPC_CHANNELS.detachedDocument, (event) => {
    const window = requireSender(event);
    return detachedWindows.forWindow(window.id);
  });

  ipcMain.handle(IPC_CHANNELS.workspaceCollaboration, async (event, value: unknown) => {
    requireSender(event);
    const parsed = readWorkspaceCollaborationAction(value);
    if (parsed === null || accountService === null) {
      return {
        status: "error",
        code: "invalid_input",
        message: "The workspace request is not valid.",
      };
    }
    const paths = {
      snapshot: WORKSPACE_COLLABORATION_PATHS.snapshot,
      invite: WORKSPACE_COLLABORATION_PATHS.invite,
      revoke_invitation: WORKSPACE_COLLABORATION_PATHS.revokeInvitation,
      update_member: WORKSPACE_COLLABORATION_PATHS.updateMember,
      remove_member: WORKSPACE_COLLABORATION_PATHS.removeMember,
      create_project: WORKSPACE_COLLABORATION_PATHS.createProject,
      update_project: WORKSPACE_COLLABORATION_PATHS.updateProject,
    } as const;
    return accountService.workspaceCollaboration(paths[parsed.action], parsed.input);
  });

  // One per window and document. Cleared with the window, which is also when the presence it was
  // counting stops being sent.
  const presenceSequences = new Map<string, number>();

  ipcMain.handle(IPC_CHANNELS.workspacePresence, async (event, value: unknown) => {
    const window = requireSender(event);
    const parsed = readWorkspacePresenceRequest(value);
    const active = sessions?.forWindow(window.id)?.summary;
    // Every way of not having an answer is the same answer. There is nothing the renderer could do
    // differently about being offline than about being signed out, and presence that guesses is
    // worse than presence that says it does not know.
    if (
      parsed === null ||
      accountService === null ||
      active === undefined ||
      active.workspaceId === ""
    ) {
      return { status: "unavailable" as const };
    }
    const key = `${window.id}:${parsed.documentId}`;
    const sequence = presenceSequence(presenceSequences.get(key) ?? 0, Date.now());
    presenceSequences.set(key, sequence);
    const answer = await accountService
      .workspaceCoedit(WORKSPACE_COEDIT_PATHS.presence, {
        workspace_id: active.workspaceId,
        document_id: parsed.documentId,
        sequence,
        cursor: parsed.cursor,
      })
      .catch(() => null);
    return answer?.status === "presence"
      ? { status: "present" as const, collaborators: answer.collaborators }
      : { status: "unavailable" as const };
  });

  ipcMain.handle(
    IPC_CHANNELS.workspaceSyncStatus,
    async (event): Promise<WorkspaceSyncStatusResult> => {
      const window = requireSender(event);
      const active = sessions?.forWindow(window.id)?.summary;
      const state = await accountService?.ensureSession();
      // Nothing signed in, or no workspace on this window. There is no state of sharing to report
      // and the status says nothing rather than reporting a workspace that is not open here.
      if (state?.status !== "authenticated" || active === undefined || active.workspaceId === "") {
        return { status: "unknown" };
      }
      const workspaceId = active.workspaceId;
      const accountId = state.account.id;
      const [registrations, structured, documents, conflicts] = await Promise.all([
        collaborationOutbox?.countFor(accountId, workspaceId) ?? 0,
        structuredSyncStore?.pending(accountId, workspaceId).then((items) => items.length) ?? 0,
        coeditSyncStore
          ?.pending(accountId, workspaceId)
          .then((batches) =>
            batches.reduce((total, batch) => total + batch.operations.length, 0),
          ) ?? 0,
        structuredSyncStore?.conflicts(accountId, workspaceId).then((items) => items.length) ?? 0,
      ]);
      const chosen = offlineMode?.offline() === true;
      return {
        status: "known",
        connection: chosen || state.connection !== "online" ? "offline" : "online",
        working_offline: chosen,
        pending: {
          registrations,
          structured_changes: structured,
          document_operations: documents,
          total: registrations + structured + documents,
        },
        conflicts,
        ...syncJournal.read(workspaceId),
      };
    },
  );

  /**
   * Reads or sets whether this machine is deliberately not reaching out.
   *
   * One channel for both because they are one thing: asking with nothing answers what is in
   * force, and asking with a decision records it and answers the same way. The answer is always
   * the state afterwards, so the switch on Home never has to guess whether it took.
   */
  ipcMain.handle(IPC_CHANNELS.offlineMode, async (event, value: unknown): Promise<boolean> => {
    requireSender(event);
    if (value === undefined || value === null) return offlineMode?.offline() ?? false;
    const record =
      typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const wanted = record?.["offline"];
    if (typeof wanted !== "boolean") throw new Error("Denied: unsupported offline request");
    return (await offlineMode?.set(wanted)) ?? false;
  });

  /**
   * Searches every workspace this account has opened, and says where each result lives.
   *
   * Only this side can do it. A projection is per workspace and the renderer names no folders, so
   * "search everywhere" is a loop over the recent list here rather than a command a page could
   * send. A workspace whose folder has moved, been renamed, or lives on a drive that is not
   * attached is skipped rather than failing the whole search: eleven results from four workspaces
   * is a better answer than an error because the fifth is on a memory stick somebody took home.
   */
  ipcMain.handle(
    IPC_CHANNELS.searchEverywhere,
    async (event, value: unknown): Promise<GlobalSearchHit[]> => {
      requireSender(event);
      if ((await accountService?.ensureSession())?.status !== "authenticated") return [];
      const record =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const query = typeof record?.["query"] === "string" ? record["query"].trim() : "";
      if (query === "" || query.length > 500 || projection === null) return [];

      const recent = (await sessions?.recent.list()) ?? [];
      const hits: GlobalSearchHit[] = [];
      for (const workspace of recent) {
        const target = { workspaceId: workspace.workspaceId, root: workspace.root };
        const found = await projection.search(target, query).catch(() => null);
        if (found === null || found.results.length === 0) continue;

        // Where each result is filed, read once for the workspace rather than once per result.
        const [projects, relations] = await Promise.all([
          listProjects(workspace.root).catch(() => []),
          listCanonicalRelations(workspace.root).catch(() => []),
        ]);
        const projectTitles = new Map(
          projects.map((entry) => [entry.object.id, entry.object.title]),
        );
        const projectOf = new Map<string, string>();
        for (const relation of relations) {
          if (relation.type !== IN_PROJECT_RELATION || relation.assertion !== "asserted") continue;
          projectOf.set(relation.subject.object_id, relation.object.object_id);
        }

        for (const result of found.results) {
          const projectId = projectOf.get(result.id);
          const projectTitle = projectId === undefined ? undefined : projectTitles.get(projectId);
          hits.push({
            workspaceId: workspace.workspaceId,
            workspaceTitle: workspace.title,
            objectId: result.id,
            objectType: result.type,
            title: result.title,
            project:
              projectId === undefined || projectTitle === undefined
                ? null
                : { id: projectId, title: projectTitle },
            rank: result.rank,
          });
        }
      }
      return hits.sort(
        (left, right) => left.rank - right.rank || left.title.localeCompare(right.title),
      );
    },
  );

  /**
   * Opens a workspace this account has opened before, named by id, in a window of its own.
   *
   * Searching everywhere turns up results in workspaces that are not the one open here, and a
   * result somebody cannot reach is only slightly better than one they cannot place. The id comes
   * from the recent list, which this side wrote, so the renderer still names no folders. A new
   * window rather than this one, because whatever is open here was not something they asked to
   * leave.
   */
  ipcMain.handle(
    IPC_CHANNELS.workspaceOpenById,
    async (event, value: unknown): Promise<boolean> => {
      requireSender(event);
      if ((await accountService?.ensureSession())?.status !== "authenticated") return false;
      const record =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const workspaceId = typeof record?.["workspaceId"] === "string" ? record["workspaceId"] : "";
      if (workspaceId === "") return false;
      const recent = (await sessions?.recent.list()) ?? [];
      const found = recent.find((entry) => entry.workspaceId === workspaceId);
      if (found === undefined) return false;
      await createResearchWindow(found.root);
      return true;
    },
  );

  ipcMain.handle(IPC_CHANNELS.commandCancel, (event, requestId: unknown): boolean => {
    requireSender(event);
    if (commands === null || typeof requestId !== "string") return false;
    return commands.cancel(requestId);
  });

  ipcMain.handle(IPC_CHANNELS.commandNames, (event): string[] => {
    requireSender(event);
    return commands?.commandNames() ?? [];
  });

  /**
   * Stops this window working on the workspace it has open.
   *
   * Nothing on disk is touched. What this releases is the lock and the binding: the folder is
   * exactly as it was, and the point of the action is that another Kiwi -- or another window, or
   * the same one tomorrow -- can now open it.
   */
  ipcMain.handle(IPC_CHANNELS.workspaceClose, async (event): Promise<boolean> => {
    const window = requireSender(event);
    if (sessions === null || sessions.forWindow(window.id) === null) return false;
    await sessions.release(window.id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.workspaceSession, (event) => {
    const window = requireSender(event);
    return sessions?.forWindow(window.id) ?? null;
  });

  /**
   * Every workspace this account has opened, with the projects inside each one.
   *
   * Home needs to show projects from several workspaces at once, and only this side knows
   * where those folders are. Reading them here keeps the renderer naming ids rather than
   * paths, which is the same rule every other command follows.
   */
  ipcMain.handle(IPC_CHANNELS.projectDirectory, async (event): Promise<ProjectDirectoryEntry[]> => {
    requireSender(event);
    if ((await accountService?.ensureSession())?.status !== "authenticated") return [];
    const recent = (await sessions?.recent.list()) ?? [];
    const entries: ProjectDirectoryEntry[] = [];
    for (const workspace of recent) {
      // A folder that has moved, been renamed, or lives on a drive that is not attached
      // reads as null rather than as an empty workspace. Those are different situations and
      // Home says so.
      const projects = await listProjects(workspace.root).catch(() => null);
      entries.push({
        workspaceId: workspace.workspaceId,
        workspaceTitle: workspace.title,
        displayPath: workspace.root,
        lastOpenedAt: workspace.lastOpenedAt,
        projects:
          projects === null
            ? null
            : projects.map((entry) => ({
                id: entry.object.id,
                title: entry.object.title,
                description: entry.settings.description,
                updatedAt: entry.object.updated_at,
                archived: entry.settings.archived,
                sensitivity: entry.settings.sensitivity,
                counts: entry.counts,
              })),
      });
    }
    return entries;
  });

  ipcMain.handle(IPC_CHANNELS.runtimeHealth, (event) => {
    requireSender(event);
    const failure = lastRendererFailure;
    lastRendererFailure = null;
    return {
      worker: workerHost?.state() ?? "stopped",
      workerRestarts: workerHost?.restartCount() ?? 0,
      commandsInFlight: commands?.inFlight() ?? 0,
      rendererFailure: failure,
    };
  });

  ipcMain.handle(IPC_CHANNELS.startupStatus, (event): StartupStatus => {
    requireSender(event);
    return startupStatus;
  });

  ipcMain.handle(IPC_CHANNELS.windowAction, (event, action: unknown) => {
    const window = requireSender(event);
    if (!isAllowedWindowAction(action)) {
      throw new Error("Denied: unsupported window action");
    }
    switch (action) {
      case "minimize":
        window.minimize();
        return;
      case "maximize":
        window.maximize();
        return;
      case "unmaximize":
        window.unmaximize();
        return;
      case "toggle-maximize":
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
        return;
      case "close":
        window.close();
        return;
    }
  });

  ipcMain.handle(IPC_CHANNELS.recoveryAction, async (event, action: unknown) => {
    const window = requireSender(event);
    if (!isRecoveryAction(action)) {
      throw new Error("Denied: unsupported recovery action");
    }
    logger?.info("recovery.requested", { action });
    await performRecovery(action, window);
  });
}

/**
 * The icon a copy run from the repository shows in the taskbar.
 *
 * A packaged copy carries its icon in the executable and needs nothing here. One started with
 * `electron .` has no executable of its own and would show Electron's, so the window is given
 * the same file the installer is built from.
 */
function windowIcon(): { icon?: string } {
  if (app.isPackaged) return {};
  const path = join(app.getAppPath(), "build", "icon.ico");
  return existsSync(path) ? { icon: path } : {};
}

async function createResearchWindow(
  initialWorkspaceRoot?: string,
  detachedAs?: DetachedAssignment,
): Promise<{ window: BrowserWindow; initialResult: CommandResult | null }> {
  const window = new BrowserWindow({
    ...researchWindowOptions(preloadPath, nativeTheme.shouldUseDarkColors),
    ...windowIcon(),
  });

  // Recorded before anything loads, because the first thing the renderer asks is what this
  // window is for, and an answer that arrives after the page has rendered is a page that
  // rendered as the wrong thing.
  if (detachedAs !== undefined) detachedWindows.attach(window.id, detachedAs);

  hardenWebContents(window.webContents, devServerOrigin);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    googleSignIn?.cancel();
    workspaceFolders.clearWindow(window.id);
    assetFiles.clearWindow(window.id);
    // A detached window is a view onto the workspace this window holds open. Left behind, it
    // would be a window whose commands resolve against a root that has been released.
    for (const childId of detachedWindows.childrenOf(window.id)) {
      const child = BrowserWindow.fromId(childId);
      if (child !== null && !child.isDestroyed()) child.close();
    }
    detachedWindows.clearWindow(window.id);
    const workspaceId = sessions?.forWindow(window.id)?.summary.workspaceId;
    void sessions?.release(window.id).then(() => {
      if (workspaceId !== undefined && !sessions?.openWorkspaceIds().includes(workspaceId))
        projection?.close(workspaceId);
    });
  });

  // A preload that fails leaves the renderer without its bridge and no other signal.
  window.webContents.on("preload-error", (_event, _preloadPath, cause) => {
    logger?.error("preload.failed", {
      cause_message: cause.message.slice(0, 500),
      ...describeCause(cause),
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    const failure = classifyRendererExit(
      details.reason,
      details.exitCode,
      new Date().toISOString(),
    );
    if (failure === null) return;

    lastRendererFailure = failure;
    logger?.error("renderer.gone", {
      reason: failure.reason,
      exit_code: failure.exitCode,
      recoverable: failure.recoverable,
    });

    // The renderer holds no canonical state, so reloading restores a usable window.
    if (failure.recoverable && !window.isDestroyed()) {
      void window
        .loadURL(devServerOrigin ?? `${APP_ORIGIN}/index.html`)
        .catch((cause: unknown) => logger?.warn("renderer.reload_failed", describeCause(cause)));
    }
  });

  let initialResult: CommandResult | null = null;
  if (initialWorkspaceRoot !== undefined) {
    initialResult = await invokeAndBind(window, {
      protocol_version: PROTOCOL_VERSION,
      request_id: uuidV7(),
      command: "kiwi.workspace.open",
      args: { root: initialWorkspaceRoot },
    });
    if (initialResult.status === "failed") {
      window.destroy();
      return { window, initialResult };
    }
  }

  if (devServerOrigin !== null) {
    await window.loadURL(devServerOrigin);
  } else {
    await window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return { window, initialResult };
}

/**
 * The absolute path of a workspace-relative path, refusing anything that lands outside the root.
 *
 * Both of the shell operations below hand a path to the operating system, which is as far outside
 * Kiwi's control as a path can go. The relative path comes off a canonical file, and canonical
 * files are editable on disk by design, so the check is against reachable input rather than
 * against a hypothetical.
 */
function insideWorkspace(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const canonicalRoot = resolve(root);
  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep))
    throw new Error("The object path escaped its workspace.");
  return target;
}

async function start(): Promise<void> {
  logger = createMainLogger(fileSink(logDirectory()));
  logger.info("startup.begin", { development: isDevelopment });
  publicLinks = resolvePublicLinks({ env: process.env, appPath: app.getAppPath() });

  sessions = createSessionRegistry(electronSessionPaths(), logger.child("workspace"));
  projection = createProjectionService(join(app.getPath("userData"), "workspaces"));
  commands = createCommandService(
    logger,
    sessions,
    projection,
    createRecoveryDraftStore(join(app.getPath("userData"), "recovery-drafts.json")),
    async (root, relativePath) => {
      shell.showItemInFolder(insideWorkspace(root, relativePath));
    },
    async (root, relativePath) => {
      // `openPath` reports a refusal by resolving with the reason rather than by rejecting, so an
      // empty string is the only answer that means the system took the file.
      const failure = await shell.openPath(insideWorkspace(root, relativePath));
      if (failure !== "") throw new Error(failure);
    },
  );
  accountService = createAccountServiceClient({
    origin: resolveAccountServiceOrigin({
      env: process.env,
      isDevelopment,
      appPath: app.getAppPath(),
    }),
    allowInsecureLoopback: isDevelopment,
    reportSessionFailure: (reason) => logger?.warn("session.refresh_failed", { reason }),
    reportServiceUnavailable: (reason) => logger?.warn("account_service.unavailable", { reason }),
    sessionVault: shouldPersistAccountSession(isDevelopment, process.env)
      ? createProtectedSessionVault(join(app.getPath("userData"), "session.vault"), safeStorage)
      : createMemorySessionVault(),
  });
  collaborationOutbox = createCollaborationOutbox(
    join(app.getPath("userData"), "collaboration-outbox.json"),
  );
  structuredSyncStore = createStructuredSyncStore(
    join(app.getPath("userData"), "structured-sync.json"),
  );
  coeditSyncStore = createCoeditSyncStore(join(app.getPath("userData"), "coedit-sync.json"));
  offlineMode = createOfflineMode(join(app.getPath("userData"), "offline-mode.json"));
  await offlineMode.load();
  googleSignIn = createGoogleSignInBroker({
    accountService,
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
  });

  workerHost = createWorkerHost({
    entry: workerEntry(distRoot),
    logger: logger.child("worker-host"),
  });
  workerHost.start();

  hardenSession(session.defaultSession, isDevelopment);
  registerAppProtocol();
  registerAssetProtocol();
  registerSelectionProtocol();
  registerIpcHandlers();

  try {
    throwIfFaultRequested("startup", process.env);
  } catch (cause) {
    const error = toKiwiError({
      code: "KIWI_STARTUP_FAILED",
      message: "Kiwi started but could not finish preparing this session.",
      correlationId: logger.correlationId,
      retryable: true,
      recoveryActions: ["retry", "open_logs", "quit"],
    });
    startupStatus = { status: "failed", error };
    logger.error("startup.failed", { code: error.code, ...describeCause(cause) });
  }

  // The window opens whether or not startup succeeded. A failed session must show the
  // diagnostic screen rather than nothing at all.
  await createResearchWindow();

  if (startupStatus.status === "ready") {
    logger.info("startup.completed");
  }

  await startUpdates();
}

/**
 * Wraps electron-updater so that `updater.ts` can be tested without it.
 *
 * Loaded only when updates are on, so that a development run never evaluates it.
 */
async function electronUpdateFeed(): Promise<UpdateFeed> {
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Kiwi logs what an update did itself, without the HTTP responses electron-updater writes.
  autoUpdater.logger = null;
  return {
    async check() {
      await autoUpdater.checkForUpdates();
    },
    install() {
      // Silent, and started again afterwards: the same install that happens on quit, sooner.
      autoUpdater.quitAndInstall(true, true);
    },
    listen(listener) {
      autoUpdater.on("checking-for-update", () => listener({ kind: "checking" }));
      autoUpdater.on("update-available", (info) =>
        listener({ kind: "available", version: info.version }),
      );
      autoUpdater.on("update-not-available", () => listener({ kind: "none" }));
      autoUpdater.on("download-progress", (progress) =>
        listener({ kind: "progress", percent: progress.percent }),
      );
      autoUpdater.on("update-downloaded", (info) =>
        listener({ kind: "downloaded", version: info.version }),
      );
      autoUpdater.on("error", (error) =>
        listener({ kind: "failed", message: describeUpdateFailure(error) }),
      );
    },
  };
}

async function startUpdates(): Promise<void> {
  // electron-builder writes this file only when the package was built with a feed.
  const off = updatesOffReason({
    isPackaged: app.isPackaged,
    env: process.env,
    hasFeed: app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml")),
  });
  let feed: UpdateFeed | null = null;
  if (off === null) {
    try {
      feed = await electronUpdateFeed();
    } catch (cause) {
      logger?.warn("update.unavailable", describeCause(cause));
    }
  }
  updates = createUpdateController({
    feed,
    off: feed === null ? (off ?? "no_feed") : null,
    offline: () => offlineMode?.offline() === true,
    ...(logger === null ? {} : { logger: logger.child("updates") }),
  });
  updates.start();
}

function main(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents, devServerOrigin);
  });

  app.on("window-all-closed", () => {
    void workerHost?.stop();
    app.quit();
  });

  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  // The same identity the installer registers, so that the taskbar groups every window under
  // Kiwi rather than under the Electron executable that runs them.
  app.setAppUserModelId("dev.kiwi.workspace");
  app.whenReady().then(start, (cause: unknown) => {
    logger?.error("startup.crashed", describeCause(cause));
    app.exit(1);
  });
}

main();
