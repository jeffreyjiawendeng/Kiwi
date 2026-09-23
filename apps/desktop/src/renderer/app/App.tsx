import { useCallback, useEffect, useRef, useState } from "react";
import { readBridge, type RendererError } from "./bridge.js";
import { DiagnosticScreen } from "./DiagnosticScreen.js";
import { RuntimeNotice } from "./RuntimeNotice.js";
import { UndoBar } from "./UndoBar.js";
import { TopBar, type WindowAction } from "./TopBar.js";
import { AccountServiceGate } from "./AccountServiceGate.js";
import { AccountAuth } from "./AccountAuth.js";
import { WorkspacePanel, type WorkspaceSummaryView } from "./WorkspacePanel.js";
import type { RendererAccountIdentity, RendererAccountServiceStatus } from "./bridge.js";
import type { RendererAccountSignOutPreview } from "./bridge.js";
import { AccountSettings } from "./AccountSettings.js";
import { ProjectHome, type ProjectTarget } from "./ProjectHome.js";
import { readSelectedProject, writeSelectedProject } from "./selected-project.js";
import { ProjectCreate } from "./ProjectCreate.js";
import { DetachedDocument } from "./DetachedDocument.js";
import { DetachedReader } from "./DetachedReader.js";

type ShellState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "failed"; error: RendererError }
  | { status: "service_unavailable"; service: RendererAccountServiceStatus }
  | { status: "signed_out" }
  | {
      status: "authenticated";
      account: RendererAccountIdentity;
      connection: "online" | "offline";
    };

// Waits between the launch probes of the account service, in milliseconds. Together they
// cover the few seconds a local service needs to begin listening.
const SERVICE_PROBE_BACKOFF_MS = [200, 400, 800, 1600] as const;

// The longest the launch will keep probing before it reports the service unreachable.
const SERVICE_PROBE_WINDOW_MS = 3_000;

/**
 * What this window was opened to show, once the shell has asked.
 *
 * A detached window runs the same renderer as every other one; the only thing that makes it
 * different is this answer, and the one view it draws instead of the shell.
 */
type DetachedView =
  { kind: "document"; objectId: string } | { kind: "reader"; objectId: string; assetId: string };

function detachedView(assignment: {
  objectId: string;
  kind: "document" | "reader";
  assetId?: string;
}): DetachedView | null {
  if (assignment.kind === "reader") {
    // A Reader without a file is a window that could only sit over a blank page. The main
    // process refuses to open one, so this is the second of the two places that agree on it.
    return assignment.assetId === undefined
      ? null
      : { kind: "reader", objectId: assignment.objectId, assetId: assignment.assetId };
  }
  return { kind: "document", objectId: assignment.objectId };
}

