import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  isRecoveryAction,
  type AccountAuthResult,
  type AccountAuthState,
  type AccountRegistrationProfile,
  type AccountProfile,
  type ConnectedAccountsResult,
  type ConnectedProviderId,
  type SignInProvider,
  type AccountSettingsResult,
  type AccountNotificationsResult,
  type WorkspaceCollaborationResult,
  type RecoveryAction,
} from "@kiwi/contracts";
import {
  IPC_CHANNELS,
  isAllowedWindowAction,
  type DocumentExportOutcome,
  type DocumentExportRequest,
  type LatexCompileOutcome,
  type LibraryExportOutcome,
  type LibraryExportRequest,
  type ProjectDirectoryEntry,
  type GlobalSearchHit,
  type AccountSignOutPreview,
  type AllowedWindowAction,
  type BridgeCapabilities,
  type DesktopAccountServiceStatus,
  type DetachRequest,
  type DetachedAssignment,
  type WorkspacePresenceResult,
  type WorkspaceSyncStatusResult,
  type AssetFolderSelection,
  type ManagedAssetSelection,
  type ReferenceFileSelection,
  type PublicLinkAvailability,
  type PublicLinkKey,
  type WorkspaceCreateRequest,
  type WorkspaceFolderSelection,
} from "../main/ipc.js";
import type { StartupStatus } from "../main/startup.js";
import type { AboutInfo } from "../main/about.js";
import type { UpdateState } from "../main/updater.js";
import type { CommandResult } from "@kiwi/contracts";
import type { RuntimeHealth } from "./health.js";
import type { WindowSession } from "../main/workspace-session.js";

export const BRIDGE_KEY = "kiwiDesktop";
export const BRIDGE_VERSION = "1.0.0";

// Only the outcome crosses the boundary. The exported record is written to the chosen file
// by the main process and never reaches the renderer.
export type AccountExportOutcome =
  | { status: "written"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string; code?: string };

