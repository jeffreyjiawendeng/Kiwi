import { useCallback, useEffect, useId, useState } from "react";
import {
  readBridge,
  type RendererCommandResult,
  type RendererError,
  type RendererWorkspaceFolderSelection,
} from "./bridge.js";
import { WorkspaceSettings } from "./WorkspaceSettings.js";
import { ProjectShell } from "./ProjectShell.js";
import { ServiceStatus } from "./ServiceStatus.js";
import { useSyncStatus } from "./useSyncStatus.js";

export interface WorkspaceSummaryView {
  workspaceId: string;
  title: string;
  root: string;
  formatVersion: string;
  status: string;
  trust: string;
  writable: boolean;
  problems: { rule: string; path: string; detail: string; severity: string }[];
}

export interface HealthView {
  root: string;
  status: string;
  manifestPresent: boolean;
  rootWritable: boolean;
  missingDirectories: string[];
  pendingTransactions: number;
  projection?: ProjectionView;
  problems: { rule: string; path: string; detail: string; severity: string }[];
}

interface ProjectionView {
  status: "ready" | "missing" | "stale" | "corrupt";
  generation: number;
  schemaVersion: number;
  objectCount: number;
  relationCount: number;
  errorCount: number;
  updatedAt: string | null;
  location: "outside_workspace";
}

interface RecentView {
  workspaceId: string;
  title: string;
  root: string;
  lastOpenedAt: string;
}

const STATUS_GUIDANCE: Record<string, string> = {
  future_schema:
    "This workspace was written by a newer version of Kiwi. It opens read only so nothing is lost. Update Kiwi to make changes.",
  migration_required:
    "This workspace uses an older format. Migration is not available yet, so it opens read only.",
  repair_required:
    "Kiwi could not read kiwi.workspace.json. Your records are untouched. Restore the file from a backup, or inspect it in a text editor.",
  workspace_missing: "This folder has no kiwi.workspace.json, so it is not a Kiwi workspace.",
  read_only: "The folder is read only, so Kiwi will not change anything in it.",
};

async function invoke(
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult | null> {
  const bridge = readBridge();
  if (bridge === null) return null;
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    command,
    args,
  });
}

export interface WorkspacePanelProps {
  onWorkspaceChange?: (workspace: WorkspaceSummaryView | null) => void;
  switchRequest?: number;
  /** The project open in this workspace, once one has been chosen on Home. */
  projectId?: string | null;
  /** The person reading, for the pages that assign work to somebody. */
  account?: { id: string; email: string } | undefined;
  /** Returns to Home, forgetting which project was open. */
  onLeaveProject?: () => void;
}

