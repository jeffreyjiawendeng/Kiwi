import { join } from "node:path";
import {
  mergeThreadMessages,
  readThread,
  validateThread,
  withThreadMessages,
  type StructuredSyncChange,
  type StructuredSyncProposal,
  type ThreadBody,
} from "@kiwi/contracts";
import { canonicalJson, prettyJson } from "./canonical-json.js";
import {
  commitCanonical,
  withCanonicalWrite,
  type CanonicalEvent,
} from "./canonical-transaction.js";
import {
  canonicalObjectPath,
  readCanonicalObject,
  threadObject,
  verifyObjectHash,
  type CanonicalObject,
} from "./objects.js";

export interface ApplyStructuredChangeInput {
  root: string;
  workspaceId: string;
  change: StructuredSyncChange;
  actor: string;
  requestId: string;
  now: string;
  newId(): string;
}

export type ApplyStructuredChangeResult =
  | { status: "applied"; object: CanonicalObject }
  | { status: "merged"; object: CanonicalObject }
  | { status: "no_change"; object: CanonicalObject }
  | { status: "conflict"; conflict_id: string; path: string };

function canonicalObject(value: StructuredSyncProposal["snapshot"]): CanonicalObject | null {
  const candidate = value as Partial<CanonicalObject>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.type !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.content !== "string" ||
    typeof candidate.version !== "number" ||
    typeof candidate.content_hash !== "string"
  )
    return null;
  return verifyObjectHash(candidate as CanonicalObject) ? (candidate as CanonicalObject) : null;
}

/**
 * Which of two copies of one object was written last.
 *
 * The tie-break on the account is arbitrary. What matters is that two machines given the same
 * pair break the tie the same way, and so settle on the same thread.
 */
function wroteLast(candidate: CanonicalObject, other: CanonicalObject): boolean {
  if (candidate.updated_at !== other.updated_at) return candidate.updated_at > other.updated_at;
  return candidate.updated_by > other.updated_by;
}

/**
 * Two copies of one thread, reconciled instead of conflicted.
 *
 * Last-writer-wins would drop a reply: whichever machine synced second would erase what the other
 * wrote while it was offline, and neither person would be told. The messages are unioned by id
 * instead. That is safe precisely because nobody can edit anybody else's message, so two copies
 * of one id are one person's message before and after their own edit, never two people's words.
 *
 * Everything else stays last-writer-wins, which is right for what it covers: resolving a thread
 * twice is resolving it, and an anchor points at one passage or at another, never at both.
 *
 * Returns null when either side is not a readable thread, or when the result would fail
 * validation, so that a replica sending nonsense raises a conflict rather than writing it.
 */
function mergedThread(mine: CanonicalObject, theirs: CanonicalObject): ThreadBody | null {
  if (mine.type !== "thread" || theirs.type !== "thread") return null;
  const ours = readThread(mine["thread"]);
  const yours = readThread(theirs["thread"]);
  if (ours === null || yours === null) return null;
  const settled = wroteLast(theirs, mine) ? yours : ours;
  const merged = withThreadMessages(settled, mergeThreadMessages(ours.messages, yours.messages));
  return validateThread(merged).length === 0 ? merged : null;
}

function checkpointPath(id: string, version: number): string {
  return join(".kiwi", "checkpoints", id, `${String(version).padStart(8, "0")}.json`);
}