export interface KiwiDesktopBridge {
  readonly version: string;
  getPublicLinks(): Promise<PublicLinkAvailability>;
  openPublicLink(key: PublicLinkKey): Promise<boolean>;
  getCapabilities(): Promise<BridgeCapabilities>;
  getAccountServiceStatus(): Promise<DesktopAccountServiceStatus>;
  getAccountAuthState(): Promise<AccountAuthState>;
  createPasswordAccount(input: {
    email: string;
    email_kind: "personal" | "institutional";
    password: string;
    given_name: string;
    family_name: string;
    phone: string;
  }): Promise<AccountAuthResult>;
  verifyAccountEmail(input: { email: string; code: string }): Promise<AccountAuthResult>;
  resendAccountEmailVerification(input: { email: string }): Promise<AccountAuthResult>;
  signInWithPassword(input: { email: string; password: string }): Promise<AccountAuthResult>;
  reauthenticateWithPassword(input: { password: string }): Promise<AccountAuthResult>;
  reauthenticateWithProvider(input: { provider: SignInProvider }): Promise<AccountAuthResult>;
  requestPasswordReset(input: { email: string }): Promise<AccountAuthResult>;
  resetPassword(input: {
    email: string;
    code: string;
    new_password: string;
  }): Promise<AccountAuthResult>;
  signInWithProvider(input: {
    provider: SignInProvider;
    registration_profile?: AccountRegistrationProfile;
  }): Promise<AccountAuthResult>;
  cancelProviderSignIn(): Promise<boolean>;
  previewSignOut(): Promise<AccountSignOutPreview>;
  signOut(): Promise<AccountAuthResult>;
  getAccountSettings(): Promise<AccountSettingsResult>;
  updateAccountProfile(input: AccountProfile): Promise<AccountSettingsResult>;
  linkSignInMethod(input: { provider: SignInProvider }): Promise<AccountAuthResult>;
  unlinkSignInMethod(input: { provider: SignInProvider }): Promise<AccountAuthResult>;
  listConnections(): Promise<ConnectedAccountsResult>;
  startConnection(input: { provider: ConnectedProviderId }): Promise<ConnectedAccountsResult>;
  pollConnection(input: { transaction_id: string }): Promise<ConnectedAccountsResult>;
  disconnectConnection(input: { provider: ConnectedProviderId }): Promise<ConnectedAccountsResult>;
  listAccountNotifications(): Promise<AccountNotificationsResult>;
  markAccountNotificationRead(input: {
    notification_id: string;
  }): Promise<AccountNotificationsResult>;
  dismissAccountNotification(input: {
    notification_id: string;
  }): Promise<AccountNotificationsResult>;
  addAccountEmail(input: {
    address: string;
    kind: "personal" | "institutional";
  }): Promise<AccountSettingsResult>;
  verifyAccountEmailAddress(input: {
    email_id: string;
    code: string;
  }): Promise<AccountSettingsResult>;
  resendAccountEmail(input: { email_id: string }): Promise<AccountSettingsResult>;
  promoteAccountEmail(input: { email_id: string }): Promise<AccountSettingsResult>;
  setAccountNotificationEmail(input: { email_id: string }): Promise<AccountSettingsResult>;
  removeAccountEmail(input: { email_id: string }): Promise<AccountSettingsResult>;
  chooseAccountAvatar(): Promise<AccountSettingsResult | null>;
  removeAccountAvatar(): Promise<AccountSettingsResult>;
  readAccountAvatar(): Promise<string | null>;
  compileLatex(input: {
    workspace_id: string;
    source: string;
    engine: string;
    files: Array<{ name: string; asset_id?: string; text?: string }>;
    prefer?: "cloud" | "local";
  }): Promise<LatexCompileOutcome>;
  exportDocument(input: DocumentExportRequest): Promise<DocumentExportOutcome>;
  exportLibrary(input: LibraryExportRequest): Promise<LibraryExportOutcome>;
  listProjectDirectory(): Promise<ProjectDirectoryEntry[]>;
  exportAccountData(): Promise<AccountExportOutcome>;
  setAccountNotificationPreference(input: {
    category: string;
    email: boolean;
  }): Promise<AccountSettingsResult>;
  setAccountPassword(input: {
    current_password: string | null;
    new_password: string;
  }): Promise<AccountSettingsResult>;
  removeAccountPassword(): Promise<AccountSettingsResult>;
  revokeAccountSession(input: { session_id: string }): Promise<AccountSettingsResult>;
  revokeOtherAccountSessions(): Promise<AccountSettingsResult>;
  requestAccountDeletion(input: { confirmation: "DELETE" }): Promise<AccountSettingsResult>;
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
  }): Promise<WorkspaceCollaborationResult>;
  readWorkspacePresence(input: {
    documentId: string;
    cursor: number;
  }): Promise<WorkspacePresenceResult>;
  readWorkspaceSyncStatus(): Promise<WorkspaceSyncStatusResult>;
  closeWorkspace(): Promise<boolean>;
  searchEverywhere(input: { query: string }): Promise<GlobalSearchHit[]>;
  openWorkspaceById(input: { workspaceId: string }): Promise<boolean>;
  readOfflineMode(): Promise<boolean>;
  setOfflineMode(input: { offline: boolean }): Promise<boolean>;
  getStartupStatus(): Promise<StartupStatus>;
  getAbout(): Promise<AboutInfo>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  restartToUpdate(): Promise<boolean>;
  listCommands(): Promise<string[]>;
  invokeCommand(envelope: unknown): Promise<CommandResult>;
  cancelCommand(requestId: string): Promise<boolean>;
  getRuntimeHealth(): Promise<RuntimeHealth>;
  chooseManagedAsset(): Promise<ManagedAssetSelection | null>;
  chooseAssetFolder(): Promise<AssetFolderSelection | null>;
  captureManagedAsset(input: {
    bytes: string;
    name: string;
  }): Promise<ManagedAssetSelection | null>;
  registerDroppedManagedAsset(
    file: Parameters<typeof webUtils.getPathForFile>[0],
  ): Promise<ManagedAssetSelection | null>;
  chooseReferenceFile(): Promise<ReferenceFileSelection | null>;
  chooseWorkspaceFolder(): Promise<WorkspaceFolderSelection | null>;
  createWorkspace(input: WorkspaceCreateRequest): Promise<CommandResult>;
  openWorkspaceFolder(): Promise<CommandResult | null>;
  openWorkspaceInNewWindow(): Promise<CommandResult | null>;
  detachDocument(request: DetachRequest): Promise<CommandResult | null>;
  getDetachedDocument(): Promise<DetachedAssignment | null>;
  getWorkspaceSession(): Promise<WindowSession | null>;
  performWindowAction(action: AllowedWindowAction): Promise<void>;
  performRecoveryAction(action: RecoveryAction): Promise<void>;
}

