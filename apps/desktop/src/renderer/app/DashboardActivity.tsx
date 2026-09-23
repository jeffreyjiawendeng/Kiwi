import { useMemo } from "react";
import { projectFeed, type FeedMember } from "./dashboard-activity.js";
import { readRow, type RawEvent } from "./history-log.js";

const SHOWN = 8;

/**
 * What has been happening in this project, on the Dashboard.
 *
 * Short on purpose. The Dashboard answers "what is going on here" at a glance, and a panel that
 * showed forty lines would be the History page in a smaller box. Eight rows and a way through to
 * the whole log is the right shape: enough to notice something, not enough to read instead of
 * working.
 *
 * The two filter menus are gone. Narrowing a feed is what the History page is for, and it has
 * both of them; a pair of select boxes over eight rows was a control for a problem eight rows
 * cannot have.
 */
export function DashboardActivity({
  events,
  members,
  people,
  now,
  loaded = true,
  onOpenObject,
  onOpenHistory,
}: {
  events: readonly RawEvent[];
  members: ReadonlyMap<string, FeedMember>;
  /** What each account is called, so a row says who rather than which identifier. */
  people?: ReadonlyMap<string, string> | undefined;
  now: Date;
  /** False while the project is still being read, so an empty feed is not called an empty project. */
  loaded?: boolean;
  onOpenObject: (objectId: string, type: string) => void;
  onOpenHistory: () => void;
}): React.JSX.Element {
  const feed = useMemo(() => projectFeed(events, members, SHOWN), [events, members]);
  const titles = useMemo(
    () => new Map([...members].map(([id, member]) => [id, member.title])),
    [members],
  );

  return (
    <section className="dashboard__feed-panel" aria-labelledby="dashboard-activity-title">
      <div className="dashboard__feed-header">
        <h3 id="dashboard-activity-title">Recent activity</h3>
        {/* The rest of the log is a page, not a longer panel. */}
        <button type="button" className="dashboard__feed-more" onClick={onOpenHistory}>
          History →
        </button>
      </div>

      {feed.events.length === 0 ? (
        <p className="dashboard__quiet">
          {loaded ? "Nothing has happened in this project yet." : "Reading the project"}
        </p>
      ) : (
        <ul className="dashboard__feed">
          {feed.events.map((event) => {
            const row = readRow(event, titles, now, people);
            if (row === null || row.subject === null) return null;
            const kind = members.get(row.subject.objectId)?.type ?? "";
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onOpenObject(row.subject?.objectId ?? "", kind)}
                >
                  <span className="dashboard__feed-title">{row.subject.title}</span>
                  <span className="dashboard__feed-action">
                    {row.action} · {row.who}
                  </span>
                  <span className="dashboard__feed-ago">{row.ago}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
