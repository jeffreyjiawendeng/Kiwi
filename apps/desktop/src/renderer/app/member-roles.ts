import { anArticle, ROLES, roleLabel } from "./members-roster.js";

/**
 * Changing what somebody may do in this workspace.
 *
 * All of the shaping and none of the sending, so that the wording can be read on its own. The rules
 * here are the service's rules said ahead of time: it is the service that checks a role and refuses,
 * and every one of these is also enforced there. Saying them early is not a substitute for that. It
 * is so that a menu does not offer a choice that can only be answered with a refusal.
 */

/** The roles the service lets change anything about who is here. Everybody else it refuses. */
export const MANAGERS: readonly string[] = ["owner", "admin"];

/**
 * The roles this account may put somebody into, with the role they have now among them.
 *
 * Only an owner may hand out owner: an admin who picks it is refused, and a menu that offers a
 * choice it knows will be refused spends somebody's click on finding that out.
 *
 * What somebody has now is always in the menu even where it could not be assigned -- an admin
 * looking at an owner still has to be shown that they are an owner -- and so is a role this build
 * has never heard of. A newer service that adds one should leave this menu able to say what
 * somebody is, and it is the Save button, held back until the choice changes, that stops that
 * showing from turning into a change.
 */
export function roleOptions(actorRole: string, currentRole: string): string[] {
  const offered: string[] = ROLES.filter((role) => role !== "owner" || actorRole === "owner");
  return offered.includes(currentRole) ? offered : [currentRole, ...offered];
}

/**
 * What to say once a role has been changed.
 *
 * Somebody stepping down from managing is told what they have just given up. It is the one role
 * change that takes away the ability to make role changes, so it is also the one where the next
 * thing they try is the thing they can no longer do.
 */
export function describeRoleChange(name: string, role: string, isSelf: boolean): string {
  const label = roleLabel(role).toLowerCase();
  if (isSelf && !MANAGERS.includes(role))
    return `You are now ${anArticle(label)} ${label} in this workspace, so you can no longer invite people, change roles, or remove anybody here.`;
  return `${name} is now ${anArticle(label)} ${label} in this workspace.`;
}

/**
 * What is about to be given up, where anything is, said before the change rather than after.
 *
 * Only for the reader's own row. Somebody demoting themselves out of owner or admin is doing the
 * one thing on this page they cannot then undo on their own, and it does not look like it: it is
 * the same menu and the same button as changing anybody else.
 */
export function warnSelfChange(isSelf: boolean, role: string): string | null {
  if (!isSelf || MANAGERS.includes(role)) return null;
  return "This gives up your own ability to invite people, change roles, and remove people in this workspace. Only an owner or an admin can give it back.";
}

/**
 * Why a role could not be changed.
 *
 * `last_owner` and `not_found` are the two worth translating, because both are about the workspace
 * having moved since this roster was read rather than about the request being wrong. The service's
 * own words carry the rest: "Only an owner can assign that role" is already the whole answer, and
 * putting it another way would only make it less exact.
 */
export function roleRefusal(code: string, message: string, name: string): string {
  const failed = `${name}'s role was not changed.`;
  if (code === "last_owner")
    return `${failed} A workspace has to keep an owner. Make somebody else an owner first, and then this can change.`;
  if (code === "not_found")
    return `${failed} They are no longer a member of this workspace. Refresh to see who is here now.`;
  if (code === "forbidden") return `${failed} ${message}`;
  return `${failed} The account service said: ${message}`;
}
