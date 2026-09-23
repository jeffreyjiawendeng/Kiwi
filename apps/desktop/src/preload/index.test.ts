import { describe, expect, it, vi } from "vitest";

const exposed: Array<[string, unknown]> = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.push([key, value]);
    },
  },
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
  },
}));

const { BRIDGE_KEY, createBridge } = await import("./index.js");

describe("exposed surface", () => {
  it("exposes exactly one object under the documented key", () => {
    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.[0]).toBe(BRIDGE_KEY);
  });

  it("exposes no raw Electron primitive", () => {
    const bridge = exposed[0]?.[1] as Record<string, unknown>;
    for (const forbidden of ["ipcRenderer", "shell", "require", "process", "webFrame"]) {
      expect(bridge[forbidden]).toBeUndefined();
    }
  });

  it("freezes the exposed object", () => {
    expect(Object.isFrozen(exposed[0]?.[1])).toBe(true);
  });
});

describe("bridge behaviour", () => {
  it("declares only the methods the renderer is given", () => {
    const bridge = createBridge(async () => undefined);
    expect(Object.keys(bridge).sort()).toEqual([
      "addAccountEmail",
      "cancelCommand",
      "cancelProviderSignIn",
      "captureManagedAsset",
      "checkForUpdates",
      "chooseAccountAvatar",
      "chooseAssetFolder",
      "chooseManagedAsset",
      "chooseReferenceFile",
      "chooseWorkspaceFolder",
      "closeWorkspace",
      "compileLatex",
      "createPasswordAccount",
      "createWorkspace",
      "detachDocument",
      "disconnectConnection",
      "dismissAccountNotification",
      "exportAccountData",
      "exportDocument",
      "exportLibrary",
      "getAbout",
      "getAccountAuthState",
      "getAccountServiceStatus",
      "getAccountSettings",
      "getCapabilities",
      "getDetachedDocument",
      "getPublicLinks",
      "getRuntimeHealth",
      "getStartupStatus",
      "getUpdateState",
      "getWorkspaceSession",
      "invokeCommand",
      "linkSignInMethod",
      "listAccountNotifications",
      "listCommands",
      "listConnections",
      "listProjectDirectory",
      "manageWorkspaceCollaboration",
      "markAccountNotificationRead",
      "openPublicLink",
      "openWorkspaceById",
      "openWorkspaceFolder",
      "openWorkspaceInNewWindow",
      "performRecoveryAction",
      "performWindowAction",
      "pollConnection",
      "previewSignOut",
      "promoteAccountEmail",
      "readAccountAvatar",
      "readOfflineMode",
      "readWorkspacePresence",
      "readWorkspaceSyncStatus",
      "reauthenticateWithPassword",
      "reauthenticateWithProvider",
      "registerDroppedManagedAsset",
      "removeAccountAvatar",
      "removeAccountEmail",
      "removeAccountPassword",
      "requestAccountDeletion",
      "requestPasswordReset",
      "resendAccountEmail",
      "resendAccountEmailVerification",
      "resetPassword",
      "restartToUpdate",
      "revokeAccountSession",
      "revokeOtherAccountSessions",
      "searchEverywhere",
      "setAccountNotificationEmail",
      "setAccountNotificationPreference",
      "setAccountPassword",
      "setOfflineMode",
      "signInWithPassword",
      "signInWithProvider",
      "signOut",
      "startConnection",
      "unlinkSignInMethod",
      "updateAccountProfile",
      "verifyAccountEmail",
      "verifyAccountEmailAddress",
      "version",
    ]);
  });

  it("sends an allowed window action to the documented channel", async () => {
    const invoke = vi.fn(async () => undefined);
    await createBridge(invoke).performWindowAction("minimize");
    expect(invoke).toHaveBeenCalledWith("kiwi:window-action", "minimize");
  });

  it("opens only a named public-link destination through main", async () => {
    const invoke = vi.fn(async () => true);
    await createBridge(invoke).openPublicLink("privacy");
    expect(invoke).toHaveBeenCalledWith("kiwi:public-link-open", "privacy");
  });

  it("turns a dropped browser file into an opaque main-process selection request", async () => {
    const invoke = vi.fn(async () => ({ id: "selection-1" }));
    const file = { type: "text/plain" };
    const bridge = createBridge(invoke, () => "C:\\Research\\notes.txt");

    await bridge.chooseManagedAsset();
    await bridge.registerDroppedManagedAsset(file as never);

    expect(invoke).toHaveBeenCalledWith("kiwi:asset-choose-managed");
    expect(invoke).toHaveBeenCalledWith("kiwi:asset-register-dropped", {
      path: "C:\\Research\\notes.txt",
      declaredMediaType: "text/plain",
    });
  });

  it("asks main to open the folder picker, and sends nothing of its own", async () => {
    // Which folder to start in and what counts as a PDF are both settled on the other side.
    const invoke = vi.fn(async () => ({
      name: "Papers",
      files: [{ id: "selection-1", name: "first.pdf" }],
      skipped: 2,
      truncated: false,
    }));

    await expect(createBridge(invoke).chooseAssetFolder()).resolves.toEqual({
      name: "Papers",
      files: [{ id: "selection-1", name: "first.pdf" }],
      skipped: 2,
      truncated: false,
    });
    expect(invoke).toHaveBeenCalledWith("kiwi:asset-choose-folder");
  });

  it("asks main to open the reference picker, and sends nothing of its own", async () => {
    // Nothing goes with the request. Which folder the dialog starts in, what it will accept and
    // where the chosen file turns out to be are all settled on the other side.
    const invoke = vi.fn(async () => ({ id: "selection-1", name: "library.bib" }));

    await expect(createBridge(invoke).chooseReferenceFile()).resolves.toEqual({
      id: "selection-1",
      name: "library.bib",
    });
    expect(invoke).toHaveBeenCalledWith("kiwi:bibliography-choose-file");
  });

  it("rejects an unsupported window action without reaching main", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge(invoke);
    await expect(
      bridge.performWindowAction(
        "openDevTools" as Parameters<typeof bridge.performWindowAction>[0],
      ),
    ).rejects.toThrow(/Unsupported window action/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an unsupported recovery action without reaching main", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge(invoke);
    await expect(
      bridge.performRecoveryAction(
        "delete_workspace" as Parameters<typeof bridge.performRecoveryAction>[0],
      ),
    ).rejects.toThrow(/Unsupported recovery action/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards a command envelope to the documented channel", async () => {
    const invoke = vi.fn(async () => ({ status: "committed" }));
    const bridge = createBridge(invoke);
    const envelope = { protocol_version: "1.0.0", request_id: "r", command: "kiwi.a.b", args: {} };

    await bridge.invokeCommand(envelope);

    expect(invoke).toHaveBeenCalledWith("kiwi:command-invoke", envelope);
  });

  it("forwards a cancellation to the documented channel", async () => {
    const invoke = vi.fn(async () => true);
    await createBridge(invoke).cancelCommand("req-1");
    expect(invoke).toHaveBeenCalledWith("kiwi:command-cancel", "req-1");
  });

  it("uses a dedicated account-service readiness channel", async () => {
    const invoke = vi.fn(async () => ({ status: "ready" }));
    await createBridge(invoke).getAccountServiceStatus();
    expect(invoke).toHaveBeenCalledWith("kiwi:account-service-status");
  });

  it("uses dedicated account-authentication channels", async () => {
    const invoke = vi
      .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({ status: "signed_out" });
    const bridge = createBridge(invoke);
    await bridge.getAccountAuthState();
    await bridge.createPasswordAccount({
      email: "reader@example.test",
      email_kind: "personal",
      password: "secret",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "+14155550134",
    });
    await bridge.verifyAccountEmail({ email: "reader@example.test", code: "code" });
    await bridge.resendAccountEmailVerification({ email: "reader@example.test" });
    await bridge.signInWithPassword({ email: "reader@example.test", password: "secret" });
    await bridge.requestPasswordReset({ email: "reader@example.test" });
    await bridge.resetPassword({
      email: "reader@example.test",
      code: "code",
      new_password: "new secret",
    });
    await bridge.signInWithProvider({ provider: "google" });
    await bridge.cancelProviderSignIn();
    await bridge.previewSignOut();
    await bridge.signOut();
    await bridge.getAccountSettings();
    await bridge.updateAccountProfile({
      given_name: null,
      family_name: null,
      phone: null,
    });
    await bridge.resendAccountEmail({ email_id: "email-pending" });
    await bridge.revokeAccountSession({ session_id: "session-other" });
    await bridge.revokeOtherAccountSessions();
    await bridge.requestAccountDeletion({ confirmation: "DELETE" });

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "kiwi:account-auth-state",
      "kiwi:account-create-password",
      "kiwi:account-verify-email",
      "kiwi:account-resend-email-verification",
      "kiwi:account-sign-in-password",
      "kiwi:account-request-password-reset",
      "kiwi:account-reset-password",
      "kiwi:account-provider-sign-in",
      "kiwi:account-provider-cancel",
      "kiwi:account-sign-out-preview",
      "kiwi:account-sign-out",
      "kiwi:account-settings-get",
      "kiwi:account-profile-update",
      "kiwi:account-email-resend",
      "kiwi:account-session-revoke",
      "kiwi:account-sessions-revoke-others",
      "kiwi:account-deletion-request",
    ]);
  });

  it("uses dedicated channels for folder choice and workspace creation", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge(invoke);

    await bridge.chooseWorkspaceFolder();
    await bridge.createWorkspace({ selectionId: "selection-1", title: "Trial" });

    expect(invoke).toHaveBeenNthCalledWith(1, "kiwi:workspace-choose-folder");
    expect(invoke).toHaveBeenNthCalledWith(2, "kiwi:workspace-create", {
      selectionId: "selection-1",
      title: "Trial",
    });
  });

  it("cannot be mutated by renderer code", () => {
    const bridge = createBridge(async () => undefined);
    expect(() => {
      (bridge as unknown as Record<string, unknown>)["performWindowAction"] = () => undefined;
    }).toThrow();
  });
});
