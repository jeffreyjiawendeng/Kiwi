import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prettyJson } from "./canonical-json.js";
import {
  commitCanonical,
  withCanonicalWrite,
  type CanonicalEvent,
} from "./canonical-transaction.js";
import { OBJECT_TITLE_MAX_LENGTH } from "@kiwi/contracts";
import {
  copyObjectAside,
  publishObject,
  readCanonicalObject,
  readObjectVersion,
  rehashCanonicalObject,
  type CanonicalIds,
  type CanonicalObject,
} from "./objects.js";

export interface StructuredConflict extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  object_id: string;
  status: "unresolved" | "resolved";
  detected_at: string;
  base: { version: number; content_hash: string | null };
  base_snapshot?: CanonicalObject;
  mine: CanonicalObject | null;
  theirs: CanonicalObject;
  resolved_at?: string;
  resolution?: "mine" | "theirs";
  /** Where the side that did not become the new version went, when it was kept as well. */
  kept_other_as?: { object_id: string; side: "mine" | "theirs"; relation_id: string };
}

export interface CreateExternalDraftConflictInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  conflictId: string;
  objectId: string;
  baseVersion: number;
  baseHash: string;
  mineTitle: string;
  mineContent: string;
  actor: string;
  requestId: string;
  now: string;
}

export async function createExternalDraftConflict(
  input: CreateExternalDraftConflictInput,
): Promise<StructuredConflict> {
  return withCanonicalWrite(input.root, async () => {
    const [base, found, existing] = await Promise.all([
      readObjectVersion(input.root, input.objectId, input.baseVersion),
      readCanonicalObject(input.root, input.objectId),
      listStructuredConflicts(input.root),
    ]);
    if (base === null || base.content_hash !== input.baseHash)
      throw new Error("The draft base is no longer available.");
    if (found === null) throw new Error("The externally edited object was not found.");
    if (found.object.version === input.baseVersion && found.object.content_hash === input.baseHash)
      throw new Error("The object has not changed outside Kiwi.");
    const duplicate = existing.find(
      (item) =>
        item.status === "unresolved" &&
        item.object_id === input.objectId &&
        item.base.version === input.baseVersion &&
        item.base.content_hash === input.baseHash &&
        item.theirs.content_hash === found.object.content_hash,
    );
    if (duplicate !== undefined) return duplicate;

    const mine = rehashCanonicalObject({
      ...base,
      title: input.mineTitle.trim(),
      content: input.mineContent,
    });
    const conflict: StructuredConflict = {
      $schema: "https://kiwi-research.org/schemas/conflict/structured-object/1-0-0.json",
      id: input.conflictId,
      workspace_id: input.workspaceId,
      object_id: input.objectId,
      status: "unresolved",
      detected_at: input.now,
      base: { version: base.version, content_hash: base.content_hash },
      base_snapshot: base,
      mine,
      theirs: found.object,
      source: "external_file_edit",
    };
    const event: CanonicalEvent = {
      id: input.domainEventId,
      workspace_id: input.workspaceId,
      transaction_id: input.transactionId,
      schema_version: "1.0.0",
      event_type: "external.conflict.detected",
      occurred_at: input.now,
      recorded_at: input.now,
      actor: input.actor,
      origin: "ui",
      request_id: input.requestId,
      object_ids: [input.objectId],
      conflict_ids: [input.conflictId],
      base_version: base.version,
      base_hash: base.content_hash,
      external_hash: found.object.content_hash,
    };
    await commitCanonical({
      root: input.root,
      workspaceId: input.workspaceId,
      transactionId: input.transactionId,
      now: input.now,
      actor: input.actor,
      origin: "ui",
      requestId: input.requestId,
      preparedEventId: input.preparedEventId,
      committedEventId: input.committedEventId,
      domainEvents: [event],
      targets: [
        {
          relativePath: join(".kiwi", "conflicts", `${input.conflictId}.json`),
          after: prettyJson(conflict),
        },
      ],
    });
    return conflict;
  });
}

function valid(value: unknown): value is StructuredConflict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["id"] === "string" &&
    typeof item["object_id"] === "string" &&
    (item["status"] === "unresolved" || item["status"] === "resolved") &&
    item["theirs"] !== null &&
    typeof item["theirs"] === "object"
  );
}

export async function listStructuredConflicts(root: string): Promise<StructuredConflict[]> {
  const folder = join(root, ".kiwi", "conflicts");
  const files = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const conflicts: StructuredConflict[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(join(folder, file.name), "utf8")) as unknown;
      if (valid(value) && file.name === `${value.id}.json`) conflicts.push(value);
    } catch {
      // Workspace Health owns malformed conflict diagnostics.
    }
  }
  return conflicts.sort((a, b) => a.detected_at.localeCompare(b.detected_at));
}

/** The relation from the version kept aside back to the object it was a version of. */
export const CONFLICT_VARIANT_RELATION = "conflict_variant_of";

const OTHER_VERSION_SUFFIX = " (other version)";