function detachedContent(view: DetachedView): React.JSX.Element {
  return view.kind === "reader" ? (
    <DetachedReader objectId={view.objectId} assetId={view.assetId} />
  ) : (
    <DetachedDocument objectId={view.objectId} />
  );
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const [retrying, setRetrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutPreview, setSignOutPreview] = useState<RendererAccountSignOutPreview | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [authenticatedView, setAuthenticatedView] = useState<
    "home" | "create" | "project" | "account"
  >(() => (readSelectedProject() === null ? "home" : "project"));
  const [project, setProject] = useState<ProjectTarget | null>(() => readSelectedProject());
  // What this window was opened to show. `undefined` while the question is still being asked,
  // which is why it is not simply null: rendering the whole shell for a moment and replacing it
  // with one document is a flash of the wrong window.
  const [detached, setDetached] = useState<DetachedView | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceSummaryView | null>(null);
  const [switchRequest, setSwitchRequest] = useState(0);
  const [accountPresentation, setAccountPresentation] = useState<{
    accountId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
  const [accountPresentationRefresh, setAccountPresentationRefresh] = useState(0);

  const performWindowAction = useCallback((action: WindowAction): void => {
    void readBridge()?.performWindowAction(action);
  }, []);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) {
      setState({ status: "unavailable" });
      return;
    }

    let active = true;

    function probeService(): Promise<RendererAccountServiceStatus> {
      return bridge!
        .getAccountServiceStatus()
        .catch((): RendererAccountServiceStatus => ({ status: "unavailable", retryable: true }));
    }

    // The window and the account service start at the same moment, and the service is not
    // listening for the first part of it. One refused connection therefore says nothing
    // about whether the service is there, so the launch waits out a few of them before it
    // reports being offline. The shell reads "Starting" throughout, which is what is true.
    async function reachService(): Promise<RendererAccountServiceStatus> {
      // A refused connection returns at once, but a host that accepts nothing and answers
      // nothing costs a full request timeout each time. The deadline is what keeps a
      // genuinely unreachable service from holding the window on "Starting".
      const deadline = Date.now() + SERVICE_PROBE_WINDOW_MS;
      let service = await probeService();
      for (const delay of SERVICE_PROBE_BACKOFF_MS) {
        if (!active || service.status === "ready" || Date.now() >= deadline) return service;
        await new Promise((resume) => window.setTimeout(resume, delay));
        if (!active) return service;
        service = await probeService();
      }
      return service;
    }

    async function load(): Promise<ShellState> {
      const startup = await bridge!.getStartupStatus();
      if (startup.status === "failed") {
        return { status: "failed", error: startup.error };
      }
      const auth = await bridge!.getAccountAuthState();
      if (auth.status === "authenticated") {
        return {
          status: "authenticated",
          account: auth.account,
          connection: auth.connection,
        };
      }
      const service = await reachService();
      return service.status === "ready"
        ? { status: "signed_out" }
        : { status: "service_unavailable", service };
    }

    load().then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setState({ status: "unavailable" });
      },
    );

    return () => {
      active = false;
    };
  }, []);

  const authenticatedAccountId = state.status === "authenticated" ? state.account.id : null;
  const authenticatedConnection = state.status === "authenticated" ? state.connection : null;

  useEffect(() => {
    if (authenticatedAccountId === null) {
      setAccountPresentation(null);
      return;
    }
    if (authenticatedConnection !== "online") return;
    const bridge = readBridge();
    if (bridge === null) return;
    let active = true;
    void bridge
      .getAccountSettings()
      .then(async (result) => {
        if (!active || result?.status !== "ok") return;
        const account = result.settings.account;
        const avatarUrl = account.avatar === null ? null : await bridge.readAccountAvatar();
        if (!active) return;
        setAccountPresentation({
          accountId: account.id,
          displayName: account.display_name,
          avatarUrl,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [accountPresentationRefresh, authenticatedAccountId, authenticatedConnection]);

  useEffect(() => {
    if (state.status !== "authenticated" || state.connection !== "offline") return;
    const bridge = readBridge();
    if (bridge === null) return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      bridge
        .getAccountAuthState()
        .then((auth) => {
          setState(
            auth.status === "authenticated"
              ? {
                  status: "authenticated",
                  account: auth.account,
                  connection: auth.connection,
                }
              : { status: "signed_out" },
          );
        })
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [state]);

  const retryAccountService = useCallback((): void => {
    const bridge = readBridge();
    if (bridge === null || retrying) return;
    setRetrying(true);
    bridge
      .getAccountServiceStatus()
      .then(async (service) => {
        if (service.status !== "ready") {
          setState({ status: "service_unavailable", service });
          return;
        }
        const auth = await bridge.getAccountAuthState();
        setState(
          auth.status === "authenticated"
            ? {
                status: "authenticated",
                account: auth.account,
                connection: auth.connection,
              }
            : { status: "signed_out" },
        );
      })
      .catch(() =>
        setState({
          status: "service_unavailable",
          service: { status: "unavailable", retryable: true },
        }),
      )
      .finally(() => setRetrying(false));
  }, [retrying]);

  useEffect(() => {
    if (state.status !== "service_unavailable") return;
    const timer = window.setInterval(retryAccountService, 5_000);
    return () => window.clearInterval(timer);
  }, [retryAccountService, state.status]);

  const clearAuthenticatedShell = useCallback((): void => {
    setAuthenticatedView("home");
    setSignOutPreview(null);
    setSignOutError(null);
    setAccountPresentation(null);
    setState({ status: "signed_out" });
  }, []);

  const signOutNow = useCallback((): void => {
    const bridge = readBridge();
    if (bridge === null || signingOut) return;
    setSigningOut(true);
    bridge
      .signOut()
      .then(clearAuthenticatedShell)
      .catch(() => setSignOutError("Kiwi could not finish signing out. Try again."))
      .finally(() => setSigningOut(false));
  }, [clearAuthenticatedShell, signingOut]);

  const requestSignOut = useCallback((): void => {
    const bridge = readBridge();
    if (bridge === null || signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    bridge
      .previewSignOut()
      .then(async (preview) => {
        if (preview.total > 0) {
          setSignOutPreview(preview);
          return;
        }
        await bridge.signOut();
        clearAuthenticatedShell();
      })
      .catch(() => {
        setSignOutError("Kiwi could not review pending synchronization. Sign out was canceled.");
      })
      .finally(() => setSigningOut(false));
  }, [clearAuthenticatedShell, signingOut]);

  const closeSignOutReview = useCallback((): void => {
    setSignOutPreview(null);
    setSignOutError(null);
    window.setTimeout(
      () => document.querySelector<HTMLButtonElement>(".account-menu__trigger")?.focus(),
      0,
    );
  }, []);

  /**
   * Opening a project means opening the workspace that holds it first.
   *
   * Every command resolves its folder from the window's active workspace session, so the
   * session has to be bound before anything in the project can be read.
   */
  const openProject = useCallback((target: ProjectTarget): void => {
    const bridge = readBridge();
    if (bridge === null) return;
    bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        command: "kiwi.workspace.open",
        args: { root: target.root },
      })
      .then((result) => {
        if (result.error !== undefined) {
          // The folder has gone. Home says so rather than leaving a dead project selected.
          writeSelectedProject(null);
          setProject(null);
          setAuthenticatedView("home");
          return;
        }
        writeSelectedProject(target);
        setProject(target);
        setAuthenticatedView("project");
      })
      .catch(() => {
        setAuthenticatedView("home");
      });
  }, []);

  const leaveProject = useCallback((): void => {
    writeSelectedProject(null);
    setProject(null);
    setAuthenticatedView("home");
  }, []);

  // A project remembered from a previous session is opened once, at launch. Failing to open it
  // lands on Home, which is the only other honest place to be. The ref is what keeps this to
  // one attempt: without it, a failure that clears the selection would re-run the effect.
  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) {
      setDetached(null);
      return;
    }
    let active = true;
    void bridge
      .getDetachedDocument()
      .catch(() => null)
      .then((assignment) => {
        if (active) setDetached(assignment === null ? null : detachedView(assignment));
      });
    return () => {
      active = false;
    };
  }, []);

  const restored = useRef(false);
  useEffect(() => {
    if (state.status !== "authenticated" || restored.current) return;
    const remembered = readSelectedProject();
    if (remembered === null) return;
    restored.current = true;
    openProject(remembered);
  }, [openProject, state.status]);

  return (
    <>
      <TopBar
        workspaceTitle={workspace?.title ?? null}
        workspaceId={workspace?.workspaceId ?? null}
        workspaceStatus={workspace?.status ?? null}
        onOpenQuickSwitch={() => {
          setAuthenticatedView("home");
          setSwitchRequest((value) => value + 1);
        }}
        onWindowAction={performWindowAction}
        accountEmail={state.status === "authenticated" ? state.account.email : null}
        accountId={state.status === "authenticated" ? state.account.id : null}
        accountName={
          state.status === "authenticated" && accountPresentation?.accountId === state.account.id
            ? accountPresentation.displayName
            : null
        }
        accountAvatarUrl={
          state.status === "authenticated" && accountPresentation?.accountId === state.account.id
            ? accountPresentation.avatarUrl
            : null
        }
        accountConnection={state.status === "authenticated" ? state.connection : null}
        signingOut={signingOut}
        onSignOut={requestSignOut}
        onOpenAccountSettings={() => {
          setAuthenticatedView("account");
        }}
      />

      <main
        className={`shell${workspace === null ? "" : " shell--workbench"}${state.status === "signed_out" ? " shell--auth" : ""}`}
      >
        {state.status === "failed" ? <DiagnosticScreen error={state.error} /> : null}
        {state.status === "loading" ? <p className="shell__status">Starting</p> : null}
        {state.status === "unavailable" ? (
          <p className="shell__status" role="alert">
            The desktop bridge is unavailable.
          </p>
        ) : null}
        {state.status === "service_unavailable" ? (
          <AccountServiceGate
            status={state.service}
            retrying={retrying}
            onRetry={retryAccountService}
          />
        ) : null}
        {state.status === "signed_out" ? (
          <AccountAuth
            onAuthenticated={(account) =>
              setState({ status: "authenticated", account, connection: "online" })
            }
          />
        ) : null}
        {state.status === "authenticated" ? (
          <>
            {state.connection === "offline" ? (
              <p className="offline-banner" role="status">
                Offline. Downloaded workspaces remain available; changes will sync when Kiwi
                reconnects.
              </p>
            ) : null}
            {detached === undefined ? (
              <p className="shell__status">Opening</p>
            ) : detached !== null ? (
              detachedContent(detached)
            ) : authenticatedView === "account" ? (
              <AccountSettings
                onClose={() => {
                  setAuthenticatedView(project === null ? "home" : "project");
                  setAccountPresentationRefresh((value) => value + 1);
                }}
                onAccountDeletion={signOutNow}
                onSignOut={requestSignOut}
              />
            ) : authenticatedView === "home" ? (
              <ProjectHome
                onOpenProject={openProject}
                onCreateProject={() => setAuthenticatedView("create")}
                onOpenWorkspaceFolder={() => {
                  setAuthenticatedView("project");
                  setSwitchRequest((value) => value + 1);
                }}
              />
            ) : authenticatedView === "create" ? (
              <ProjectCreate
                onCreated={openProject}
                onCancel={() => setAuthenticatedView("home")}
              />
            ) : (
              <>
                <RuntimeNotice />
                <UndoBar workspaceId={workspace?.workspaceId ?? null} />
                <WorkspacePanel
                  onWorkspaceChange={setWorkspace}
                  switchRequest={switchRequest}
                  projectId={project?.projectId ?? null}
                  account={{ id: state.account.id, email: state.account.email }}
                  onLeaveProject={leaveProject}
                />
              </>
            )}
          </>
        ) : null}
      </main>
      {signOutPreview !== null ? (
        <div className="signout-review__backdrop" role="presentation">
          <section
            className="signout-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signout-review-title"
            aria-describedby="signout-review-description"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !signingOut) closeSignOutReview();
            }}
          >
            <span>Unsynchronized work</span>
            <h2 id="signout-review-title">Keep pending work on this device?</h2>
            <p id="signout-review-description">
              {signOutPreview.total} local synchronization{" "}
              {signOutPreview.total === 1 ? "item has" : "items have"} not reached the account
              service. Kiwi will keep this work on this device and will not upload it until this
              account signs in again.
            </p>
            <ul>
              {signOutPreview.pending_workspace_registrations > 0 ? (
                <li>
                  {signOutPreview.pending_workspace_registrations} workspace{" "}
                  {signOutPreview.pending_workspace_registrations === 1
                    ? "registration"
                    : "registrations"}
                </li>
              ) : null}
              {signOutPreview.pending_structured_changes > 0 ? (
                <li>
                  {signOutPreview.pending_structured_changes} structured{" "}
                  {signOutPreview.pending_structured_changes === 1 ? "change" : "changes"}
                </li>
              ) : null}
              {signOutPreview.pending_document_operations > 0 ? (
                <li>
                  {signOutPreview.pending_document_operations} note or document{" "}
                  {signOutPreview.pending_document_operations === 1 ? "edit" : "edits"}
                </li>
              ) : null}
            </ul>
            {signOutError !== null ? (
              <p className="auth__error" role="alert">
                {signOutError}
              </p>
            ) : null}
            <div className="signout-review__actions">
              <button
                className="button"
                type="button"
                autoFocus
                disabled={signingOut}
                onClick={closeSignOutReview}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={signingOut}
                onClick={signOutNow}
              >
                {signingOut ? "Signing out" : "Keep pending work and sign out"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {signOutError !== null && signOutPreview === null ? (
        <p className="shell__status" role="alert">
          {signOutError}
        </p>
      ) : null}
    </>
  );
}
