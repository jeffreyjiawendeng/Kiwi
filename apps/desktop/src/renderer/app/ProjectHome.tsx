import { useEffect, useMemo, useState } from "react";
import { readBridge, type RendererProjectDirectoryEntry } from "./bridge.js";
import { objectTypeLabel } from "@kiwi/contracts";

/**
 * Home: pick a project, or start one.
 *
 * Shown only while no project is open. Once one is, signing in goes straight to it, a screen
 * between someone and their work every launch is a screen nobody wants.
 *
 * Projects are listed across every workspace this account has opened, because "which workspace
 * was that in" is not a question anybody should have to answer to get back to their work.
 */

export interface ProjectTarget {
  workspaceId: string;
  root: string;
  projectId: string;
}

export interface ProjectHomeProps {
  onOpenProject: (target: ProjectTarget) => void;
  onCreateProject: () => void;
  onOpenWorkspaceFolder: () => void;
  /** Injected by tests so the "3 days ago" labels do not drift with the calendar. */
  now?: number;
}

interface Row {
  workspaceId: string;
  workspaceTitle: string;
  root: string;
  projectId: string;
  title: string;
  description: string;
  updatedAt: string;
  archived: boolean;
  sensitivity: string;
  counts: Record<string, number>;
}

const DAY_MS = 86_400_000;

/**
 * How long ago, in the words someone would use.
 *
 * A timestamp is precise and unreadable; "yesterday" is what the reader is actually asking.
 * Anything older than a fortnight gets a date, because "37 days ago" is arithmetic, not an
 * answer.
 */
export function whenLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((now - at) / DAY_MS);
  if (days < 0) return "just now";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "12 Papers · 3 Notes", built from whatever the project actually holds. */
export function countsLabel(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([type, count]) => `${count} ${objectTypeLabel(type, count !== 1)}`);
  return parts.length === 0 ? "Empty" : parts.join(" · ");
}

function rowsOf(entries: RendererProjectDirectoryEntry[]): Row[] {
  return entries.flatMap((entry) =>
    (entry.projects ?? []).map((project) => ({
      workspaceId: entry.workspaceId,
      workspaceTitle: entry.workspaceTitle,
      root: entry.displayPath,
      projectId: project.id,
      title: project.title,
      description: project.description,
      updatedAt: project.updatedAt,
      archived: project.archived,
      sensitivity: project.sensitivity,
      counts: project.counts,
    })),
  );
}

