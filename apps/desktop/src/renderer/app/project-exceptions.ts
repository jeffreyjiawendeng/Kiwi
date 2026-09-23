import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import { anArticle, personName, ROLES, roleLabel } from "./members-roster.js";

/**
 * Where one person's access on one project is not their access in the workspace.
 *
 * A workspace role is the answer almost everywhere, and the exceptions to it are few and worth
 * reading one by one. So this is a list of the exceptions and not a grid of everybody against
 * everything: a grid of five people and four projects is twenty menus, nineteen of which say the
 * same thing as the roster, and the one that does not is the one nobody finds.
 *
 * An exception is a project role that differs from the workspace role. A recorded role that matches
 * is not an exception and is not listed -- it grants exactly what the roster already says, and
 * putting it in the list would bury the real ones among rows that say nothing.
 */

/** A project as the service holds it, carried because changing an exception has to resend it. */
export interface ProjectPolicy {
  id: string;
  name: string;
  /**
   * The service takes a project's policy and one person's exception in the same call, so both of
   * these go back exactly as they were read. That is also why nothing here may be sent from a
   * stale reading: a policy resent from an old reading would quietly undo a newer one.
   */
  sensitivity: string;
  reviewRequired: boolean;
}

export interface ProjectException {
  userId: string;
  name: string;
  /** What they are in the workspace, which is what the exception is an exception to. */
  workspaceRole: string;
  projectRole: string;
  /** Whether the project role is above the workspace role, which the service no longer allows. */
  widens: boolean;
}

export interface ExceptionGroup {
  project: ProjectPolicy;
  people: ProjectException[];
}

/**
 * How much a role may do, by where it sits in the list.
 *
 * A role this build has never heard of has no place in that order, and guessing one is how a menu
 * ends up offering a choice the service refuses. Unknown ranks as nothing, and everything that
 * reads a rank says what it does when there is none.
 */
function rank(role: string): number | null {
  const at = (ROLES as readonly string[]).indexOf(role);
  return at === -1 ? null : ROLES.length - at;
}