export async function applyStructuredSyncChange(
  input: ApplyStructuredChangeInput,
): Promise<ApplyStructuredChangeResult> {
  return withCanonicalWrite(input.root, async () => {
    const object = canonicalObject(input.change.proposed.snapshot);
    if (
      object === null ||
      object.id !== input.change.object_id ||
      object.version !== input.change.proposed.version ||
      object.content_hash !== input.change.proposed.content_hash
    ) {
      throw new Error("The synchronized object failed canonical verification.");
    }
    const current = await readCanonicalObject(input.root, object.id);
    if (
      current !== null &&
      current.object.version === object.version &&
      current.object.content_hash === object.content_hash
    ) {
      return { status: "no_change", object: current.object };
    }
    const matchesBase =
      current === null
        ? input.change.base_version === 0 && input.change.base_hash === null
        : current.object.version === input.change.base_version &&
          current.object.content_hash === input.change.base_hash;
    const transactionId = input.newId();
    const preparedEventId = input.newId();
    const domainEventId = input.newId();
    const committedEventId = input.newId();
    // A thread is the one object where a divergence is not something to put in front of a person:
    // two people replying while offline both meant what they wrote, and there is nothing for
    // either of them to choose between.
    const merged = matchesBase || current === null ? null : mergedThread(current.object, object);
    if (current !== null && merged !== null) {
      const before = readThread(current.object["thread"]);
      // Nothing came back that we did not already hold. Sync runs in both directions, so this is
      // the ordinary end of an exchange rather than a rare case: without it two machines would
      // merge each other's merges without ever stopping.
      if (before !== null && canonicalJson(before) === canonicalJson(merged)) {
        return { status: "no_change", object: current.object };
      }
      const next = threadObject(
        {
          threadId: object.id,
          actor: input.actor,
          now: input.now,
          transactionId,
          preparedEventId,
          domainEventId,
          committedEventId,
        },
        merged,
        current.object,
      );
      const event: CanonicalEvent = {
        id: domainEventId,
        workspace_id: input.workspaceId,
        transaction_id: transactionId,
        schema_version: "1.0.0",
        event_type: "sync.thread.merged",
        occurred_at: input.now,
        recorded_at: input.now,
        actor: input.actor,
        origin: "sync",
        request_id: input.requestId,
        object_ids: [next.id],
        prior_version: current.object.version,
        new_version: next.version,
        prior_hash: current.object.content_hash,
        new_hash: next.content_hash,
        remote_sequence: input.change.sequence,
        remote_actor: input.change.actor_id,
      };
      const merge = prettyJson(next);
      const nextPath = canonicalObjectPath(next);
      await commitCanonical({
        root: input.root,
        workspaceId: input.workspaceId,
        transactionId,
        now: input.now,
        actor: input.actor,
        origin: "sync",
        requestId: input.requestId,
        preparedEventId,
        committedEventId,
        domainEvents: [event],
        targets: [
          // The other machine may have edited the opening message, which retitles the thread and
          // so moves its file.
          ...(nextPath === current.relativePath
            ? [{ relativePath: current.relativePath, after: merge }]
            : [
                { relativePath: nextPath, after: merge },
                { relativePath: current.relativePath, after: null },
              ]),
          { relativePath: checkpointPath(next.id, next.version), after: merge },
        ],
      });
      return { status: "merged", object: next };
    }

    if (!matchesBase) {
      const conflictId = input.newId();
      const relativePath = join(".kiwi", "conflicts", `${conflictId}.json`);
      const conflict = {
        $schema: "https://kiwi-research.org/schemas/conflict/structured-object/1-0-0.json",
        id: conflictId,
        workspace_id: input.workspaceId,
        object_id: object.id,
        status: "unresolved",
        detected_at: input.now,
        base: { version: input.change.base_version, content_hash: input.change.base_hash },
        mine: current?.object ?? null,
        theirs: object,
        remote_sequence: input.change.sequence,
        remote_actor: input.change.actor_id,
      };
      const event: CanonicalEvent = {
        id: domainEventId,
        workspace_id: input.workspaceId,
        transaction_id: transactionId,
        schema_version: "1.0.0",
        event_type: "sync.conflict.detected",
        occurred_at: input.now,
        recorded_at: input.now,
        actor: input.actor,
        origin: "sync",
        request_id: input.requestId,
        object_ids: [object.id],
        conflict_ids: [conflictId],
        remote_sequence: input.change.sequence,
      };
      await commitCanonical({
        root: input.root,
        workspaceId: input.workspaceId,
        transactionId,
        now: input.now,
        actor: input.actor,
        origin: "sync",
        requestId: input.requestId,
        preparedEventId,
        committedEventId,
        domainEvents: [event],
        targets: [{ relativePath, after: prettyJson(conflict) }],
      });
      return { status: "conflict", conflict_id: conflictId, path: relativePath };
    }

    const serialized = prettyJson(object);
    const event: CanonicalEvent = {
      id: domainEventId,
      workspace_id: input.workspaceId,
      transaction_id: transactionId,
      schema_version: "1.0.0",
      event_type: "sync.object.applied",
      occurred_at: input.now,
      recorded_at: input.now,
      actor: input.actor,
      origin: "sync",
      request_id: input.requestId,
      object_ids: [object.id],
      new_version: object.version,
      new_hash: object.content_hash,
      remote_sequence: input.change.sequence,
      remote_actor: input.change.actor_id,
    };
    await commitCanonical({
      root: input.root,
      workspaceId: input.workspaceId,
      transactionId,
      now: input.now,
      actor: input.actor,
      origin: "sync",
      requestId: input.requestId,
      preparedEventId,
      committedEventId,
      domainEvents: [event],
      targets: [
        {
          relativePath: current?.relativePath ?? canonicalObjectPath(object),
          after: serialized,
        },
        { relativePath: checkpointPath(object.id, object.version), after: serialized },
      ],
    });
    return { status: "applied", object };
  });
}