export function ProjectHome({
  onOpenProject,
  onCreateProject,
  onOpenWorkspaceFolder,
  now = Date.now(),
}: ProjectHomeProps): React.JSX.Element {
  const [entries, setEntries] = useState<RendererProjectDirectoryEntry[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const bridge = readBridge();
    // A preload older than this renderer has no such method. Calling it would throw inside
    // the effect and take the whole window down, which is a worse answer than an empty Home.
    if (bridge === null || typeof bridge.listProjectDirectory !== "function") {
      setEntries([]);
      return;
    }
    let active = true;
    void bridge
      .listProjectDirectory()
      .then((found) => {
        if (active) setEntries(found);
      })
      .catch(() => {
        if (active) setEntries([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => rowsOf(entries ?? []), [entries]);

  const matching = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        row.title.toLocaleLowerCase().includes(needle) ||
        row.description.toLocaleLowerCase().includes(needle) ||
        row.workspaceTitle.toLocaleLowerCase().includes(needle),
    );
  }, [filter, rows]);

  const recent = useMemo(
    () =>
      [...matching]
        .filter((row) => !row.archived)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 6),
    [matching],
  );

  const byWorkspace = useMemo(() => {
    const groups = new Map<string, { title: string; root: string; rows: Row[] }>();
    for (const entry of entries ?? []) {
      groups.set(entry.workspaceId, {
        title: entry.workspaceTitle,
        root: entry.displayPath,
        rows: [],
      });
    }
    for (const row of matching) groups.get(row.workspaceId)?.rows.push(row);
    return [...groups.entries()].map(([workspaceId, group]) => ({ workspaceId, ...group }));
  }, [entries, matching]);

  const unreadable = (entries ?? []).filter((entry) => entry.projects === null);
  const nothingYet = entries !== null && rows.length === 0 && unreadable.length === 0;

  return (
    <section className="home" aria-labelledby="home-title">
      <header className="home__heading">
        <h2 id="home-title">Projects</h2>
        <div className="home__actions">
          <button className="button button--primary" type="button" onClick={onCreateProject}>
            New project
          </button>
          <button className="button" type="button" onClick={onOpenWorkspaceFolder}>
            Open a workspace folder
          </button>
        </div>
      </header>

      {entries === null ? <p className="home__status">Reading your workspaces</p> : null}

      {nothingYet ? (
        <div className="home__empty">
          <h3>Start your first project</h3>
          <p>
            A project is one piece of research: the papers you are reading, the notes you take on
            them, and the manuscript you write. It lives in a workspace, which is a folder on this
            computer that you can share with a lab or keep to yourself.
          </p>
          <button className="button button--primary" type="button" onClick={onCreateProject}>
            New project
          </button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <label className="home__filter">
          <span className="sr-only">Filter projects</span>
          <input
            type="search"
            placeholder="Filter projects"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      ) : null}

      {recent.length > 0 && filter.trim() === "" ? (
        <section className="home__section" aria-labelledby="home-recent-title">
          <h3 id="home-recent-title">Recent</h3>
          <ul className="home__grid">
            {recent.map((row) => (
              <li key={`${row.workspaceId}:${row.projectId}`}>
                <ProjectCard row={row} now={now} onOpen={onOpenProject} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {byWorkspace.map((group) => (
        <section
          className="home__section"
          key={group.workspaceId}
          aria-label={`Workspace ${group.title}`}
        >
          <h3>
            {group.title}
            <span className="home__path">{group.root}</span>
          </h3>
          {group.rows.length === 0 ? (
            <p className="home__note">
              {filter.trim() === ""
                ? "No projects in this workspace yet."
                : "Nothing here matches that."}
            </p>
          ) : (
            <ul className="home__grid">
              {group.rows
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                .map((row) => (
                  <li key={row.projectId}>
                    <ProjectCard row={row} now={now} onOpen={onOpenProject} />
                  </li>
                ))}
            </ul>
          )}
        </section>
      ))}

      {unreadable.length > 0 ? (
        <section className="home__section" aria-labelledby="home-unreachable-title">
          <h3 id="home-unreachable-title">Not reachable</h3>
          <p className="home__note">
            Kiwi could not read these folders. They may have been moved or renamed, or they may be
            on a drive that is not attached. Nothing has been deleted.
          </p>
          <ul className="home__unreachable">
            {unreadable.map((entry) => (
              <li key={entry.workspaceId}>
                <strong>{entry.workspaceTitle}</strong>
                <span>{entry.displayPath}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function ProjectCard({
  row,
  now,
  onOpen,
}: {
  row: Row;
  now: number;
  onOpen: (target: ProjectTarget) => void;
}): React.JSX.Element {
  return (
    <button
      className={`project-card${row.archived ? " project-card--archived" : ""}`}
      type="button"
      onClick={() =>
        onOpen({ workspaceId: row.workspaceId, root: row.root, projectId: row.projectId })
      }
    >
      <strong>{row.title}</strong>
      {row.description === "" ? null : (
        <span className="project-card__about">{row.description}</span>
      )}
      <span className="project-card__meta">
        {row.workspaceTitle} · {countsLabel(row.counts)}
      </span>
      <span className="project-card__when">
        {row.archived ? "Archived · " : ""}
        {whenLabel(row.updatedAt, now)}
      </span>
      {/* Only when it is not the ordinary case: a marking on every card is a marking nobody
          reads, and the one that matters is the one that is different. */}
      {row.sensitivity === "internal" || row.sensitivity === "" ? null : (
        <span className="project-card__sensitivity">{row.sensitivity}</span>
      )}
    </button>
  );
}
