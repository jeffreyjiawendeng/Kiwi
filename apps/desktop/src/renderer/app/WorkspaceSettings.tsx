import { useEffect, useState } from "react";
import { readBridge, type RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import { anArticle } from "./members-roster.js";
import type { WorkspaceSummaryView } from "./WorkspacePanel.js";

export function WorkspaceSettings({
  workspace,
  onWorkspaceChange,
  onClose,
  onWorkspaceClosed,
}: {
  workspace: WorkspaceSummaryView;
  onWorkspaceChange(workspace: WorkspaceSummaryView): void;
  onClose(): void;
  /** Called once this window has let go of the workspace. */
  onWorkspaceClosed?: (() => void) | undefined;
}): React.JSX.Element {
  const [settings, setSettings] = useState<RendererWorkspaceCollaborationSnapshot | null>(null);
  const [projectName, setProjectName] = useState("");
  const [workspaceTitle, setWorkspaceTitle] = useState(workspace.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<
    "user" | "application" | "workspace" | "project" | "extension"
  >("workspace");
  const [theme, setTheme] = useState(
    () => window.localStorage.getItem("kiwi.preference.theme") ?? "system",
  );
  const [density, setDensity] = useState(
    () => window.localStorage.getItem("kiwi.preference.density") ?? "default",
  );

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.dataset["density"] = density;
    window.localStorage.setItem("kiwi.preference.theme", theme);
    window.localStorage.setItem("kiwi.preference.density", density);
  }, [density, theme]);

  async function closeWorkspace(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.closeWorkspace();
      onWorkspaceClosed?.();
    } catch {
      setError("Kiwi could not close the workspace. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function act(
    action: Parameters<
      NonNullable<ReturnType<typeof readBridge>>["manageWorkspaceCollaboration"]
    >[0]["action"],
    input: Record<string, unknown>,
  ) {
    const bridge = readBridge();
    if (bridge === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action,
        input: { workspace_id: workspace.workspaceId, ...input },
      });
      if (result.status === "ok") setSettings(result.settings);
      else if (result.status === "error") setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void act("snapshot", {});
  }, [workspace.workspaceId]);

  async function renameLocalWorkspace(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const bridge = readBridge();
    if (bridge === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        command: "kiwi.workspace.rename",
        args: { root: workspace.root, title: workspaceTitle },
      });
      if (result.error !== undefined) setError(result.error.message);
      else if (result.data?.["workspace"] !== undefined)
        onWorkspaceChange(result.data["workspace"] as WorkspaceSummaryView);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="account-settings"
      aria-labelledby="workspace-settings-title"
      aria-busy={busy}
    >
      <button className="account-settings__back" type="button" onClick={onClose}>
        Back to workspace
      </button>
      <header>
        <nav className="account-settings__breadcrumb" aria-label="Settings location">
          <span>Settings</span>
          <span aria-hidden="true">&gt;</span>
          <span>{scope.slice(0, 1).toLocaleUpperCase() + scope.slice(1)}</span>
        </nav>
        <h1 id="workspace-settings-title">
          {scope.slice(0, 1).toLocaleUpperCase() + scope.slice(1)} settings
        </h1>
        <span>
          Preferences, collaboration, and project policy, each resolved at an explicit scope.
        </span>
      </header>
      <nav className="settings-scopes" aria-label="Settings scope">
        {(["user", "application", "workspace", "project", "extension"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-current={scope === item ? "page" : undefined}
            onClick={() => setScope(item)}
          >
            {item.slice(0, 1).toLocaleUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      {error !== null ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {scope === "user" || scope === "application" ? (
        <section className="settings-section">
          <h2>{scope === "user" ? "User preferences" : "Appearance on this device"}</h2>
          <p className="settings-section__description">
            {scope === "user"
              ? "User preferences can follow your account. Device appearance stays in Application scope."
              : "These choices affect this Kiwi installation and never change workspace files."}
          </p>
          {scope === "user" ? (
            <label className="settings-toggle">
              <span>
                <strong>Quiet routine notifications</strong>
                <small>Failures and required actions are still shown.</small>
              </span>
              <input type="checkbox" />
            </label>
          ) : (
            <>
              <label className="settings-choice">
                <span>Theme</span>
                <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                  <option value="system">Follow Windows</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="settings-choice">
                <span>Density</span>
                <select value={density} onChange={(event) => setDensity(event.target.value)}>
                  <option value="compact">Compact</option>
                  <option value="default">Default</option>
                  <option value="comfortable">Comfortable</option>
                </select>
              </label>
              <button
                className="button"
                type="button"
                disabled={theme === "system" && density === "default"}
                onClick={() => {
                  setTheme("system");
                  setDensity("default");
                }}
              >
                Reset Application settings
              </button>
            </>
          )}
        </section>
      ) : null}
      {scope === "extension" ? (
        <section className="settings-section">
          <h2>Extension settings</h2>
          <p className="settings-section__description">
            No installed extension contributes settings.
          </p>
        </section>
      ) : null}
      {scope === "workspace" ? (
        <section className="settings-section">
          <h2>General</h2>
          <p className="settings-section__description">
            The name is saved in the local canonical workspace first. Synchronization can finish
            after reconnecting.
          </p>
          <form onSubmit={(event) => void renameLocalWorkspace(event)}>
            <label htmlFor="workspace-title-input">Workspace name</label>
            <div className="settings-inline">
              <input
                id="workspace-title-input"
                required
                maxLength={200}
                value={workspaceTitle}
                onChange={(event) => setWorkspaceTitle(event.target.value)}
              />
              <button className="button button--primary" type="submit">
                Save name
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {scope === "workspace" ? (
        <section className="settings-section">
          <h2>Closing this workspace</h2>
          <p className="settings-section__description">
            This window stops working on {workspace.title} and goes back to the list. Nothing in the
            folder changes. Closing is what lets another Kiwi open it: another window, another
            machine, or this one tomorrow.
          </p>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void closeWorkspace()}
          >
            Close workspace
          </button>
        </section>
      ) : null}
      {(scope === "workspace" || scope === "project") && settings === null && error === null ? (
        <p role="status">Loading workspace settings...</p>
      ) : null}
      {settings !== null ? (
        <>
          {/*
            Who is here, and everything that changes it, is on the Members page. What stood here
            was written before that page existed and was kept only so that nothing was missing in
            between: a role menu that sent on the first click, a remove button with nothing to
            confirm, and no word about how old any of it was. Two places to change the same thing
            is how the two come to disagree, and the worse of them is the one somebody finds first.
          */}
          {scope === "workspace" ? (
            <section className="settings-section">
              <h2>Collaborators</h2>
              <p className="settings-section__description">
                You are {anArticle(settings.workspace.role)} {settings.workspace.role} in this
                workspace. Who else is here, invitations, roles, and removals are all on the Members
                page.
              </p>
            </section>
          ) : null}
          {scope === "project" ? (
            <section className="settings-section">
              <h2>Projects</h2>
              <p className="settings-section__description">
                Project policy may narrow access. It cannot expand a workspace role.
              </p>
              <ul className="session-list">
                {settings.projects.map((project) => (
                  <li key={project.id}>
                    <div>
                      <strong>{project.name}</strong>
                      <span className="settings-list__meta">
                        <span className="settings-tag">{project.sensitivity}</span>
                        <span className="settings-tag">
                          {project.review_required ? "Review required" : "No review gate"}
                        </span>
                      </span>
                    </div>
                    <div className="settings-inline">
                      <select
                        aria-label={`Sensitivity for ${project.name}`}
                        value={project.sensitivity}
                        onChange={(event) =>
                          void act("update_project", {
                            project_id: project.id,
                            sensitivity: event.target.value,
                            review_required: project.review_required,
                          })
                        }
                      >
                        {["public", "internal", "confidential", "restricted"].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                      <button
                        className="button"
                        type="button"
                        onClick={() =>
                          void act("update_project", {
                            project_id: project.id,
                            sensitivity: project.sensitivity,
                            review_required: !project.review_required,
                          })
                        }
                      >
                        {project.review_required ? "Remove review gate" : "Require review"}
                      </button>
                    </div>
                    {/*
                      Every member crossed against every project used to be here. It is on the
                      Members page now, as the list of people whose access on one project is not
                      their workspace role, which is the short list somebody is actually looking
                      for. The count is all that is worth saying from here.
                    */}
                    {project.member_overrides.some(
                      (override) => override.project_role !== override.workspace_role,
                    ) ? (
                      <span className="settings-list__meta">
                        <span className="settings-tag">
                          Somebody's access here is not their workspace role. The Members page lists
                          it.
                        </span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act("create_project", { name: projectName });
                  setProjectName("");
                }}
              >
                <label htmlFor="new-project-name">New project</label>
                <div className="settings-inline">
                  <input
                    id="new-project-name"
                    required
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                  <button className="button button--primary" type="submit">
                    Create project
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
