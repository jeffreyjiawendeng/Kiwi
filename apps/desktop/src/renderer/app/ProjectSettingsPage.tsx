import { useEffect, useId, useState } from "react";
import {
  CITATION_STYLES,
  OPTIONAL_PROJECT_PAGES,
  PROJECT_LIMITS,
  PROJECT_PAGE_LABELS,
  PROJECT_PAGE_PURPOSE,
  PROJECT_SENSITIVITIES,
  objectTypeLabel,
  validateProjectSettings,
  type CitationStyle,
  type OptionalProjectPage,
  type ProjectProblem,
  type ProjectSensitivity,
  type ProjectSettings,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * Project settings, and the switch that turns a page on.
 *
 * Turning a page off hides it and destroys nothing: the objects behind it stay where they are
 * and reappear when the page comes back. Saying so on the screen is what makes the switch
 * usable, a switch people are afraid of is a switch nobody touches.
 */

/**
 * What each level means, in the words somebody would use to a colleague.
 *
 * These are not access levels. Nothing Kiwi does stops a person who can open the folder from
 * reading the files in it -- nothing on somebody's own disk could -- so the wording says how the
 * material should be treated rather than implying a lock that is not there.
 */
const SENSITIVITY_MEANING: Record<ProjectSensitivity, string> = {
  public: "Meant to be shared outside the project.",
  internal: "For the people in this workspace.",
  confidential: "For named people only.",
  restricted: "The most guarded. Every copy should have a reason to exist.",
};

const CITATION_STYLE_LABELS: Record<CitationStyle, string> = {
  apa: "APA",
  mla: "MLA",
  chicago: "Chicago",
  ieee: "IEEE",
  nature: "Nature",
};

export interface ProjectSettingsPageProps {
  projectId: string;
  projectTitle: string;
  settings: ProjectSettings;
  version: number;
  contentHash: string;
  writable: boolean;
  onSaved: () => void;
  onOpenWorkspaceSettings?: (() => void) | undefined;
  /** Called once the project is gone, so the shell can leave a page about nothing. */
  onDeleted?: (() => void) | undefined;
}

async function invoke(
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult | null> {
  const bridge = readBridge();
  if (bridge === null) return null;
  return bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      command,
      args,
    })
    .catch(() => null);
}