export function createBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  pathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]) => string = (file) =>
    webUtils.getPathForFile(file),
) {
  const bridge: KiwiDesktopBridge = {
    version: BRIDGE_VERSION,

    async getPublicLinks(): Promise<PublicLinkAvailability> {
      return (await invoke(IPC_CHANNELS.publicLinksGet)) as PublicLinkAvailability;
    },

    async openPublicLink(key): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.publicLinkOpen, key)) as boolean;
    },

    async getCapabilities(): Promise<BridgeCapabilities> {
      return (await invoke(IPC_CHANNELS.capabilities)) as BridgeCapabilities;
    },

    async getAccountServiceStatus(): Promise<DesktopAccountServiceStatus> {
      return (await invoke(IPC_CHANNELS.accountServiceStatus)) as DesktopAccountServiceStatus;
    },

    async getAccountAuthState(): Promise<AccountAuthState> {
      return (await invoke(IPC_CHANNELS.accountAuthState)) as AccountAuthState;
    },

    async createPasswordAccount(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountCreatePassword, input)) as AccountAuthResult;
    },

    async verifyAccountEmail(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountVerifyEmail, input)) as AccountAuthResult;
    },

    async resendAccountEmailVerification(input): Promise<AccountAuthResult> {
      return (await invoke(
        IPC_CHANNELS.accountResendEmailVerification,
        input,
      )) as AccountAuthResult;
    },

    async signInWithPassword(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountSignInPassword, input)) as AccountAuthResult;
    },

    async reauthenticateWithPassword(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountReauthenticatePassword, input)) as AccountAuthResult;
    },

    async reauthenticateWithProvider(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountReauthenticateProvider, input)) as AccountAuthResult;
    },

    async requestPasswordReset(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountRequestPasswordReset, input)) as AccountAuthResult;
    },

    async resetPassword(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountResetPassword, input)) as AccountAuthResult;
    },

    async signInWithProvider(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountProviderSignIn, input)) as AccountAuthResult;
    },

    async cancelProviderSignIn(): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.accountProviderCancel)) as boolean;
    },

    async previewSignOut(): Promise<AccountSignOutPreview> {
      return (await invoke(IPC_CHANNELS.accountSignOutPreview)) as AccountSignOutPreview;
    },

    async signOut(): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountSignOut)) as AccountAuthResult;
    },

    async getAccountSettings(): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountSettingsGet)) as AccountSettingsResult;
    },

    async updateAccountProfile(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountProfileUpdate, input)) as AccountSettingsResult;
    },

    async linkSignInMethod(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountIdentityLink, input)) as AccountAuthResult;
    },

    async unlinkSignInMethod(input): Promise<AccountAuthResult> {
      return (await invoke(IPC_CHANNELS.accountIdentityUnlink, input)) as AccountAuthResult;
    },

    async listConnections(): Promise<ConnectedAccountsResult> {
      return (await invoke(IPC_CHANNELS.connectionsList)) as ConnectedAccountsResult;
    },

    async startConnection(input): Promise<ConnectedAccountsResult> {
      return (await invoke(IPC_CHANNELS.connectionsStart, input)) as ConnectedAccountsResult;
    },

    async pollConnection(input): Promise<ConnectedAccountsResult> {
      return (await invoke(IPC_CHANNELS.connectionsPoll, input)) as ConnectedAccountsResult;
    },

    async disconnectConnection(input): Promise<ConnectedAccountsResult> {
      return (await invoke(IPC_CHANNELS.connectionsDisconnect, input)) as ConnectedAccountsResult;
    },

    async listAccountNotifications(): Promise<AccountNotificationsResult> {
      return (await invoke(IPC_CHANNELS.accountNotificationsList)) as AccountNotificationsResult;
    },

    async markAccountNotificationRead(input): Promise<AccountNotificationsResult> {
      return (await invoke(
        IPC_CHANNELS.accountNotificationRead,
        input,
      )) as AccountNotificationsResult;
    },

    async dismissAccountNotification(input): Promise<AccountNotificationsResult> {
      return (await invoke(
        IPC_CHANNELS.accountNotificationDismiss,
        input,
      )) as AccountNotificationsResult;
    },

    async addAccountEmail(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailAdd, input)) as AccountSettingsResult;
    },

    async verifyAccountEmailAddress(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailVerify, input)) as AccountSettingsResult;
    },

    async resendAccountEmail(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailResend, input)) as AccountSettingsResult;
    },

    async promoteAccountEmail(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailPromote, input)) as AccountSettingsResult;
    },

    async setAccountNotificationEmail(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailNotifications, input)) as AccountSettingsResult;
    },

    async removeAccountEmail(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountEmailRemove, input)) as AccountSettingsResult;
    },

    async chooseAccountAvatar(): Promise<AccountSettingsResult | null> {
      return (await invoke(IPC_CHANNELS.accountAvatarChoose)) as AccountSettingsResult | null;
    },

    async removeAccountAvatar(): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountAvatarRemove)) as AccountSettingsResult;
    },

    async readAccountAvatar(): Promise<string | null> {
      return (await invoke(IPC_CHANNELS.accountAvatarRead)) as string | null;
    },

    async compileLatex(input): Promise<LatexCompileOutcome> {
      return (await invoke(IPC_CHANNELS.latexCompile, input)) as LatexCompileOutcome;
    },

    async exportDocument(input): Promise<DocumentExportOutcome> {
      return (await invoke(IPC_CHANNELS.documentExport, input)) as DocumentExportOutcome;
    },

    async exportLibrary(input): Promise<LibraryExportOutcome> {
      return (await invoke(IPC_CHANNELS.libraryExport, input)) as LibraryExportOutcome;
    },

    async listProjectDirectory(): Promise<ProjectDirectoryEntry[]> {
      return (await invoke(IPC_CHANNELS.projectDirectory)) as ProjectDirectoryEntry[];
    },

    async exportAccountData(): Promise<AccountExportOutcome> {
      return (await invoke(IPC_CHANNELS.accountExport)) as AccountExportOutcome;
    },

    async setAccountNotificationPreference(input): Promise<AccountSettingsResult> {
      return (await invoke(
        IPC_CHANNELS.accountNotificationPreference,
        input,
      )) as AccountSettingsResult;
    },

    async setAccountPassword(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountPasswordSet, input)) as AccountSettingsResult;
    },

    async removeAccountPassword(): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountPasswordRemove)) as AccountSettingsResult;
    },

    async revokeAccountSession(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountSessionRevoke, input)) as AccountSettingsResult;
    },

    async revokeOtherAccountSessions(): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountSessionsRevokeOthers)) as AccountSettingsResult;
    },

    async requestAccountDeletion(input): Promise<AccountSettingsResult> {
      return (await invoke(IPC_CHANNELS.accountDeletionRequest, input)) as AccountSettingsResult;
    },

    async manageWorkspaceCollaboration(input): Promise<WorkspaceCollaborationResult> {
      return (await invoke(
        IPC_CHANNELS.workspaceCollaboration,
        input,
      )) as WorkspaceCollaborationResult;
    },

    async readWorkspacePresence(input): Promise<WorkspacePresenceResult> {
      return (await invoke(IPC_CHANNELS.workspacePresence, input)) as WorkspacePresenceResult;
    },

    async readWorkspaceSyncStatus(): Promise<WorkspaceSyncStatusResult> {
      return (await invoke(IPC_CHANNELS.workspaceSyncStatus)) as WorkspaceSyncStatusResult;
    },

    async openWorkspaceById(input): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.workspaceOpenById, input)) as boolean;
    },

    async searchEverywhere(input): Promise<GlobalSearchHit[]> {
      return (await invoke(IPC_CHANNELS.searchEverywhere, input)) as GlobalSearchHit[];
    },

    async closeWorkspace(): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.workspaceClose)) as boolean;
    },

    async readOfflineMode(): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.offlineMode)) as boolean;
    },

    async setOfflineMode(input): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.offlineMode, input)) as boolean;
    },

    async getStartupStatus(): Promise<StartupStatus> {
      return (await invoke(IPC_CHANNELS.startupStatus)) as StartupStatus;
    },

    async getAbout(): Promise<AboutInfo> {
      return (await invoke(IPC_CHANNELS.about)) as AboutInfo;
    },

    async getUpdateState(): Promise<UpdateState> {
      return (await invoke(IPC_CHANNELS.updateState)) as UpdateState;
    },

    async checkForUpdates(): Promise<UpdateState> {
      return (await invoke(IPC_CHANNELS.updateCheck)) as UpdateState;
    },

    async restartToUpdate(): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.updateRestart)) as boolean;
    },

    async listCommands(): Promise<string[]> {
      return (await invoke(IPC_CHANNELS.commandNames)) as string[];
    },

    async invokeCommand(envelope: unknown): Promise<CommandResult> {
      return (await invoke(IPC_CHANNELS.commandInvoke, envelope)) as CommandResult;
    },

    async cancelCommand(requestId: string): Promise<boolean> {
      return (await invoke(IPC_CHANNELS.commandCancel, requestId)) as boolean;
    },

    async getRuntimeHealth(): Promise<RuntimeHealth> {
      return (await invoke(IPC_CHANNELS.runtimeHealth)) as RuntimeHealth;
    },

    async chooseManagedAsset(): Promise<ManagedAssetSelection | null> {
      return (await invoke(IPC_CHANNELS.assetChooseManaged)) as ManagedAssetSelection | null;
    },

    async chooseAssetFolder(): Promise<AssetFolderSelection | null> {
      return (await invoke(IPC_CHANNELS.assetChooseFolder)) as AssetFolderSelection | null;
    },

    async captureManagedAsset(input): Promise<ManagedAssetSelection | null> {
      return (await invoke(IPC_CHANNELS.assetCapture, input)) as ManagedAssetSelection | null;
    },

    async registerDroppedManagedAsset(file): Promise<ManagedAssetSelection | null> {
      const path = pathForFile(file);
      if (path === "") return null;
      const declaredMediaType =
        typeof (file as { type?: unknown }).type === "string" &&
        (file as { type: string }).type.trim() !== ""
          ? (file as { type: string }).type
          : null;
      return (await invoke(IPC_CHANNELS.assetRegisterDropped, {
        path,
        declaredMediaType,
      })) as ManagedAssetSelection | null;
    },

    async chooseReferenceFile(): Promise<ReferenceFileSelection | null> {
      return (await invoke(IPC_CHANNELS.bibliographyChooseFile)) as ReferenceFileSelection | null;
    },

    async chooseWorkspaceFolder(): Promise<WorkspaceFolderSelection | null> {
      return (await invoke(IPC_CHANNELS.workspaceChooseFolder)) as WorkspaceFolderSelection | null;
    },

    async createWorkspace(input: WorkspaceCreateRequest): Promise<CommandResult> {
      return (await invoke(IPC_CHANNELS.workspaceCreate, input)) as CommandResult;
    },

    async openWorkspaceFolder(): Promise<CommandResult | null> {
      return (await invoke(IPC_CHANNELS.workspaceOpenFolder)) as CommandResult | null;
    },

    async openWorkspaceInNewWindow(): Promise<CommandResult | null> {
      return (await invoke(IPC_CHANNELS.workspaceOpenNewWindow)) as CommandResult | null;
    },

    async detachDocument(request: DetachRequest): Promise<CommandResult | null> {
      return (await invoke(IPC_CHANNELS.detachDocument, request)) as CommandResult | null;
    },

    async getDetachedDocument(): Promise<DetachedAssignment | null> {
      return (await invoke(IPC_CHANNELS.detachedDocument)) as DetachedAssignment | null;
    },

    async getWorkspaceSession(): Promise<WindowSession | null> {
      return (await invoke(IPC_CHANNELS.workspaceSession)) as WindowSession | null;
    },

    async performWindowAction(action: AllowedWindowAction): Promise<void> {
      if (!isAllowedWindowAction(action)) {
        throw new Error(`Unsupported window action: ${String(action)}`);
      }
      await invoke(IPC_CHANNELS.windowAction, action);
    },

    async performRecoveryAction(action: RecoveryAction): Promise<void> {
      if (!isRecoveryAction(action)) {
        throw new Error(`Unsupported recovery action: ${String(action)}`);
      }
      await invoke(IPC_CHANNELS.recoveryAction, action);
    },
  };

  return Object.freeze(bridge);
}

contextBridge.exposeInMainWorld(
  BRIDGE_KEY,
  createBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
);
