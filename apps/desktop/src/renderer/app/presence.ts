/**
 * Who else has this document open.
 *
 * Presence is a claim about right now that arrives a few seconds late, so the only safe direction
 * to be wrong in is saying somebody has left when they are still there: the next poll puts them
 * back. Saying somebody is here when they closed the window an hour ago is the mistake that costs
 * something, because it is what somebody waits on before they start typing. So a record with no
 * life left in it is gone, and an answer that did not arrive shows nobody rather than showing the
 * last answer that did.
 */

import { personName } from "./members-roster.js";

/** One row as the co-editing endpoint returns it. */
export interface PresenceRecord {
  /** `account:<user id>`. The roster holds the bare id, so the two are not comparable as they are. */
  actor_id: string;
  sequence: number;
  cursor: number;
  expires_at: string;
}

/** As much of a member as naming them needs. */
export interface PresenceMember {
  user_id: string;
  display_name: string;
  email: string;
}

export interface PresentPerson {
  userId: string;
  name: string;
  initials: string;
  colour: string;
  cursor: number;
  /** Whether the roster knew this person. See `presentPeople`. */
  named: boolean;
}

export type PresenceReading =
  { state: "here"; people: PresentPerson[] } | { state: "unknown"; people: [] };

/**
 * Distinct at a glance and legible with white on them, which rules out yellow. The list is short
 * on purpose: a colour per person stops meaning anything once there are more people than colours,
 * and the name label is what actually identifies somebody.
 */
export const PRESENCE_COLOURS = [
  "#3b6fd4",
  "#159078",
  "#b84a9a",
  "#c05621",
  "#6d5bd0",
  "#0f7b9c",
  "#a33b52",
  "#4a7a2b",
] as const;

/** The endpoint answers with `account:<id>`; everything else in the renderer holds the bare id. */
export function actorUserId(actorId: string): string {
  return actorId.startsWith("account:") ? actorId.slice("account:".length) : actorId;
}

/**
 * The same person is the same colour every time, in every window, without anybody storing a
 * choice. Two people can collide; that is why the name is on the label and not only the colour.
 */
export function presenceColour(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
  return PRESENCE_COLOURS[hash % PRESENCE_COLOURS.length] ?? PRESENCE_COLOURS[0];
}

/** First letters of the first and last word, or the first two characters of a single word. */
export function initialsFrom(name: string): string {
  const words = name
    .split(/[\s@._-]+/u)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  const first = words[0];
  if (first === undefined) return "?";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters =
    last === undefined ? first.slice(0, 2) : `${first.slice(0, 1)}${last.slice(0, 1)}`;
  return letters.toLocaleUpperCase();
}

/**
 * The people the roster and the clock agree are here, without you.
 *
 * Three rules, each of them a way of not lying:
 *
 * - You are dropped. The endpoint records your own presence in the same call it reports everyone
 *   else's, so you are always in the answer, and an avatar of yourself tells you nothing.
 * - A record whose `expires_at` has passed is dropped here as well as at the service. The service
 *   sweeps them, but its answer is already a few seconds old by the time it is read, and the
 *   difference is exactly the window in which somebody who has gone still looks present.
 * - Somebody the roster does not know is still shown, by address, marked `named: false`. They have
 *   the document open; a roster that has not caught up with them is not a reason to hide them.
 */
export function presentPeople(options: {
  records: readonly PresenceRecord[];
  members: readonly PresenceMember[];
  selfUserId: string | null;
  now: Date;
}): PresentPerson[] {
  const byId = new Map(options.members.map((member) => [member.user_id, member]));
  const seen = new Set<string>();
  const people: PresentPerson[] = [];
  for (const record of options.records) {
    const userId = actorUserId(record.actor_id);
    if (userId === "" || userId === options.selfUserId || seen.has(userId)) continue;
    const expires = Date.parse(record.expires_at);
    if (!Number.isFinite(expires) || expires <= options.now.getTime()) continue;
    seen.add(userId);
    const member = byId.get(userId);
    const name =
      member === undefined
        ? "Somebody not on the roster"
        : personName(member.display_name, member.email);
    people.push({
      userId,
      name,
      initials: member === undefined ? "?" : initialsFrom(name),
      colour: presenceColour(userId),
      cursor: record.cursor,
      named: member !== undefined,
    });
  }
  people.sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.userId.localeCompare(right.userId),
  );
  return people;
}

/**
 * An answer that did not arrive is not an answer that nobody is here, and it is not the previous
 * answer either. It is `unknown`, which shows nothing at all: an avatar that has stopped being
 * refreshed is worse than an empty space, because the empty space does not claim anything.
 */
export function readingFrom(
  result: { status: "present"; collaborators: readonly PresenceRecord[] } | { status: string },
  options: { members: readonly PresenceMember[]; selfUserId: string | null; now: Date },
): PresenceReading {
  if (result.status !== "present" || !("collaborators" in result)) {
    return { state: "unknown", people: [] };
  }
  return {
    state: "here",
    people: presentPeople({
      records: result.collaborators,
      members: options.members,
      selfUserId: options.selfUserId,
      now: options.now,
    }),
  };
}

/** For a screen reader, and for the tooltip on a row of avatars. */
export function describePresence(people: readonly PresentPerson[]): string {
  const names = people.map((person) => person.name);
  const first = names[0];
  if (first === undefined) return "Nobody else has this document open.";
  if (names.length === 1) return `${first} also has this document open.`;
  if (names.length === 2) return `${first} and ${names[1] ?? ""} also have this document open.`;
  const listed = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  if (rest <= 0) return `${listed} also have this document open.`;
  return `${listed}, and ${rest} other${rest === 1 ? "" : "s"} also have this document open.`;
}