/**
 * What to call the copy.
 *
 * Two people editing the same note usually leave it with the same name, and two rows in the
 * library reading the same thing is the confusion keeping both was meant to prevent. So a copy
 * that would be indistinguishable by name says which one it is, and a copy that was already
 * called something else keeps the name whoever wrote it chose.
 */
function asideTitle(other: CanonicalObject, published: CanonicalObject): string {
  if (other.title !== published.title) return other.title;
  const combined = `${other.title}${OTHER_VERSION_SUFFIX}`;
  if (combined.length <= OBJECT_TITLE_MAX_LENGTH) return combined;
  const room = OBJECT_TITLE_MAX_LENGTH - OTHER_VERSION_SUFFIX.length;
  return `${other.title.slice(0, room).trimEnd()}${OTHER_VERSION_SUFFIX}`;
}

export interface ResolveStructuredConflictInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  conflictId: string;
  /** Which side becomes the new version of the object. */
  resolution: "mine" | "theirs";
  expectedVersion: number;
  expectedHash: string;
  actor: string;
  requestId: string;
  now: string;
  /**
   * Set to also keep the side that did not win, as an object of its own beside the first.
   *
   * The ids come from the caller because they belong to the same allocation as the transaction:
   * a copy and its relation are new canonical objects and need their own identifiers and events.
   */
  keepOther?: {
    objectId: string;
    relationId: string;
    objectEventId: string;
    relationEventId: string;
  };
}

/**
 * Resolve a conflict by choosing which version the object carries on as.
 *
 * `keepOther` is the answer to the question the two buttons cannot answer: sometimes both versions
 * are worth having, and the only way to say so used to be copying one out by hand before choosing.
 * With it, the losing side is written as an object of its own, related to the first, in the same
 * transaction as the save -- so there is no moment where the object has moved on and the other
 * side has not landed yet.
 */
export async function resolveStructuredConflict(input: ResolveStructuredConflictInput): Promise<{
  object: CanonicalObject;
  conflict: StructuredConflict;
  kept: CanonicalObject | null;
}> {
  const conflict = (await listStructuredConflicts(input.root)).find(
    (item) => item.id === input.conflictId,
  );
  if (conflict === undefined) throw new Error("Conflict not found.");
  if (conflict.status !== "unresolved") throw new Error("Conflict is already resolved.");
  const selected = input.resolution === "theirs" ? conflict.theirs : conflict.mine;
  if (selected === null) throw new Error("The selected conflict variant is not available.");
  const otherSide = input.resolution === "theirs" ? "mine" : "theirs";
  const other = input.resolution === "theirs" ? conflict.mine : conflict.theirs;
  if (input.keepOther !== undefined && other === null)
    throw new Error("There is no other version to keep.");

  const aside =
    input.keepOther === undefined || other === null
      ? null
      : copyObjectAside({
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          actor: input.actor,
          requestId: input.requestId,
          now: input.now,
          source: other,
          relatedObjectId: conflict.object_id,
          relationType: CONFLICT_VARIANT_RELATION,
          newObjectId: input.keepOther.objectId,
          relationId: input.keepOther.relationId,
          objectEventId: input.keepOther.objectEventId,
          relationEventId: input.keepOther.relationEventId,
          title: asideTitle(other, selected),
          objectFields: {
            kept_from_conflict_id: input.conflictId,
            kept_from_object_id: conflict.object_id,
            kept_conflict_side: otherSide,
          },
        });

  const resolved: StructuredConflict = {
    ...conflict,
    status: "resolved",
    resolved_at: input.now,
    resolution: input.resolution,
    ...(aside === null
      ? {}
      : {
          kept_other_as: {
            object_id: aside.object.id,
            side: otherSide,
            relation_id: aside.relation.id,
          },
        }),
  };
  const object = await publishObject({
    root: input.root,
    workspaceId: input.workspaceId,
    objectId: conflict.object_id,
    expectedVersion: input.expectedVersion,
    expectedHash: input.expectedHash,
    title: selected.title,
    content: selected.content,
    actor: input.actor,
    requestId: input.requestId,
    now: input.now,
    reason:
      aside === null
        ? `Resolve conflict ${input.conflictId} using ${input.resolution}`
        : `Resolve conflict ${input.conflictId} using ${input.resolution}, keeping ${otherSide} beside it`,
    additionalFields: {
      resolved_conflict_id: input.conflictId,
      conflict_resolution: input.resolution,
      ...(aside === null ? {} : { kept_other_as_object_id: aside.object.id }),
    },
    additionalTargets: [
      {
        relativePath: join(".kiwi", "conflicts", `${input.conflictId}.json`),
        after: prettyJson(resolved),
      },
      ...(aside === null ? [] : aside.targets),
    ],
    ...(aside === null ? {} : { additionalEvents: aside.events }),
    transactionId: input.transactionId,
    preparedEventId: input.preparedEventId,
    domainEventId: input.domainEventId,
    committedEventId: input.committedEventId,
  });
  return { object, conflict: resolved, kept: aside === null ? null : aside.object };
}