export function WorkspacePanel({
  onWorkspaceChange,
  switchRequest = 0,
  projectId = null,
  account,
  onLeaveProject,
}: WorkspacePanelProps = {}): React.JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceSummaryView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [recent, setRecent] = useState<RecentView[]>([]);
  const [syncHint, setSyncHint] = useState<string | null>(null);
  const [trustDecided, setTrustDecided] = useState(true);
  const [error, setError] = useState<RendererError | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<RendererWorkspaceFolderSelection | null>(null);
  const [createReceipt, setCreateReceipt] = useState<string | null>(null);
  const [collaborationState, setCollaborationState] = useState<"registered" | "pending" | null>(
    null,
  );
  const [projection, setProjection] = useState<ProjectionView | null>(null);
  const [projectionRequestId, setProjectionRequestId] = useState<string | null>(null);

  const [titleInput, setTitleInput] = useState("");
  const [showExisting, setShowExisting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const titleId = useId();

  // Home is where somebody comes to ask how Kiwi itself is doing, so the same reading the top
  // bar shows in one word is shown here in a sentence.
  const sharing = useSyncStatus(workspace?.workspaceId ?? null);

  const loadRecent = useCallback(async () => {
    const result = await invoke("kiwi.workspace.recent", {});
    const list = (result?.data ?? {})["recent"];
    if (Array.isArray(list)) setRecent(list as RecentView[]);
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) return;
    void bridge.getWorkspaceSession().then((session) => {
      if (session !== null) {
        setWorkspace(session.summary);
        onWorkspaceChange?.(session.summary);
      }
    });
  }, [onWorkspaceChange]);

  useEffect(() => {
    if (switchRequest > 0) setShowExisting(true);
  }, [switchRequest]);

  function applyResult(result: RendererCommandResult | null): boolean {
    if (result === null) return false;
    if (result.error !== undefined) {
      setError(result.error);
      return false;
    }
    setError(null);
    const data = result.data ?? {};
    if (data["workspace"] !== undefined) {
      const next = data["workspace"] as WorkspaceSummaryView;
      setWorkspace(next);
      onWorkspaceChange?.(next);
      setHealth(null);
    }
    if (data["health"] !== undefined) setHealth(data["health"] as HealthView);
    if (data["projection"] !== undefined) setProjection(data["projection"] as ProjectionView);
    if (data["registration"] === "registered" || data["registration"] === "pending") {
      setCollaborationState(data["registration"]);
    }
    setSyncHint((data["syncHint"] as string | null) ?? null);
    if (data["trustDecided"] !== undefined) setTrustDecided(data["trustDecided"] === true);
    return true;
  }

  async function withBusy(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError({
        code: "KIWI_UNAVAILABLE",
        message: "Kiwi could not reach the workspace service. Try again.",
        details: {},
        retryable: true,
        recovery_actions: ["retry"],
        correlation_id: crypto.randomUUID(),
      });
    } finally {
      setBusy(false);
    }
  }

  const chooseFolder = (): void =>
    void withBusy(async () => {
      setCreateReceipt(null);
      const bridge = readBridge();
      if (bridge === null) throw new Error("Workspace bridge unavailable");
      const next = await bridge.chooseWorkspaceFolder();
      if (next === null) return;
      setSelection(next);
      if (titleInput.trim() === "") setTitleInput(next.suggestedTitle);
    });

  const create = (): void =>
    void withBusy(async () => {
      const bridge = readBridge();
      if (bridge === null) throw new Error("Workspace bridge unavailable");
      if (selection === null) return;
      const result = await bridge.createWorkspace({
        selectionId: selection.id,
        title: titleInput,
      });
      setSelection(null);
      if (applyResult(result)) {
        setCreateReceipt(result.request_id);
        await loadRecent();
      }
    });

  const open = (root: string): void =>
    void withBusy(async () => {
      applyResult(await invoke("kiwi.workspace.open", { root }));
      await loadRecent();
    });

  const forget = (workspaceId: string): void =>
    void withBusy(async () => {
      const result = await invoke("kiwi.workspace.forget", { workspace_id: workspaceId });
      if (result?.error !== undefined) {
        setError(result.error);
        return;
      }
      const list = (result?.data ?? {})["recent"];
      if (Array.isArray(list)) setRecent(list as RecentView[]);
    });

  const chooseExisting = (): void =>
    void withBusy(async () => {
      const bridge = readBridge();
      if (bridge === null) throw new Error("Workspace bridge unavailable");
      applyResult(await bridge.openWorkspaceFolder());
      await loadRecent();
    });

  const chooseExistingInNewWindow = (): void =>
    void withBusy(async () => {
      const bridge = readBridge();
      if (bridge === null) throw new Error("Workspace bridge unavailable");
      const result = await bridge.openWorkspaceInNewWindow();
      if (result?.error !== undefined) setError(result.error);
    });

  const decideTrust = (trust: "trusted" | "restricted"): void =>
    void withBusy(async () => {
      if (workspace === null) return;
      applyResult(await invoke("kiwi.workspace.set-trust", { root: workspace.root, trust }));
      setTrustDecided(true);
    });

  const runHealth = (): void =>
    void withBusy(async () => {
      if (workspace === null) return;
      applyResult(await invoke("kiwi.workspace.health", { root: workspace.root }));
    });

  const repair = (): void =>
    void withBusy(async () => {
      if (workspace === null) return;
      await invoke("kiwi.workspace.repair-layout", { root: workspace.root });
      applyResult(await invoke("kiwi.workspace.health", { root: workspace.root }));
    });

  const recover = (): void =>
    void withBusy(async () => {
      if (workspace === null) return;
      const result = await invoke("kiwi.workspace.recover-transactions", {
        root: workspace.root,
      });
      if (result?.error !== undefined) {
        setError(result.error);
        return;
      }
      applyResult(await invoke("kiwi.workspace.health", { root: workspace.root }));
    });

  const rebuildProjection = (): void => {
    if (workspace === null || projectionRequestId !== null) return;
    const bridge = readBridge();
    if (bridge === null) return;
    const requestId = crypto.randomUUID();
    setProjectionRequestId(requestId);
    setBusy(true);
    setError(null);
    void bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspace.workspaceId,
        command: "kiwi.projection.clear-and-rebuild",
        args: { root: workspace.root },
      })
      .then(async (result) => {
        if (!applyResult(result)) return;
        applyResult(await invoke("kiwi.workspace.health", { root: workspace.root }));
      })
      .catch(() => {
        setError({
          code: "KIWI_UNAVAILABLE",
          message: "Kiwi could not rebuild the search index. Your workspace files are unchanged.",
          details: {},
          retryable: true,
          recovery_actions: ["retry"],
          correlation_id: requestId,
        });
      })
      .finally(() => {
        setProjectionRequestId(null);
        setBusy(false);
      });
  };

  const cancelProjectionRebuild = (): void => {
    if (projectionRequestId !== null) void readBridge()?.cancelCommand(projectionRequestId);
  };

  if (workspace !== null && showSettings) {
    return (
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={(next) => {
          setWorkspace(next);
          onWorkspaceChange?.(next);
        }}
        onClose={() => setShowSettings(false)}
        onWorkspaceClosed={() => {
          setShowSettings(false);
          setWorkspace(null);
          setHealth(null);
          setProjection(null);
          onWorkspaceChange?.(null);
          void loadRecent();
        }}
      />
    );
  }

  return (
    <section
      className={`workspace${workspace === null ? "" : " workspace--open"}`}
      aria-labelledby="workspace-title"
      aria-busy={busy}
    >
      {workspace === null ? (
        <h2 className="workspace__title" id="workspace-title">
          Create your first workspace
        </h2>
      ) : (
        <header className="workspace__heading">
          <div>
            <span>Workspace</span>
            <h2 className="workspace__title" id="workspace-title">
              {workspace.title || "Workspace"}
            </h2>
          </div>
          <button className="button" type="button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </header>
      )}

      {workspace === null ? (
        <p className="workspace__lead">
          Choose a folder for your research. Kiwi keeps the workspace as readable local files.
        </p>
      ) : (
        <WorkspaceIdentity
          workspace={workspace}
          syncHint={syncHint}
          collaborationState={collaborationState}
          projection={projection}
        />
      )}

      {workspace !== null && !trustDecided ? (
        <TrustPrompt root={workspace.root} syncHint={syncHint} busy={busy} onDecide={decideTrust} />
      ) : null}

      {error !== null ? <WorkspaceError error={error} /> : null}
      {health !== null ? (
        <HealthReport
          health={health}
          busy={busy}
          onRepair={repair}
          onRecover={recover}
          onRebuildProjection={rebuildProjection}
          onCancelProjectionRebuild={cancelProjectionRebuild}
          projectionRebuilding={projectionRequestId !== null}
        />
      ) : null}

      {workspace !== null && trustDecided && workspace.status === "ready" ? (
        <ProjectShell
          workspaceId={workspace.workspaceId}
          writable={workspace.writable}
          workspaceTitle={workspace.title}
          projectId={projectId}
          account={account}
          onOpenSettings={() => setShowSettings(true)}
          {...(onLeaveProject === undefined ? {} : { onLeaveProject })}
        />
      ) : null}

      {workspace === null ? (
        <div className="workspace__create">
          <label htmlFor={titleId}>Workspace name</label>
          <input
            id={titleId}
            type="text"
            maxLength={200}
            value={titleInput}
            onChange={(event) => setTitleInput(event.target.value)}
          />
          <p className="workspace__hint">Uses the flexible General Research setup.</p>
          <div className="workspace__folder">
            <span className="workspace__folder-label">Location</span>
            <button type="button" disabled={busy} onClick={chooseFolder}>
              {selection === null ? "Choose folder" : "Choose a different folder"}
            </button>
            {selection === null ? (
              <span className="workspace__status">Choose a folder to continue.</span>
            ) : (
              <output className="workspace__path" aria-live="polite">
                {selection.displayPath}
              </output>
            )}
          </div>
          {selection?.hasExistingContents === true ? (
            <p className="workspace__guidance" role="status">
              This folder contains other files. Kiwi will add its workspace files without changing
              the existing files.
            </p>
          ) : null}
          <div className="workspace__actions">
            <button
              type="button"
              disabled={busy || selection === null || titleInput.trim() === ""}
              onClick={create}
            >
              {busy ? "Creating workspace" : "Create workspace"}
            </button>
          </div>
        </div>
      ) : null}

      {createReceipt !== null ? (
        <p className="workspace__created" role="status">
          Workspace created. Receipt <code>{createReceipt}</code>
        </p>
      ) : null}

      <ServiceStatus sharing={sharing} />

      <details
        className="workspace__existing"
        open={showExisting}
        onToggle={(event) => setShowExisting(event.currentTarget.open)}
      >
        <summary>Open an existing workspace</summary>
        <div className="workspace__open">
          <div className="workspace__actions">
            <button type="button" disabled={busy} onClick={chooseExisting}>
              Choose workspace folder
            </button>
            <button type="button" disabled={busy} onClick={chooseExistingInNewWindow}>
              Open in new window
            </button>
            <button type="button" disabled={busy || workspace === null} onClick={runHealth}>
              Check health
            </button>
          </div>
        </div>
        <RecentList recent={recent} busy={busy} onOpen={open} onForget={forget} />
      </details>
    </section>
  );
}

