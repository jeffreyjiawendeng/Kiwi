import { useEffect, useId, useState } from "react";
import {
  PROJECT_LIMITS,
  PROJECT_PAGE_LABELS,
  PROJECT_TEMPLATES,
  type ProjectTemplateId,
} from "@kiwi/contracts";
import {
  readBridge,
  type RendererCommandResult,
  type RendererProjectDirectoryEntry,
  type RendererWorkspaceFolderSelection,
} from "./bridge.js";
import type { ProjectTarget } from "./ProjectHome.js";

/**
 * Creating a project.
 *
 * One screen, grouped, no wizard, the shape of a repository or a server creation page. The
 * question that matters is the second one: whether this is yours alone or a team's, because
 * that is what decides whether anything ever leaves this machine. A project kept to yourself
 * is local until the day it is shared.
 */

type Audience = "me" | "team";

export interface ProjectCreateProps {
  onCreated: (target: ProjectTarget) => void;
  onCancel: () => void;
}

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

export function ProjectCreate({ onCreated, onCancel }: ProjectCreateProps): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<Audience>("me");
  const [template, setTemplate] = useState<ProjectTemplateId>("general");
  const [workspaces, setWorkspaces] = useState<RendererProjectDirectoryEntry[]>([]);
  const [workspaceChoice, setWorkspaceChoice] = useState<string>("new");
  const [newWorkspaceTitle, setNewWorkspaceTitle] = useState("");
  const [folder, setFolder] = useState<RendererWorkspaceFolderSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const descriptionId = useId();
  const workspaceId = useId();
  const workspaceTitleId = useId();

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null || typeof bridge.listProjectDirectory !== "function") return;
    let active = true;
    void bridge
      .listProjectDirectory()
      .then((found) => {
        if (!active) return;
        setWorkspaces(found);
        // Somebody who already has a workspace almost always means that one. Defaulting to
        // "new" would make a second folder the easy mistake.
        const reachable = found.find((entry) => entry.projects !== null);
        if (reachable !== undefined) setWorkspaceChoice(reachable.workspaceId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const creatingWorkspace = workspaceChoice === "new";
  const chosen = workspaces.find((entry) => entry.workspaceId === workspaceChoice) ?? null;
  const pages = PROJECT_TEMPLATES.find((entry) => entry.id === template)?.pages ?? [];

  const ready =
    title.trim() !== "" &&
    !busy &&
    (!creatingWorkspace ? chosen !== null : folder !== null && newWorkspaceTitle.trim() !== "");

  async function chooseFolder(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    const selection = await bridge.chooseWorkspaceFolder().catch(() => null);
    if (selection !== null) setFolder(selection);
  }

  async function submit(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !ready) return;
    setBusy(true);
    setError(null);
    try {
      // The workspace has to be the open one before a project can be created in it: the main
      // process resolves every command's folder from the active session rather than trusting
      // a path from here.
      let root: string;
      let openedWorkspaceId: string;
      if (creatingWorkspace) {
        const created = await bridge.createWorkspace({
          selectionId: folder!.id,
          title: newWorkspaceTitle.trim(),
        });
        const summary = (created.data ?? {})["workspace"] as
          { workspaceId: string; root: string } | undefined;
        if (created.error !== undefined || summary === undefined) {
          setError(created.error?.message ?? "Kiwi could not create that workspace.");
          return;
        }
        root = summary.root;
        openedWorkspaceId = summary.workspaceId;
      } else {
        const opened = await invoke("kiwi.workspace.open", { root: chosen!.displayPath });
        const summary = (opened?.data ?? {})["workspace"] as
          { workspaceId: string; root: string } | undefined;
        if (opened === null || opened.error !== undefined || summary === undefined) {
          setError(opened?.error?.message ?? "Kiwi could not open that workspace.");
          return;
        }
        root = summary.root;
        openedWorkspaceId = summary.workspaceId;
      }

      const result = await invoke("kiwi.project.create", {
        title: title.trim(),
        template,
        description: description.trim(),
      });
      const project = (result?.data ?? {})["project"] as { id: string } | undefined;
      if (result === null || result.error !== undefined || project === undefined) {
        setError(result?.error?.message ?? "Kiwi could not create that project.");
        return;
      }
      onCreated({ workspaceId: openedWorkspaceId, root, projectId: project.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="create-project" aria-labelledby="create-project-title">
      <header>
        <span>New project</span>
        <h2 id="create-project-title">What are you working on?</h2>
      </header>

      <div className="create-project__field">
        <label htmlFor={titleId}>Project name</label>
        <input
          id={titleId}
          type="text"
          maxLength={PROJECT_LIMITS.title}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="create-project__field">
        <label htmlFor={descriptionId}>What it is about</label>
        <textarea
          id={descriptionId}
          rows={2}
          maxLength={PROJECT_LIMITS.description}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p className="create-project__hint">Optional. Searchable later.</p>
      </div>

      <fieldset className="create-project__group">
        <legend>Who it is for</legend>
        <div className="create-project__choices">
          <label className={audience === "me" ? "is-selected" : ""}>
            <input
              type="radio"
              name="audience"
              value="me"
              checked={audience === "me"}
              onChange={() => setAudience("me")}
            />
            <strong>Just me</strong>
            <span>Stays on this computer. You can share it later.</span>
          </label>
          <label className={audience === "team" ? "is-selected" : ""}>
            <input
              type="radio"
              name="audience"
              value="team"
              checked={audience === "team"}
              onChange={() => setAudience("team")}
            />
            <strong>A team</strong>
            <span>People you invite can read and edit it.</span>
          </label>
        </div>
        {audience === "team" ? (
          <p className="create-project__hint">
            Invitations are sent from the Members page once the project exists.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="create-project__group">
        <legend>Starting point</legend>
        <div className="create-project__choices create-project__choices--templates">
          {PROJECT_TEMPLATES.map((entry) => (
            <label key={entry.id} className={template === entry.id ? "is-selected" : ""}>
              <input
                type="radio"
                name="template"
                value={entry.id}
                checked={template === entry.id}
                onChange={() => setTemplate(entry.id)}
              />
              <strong>{entry.label}</strong>
              <span>{entry.description}</span>
            </label>
          ))}
        </div>
        <p className="create-project__hint">
          {pages.length === 0
            ? "Adds no extra pages. You can turn any of them on later in Settings."
            : `Turns on ${pages.map((page) => PROJECT_PAGE_LABELS[page]).join(", ")}. Reversible in Settings.`}
        </p>
      </fieldset>

      <div className="create-project__field">
        <label htmlFor={workspaceId}>Workspace</label>
        <select
          id={workspaceId}
          value={workspaceChoice}
          onChange={(event) => setWorkspaceChoice(event.target.value)}
        >
          {workspaces
            .filter((entry) => entry.projects !== null)
            .map((entry) => (
              <option key={entry.workspaceId} value={entry.workspaceId}>
                {entry.workspaceTitle}
              </option>
            ))}
          <option value="new">New workspace</option>
        </select>
        <p className="create-project__hint">
          A workspace is a folder holding one or more projects, and the people who share them.
        </p>
      </div>

      {creatingWorkspace ? (
        <div className="create-project__workspace">
          <div className="create-project__field">
            <label htmlFor={workspaceTitleId}>Workspace name</label>
            <input
              id={workspaceTitleId}
              type="text"
              maxLength={200}
              value={newWorkspaceTitle}
              onChange={(event) => setNewWorkspaceTitle(event.target.value)}
            />
          </div>
          <div className="create-project__field">
            <span className="create-project__label">Location</span>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              {folder === null ? "Choose folder" : "Choose a different folder"}
            </button>
            {folder === null ? (
              <p className="create-project__hint">Choose a folder to continue.</p>
            ) : (
              <output className="create-project__path">{folder.displayPath}</output>
            )}
            {folder?.hasExistingContents === true ? (
              <p className="create-project__hint" role="status">
                This folder holds other files. Kiwi adds its own without changing them.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <p className="create-project__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="create-project__actions">
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button button--primary"
          type="button"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {busy ? "Creating" : "Create project"}
        </button>
      </div>
    </section>
  );
}
