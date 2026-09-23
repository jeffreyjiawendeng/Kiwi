import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import type { RendererBridge } from "./bridge.js";

// How long the launch spends probing the account service before it says Kiwi is offline.
// It has to outlast the backoff the shell itself uses.
const LAUNCH_PROBE_WINDOW_MS = 3_000;

function stubBridge(overrides: Partial<RendererBridge>): RendererBridge {
  return {
    version: "1.0.0",
    getPublicLinks: vi.fn(async () => ({ terms: false, privacy: false, support: false })),
    openPublicLink: vi.fn(async () => false),
    getCapabilities: vi.fn(async () => ({
      protocolVersion: "1.0.0",
      appVersion: "0.1.0",
      commands: false,
      queries: false,
      subscriptions: false,
      streams: false,
    })),
    getStartupStatus: vi.fn(async () => ({ status: "ready" as const })),
    getAccountServiceStatus: vi.fn(async () => ({ status: "ready" as const })),
    getAccountAuthState: vi.fn(async () => ({ status: "signed_out" as const })),
    createPasswordAccount: vi.fn(async () => ({
      status: "accepted" as const,
      next: "verify_email" as const,
    })),
    verifyAccountEmail: vi.fn(async () => ({
      status: "error" as const,
      code: "invalid_or_expired_code",
      message: "That verification code is invalid or has expired.",
    })),
    resendAccountEmailVerification: vi.fn(async () => ({
      status: "accepted" as const,
      next: "verify_email" as const,
    })),
    resendAccountEmail: vi.fn(async () => ({
      status: "error" as const,
      code: "invalid_input",
      message: "That pending address was not found.",
    })),
    signInWithPassword: vi.fn(async () => ({
      status: "error" as const,
      code: "invalid_credentials",
      message: "The email or password is not correct.",
    })),
    reauthenticateWithPassword: vi.fn(async () => ({
      status: "reauthenticated" as const,
      provider: "password" as const,
    })),
    reauthenticateWithProvider: vi.fn(async () => ({
      status: "reauthenticated" as const,
      provider: "google" as const,
    })),
    requestPasswordReset: vi.fn(async () => ({
      status: "accepted" as const,
      next: "check_email" as const,
    })),
    resetPassword: vi.fn(async () => ({ status: "password_reset" as const })),
    signInWithProvider: vi.fn(async () => ({
      status: "error" as const,
      code: "provider_cancelled",
      message: "Google sign-in was canceled.",
    })),
    cancelProviderSignIn: vi.fn(async () => false),
    previewSignOut: vi.fn(async () => ({
      pending_workspace_registrations: 0,
      pending_structured_changes: 0,
      pending_document_operations: 0,
      total: 0,
    })),
    signOut: vi.fn(async () => ({ status: "signed_out" as const })),
    getAccountSettings: vi.fn(async () => ({
      status: "error" as const,
      code: "service_unavailable",
      message: "Account settings are unavailable. Try again.",
    })),
    updateAccountProfile: vi.fn(async () => ({
      status: "error" as const,
      code: "service_unavailable",
      message: "Account settings are unavailable. Try again.",
    })),
    revokeAccountSession: vi.fn(async () => ({ status: "session_revoked" as const })),
    linkSignInMethod: vi.fn(async () => ({
      status: "identity_linked" as const,
      provider: "google" as const,
    })),
    unlinkSignInMethod: vi.fn(async () => ({
      status: "identity_unlinked" as const,
      provider: "google" as const,
      provider_revocation: "not_supported" as const,
    })),
    listConnections: vi.fn(async () => ({
      status: "ok" as const,
      connections: { connections: [], available: [] },
    })),
    startConnection: vi.fn(async () => ({ status: "pending" as const })),
    pollConnection: vi.fn(async () => ({ status: "pending" as const })),
    listAccountNotifications: vi.fn(async () => ({
      status: "ok" as const,
      notifications: [],
      unread_count: 0,
    })),
    markAccountNotificationRead: vi.fn(async () => ({ status: "updated" as const })),
    dismissAccountNotification: vi.fn(async () => ({ status: "updated" as const })),
    disconnectConnection: vi.fn(async () => ({
      status: "disconnected" as const,
      provider: "github",
      provider_revocation: "not_supported" as const,
    })),
    addAccountEmail: vi.fn(async () => ({ status: "session_revoked" as const })),
    verifyAccountEmailAddress: vi.fn(async () => ({ status: "session_revoked" as const })),
    promoteAccountEmail: vi.fn(async () => ({ status: "session_revoked" as const })),
    setAccountNotificationEmail: vi.fn(async () => ({ status: "session_revoked" as const })),
    removeAccountEmail: vi.fn(async () => ({ status: "session_revoked" as const })),
    chooseAccountAvatar: vi.fn(async () => null),
    removeAccountAvatar: vi.fn(async () => ({ status: "session_revoked" as const })),
    readAccountAvatar: vi.fn(async () => null),
    compileLatex: vi.fn(async () => ({
      status: "ok" as const,
      ran: "local" as const,
      pdf: null,
      problems: [],
    })),
    exportAccountData: vi.fn(async () => ({ status: "cancelled" as const })),
    exportDocument: vi.fn(async () => ({ status: "cancelled" as const })),
    exportLibrary: vi.fn(async () => ({ status: "cancelled" as const })),
    setAccountNotificationPreference: vi.fn(async () => ({ status: "session_revoked" as const })),
    setAccountPassword: vi.fn(async () => ({ status: "session_revoked" as const })),
    removeAccountPassword: vi.fn(async () => ({ status: "session_revoked" as const })),
    revokeOtherAccountSessions: vi.fn(async () => ({ status: "session_revoked" as const })),
    requestAccountDeletion: vi.fn(async () => ({
      status: "deletion_requested" as const,
      recover_until: "2026-09-21T12:00:00.000Z",
    })),
    manageWorkspaceCollaboration: vi.fn(async () => ({
      status: "error" as const,
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    })),
    readWorkspacePresence: vi.fn(async () => ({ status: "unavailable" as const })),
    readWorkspaceSyncStatus: vi.fn(async () => ({ status: "unknown" as const })),
    closeWorkspace: vi.fn(async () => true),
    searchEverywhere: vi.fn(async () => []),
    openWorkspaceById: vi.fn(async () => true),
    readOfflineMode: vi.fn(async () => false),
    setOfflineMode: vi.fn(async () => false),
    listCommands: vi.fn(async () => []),
    invokeCommand: vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "r-0",
      status: "committed",
      data: {},
    })),
    cancelCommand: vi.fn(async () => false),
    getRuntimeHealth: vi.fn(async () => ({
      worker: "running",
      workerRestarts: 0,
      commandsInFlight: 0,
      rendererFailure: null,
    })),
    chooseManagedAsset: vi.fn(async () => null),
    chooseAssetFolder: vi.fn(async () => null),
    captureManagedAsset: vi.fn(async () => null),
    registerDroppedManagedAsset: vi.fn(async () => null),
    chooseReferenceFile: vi.fn(async () => null),
    chooseWorkspaceFolder: vi.fn(async () => null),
    createWorkspace: vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "r-0",
      status: "committed",
      data: {},
    })),
    openWorkspaceFolder: vi.fn(async () => null),
    openWorkspaceInNewWindow: vi.fn(async () => null),
    detachDocument: vi.fn(async () => null),
    getDetachedDocument: vi.fn(async () => null),
    getWorkspaceSession: vi.fn(async () => null),
    listProjectDirectory: vi.fn(async () => []),
    getAbout: vi.fn(async () => ({
      appVersion: "0.1.0",
      electronVersion: "43.4.1",
      chromiumVersion: "142.0.0.0",
      nodeVersion: "22.20.0",
      platform: "win32",
      architecture: "x64",
      installType: "development",
      protocolVersion: "1.0.0",
      buildIdentifier: "local",
      signed: false,
    })),
    getUpdateState: vi.fn(async () => ({ status: "off" as const, reason: "development" as const })),
    checkForUpdates: vi.fn(async () => ({
      status: "off" as const,
      reason: "development" as const,
    })),
    restartToUpdate: vi.fn(async () => false),
    performWindowAction: vi.fn(async () => undefined),
    performRecoveryAction: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.kiwiDesktop;
});

