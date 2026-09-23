import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import {
  forgetCollaborationSnapshots,
  useCollaborationSnapshot,
} from "./collaboration-snapshot.js";

/**
 * Who a task can be given to.
 *
 * The list is the workspace's people when the account service answers, and the signed-in person
 * when it does not. It is never empty and never pending: there is always somebody to assign work
 * to, because there is always you. A solo project has one possible assignee and should never see
 * a spinner about it.
 *
 * Nothing here blocks a write. A menu that fills in a moment later is a menu that grew; a menu
 * that will not open until a server answers is a task that did not get written down.
 */

export interface Assignee {
  /**
   * The string a task stores, and the one `kiwi.task.list` compares against for `mine`.
   *
   * The main process signs every command as `account:<id>`, so an assignee written any other way
   * would be a person the Dashboard could never find their own work under.
   */
  id: string;
  name: string;
  email: string;
  /** Their part in the workspace, or null offline, where only the signed-in person is known. */
  role: string | null;
  /** Whether this is the person reading. Worth marking: it is the common assignment. */
  isSelf: boolean;
}

/** How far the list reaches: everybody in the workspace, or only the person at this machine. */
export type AssigneeReach = "self" | "workspace";

/** The id a task carries for an account. */
export function assigneeId(accountId: string): string {
  return `account:${accountId}`;
}

function named(displayName: string, email: string): string {
  // An account that has not filled in a name is still a person somebody has to pick out of a
  // menu, and the address is the only thing we can say about them that is true.
  const trimmed = displayName.trim();
  return trimmed === "" ? email : trimmed;
}

/**
 * The signed-in person, and everyone else the workspace knows about.
 *
 * The member whose account matches the reader is the same person as the reader, merged rather
 * than listed twice -- with the name and role from the snapshot, which are better than anything
 * this machine holds on its own.
 *
 * The list is workspace-wide even on a project board. The account service keeps its own register
 * of projects, created in Workspace settings, and its ids are not the ids of the project objects
 * in the workspace; joining the two here would be a guess, and a guess would quietly drop people
 * off the menu.
 */
export function assigneesFrom(
  account: { id: string; email: string },
  snapshot: RendererWorkspaceCollaborationSnapshot | null,
): Assignee[] {
  const self: Assignee = {
    id: assigneeId(account.id),
    name: account.email,
    email: account.email,
    role: null,
    isSelf: true,
  };
  const others: Assignee[] = [];
  for (const member of snapshot?.members ?? []) {
    const entry: Assignee = {
      id: assigneeId(member.user_id),
      name: named(member.display_name, member.email),
      email: member.email,
      role: member.role,
      isSelf: member.user_id === account.id,
    };
    if (entry.isSelf) {
      self.name = entry.name;
      self.email = entry.email;
      self.role = entry.role;
    } else others.push(entry);
  }
  // You first, because assigning work to yourself is what most of it is, and then by name so
  // that a menu of fifteen people is somewhere you can look rather than somewhere you search.
  // Two people called Wei are told apart by the address, which is why it is the tiebreak.
  others.sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.email.localeCompare(right.email),
  );
  return [self, ...others];
}

/**
 * Forgets what the workspaces answered. For tests, and for signing out.
 *
 * The answers themselves are held in `collaboration-snapshot.ts`, because the Members page is
 * reading the same thing and the second surface to ask should open with everybody already in it.
 * Without that, moving from the board to the table would replay the same one-name-then-many
 * flicker every time, which reads as the list changing rather than as it arriving.
 */
export function forgetAssignees(): void {
  forgetCollaborationSnapshots();
}

export function useAssignees(input: {
  workspaceId: string;
  account: { id: string; email: string };
}): { assignees: Assignee[]; reach: AssigneeReach } {
  const settings = useCollaborationSnapshot(input.workspaceId);
  return {
    assignees: assigneesFrom(input.account, settings),
    reach: settings === null ? "self" : "workspace",
  };
}
