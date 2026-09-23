/**
 * Which commands are answered against the open workspace, and which of those only read it.
 *
 * The renderer never holds a path, so a command that works on a workspace arrives without the one
 * argument it cannot do without. This side supplies it, from the session bound to the window that
 * asked. Deciding which commands that applies to used to be an expression inside the IPC handler,
 * where nothing could test it and a namespace could be left out without anything saying so. It was:
 * annotation commands were missing, and every mark made in the Reader failed with a complaint about
 * a property no interface has ever been able to send.
 *
 * Kept as data, so the test beside this file can hold it against the commands that actually exist
 * and fail when a new namespace arrives without being named here.
 */

/** The namespaces whose commands are answered against the open workspace. */
export const WORKSPACE_COMMAND_PREFIXES = [
  "kiwi.annotation.",
  "kiwi.asset.",
  "kiwi.bibliography.",
  "kiwi.claim.",
  "kiwi.conflict.",
  "kiwi.event.",
  "kiwi.note.",
  "kiwi.object.",
  "kiwi.project.",
  "kiwi.projection.",
  "kiwi.protocol.",
  "kiwi.relation.",
  "kiwi.search.",
  "kiwi.task.",
  "kiwi.thread.",
] as const;

/**
 * The commands among them that only read.
 *
 * A read-only workspace is a workspace somebody may still work in: reading a paper, looking at the
 * marks on it, searching. Everything absent from this set needs a workspace that can be written to.
 */
export const READ_ONLY_WORKSPACE_COMMANDS: ReadonlySet<string> = new Set([
  // Listing the marks on a page is reading the page, and it joins the one annotation command that
  // was already here. The rest of the namespace writes.
  "kiwi.annotation.list",
  "kiwi.annotation.locate",
  "kiwi.asset.open-managed",
  "kiwi.asset.reveal-managed",
  "kiwi.bibliography.export",
  "kiwi.bibliography.for-document",
  "kiwi.bibliography.import-preview",
  "kiwi.claim.list",
  "kiwi.conflict.list",
  // What has happened in this workspace, which History and the dashboard both read.
  "kiwi.event.list",
  "kiwi.note.list",
  "kiwi.note.read",
  "kiwi.object.doi-matches",
  "kiwi.object.duplicate-candidates",
  "kiwi.object.history",
  "kiwi.object.list",
  "kiwi.object.organization",
  "kiwi.object.read",
  "kiwi.object.read-version",
  "kiwi.object.reveal",
  "kiwi.object.trash-list",
  "kiwi.object.trash-policy",
  "kiwi.object.validate-restore",
  "kiwi.object.validate-save",
  "kiwi.object.validate-trash",
  "kiwi.object.validate-trash-policy",
  "kiwi.object.validate-trash-purge",
  "kiwi.project.list",
  "kiwi.project.members",
  "kiwi.project.membership",
  "kiwi.projection.links",
  "kiwi.projection.list",
  // Opening a paper on a read-only copy is still something this machine did, and the note it
  // leaves is in the disposable index rather than in the workspace.
  "kiwi.projection.mark-opened",
  "kiwi.projection.relations",
  "kiwi.projection.status",
  "kiwi.protocol.read",
  "kiwi.relation.for-object",
  "kiwi.search.local",
  "kiwi.task.list",
  "kiwi.thread.list",
]);

/** Whether this command is answered against the workspace open in the window that asked. */
export function needsWorkspaceRoot(commandName: string): boolean {
  return WORKSPACE_COMMAND_PREFIXES.some((prefix) => commandName.startsWith(prefix));
}

/** Whether it can be answered by a workspace that may not be written to. */
export function isReadOnlyWorkspaceCommand(commandName: string): boolean {
  return READ_ONLY_WORKSPACE_COMMANDS.has(commandName);
}
