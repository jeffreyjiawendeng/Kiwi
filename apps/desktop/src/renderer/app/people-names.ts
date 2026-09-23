import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import { personName } from "./members-roster.js";

/**
 * What each account in a workspace is called, keyed by account id.
 *
 * The event log records who did a thing as an account id, and nothing on disk knows what that
 * person is called: names are the account service's, carried in the roster it last answered
 * with. The person reading is added from their own sign-in, so that a window that has never
 * heard from the service still names its own owner rather than printing them as an identifier.
 */
export function peopleNames(
  snapshot: RendererWorkspaceCollaborationSnapshot | null,
  self: { id: string; email: string } | undefined,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (self !== undefined) names.set(self.id, self.email);
  for (const member of snapshot?.members ?? []) {
    names.set(member.user_id, personName(member.display_name, member.email));
  }
  return names;
}
