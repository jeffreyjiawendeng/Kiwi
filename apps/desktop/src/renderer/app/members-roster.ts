import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";

/**
 * Who is in this workspace, and what their role is.
 *
 * The roster is the account service's answer, not the workspace's. A workspace on disk knows the
 * names it has seen in its own history; it does not know who has been invited, who was removed
 * last week, or who is an admin. So an older answer is the best there is when the service cannot
 * be reached, and everything here shapes one without caring how old it is -- saying so is the
 * page's job, and `describeAge` is what it says it with.
 *
 * The order is by authority and then by name. A roster is read to find out who can do a thing,
 * which makes "the two owners, then the four admins" the order somebody scans in; alphabetical
 * would scatter the answer through the list.
 */

export const ROLES = ["owner", "admin", "editor", "commenter", "viewer"] as const;

export type Role = (typeof ROLES)[number];

/**
 * How much a role may do, as the service ranks it.
 *
 * The same order the service uses to refuse a project role that would give somebody more on one
 * project than they have on the workspace. A role this build has never heard of ranks below all
 * of them rather than being dropped: a newer service that adds one should show the person it
 * belongs to, named by whatever it called them.
 */
const AUTHORITY: Readonly<Record<Role, number>> = {
  owner: 5,
  admin: 4,
  editor: 3,
  commenter: 2,
  viewer: 1,
};

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

/** What each role means, in the words the rest of this page and its menus use. */
export const ROLE_POWERS: Readonly<Record<Role, string>> = {
  owner: "Runs the workspace. Cannot be removed while they are the only one.",
  admin: "Invites people, changes roles, and removes people.",
  editor: "Writes and edits everything in the workspace.",
  commenter: "Reads everything and can comment on it.",
  viewer: "Reads everything.",
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The role's name where we know it, and the service's own word where we do not. */
export function roleLabel(value: string): string {
  return isRole(value) ? ROLE_LABELS[value] : value;
}

export interface RosterPerson {
  /** The account id. What an invitation, a role change, and a removal all address. */
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** The role as the service said it, which is what any change to it has to be sent back as. */
  role: string;
  /** Whether this is the person reading. Worth marking: it is the row they will look for first. */
  isSelf: boolean;
}

export function personName(displayName: string, email: string): string {
  // Somebody who has not filled in a name is still somebody with access, and the address is the
  // only thing about them that is certainly true.
  const trimmed = displayName.trim();
  return trimmed === "" ? email : trimmed;
}

/** "an admin", "an editor", "a viewer" -- small, and wrong every time it is not done. */
export function anArticle(role: string): string {
  return /^[aeiou]/i.test(role) ? "an" : "a";
}

export function rosterFrom(
  snapshot: RendererWorkspaceCollaborationSnapshot,
  accountId: string | null,
): RosterPerson[] {
  const people = snapshot.members.map((member) => ({
    id: member.user_id,
    name: personName(member.display_name, member.email),
    email: member.email,
    phone: member.phone,
    role: member.role,
    isSelf: member.user_id === accountId,
  }));
  people.sort(
    (left, right) =>
      rank(right.role) - rank(left.role) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.email.localeCompare(right.email),
  );
  return people;
}

function rank(value: string): number {
  return isRole(value) ? AUTHORITY[value] : 0;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  /** Whether the seven days ran out. An expired invitation explains an absence; it is not a plan. */
  expired: boolean;
  /** How long is left, in the words a person would use. Empty where the date made no sense. */
  expiry: string;
}

const DAY = 24 * 60 * 60 * 1_000;

/**
 * The invitations still worth showing: the ones outstanding, and the ones that ran out.
 *
 * An accepted invitation is a member, and listing it here as well would count one person twice --
 * the reader would see six rows for five people and have no way to tell which. A revoked one is a
 * decision somebody already made and does not need to keep seeing. An expired one stays, because
 * it is the answer to "I invited them, where are they".
 */
export function pendingInvitations(
  snapshot: RendererWorkspaceCollaborationSnapshot,
  now: Date,
): PendingInvitation[] {
  const open = snapshot.invitations.filter(
    (invitation) => invitation.status === "pending" || invitation.status === "expired",
  );
  const rows = open.map((invitation) => {
    const runsOut = Date.parse(invitation.expires_at);
    const expired =
      invitation.status === "expired" || (!Number.isNaN(runsOut) && runsOut <= now.getTime());
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expired,
      expiry: Number.isNaN(runsOut) ? "" : describeExpiry(runsOut - now.getTime(), expired),
    };
  });
  // Outstanding first, since those are the ones something might still come of, and then by
  // address so that a second look at the page finds the same row in the same place.
  rows.sort(
    (left, right) =>
      Number(left.expired) - Number(right.expired) || left.email.localeCompare(right.email),
  );
  return rows;
}

/**
 * How long ago the roster on screen was answered, in the words somebody would use.
 *
 * Anything shown from memory has to carry this. A roster with no date on it is a roster that
 * passes for current, and the difference matters: somebody removed an hour ago is still on it.
 */
export function describeAge(at: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "a moment ago";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${String(minutes)} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${String(hours)} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
}

function describeExpiry(remaining: number, expired: boolean): string {
  if (expired) return "Expired";
  const days = Math.floor(remaining / DAY);
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${String(days)} days`;
}
