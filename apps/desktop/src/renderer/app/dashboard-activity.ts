/**
 * What has been happening in this project, for the Dashboard.
 *
 * The event log is a workspace-wide thing and this panel is about one project, so the log is
 * narrowed here rather than in the command. A project is a set of objects, not a field on an
 * event: what makes an event belong to this project is that it touched something filed in it, and
 * only the caller that has just listed the project's members knows which objects those are.
 *
 * That has a consequence worth stating. An event about an object that has since been unfiled, or
 * about the project object itself, is not in the feed, the feed answers "what happened to the
 * work in this project", and the History page is where the whole log is.
 */

import type { RawEvent } from "./history-log.js";

export interface FeedMember {
  title: string;
  type: string;
}

export interface ProjectFeed {
  events: RawEvent[];
  /** How many belong to this project, before the list was cut. */
  matched: number;
}

/** Whether an event touched anything filed in this project. */
function touchesProject(event: RawEvent, members: ReadonlyMap<string, FeedMember>): boolean {
  return event.object_ids.some((id) => members.has(id));
}

/**
 * The project's events, newest first, cut to what the panel shows.
 *
 * It used to build two filter menus as well, and narrow by them. Narrowing a log is what the
 * History page is for, and it has both filters; on a panel of eight rows a pair of select boxes
 * was a control for a problem eight rows cannot have. `matched` stays, because the panel still
 * has to know whether it is showing all of them.
 */
export function projectFeed(
  events: readonly RawEvent[],
  members: ReadonlyMap<string, FeedMember>,
  limit: number,
): ProjectFeed {
  const mine = events.filter((event) => touchesProject(event, members));
  return { events: mine.slice(0, Math.max(0, limit)), matched: mine.length };
}
