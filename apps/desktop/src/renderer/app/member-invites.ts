import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import { anArticle, personName, roleLabel, ROLE_LABELS, type Role } from "./members-roster.js";

/**
 * Asking somebody to join, and reading the answer that comes back.
 *
 * An invitation is the one thing on this page that reaches a person who is not using Kiwi yet, so
 * what it says has to be true about their side of it and not only about the request. The service
 * does two different things under the one word: an address that already has a Kiwi account is added
 * to the workspace on the spot, and an address that does not gets an email and seven days. Somebody
 * who sends the first and is told "invitation sent" will wait for an acceptance that already
 * happened, so the two are told apart here and named differently.
 *
 * The checks are the ones that can be made honestly from the roster on screen. Inviting somebody who
 * is already a member would quietly change their role, which is a different decision made in a
 * different place, and inviting an address that already has an invitation waiting sends a second
 * email for the same thing.
 */

/**
 * The roles an invitation may carry.
 *
 * Owner is not among them. The service refuses an invitation to owner outright, and it is right to:
 * ownership is handed over on a roster where you can see who holds it now, not offered to an address
 * that may not answer for a week.
 */
export const ASSIGNABLE_ROLES = ["admin", "editor", "commenter", "viewer"] as const;

export type AssignableRole = Exclude<Role, "owner">;

export type InviteCheck = { ok: true; email: string } | { ok: false; problem: string };

// Deliberately lenient. This rules out what cannot be an address at all; it does not try to decide
// which addresses exist, which is a question only the mail server can answer.
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether this address can be invited, and what to say instead when it cannot.
 *
 * The service lowercases and trims before it stores anything, so the same is done here: otherwise
 * "Wei@Example.org" would pass a check against a roster that holds "wei@example.org" and then be
 * matched by the service anyway.
 */
export function checkInvite(
  snapshot: RendererWorkspaceCollaborationSnapshot,
  typed: string,
): InviteCheck {
  const email = typed.trim().toLowerCase();
  if (email === "") return { ok: false, problem: "Enter the email address to invite." };
  if (!ADDRESS.test(email))
    return {
      ok: false,
      problem:
        "That is not an email address. An invitation goes to an address like wei@example.org.",
    };

  const member = snapshot.members.find((entry) => entry.email.toLowerCase() === email);
  if (member !== undefined) {
    // The service's own word for the role where this build does not know it, rather than nothing.
    const role = roleLabel(member.role).toLowerCase();
    return {
      ok: false,
      problem: `${personName(member.display_name, member.email)} is already ${anArticle(member.role)} ${role} here. Change their role on the roster rather than inviting them again.`,
    };
  }

  // Only an invitation still outstanding is in the way. One that was revoked or ran out is a reason
  // to send another, not a reason to refuse.
  const waiting = snapshot.invitations.some(
    (invitation) => invitation.status === "pending" && invitation.email.toLowerCase() === email,
  );
  if (waiting)
    return {
      ok: false,
      problem: `${email} already has an invitation waiting. Revoke it first if you want to invite them as something else.`,
    };

  return { ok: true, email };
}

/**
 * What the service actually did, read off the settings it returned.
 *
 * The snapshot that comes back from an invitation is the workspace as it now stands, which is enough
 * to tell the two outcomes apart: a new member means the address already had an account, and a
 * pending invitation means an email has gone out and nobody has joined yet.
 */
export function describeInviteOutcome(
  snapshot: RendererWorkspaceCollaborationSnapshot,
  email: string,
  role: AssignableRole,
): string {
  const named = ROLE_LABELS[role].toLowerCase();
  const member = snapshot.members.find((entry) => entry.email.toLowerCase() === email);
  if (member !== undefined)
    return `${personName(member.display_name, member.email)} is now ${anArticle(role)} ${named} in this workspace. That address already had a Kiwi account, so there was nothing for them to accept.`;

  const waiting = snapshot.invitations.some(
    (invitation) => invitation.status === "pending" && invitation.email.toLowerCase() === email,
  );
  if (waiting)
    return `Invited ${email} as ${anArticle(role)} ${named}. Kiwi has queued an email to that address, and the invitation lasts seven days.`;

  return `The account service accepted the invitation for ${email}.`;
}

/**
 * What to say once an invitation has been taken back.
 *
 * Worth saying that the address can be invited again. Revoking is the thing somebody does when they
 * sent the wrong role or the wrong address, and the next question is always whether they have now
 * shut themselves out of fixing it.
 */
export function describeRevoked(email: string): string {
  return `The invitation to ${email} has been revoked. It can no longer be accepted, and that address can be invited again.`;
}

/**
 * Why an invitation could not be taken back.
 *
 * `not_found` is the one worth translating. The service only revokes an invitation that is still
 * pending, and it sweeps the ones that have run out into `expired` on the way past, so this is the
 * answer whenever the invitation was accepted or lapsed between the reading on screen and the
 * click. Said in the service's own words -- "That pending invitation was not found" -- it sounds
 * like a fault; it is nearly always somebody having joined a moment ago.
 */
export function revokeRefusal(code: string, message: string, email: string): string {
  if (code === "not_found")
    return `The invitation to ${email} is no longer waiting. It was either accepted or it ran out. Refresh to see where it stands.`;
  if (code === "forbidden")
    return `${email} was not un-invited. Only an owner or an admin can revoke an invitation.`;
  return `${email} was not un-invited. The account service said: ${message}`;
}