describe("App", () => {
  it("reports an unavailable bridge instead of rendering nothing", async () => {
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("bridge is unavailable");
  });

  it("gates workspace content behind the account service", async () => {
    const getAbout = vi.fn();
    window.kiwiDesktop = stubBridge({ getAbout });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(document.querySelector(".topbar__brand")).toHaveTextContent("Kiwi");
    expect(document.querySelector("main.shell--auth")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Command shell" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Create your first workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "About Kiwi" })).not.toBeInTheDocument();
    expect(getAbout).not.toHaveBeenCalled();
  });

  it("shows account-service recovery without exposing the workspace", async () => {
    vi.useFakeTimers();
    window.kiwiDesktop = stubBridge({
      getAccountServiceStatus: vi.fn(async () => ({
        status: "unavailable" as const,
        retryable: true as const,
      })),
    });
    render(<App />);

    // One refused probe is what a launch looks like before the service finishes binding
    // its port, so it is not yet an answer about whether Kiwi is offline.
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("heading", { name: "Kiwi is offline" })).not.toBeInTheDocument();
    expect(screen.getByText("Starting")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(LAUNCH_PROBE_WINDOW_MS));
    expect(screen.getByRole("heading", { name: "Kiwi is offline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Create your first workspace" }),
    ).not.toBeInTheDocument();
  });

  it("never reports offline when the service only needed a moment to start", async () => {
    vi.useFakeTimers();
    const getAccountServiceStatus = vi
      .fn<RendererBridge["getAccountServiceStatus"]>()
      .mockResolvedValueOnce({ status: "unavailable", retryable: true })
      .mockResolvedValueOnce({ status: "unavailable", retryable: true })
      .mockResolvedValue({ status: "ready" });
    window.kiwiDesktop = stubBridge({ getAccountServiceStatus });

    render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(LAUNCH_PROBE_WINDOW_MS));

    // The window and the service start together, so a service that is a moment behind is
    // an ordinary launch. Calling that offline is what made every launch look broken.
    expect(screen.queryByRole("heading", { name: "Kiwi is offline" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
  });

  it("rechecks the service and leaves the offline state after recovery", async () => {
    // Fake timers keep the launch probe window from costing the suite real seconds.
    vi.useFakeTimers();
    const getAccountServiceStatus = vi
      .fn<RendererBridge["getAccountServiceStatus"]>()
      .mockResolvedValue({ status: "unavailable", retryable: true });
    window.kiwiDesktop = stubBridge({ getAccountServiceStatus });
    render(<App />);

    await act(async () => vi.advanceTimersByTimeAsync(LAUNCH_PROBE_WINDOW_MS));
    const retry = screen.getByRole("button", { name: "Try again" });
    const launchProbes = getAccountServiceStatus.mock.calls.length;
    getAccountServiceStatus.mockResolvedValue({ status: "ready" });

    await act(async () => {
      fireEvent.click(retry);
    });
    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(getAccountServiceStatus.mock.calls.length).toBeGreaterThan(launchProbes);
  });

  it("automatically leaves the signed-out offline gate after the service recovers", async () => {
    vi.useFakeTimers();
    const getAccountServiceStatus = vi
      .fn<RendererBridge["getAccountServiceStatus"]>()
      .mockResolvedValue({ status: "unavailable", retryable: true });
    window.kiwiDesktop = stubBridge({ getAccountServiceStatus });

    render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(LAUNCH_PROBE_WINDOW_MS));
    expect(screen.getByRole("heading", { name: "Kiwi is offline" })).toBeInTheDocument();

    getAccountServiceStatus.mockResolvedValue({ status: "ready" });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
  });

  it("lands on Home for an authenticated account", async () => {
    window.kiwiDesktop = stubBridge({
      getAccountAuthState: vi.fn(async () => ({
        status: "authenticated" as const,
        account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
        connection: "online" as const,
      })),
    });
    render(<App />);

    // Home is the screen above the projects. A signed-in account with no project yet is
    // asked which project to work on, not which folder to make.
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Log In" })).not.toBeInTheDocument();
  });

  it("continues to Home without a post-sign-in profile prompt", async () => {
    const getAccountSettings = vi.fn(async () => ({
      status: "error" as const,
      code: "service_unavailable",
      message: "Account settings are unavailable. Try again.",
    }));
    window.kiwiDesktop = stubBridge({
      getAccountAuthState: vi.fn(async () => ({
        status: "authenticated" as const,
        account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
        connection: "online" as const,
      })),
      getAccountSettings,
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /complete your profile/i }),
    ).not.toBeInTheDocument();
    // The account presentation is read by its own effect, so the heading can render before
    // that call settles. Asserting it straight away only passed when the machine was idle.
    await waitFor(() => expect(getAccountSettings).toHaveBeenCalledOnce());
  });

  it("opens downloaded-workspace entry with a clear offline status", async () => {
    const getAccountServiceStatus = vi.fn();
    window.kiwiDesktop = stubBridge({
      getAccountServiceStatus,
      getAccountAuthState: vi.fn(async () => ({
        status: "authenticated" as const,
        account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
        connection: "offline" as const,
      })),
    });
    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Downloaded workspaces remain available",
    );
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(getAccountServiceStatus).not.toHaveBeenCalled();
  });

  it("clears the shell after explicit sign-out", async () => {
    const signOut = vi.fn(async () => ({ status: "signed_out" as const }));
    const previewSignOut = vi.fn(async () => ({
      pending_workspace_registrations: 0,
      pending_structured_changes: 0,
      pending_document_operations: 0,
      total: 0,
    }));
    window.kiwiDesktop = stubBridge({
      signOut,
      previewSignOut,
      getAccountAuthState: vi.fn(async () => ({
        status: "authenticated" as const,
        account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
        connection: "online" as const,
      })),
    });
    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Account reader@example.test" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(previewSignOut).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("keeps unsynchronized work only after an explicit sign-out decision", async () => {
    const signOut = vi.fn(async () => ({ status: "signed_out" as const }));
    window.kiwiDesktop = stubBridge({
      signOut,
      previewSignOut: vi.fn(async () => ({
        pending_workspace_registrations: 1,
        pending_structured_changes: 2,
        pending_document_operations: 3,
        total: 6,
      })),
      getAccountAuthState: vi.fn(async () => ({
        status: "authenticated" as const,
        account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
        connection: "offline" as const,
      })),
    });
    render(<App />);

    const accountTrigger = await screen.findByRole("button", {
      name: "Account reader@example.test",
    });
    await userEvent.click(accountTrigger);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const review = await screen.findByRole("dialog", {
      name: "Keep pending work on this device?",
    });
    expect(review).toHaveTextContent("6 local synchronization items");
    expect(review).toHaveTextContent("2 structured changes");
    expect(review).toHaveTextContent("3 note or document edits");
    expect(signOut).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(accountTrigger).toHaveFocus();

    await userEvent.click(accountTrigger);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Keep pending work and sign out" }),
    );
    expect(await screen.findByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("forwards custom caption actions to the desktop bridge", async () => {
    const performWindowAction = vi.fn(async () => undefined);
    window.kiwiDesktop = stubBridge({ performWindowAction });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(performWindowAction).toHaveBeenCalledWith("close");
  });

  it("falls back to the unavailable state when the bridge rejects", async () => {
    window.kiwiDesktop = stubBridge({
      getStartupStatus: vi.fn(async () => {
        throw new Error("denied");
      }),
    });

    render(<App />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("shows the diagnostic screen when main reports a failed startup", async () => {
    window.kiwiDesktop = stubBridge({
      getStartupStatus: vi.fn(async () => ({
        status: "failed" as const,
        error: {
          code: "KIWI_STARTUP_FAILED",
          message: "Kiwi started but could not finish preparing this session.",
          details: {},
          retryable: true,
          recovery_actions: ["retry", "open_logs", "quit"],
          correlation_id: "corr-42",
        },
      })),
    });

    render(<App />);

    expect(await screen.findByText(/could not start this session/i)).toBeInTheDocument();
    expect(screen.getByText("corr-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Kiwi" })).toBeInTheDocument();
  });

  it("does not read About when startup failed", async () => {
    const getAbout = vi.fn();
    window.kiwiDesktop = stubBridge({
      getAbout,
      getStartupStatus: vi.fn(async () => ({
        status: "failed" as const,
        error: {
          code: "KIWI_STARTUP_FAILED",
          message: "failed",
          details: {},
          retryable: true,
          recovery_actions: ["retry"],
          correlation_id: "corr-43",
        },
      })),
    });

    render(<App />);
    await screen.findByText(/could not start this session/i);
    expect(getAbout).not.toHaveBeenCalled();
  });
});
