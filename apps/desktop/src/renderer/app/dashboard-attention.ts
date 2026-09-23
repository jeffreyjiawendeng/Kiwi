/**
 * What is wrong in this project, as rows rather than as a number.
 *
 * "3 unresolved conflicts" tells somebody there is a problem and nothing about which problem. It
 * is a count of things they cannot act on without going to find them first, which is the part
 * that does not happen. A row names the object, says what is wrong with it in one clause, and
 * opens it.
 *
 * Only what is in this project. The Dashboard is a project's screen, and a conflict in another
 * project of the same workspace is somebody else's afternoon.
 */

export interface AttentionRow {
  id: string;
  kind: "conflict" | "comment";
  objectId: string;
  objectType: string;
  title: string;
  /** What is wrong, in one clause. */
  what: string;
}

export interface AttentionMember {
  title: string;
  type: string;
}

export interface ConflictRecord {
  id: string;
  object_id: string;
  status: string;
}

export interface ThreadRecord {
  id: string;
  title: string;
  thread?: { anchor?: { object_id?: string } } | undefined;
}

export function attentionRows(input: {
  conflicts: readonly ConflictRecord[];
  threads: readonly ThreadRecord[];
  members: ReadonlyMap<string, AttentionMember>;
}): AttentionRow[] {
  const rows: AttentionRow[] = [];
  // A conflict is above a comment because it is two versions of the work, not a question about
  // it: one is waiting on a decision, the other on a reply.
  for (const conflict of input.conflicts) {
    if (conflict.status !== "unresolved") continue;
    const member = input.members.get(conflict.object_id);
    if (member === undefined) continue;
    rows.push({
      id: conflict.id,
      kind: "conflict",
      objectId: conflict.object_id,
      objectType: member.type,
      title: member.title,
      what: "Two versions of this. Choose which one stands.",
    });
  }
  for (const thread of input.threads) {
    const objectId = thread.thread?.anchor?.object_id ?? "";
    const member = input.members.get(objectId);
    if (member === undefined) continue;
    rows.push({
      id: thread.id,
      kind: "comment",
      objectId,
      objectType: member.type,
      title: member.title,
      what: "A comment here is waiting on you.",
    });
  }
  return rows;
}

/**
 * The panel when there is nothing in it.
 *
 * Said rather than left blank, because a panel that disappears when it is empty is a panel whose
 * silence cannot be told from its absence.
 *
 * There used to be a summary sentence above the rows as well -- "1 conflict and 2 comments
 * waiting on you" over a list of those three things. Counting what is already on screen is the
 * one thing a reader can do faster than a program.
 */
export const NOTHING_WAITING = "Nothing is waiting on you.";