export function projectPolicies(snapshot: RendererWorkspaceCollaborationSnapshot): ProjectPolicy[] {
  return snapshot.projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      sensitivity: project.sensitivity,
      reviewRequired: project.review_required,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/**
 * The exceptions, under the project they are on.
 *
 * Grouped by project because that is the question being asked: not "what does Wei have everywhere",
 * which the roster answers, but "who is not on the usual footing here". A project with no
 * exceptions is not in this list at all; it has nothing to say.
 */
export function exceptionsFrom(snapshot: RendererWorkspaceCollaborationSnapshot): ExceptionGroup[] {
  const groups: ExceptionGroup[] = [];
  for (const project of projectPolicies(snapshot)) {
    const source = snapshot.projects.find((entry) => entry.id === project.id);
    if (source === undefined) continue;
    const people = source.member_overrides
      .filter((override) => override.project_role !== override.workspace_role)
      .map((override) => {
        const member = snapshot.members.find((entry) => entry.user_id === override.user_id);
        const workspace = rank(override.workspace_role);
        const projectRank = rank(override.project_role);
        return {
          userId: override.user_id,
          name:
            member === undefined
              ? personName(override.display_name, override.user_id)
              : personName(member.display_name, member.email),
          workspaceRole: override.workspace_role,
          projectRole: override.project_role,
          widens: workspace !== null && projectRank !== null && projectRank > workspace,
        };
      })
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
    if (people.length > 0) groups.push({ project, people });
  }
  return groups;
}

/**
 * The roles that are less than the one somebody holds in the workspace.
 *
 * All an exception can do. The service refuses a project role above the workspace role, so a menu
 * that offered one would spend somebody's click on being told no. A viewer has nothing below them
 * and so cannot be given an exception at all, which is worth saying rather than showing an empty
 * menu.
 */
export function lesserRoles(workspaceRole: string): string[] {
  const held = rank(workspaceRole);
  if (held === null) return [];
  return ROLES.filter((role) => {
    const value = rank(role);
    return value !== null && value < held;
  });
}

/**
 * What one exception can be changed to, with the workspace role at the top of it.
 *
 * Choosing the workspace role is how an exception is ended: it puts the person back on the footing
 * the roster says they are on, which is what ending it means. What is recorded now is always in the
 * menu even where it could not be chosen again, so that a role set before the workspace role
 * changed can still be read off the control that would change it.
 */
export function exceptionRoleOptions(workspaceRole: string, projectRole: string): string[] {
  const offered = [workspaceRole, ...lesserRoles(workspaceRole)];
  return offered.includes(projectRole) ? offered : [...offered, projectRole];
}

/** Whether an exception can be made for somebody at all. Not for a viewer: nothing is below it. */
export function canBeExcepted(workspaceRole: string): boolean {
  return lesserRoles(workspaceRole).length > 0;
}

export interface ExceptionCandidate {
  userId: string;
  name: string;
  workspaceRole: string;
}

/**
 * Who could be given an exception on this project.
 *
 * Somebody who already has one is left out: the row in the list above is where it is changed, and
 * two ways to set the same thing is how the two disagree.
 */
export function candidateMembers(
  snapshot: RendererWorkspaceCollaborationSnapshot,
  projectId: string,
): ExceptionCandidate[] {
  const project = snapshot.projects.find((entry) => entry.id === projectId);
  const taken = new Set(
    (project?.member_overrides ?? [])
      .filter((override) => override.project_role !== override.workspace_role)
      .map((override) => override.user_id),
  );
  return snapshot.members
    .filter((member) => canBeExcepted(member.role) && !taken.has(member.user_id))
    .map((member) => ({
      userId: member.user_id,
      name: personName(member.display_name, member.email),
      workspaceRole: member.role,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/** What one exception says, in the row it is on. The project is the heading above it. */
export function describeException(exception: ProjectException): string {
  const here = roleLabel(exception.projectRole);
  const elsewhere = roleLabel(exception.workspaceRole).toLowerCase();
  return `${here} on this project, and ${anArticle(elsewhere)} ${elsewhere} everywhere else in this workspace.`;
}

/**
 * Why a recorded role that is above the workspace role is still on the list.
 *
 * It could not be set today. It is here because it was set when the person held a higher role in
 * the workspace and was left behind when that changed, so the honest thing is to show it and say
 * that it is stranded rather than quietly leave it out of a list of exceptions.
 */
export function warnWidened(name: string): string {
  return `This is more than ${name} has in the rest of the workspace. It was recorded before their workspace role changed and cannot be set again. Choose a role at or below their workspace role to put it right.`;
}

export function describeExceptionSet(name: string, project: string, role: string): string {
  const label = roleLabel(role).toLowerCase();
  return `${name} is ${anArticle(label)} ${label} on ${project}, and keeps their workspace role everywhere else.`;
}

export function describeExceptionLifted(name: string, project: string, role: string): string {
  const label = roleLabel(role).toLowerCase();
  return `${name} is back to their workspace role on ${project}, so they are ${anArticle(label)} ${label} there like everywhere else.`;
}

/**
 * Why an exception could not be set.
 *
 * The service's own words for a role that is too high are already the whole answer, so they are
 * passed on. What is worth saying differently is a project that is not there any more: like a
 * missing member on the roster, it means this reading is behind the workspace rather than that the
 * request was wrong.
 */
export function exceptionRefusal(
  code: string,
  message: string,
  name: string,
  project: string,
): string {
  const failed = `${name}'s access on ${project} was not changed.`;
  if (code === "not_found")
    return `${failed} That project is no longer in this workspace. Refresh to see what is here now.`;
  if (code === "forbidden") return `${failed} ${message}`;
  if (code === "invalid_input")
    return `${failed} The account service would not accept the settings sent with it. Refresh and try again.`;
  return `${failed} The account service said: ${message}`;
}
