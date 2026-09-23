import { useCallback, useEffect, useMemo, useState } from "react";
import {
  objectTypeLabel,
  projectPageEnabled,
  type ProjectPage,
  type ProjectSettings,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import { DashboardActivity } from "./DashboardActivity.js";
import { DashboardTasks } from "./DashboardTasks.js";
import type { FeedMember } from "./dashboard-activity.js";
import {
  NOTHING_WAITING,
  attentionRows,
  type ConflictRecord,
  type ThreadRecord,
} from "./dashboard-attention.js";
import type { RawEvent } from "./history-log.js";

/**
 * The Dashboard: the state of a project in one screen.
 *
 * This is what opens when a project opens, so it answers the question somebody actually has
 * when they sit down, what is in here, what changed, and what is wrong, rather than showing
 * them a file list and letting them work it out.
 *
 * One column, 820px wide, read top to bottom: what this project is, how much of it there is,
 * what is yours and what is wrong, and then what has been happening. It was six bordered panels
 * stacked down a full-width page, which is a filing cabinet rather than a screen you read; and
 * two of those panels, Recently changed and the activity feed, were the same list twice.
 */

export interface DashboardMember {
  id: string;
  type: string;
  title: string;
  updated_at: string;
}

export interface ProjectDashboardProps {
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  /**
   * Who is reading, when Kiwi knows.
   *
   * Only the panel of your own work needs this, and it is the one part of the Dashboard that
   * means nothing without it: work belongs to people, and "yours" has no referent otherwise.
   */
  account?: { id: string; email: string } | undefined;
  /** What each account is called, for the rows of the activity feed. */
  people?: ReadonlyMap<string, string> | undefined;
  settings: ProjectSettings;
  writable: boolean;
  onOpenPage: (page: ProjectPage) => void;
  onOpenObject: (objectId: string, type: string) => void;
  onQuickCapture: () => void;
  onImportFile: () => void;
  now?: number;
  /** Today, where the person is, for what a due date says. */
  today?: string | undefined;
}

/**
 * The stages a count is worth showing for, and where clicking one goes.
 *
 * Only types the project can actually hold appear; a count of zero for a page that is switched
 * off is noise, and a count of zero for a page that is on is an invitation.
 */
const PROGRESS: ReadonlyArray<{ type: string; page: ProjectPage }> = [
  { type: "source", page: "library" },
  { type: "annotation", page: "reader" },
  { type: "note", page: "notes" },
  { type: "claim", page: "claims" },
  { type: "output", page: "manuscript" },
  { type: "dataset", page: "data" },
  { type: "run", page: "analysis" },
];

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

export function ProjectDashboard({
  workspaceId,
  projectId,
  projectTitle,
  account,
  people,
  settings,
  writable,
  onOpenPage,
  onOpenObject,
  onQuickCapture,
  onImportFile,
  now = Date.now(),
  today,
}: ProjectDashboardProps): React.JSX.Element {
  const [members, setMembers] = useState<DashboardMember[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [waiting, setWaiting] = useState<ThreadRecord[]>([]);
  const [events, setEvents] = useState<RawEvent[]>([]);

  const load = useCallback(async (): Promise<void> => {
    // Everything in the project, not the twelve most recent: the feed needs to know which
    // objects belong here before it can tell which events are about this project.
    const result = await invoke("kiwi.project.members", { project_id: projectId, limit: 500 });
    const data = (result?.data ?? {}) as { objects?: DashboardMember[] };
    setMembers(Array.isArray(data.objects) ? data.objects : []);

    const log = await invoke("kiwi.event.list", { limit: 400 });
    setEvents(((log?.data ?? {})["entries"] ?? []) as RawEvent[]);

    const listed = await invoke("kiwi.project.list", {});
    const projects = ((listed?.data ?? {})["projects"] ?? []) as Array<{
      id: string;
      counts: Record<string, number>;
    }>;
    setCounts(projects.find((entry) => entry.id === projectId)?.counts ?? {});

    const unresolved = await invoke("kiwi.conflict.list", {});
    setConflicts(((unresolved?.data ?? {})["conflicts"] ?? []) as ConflictRecord[]);

    // Open, in this project, and involving the person reading, which is one question the
    // command answers about its caller, not three the dashboard could ask about an account it
    // has no business naming.
    const involving = await invoke("kiwi.thread.list", {
      project_id: projectId,
      status: "open",
      involving_me: true,
    });
    setWaiting(((involving?.data ?? {})["threads"] ?? []) as ThreadRecord[]);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A count for a page nobody turned on is noise: a project that runs no analyses should not
  // be told it has no runs.
  const progress = PROGRESS.filter((entry) => projectPageEnabled(settings, entry.page));
  const feedMembers = useMemo<ReadonlyMap<string, FeedMember>>(
    () =>
      new Map(
        (members ?? []).map((member) => [member.id, { title: member.title, type: member.type }]),
      ),
    [members],
  );
  const attention = useMemo(
    () => attentionRows({ conflicts, threads: waiting, members: feedMembers }),
    [conflicts, waiting, feedMembers],
  );

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <header className="dashboard__heading">
        <h1 id="dashboard-title">{projectTitle}</h1>
        {settings.description === "" ? null : <p>{settings.description}</p>}
        {/* Three, not four. Opening Notes is one click away in the rail, and an action that
            duplicates the rail is an action that makes the rail look optional. */}
        <div className="dashboard__actions">
          <button
            className="dashboard__action dashboard__action--primary"
            type="button"
            disabled={!writable}
            onClick={onImportFile}
          >
            Import a paper
          </button>
          <button
            className="dashboard__action"
            type="button"
            disabled={!writable}
            onClick={onQuickCapture}
          >
            Capture a thought
          </button>
          <button
            className="dashboard__action"
            type="button"
            onClick={() => onOpenPage("manuscript")}
          >
            Open the manuscript
          </button>
        </div>
      </header>

      {/* Plain numbers between two rules. They were five bordered cards, which made counting
          things look like the point of the screen. */}
      <section className="dashboard__progress" aria-label="Where this project stands">
        {progress.map((entry) => (
          <button
            key={entry.type}
            type="button"
            className="dashboard__stat"
            onClick={() => onOpenPage(entry.page)}
          >
            <strong>{counts[entry.type] ?? 0}</strong>
            <span>{objectTypeLabel(entry.type, (counts[entry.type] ?? 0) !== 1)}</span>
          </button>
        ))}
      </section>

      <div className="dashboard__columns">
        {/* Your own work beside the conflicts and the comments, which is the order somebody asks
            in: what am I doing, and then what is in the way of it. Signed out, there is no
            "yours" to answer about, and a panel that said so every time would be furniture. */}
        {account === undefined ? null : (
          <DashboardTasks
            workspaceId={workspaceId}
            projectId={projectId}
            writable={writable}
            today={today}
            onOpenTasks={() => onOpenPage("tasks")}
          />
        )}

        <section className="dashboard__attention-panel" aria-labelledby="dashboard-attention-title">
          <h3 id="dashboard-attention-title">Needs attention</h3>
          {attention.length === 0 ? (
            <p className="dashboard__quiet">{NOTHING_WAITING}</p>
          ) : (
            <ul className="dashboard__attention">
              {attention.map((row) => (
                <li key={`${row.kind}-${row.id}`} data-kind={row.kind}>
                  {/* The row opens the thing that is wrong, not a page listing things that are
                      wrong. Somebody who can see the problem named can act on it from here. */}
                  <button type="button" onClick={() => onOpenObject(row.objectId, row.objectType)}>
                    <strong>{row.title}</strong>
                    <span>{row.what}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <DashboardActivity
        events={events}
        members={feedMembers}
        people={people}
        now={new Date(now)}
        loaded={members !== null}
        onOpenObject={onOpenObject}
        onOpenHistory={() => onOpenPage("history")}
      />
    </section>
  );
}
