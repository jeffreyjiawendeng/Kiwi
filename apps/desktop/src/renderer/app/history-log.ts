/**
 * The project's event log, turned into something somebody can read down.
 *
 * The journal is complete and unreadable: identifiers, event types, ISO timestamps. What a person
 * wants from it is a different thing -- who did what, to what, and when -- and the gap between
 * those two is this module.
 *
 * Two decisions. **Days are the grouping**, because "yesterday" is how somebody remembers when
 * they did something, and a list of forty timestamps is a list nobody scans. **A row names the
 * object it was about**, by title where the title is known, because an identifier is not an
 * answer to "what happened to my paper" -- and where it is not known, the row still appears and
 * says what it can, since an event about something since deleted is still something that happened.
 */

import { objectEventLabel } from "@kiwi/contracts";
import { describeAge } from "./members-roster.js";

export interface RawEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  transaction_id: string;
  object_ids: string[];
  object_type: string | null;
  version: number | null;
  reason: string | null;
}

export interface LogRow {
  id: string;
  /** What was done, in words. */
  action: string;
  /** Who did it, as a person would name them. */
  who: string;
  /** The clock time on the day it happened. */
  at: string;
  /** How long ago, for the most recent ones where that reads better than a date. */
  ago: string;
  /** What it was about, or null when the event names no object. */
  subject: { objectId: string; title: string } | null;
  /** How many other objects the same event touched. */
  alsoTouched: number;
  /** The version this produced, where it produced one, so a row can offer to restore it. */
  version: number | null;
  reason: string | null;
}

export interface LogDay {
  /** The day, as a heading. */
  heading: string;
  rows: LogRow[];
}

/** The part of an account identifier a person would recognise. */
export function shortActor(actor: string): string {
  const tail = actor.startsWith("account:") ? actor.slice("account:".length) : actor;
  return tail === "" ? actor : tail;
}

/**
 * Who an actor is, as the people in the workspace would say it.
 *
 * `people` is what the account service said the members are called, keyed by account id. An
 * actor it does not name -- somebody removed since, or a window that has not heard from the
 * service -- is still shown, by the identifier, because a row with nobody on it says less than a
 * row with an id on it.
 */
export function nameActor(actor: string, people?: ReadonlyMap<string, string>): string {
  const id = shortActor(actor);
  return people?.get(id) ?? people?.get(actor) ?? id;
}

/**
 * What an event was about, by the first of its objects that still has a name.
 *
 * A mark's event names the mark first and the paper second. The library lists papers and not
 * every window lists marks, so a row that insisted on the first id would call every highlight
 * "something no longer here" while the paper it was made on sits in the Library. Only when none
 * of them is known does the row say so, and it says so of the first.
 */
function subjectOf(
  objectIds: readonly string[],
  titles: ReadonlyMap<string, string>,
): LogRow["subject"] {
  const first = objectIds[0];
  if (first === undefined) return null;
  for (const id of objectIds) {
    const title = titles.get(id);
    if (title !== undefined) return { objectId: id, title };
  }
  return { objectId: first, title: "Something no longer here" };
}

function dayKey(at: Date): string {
  return `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

function dayHeading(at: Date, now: Date): string {
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * One event as a row.
 *
 * `titles` is what the library knows right now, which is not everything: an object that was
 * trashed and purged leaves its events behind, and the row for it says so rather than printing a
 * title that no longer exists or dropping the line.
 */
export function readRow(
  event: RawEvent,
  titles: ReadonlyMap<string, string>,
  now: Date,
  people?: ReadonlyMap<string, string>,
): LogRow | null {
  const when = new Date(event.occurred_at);
  if (Number.isNaN(when.valueOf())) return null;
  return {
    id: event.id,
    action: objectEventLabel(event.event_type),
    who: nameActor(event.actor, people),
    at: when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    ago: describeAge(when, now),
    subject: subjectOf(event.object_ids, titles),
    alsoTouched: Math.max(0, event.object_ids.length - 1),
    version: event.version,
    reason: event.reason,
  };
}

/** The rows a page draws, newest day first, newest row first inside each day. */
export function readLog(
  events: readonly RawEvent[],
  titles: ReadonlyMap<string, string>,
  now: Date,
  people?: ReadonlyMap<string, string>,
): LogDay[] {
  const days: LogDay[] = [];
  const byKey = new Map<string, LogDay>();
  for (const event of events) {
    const row = readRow(event, titles, now, people);
    if (row === null) continue;
    const at = new Date(event.occurred_at);
    const key = dayKey(at);
    let day = byKey.get(key);
    if (day === undefined) {
      day = { heading: dayHeading(at, now), rows: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

/**
 * What the page says above the list.
 *
 * The count is said whether or not it was cut, because a page that only mentions a total when it
 * had to leave something out reads as though the number is a warning.
 */
export function describeCount(shown: number, matched: number): string {
  if (matched === 0) return "Nothing has happened here yet that Kiwi recorded.";
  if (shown >= matched)
    return matched === 1 ? "One thing has happened." : `${String(matched)} things have happened.`;
  return `Showing the most recent ${String(shown)} of ${String(matched)}.`;
}