function WorkspaceIdentity({
  workspace,
  syncHint,
  collaborationState,
  projection,
}: {
  workspace: WorkspaceSummaryView;
  syncHint: string | null;
  collaborationState: "registered" | "pending" | null;
  projection: ProjectionView | null;
}): React.JSX.Element {
  const guidance = STATUS_GUIDANCE[workspace.status];
  return (
    <div className="workspace__identity">
      {guidance !== undefined ? (
        <p className="workspace__guidance" role="status">
          {guidance}
        </p>
      ) : null}

      {!workspace.writable && guidance === undefined ? (
        <p className="workspace__guidance" role="status">
          This workspace is open read only.
        </p>
      ) : null}

      {syncHint !== null ? (
        <p className="workspace__guidance">
          This folder looks like it is inside a synchronizing folder ({syncHint}). Another machine
          can change these files while Kiwi has them open.
        </p>
      ) : null}

      {collaborationState === "pending" ? (
        <p className="workspace__guidance" role="status">
          Saved locally · workspace synchronization is queued until Kiwi reconnects.
        </p>
      ) : null}

      {projection !== null ? (
        <p className="workspace__index-status" role="status">
          {projection.status === "ready"
            ? `Search index ready · generation ${projection.generation}`
            : "Search index needs attention"}
        </p>
      ) : null}

      {workspace.problems.length > 0 ? (
        <ul className="workspace__problems" aria-label="Workspace problems">
          {workspace.problems.map((problem) => (
            <li key={problem.rule}>{problem.detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TrustPrompt({
  root,
  syncHint,
  busy,
  onDecide,
}: {
  root: string;
  syncHint: string | null;
  busy: boolean;
  onDecide: (trust: "trusted" | "restricted") => void;
}): React.JSX.Element {
  return (
    <div className="workspace__trust" role="group" aria-labelledby="trust-title">
      <h3 id="trust-title">Do you trust this folder?</h3>
      <p>
        Kiwi has not opened <code>{root}</code> before. Until you decide, it stays read only. Kiwi
        does not run anything from a workspace either way.
      </p>
      {syncHint !== null ? <p>It also sits inside a {syncHint} folder.</p> : null}
      <div className="workspace__actions">
        <button type="button" disabled={busy} onClick={() => onDecide("trusted")}>
          Trust this folder
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide("restricted")}>
          Keep it read only
        </button>
      </div>
    </div>
  );
}

function WorkspaceError({ error }: { error: RendererError }): React.JSX.Element {
  return (
    <div className="workspace__error" role="alert">
      <p>{error.message}</p>
      <dl className="workspace__facts">
        <dt>Code</dt>
        <dd>
          <code>{error.code}</code>
        </dd>
        <dt>Reference</dt>
        <dd>
          <code>{error.correlation_id}</code>
        </dd>
      </dl>
    </div>
  );
}

function HealthReport({
  health,
  busy,
  onRepair,
  onRecover,
  onRebuildProjection,
  onCancelProjectionRebuild,
  projectionRebuilding,
}: {
  health: HealthView;
  busy: boolean;
  onRepair: () => void;
  onRecover: () => void;
  onRebuildProjection: () => void;
  onCancelProjectionRebuild: () => void;
  projectionRebuilding: boolean;
}): React.JSX.Element {
  const healthy = health.problems.length === 0;
  return (
    <div className="workspace__health" aria-labelledby="health-title">
      <h3 id="health-title">Workspace health</h3>
      <dl className="workspace__facts">
        <dt>Manifest</dt>
        <dd>{health.manifestPresent ? "Present" : "Missing"}</dd>
        <dt>Folder</dt>
        <dd>{health.rootWritable ? "Writable" : "Read only"}</dd>
        <dt>Missing folders</dt>
        <dd>{health.missingDirectories.length}</dd>
        <dt>Interrupted writes</dt>
        <dd>{health.pendingTransactions}</dd>
        <dt>Search index</dt>
        <dd>
          {health.projection === undefined
            ? "Not checked"
            : `${health.projection.status} · generation ${health.projection.generation}`}
        </dd>
        <dt>Indexed records</dt>
        <dd>
          {health.projection === undefined
            ? "Not checked"
            : `${health.projection.objectCount} objects · ${health.projection.relationCount} relations`}
        </dd>
        <dt>Index location</dt>
        <dd>
          {health.projection?.location === "outside_workspace"
            ? "Outside workspace"
            : "Not checked"}
        </dd>
      </dl>

      {healthy ? (
        <p className="workspace__status">No problems found.</p>
      ) : (
        <ul className="workspace__problems" aria-label="Health problems">
          {health.problems.map((problem) => (
            <li key={problem.rule}>{problem.detail}</li>
          ))}
        </ul>
      )}

      {health.missingDirectories.length > 0 ? (
        <button type="button" disabled={busy} onClick={onRepair}>
          Recreate missing folders
        </button>
      ) : null}
      {health.pendingTransactions > 0 ? (
        <button type="button" disabled={busy || !health.rootWritable} onClick={onRecover}>
          Recover interrupted writes
        </button>
      ) : null}
      {health.projection !== undefined ? (
        projectionRebuilding ? (
          <button type="button" onClick={onCancelProjectionRebuild}>
            Cancel search index rebuild
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !health.rootWritable}
            onClick={onRebuildProjection}
          >
            Delete and rebuild search index
          </button>
        )
      ) : null}
    </div>
  );
}

/**
 * Where somebody has been, and the way out of it.
 *
 * Forgetting is confirmed rather than done on the click, and the confirmation says what will
 * happen: the list is Kiwi's, the folder is theirs. Nobody should have to find that out by
 * pressing the button.
 */
function RecentList({
  recent,
  busy,
  onOpen,
  onForget,
}: {
  recent: RecentView[];
  busy: boolean;
  onOpen: (root: string) => void;
  onForget: (workspaceId: string) => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="workspace__recent">
      <h3>Recent workspaces</h3>
      {recent.length === 0 ? (
        <p className="workspace__status">Kiwi has not opened a workspace yet.</p>
      ) : (
        <ul aria-label="Recent workspaces">
          {recent.map((entry) => (
            <li key={entry.root}>
              <button type="button" disabled={busy} onClick={() => onOpen(entry.root)}>
                {entry.title}
              </button>
              <code>{entry.root}</code>
              {confirming === entry.workspaceId ? (
                <div
                  className="workspace__forget"
                  role="group"
                  aria-label={`Forget ${entry.title}`}
                >
                  <p>
                    Kiwi will stop listing {entry.title}. The folder and everything in it stays
                    exactly where it is, and you can open it again by choosing that folder.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      onForget(entry.workspaceId);
                    }}
                  >
                    Forget it
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
                    Keep it listed
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(entry.workspaceId)}
                >
                  Forget {entry.title}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