export function ProjectSettingsPage({
  projectId,
  projectTitle,
  settings,
  version,
  contentHash,
  writable,
  onSaved,
  onOpenWorkspaceSettings,
  onDeleted,
}: ProjectSettingsPageProps): React.JSX.Element {
  const [title, setTitle] = useState(projectTitle);
  const [draft, setDraft] = useState<ProjectSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ProjectProblem[]>([]);
  const [saved, setSaved] = useState(false);
  const [deletion, setDeletion] = useState<{ counts: Record<string, number> } | null>(null);
  const [typed, setTyped] = useState("");

  const titleId = useId();
  const descriptionId = useId();
  const styleId = useId();
  const sensitivityId = useId();
  const confirmId = useId();

  // Somebody else may have renamed the project while this screen was open.
  useEffect(() => {
    setTitle(projectTitle);
    setDraft(settings);
  }, [projectTitle, settings]);

  const problems = validateProjectSettings({ title, settings: draft });
  const blocking = problems.filter((problem) => problem.severity === "error");
  const changed = title !== projectTitle || JSON.stringify(draft) !== JSON.stringify(settings);

  function togglePage(page: OptionalProjectPage): void {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      pages: current.pages.includes(page)
        ? current.pages.filter((entry) => entry !== page)
        : // Rail order, not the order they were switched on.
          OPTIONAL_PROJECT_PAGES.filter((entry) => entry === page || current.pages.includes(entry)),
    }));
  }

  /** "12 Papers and 3 Notes", so the confirmation says what it is about to unfile. */
  function whatIsInIt(counts: Record<string, number>): string {
    const parts = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([type, count]) => `${String(count)} ${objectTypeLabel(type, count !== 1)}`);
    if (parts.length === 0) return "nothing";
    if (parts.length === 1) return parts[0] ?? "nothing";
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
  }

  async function askToDelete(): Promise<void> {
    setError(null);
    setTyped("");
    const result = await invoke("kiwi.project.validate-delete", { project_id: projectId });
    if (result === null || result.error !== undefined) {
      setError(result?.error?.message ?? "Kiwi could not read what is in this project.");
      return;
    }
    setDeletion({ counts: ((result.data ?? {})["counts"] ?? {}) as Record<string, number> });
  }

  async function confirmDelete(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await invoke("kiwi.project.delete", {
      project_id: projectId,
      confirmation: typed,
    });
    setBusy(false);
    if (result === null || result.error !== undefined) {
      setError(result?.error?.message ?? "Kiwi could not delete that project.");
      return;
    }
    setDeletion(null);
    onDeleted?.();
  }

  async function save(): Promise<void> {
    if (busy || blocking.length > 0) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await invoke("kiwi.project.configure", {
      project_id: projectId,
      expected_version: version,
      expected_hash: contentHash,
      title: title.trim(),
      settings: draft,
    });
    setBusy(false);
    if (result === null || result.error !== undefined) {
      setError(
        result?.error?.code === "KIWI_CONFLICT_VERSION"
          ? "Somebody else changed this project while this screen was open. Reopen it and try again."
          : (result?.error?.message ?? "Kiwi could not save those settings."),
      );
      return;
    }
    setWarnings(((result.data ?? {})["warnings"] ?? []) as ProjectProblem[]);
    setSaved(true);
    onSaved();
  }

  return (
    <section className="project-settings page-fields" aria-labelledby="project-settings-title">
      <header>
        <span>Settings</span>
        <h3 id="project-settings-title">This project</h3>
      </header>

      <div className="project-settings__field">
        <label htmlFor={titleId}>Name</label>
        <input
          id={titleId}
          type="text"
          maxLength={PROJECT_LIMITS.title}
          disabled={!writable}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setSaved(false);
          }}
        />
      </div>

      <div className="project-settings__field">
        <label htmlFor={descriptionId}>What it is about</label>
        <textarea
          id={descriptionId}
          rows={2}
          maxLength={PROJECT_LIMITS.description}
          disabled={!writable}
          value={draft.description}
          onChange={(event) => {
            setDraft((current) => ({ ...current, description: event.target.value }));
            setSaved(false);
          }}
        />
      </div>

      <fieldset className="project-settings__pages">
        <legend>Pages</legend>
        <p className="project-settings__hint">
          Turning a page off hides it from the rail. Nothing behind it is deleted, and it comes back
          exactly as it was.
        </p>
        <ul>
          {OPTIONAL_PROJECT_PAGES.map((page) => (
            <li key={page}>
              <label>
                <input
                  type="checkbox"
                  disabled={!writable}
                  checked={draft.pages.includes(page)}
                  onChange={() => togglePage(page)}
                />
                <strong>{PROJECT_PAGE_LABELS[page]}</strong>
                <span>{PROJECT_PAGE_PURPOSE[page]}</span>
              </label>
            </li>
          ))}
        </ul>
        {problems
          .filter((problem) => problem.severity === "warning")
          .map((problem) => (
            <p className="project-settings__warning" role="status" key={problem.message}>
              {problem.message}
            </p>
          ))}
      </fieldset>

      <div className="project-settings__field">
        <label htmlFor={sensitivityId}>Sensitivity</label>
        <select
          id={sensitivityId}
          disabled={!writable}
          value={draft.sensitivity}
          onChange={(event) => {
            const chosen = event.target.value as ProjectSensitivity;
            setDraft((current) => ({ ...current, sensitivity: chosen }));
            setSaved(false);
          }}
        >
          {PROJECT_SENSITIVITIES.map((level) => (
            <option key={level} value={level}>
              {level}: {SENSITIVITY_MEANING[level]}
            </option>
          ))}
        </select>
        <p className="project-settings__hint">
          A marking, not a lock. It travels with the project and shows wherever the project is
          named, so everybody handling it knows how it should be treated. Who may open a shared
          workspace is decided on the Members page.
        </p>
      </div>

      <div className="project-settings__field">
        <label htmlFor={styleId}>Citation style</label>
        <select
          id={styleId}
          disabled={!writable}
          value={draft.citation_style}
          onChange={(event) => {
            setDraft((current) => ({
              ...current,
              citation_style: event.target.value as CitationStyle,
            }));
            setSaved(false);
          }}
        >
          {CITATION_STYLES.map((style) => (
            <option key={style} value={style}>
              {CITATION_STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </div>

      <div className="project-settings__field">
        <label className="project-settings__inline">
          <input
            type="checkbox"
            disabled={!writable}
            checked={draft.archived}
            onChange={(event) => {
              setDraft((current) => ({ ...current, archived: event.target.checked }));
              setSaved(false);
            }}
          />
          <span>
            Archived. The project sinks to the bottom of Home, and everything in it stays readable
            and editable.
          </span>
        </label>
      </div>

      {blocking.map((problem) => (
        <p className="project-settings__error" role="alert" key={problem.message}>
          {problem.message}
        </p>
      ))}
      {error !== null ? (
        <p className="project-settings__error" role="alert">
          {error}
        </p>
      ) : null}
      {warnings.map((problem) => (
        <p className="project-settings__warning" role="status" key={problem.message}>
          {problem.message}
        </p>
      ))}

      <section className="project-settings__danger" aria-label="Delete this project">
        <h4>Delete this project</h4>
        {deletion === null ? (
          <>
            <p className="project-settings__hint">
              Archiving is usually what somebody wants: it sinks the project to the bottom of Home
              and leaves everything readable. Deleting takes the project away for good.
            </p>
            <button
              className="button"
              type="button"
              disabled={!writable || busy}
              onClick={() => void askToDelete()}
            >
              Delete this project
            </button>
          </>
        ) : (
          <>
            <p>
              Deleting {projectTitle} takes {whatIsInIt(deletion.counts)} out of it.{" "}
              <strong>Nothing you wrote is deleted.</strong> Every one of them stays in this
              workspace, filed in no project, and you can put them in another one. What goes is the
              project itself: its name, what it is about, and which pages it showed. That cannot be
              undone.
            </p>
            <label htmlFor={confirmId}>Type {projectTitle} to confirm</label>
            <input
              id={confirmId}
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <div className="project-settings__actions">
              <button
                className="button"
                type="button"
                disabled={busy || typed.trim() !== projectTitle.trim()}
                onClick={() => void confirmDelete()}
              >
                Delete {projectTitle}
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setDeletion(null)}
              >
                Keep it
              </button>
            </div>
          </>
        )}
      </section>

      <div className="project-settings__actions">
        {onOpenWorkspaceSettings === undefined ? null : (
          <button className="button" type="button" onClick={onOpenWorkspaceSettings}>
            Workspace settings
          </button>
        )}
        <button
          className="button button--primary"
          type="button"
          disabled={!writable || busy || !changed || blocking.length > 0}
          onClick={() => void save()}
        >
          {busy ? "Saving" : "Save"}
        </button>
        {saved ? (
          // Cleared by the next edit rather than by the parent handing back new props: the
          // indicator has to be right whether or not anything upstream re-reads.
          <span className="project-settings__saved" role="status">
            Saved
          </span>
        ) : null}
      </div>
    </section>
  );
}
