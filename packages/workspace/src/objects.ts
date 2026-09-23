import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  MANIFEST_FILENAME,
  OBJECT_TITLE_MAX_LENGTH,
  QUOTATION_NODE,
  annotationTitle,
  claimContent,
  claimTitle,
  compareAnnotations,
  documentText,
  endOfManuscript,
  escapeLatex,
  insertInDocument,
  insertInSource,
  manuscriptSections,
  readDocument,
  sectionNamed,
  compareDueDates,
  completeTask,
  emptyProtocol,
  findBlockingCycle,
  freezeProtocol,
  isCreatableObjectType,
  isEvidenceObjectType,
  isEvidenceStance,
  logDeviation,
  objectSchemaUri,
  protocolContent,
  quotedAnnotations,
  readAnnotation,
  validateAnnotation,
  readClaim,
  readProjectSettings,
  readProtocol,
  readTask,
  readThread,
  reanchorThread,
  reopenTask,
  replyToThread,
  startThread,
  taskContent,
  threadContent,
  threadTitle,
  validateObjectPublication,
  validateClaim,
  validateProjectSettings,
  validateProtocol,
  validateTask,
  validateThread,
  withThreadMessages,
  type Annotation,
  type AnnotationProblem,
  type DocumentMode,
  type DocumentNode,
  type ClaimBody,
  type ClaimProblem,
  type ClaimStatus,
  type CreatableObjectType,
  type Deviation,
  type EvidenceStance,
  type ProjectPage,
  type ProjectSettings,
  type ProtocolBody,
  type ProtocolProblem,
  type PublicationProblem,
  type TaskBody,
  type TaskProblem,
  type TaskStatus,
  type ThreadAnchor,
  type ThreadBody,
  type ThreadMessage,
  type ThreadProblem,
  type ThreadStatus,
  type WorkspaceManifest,
} from "@kiwi/contracts";
import { prettyJson, sha256 } from "./canonical-json.js";
import {
  commitCanonical,
  withCanonicalWrite,
  type CanonicalEvent,
  type CommitCanonicalInput,
} from "./canonical-transaction.js";
import { readManifest, serializeManifest } from "./manifest.js";

export const OBJECT_SCHEMA_VERSION = "1.0.0";
export const INBOX_SCHEMA = "https://kiwi-research.org/schemas/object/inbox-item/1-0-0.json";
export const COLLECTION_SCHEMA = "https://kiwi-research.org/schemas/object/collection/1-0-0.json";
export const RELATION_SCHEMA = "https://kiwi-research.org/schemas/relation/1-0-0.json";

export interface CanonicalObject extends Record<string, unknown> {
  $schema: string;
  id: string;
  type: string;
  schema_version: string;
  title: string;
  lifecycle: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
  last_event_id: string;
  last_transaction_id: string;
  content_hash: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  provenance: unknown[];
  tags: string[];
  extensions: Record<string, unknown>;
  content: string;
}

export interface CanonicalRelation extends Record<string, unknown> {
  $schema: string;
  id: string;
  type: string;
  schema_version: string;
  subject: { object_id: string };
  object: { object_id: string };
  assertion: "asserted" | "retracted";
  qualifiers: Record<string, unknown>;
  provenance: unknown[];
  created_at: string;
  updated_at: string;
  created_by: string;
  version: number;
  last_event_id: string;
  last_transaction_id: string;
  content_hash: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  extensions: Record<string, unknown>;
}

export interface CanonicalIds {
  transactionId: string;
  preparedEventId: string;
  domainEventId: string;
  committedEventId: string;
}

export interface CreateInboxItemInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  title: string;
  content: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export interface QuickCaptureReference {
  object_id: string;
  version: number;
  content_hash: string;
}

export interface QuickCaptureContextInput {
  surface: string;
  project_id: string | null;
  object: QuickCaptureReference | null;
  source: (QuickCaptureReference & { representation_id: string | null }) | null;
  selection: {
    text: string;
    prefix: string | null;
    suffix: string | null;
  } | null;
}

export interface QuickCaptureProvenance extends Record<string, unknown> {
  type: "quick_capture";
  captured_at: string;
  capture_command: "kiwi.object.quick-capture";
  surface: string;
  project_id: string | null;
  object: {
    object_id: string;
    object_type: string;
    object_title: string;
    version: number;
    content_hash: string;
  } | null;
  source: {
    object_id: string;
    object_type: string;
    object_title: string;
    version: number;
    content_hash: string;
    representation_id: string | null;
  } | null;
  selection: {
    text: string;
    prefix: string | null;
    suffix: string | null;
  } | null;
}

export interface QuickCaptureInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  title: string;
  content: string;
  context: QuickCaptureContextInput;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

function semantic(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy["content_hash"];
  return copy;
}

function withHash<T extends Record<string, unknown>>(value: T): T & { content_hash: string } {
  return { ...value, content_hash: sha256(semantic(value)) };
}

export function rehashCanonicalObject(value: CanonicalObject): CanonicalObject {
  return withHash({ ...value });
}

function slug(title: string): string {
  const withoutControls = [...title]
    .map((character) => (character.codePointAt(0)! < 32 ? " " : character))
    .join("");
  const value = withoutControls
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/[. ]+$/g, "");
  return value === "" ? "untitled" : value;
}

export function canonicalObjectPath(value: Pick<CanonicalObject, "id" | "title" | "type">): string {
  const folder = value.type === "inbox_item" ? "inbox" : `${value.type.replaceAll("_", "-")}s`;
  return join("objects", folder, `${slug(value.title)}--${value.id}.json`);
}

function checkpointPath(id: string, version: number): string {
  return join(".kiwi", "checkpoints", id, `${String(version).padStart(8, "0")}.json`);
}

function relationPath(value: Pick<CanonicalRelation, "id" | "type">): string {
  return join("relations", `${slug(value.type)}--${value.id}.json`);
}

function relationCheckpointPath(id: string, version: number): string {
  return join(".kiwi", "relation-checkpoints", id, `${String(version).padStart(8, "0")}.json`);
}

function domainEvent(
  input: {
    workspaceId: string;
    transactionId: string;
    domainEventId: string;
    actor: string;
    requestId: string;
    now: string;
  },
  eventType: string,
  details: Record<string, unknown>,
): CanonicalEvent {
  return {
    id: input.domainEventId,
    workspace_id: input.workspaceId,
    transaction_id: input.transactionId,
    schema_version: "1.0.0",
    event_type: eventType,
    occurred_at: input.now,
    recorded_at: input.now,
    actor: input.actor,
    origin: "ui",
    request_id: input.requestId,
    ...details,
  };
}

function commitInput(
  input: CanonicalIds & {
    root: string;
    workspaceId: string;
    now: string;
    actor: string;
    requestId: string;
    faultAfterTarget?: number;
    additionalEvents?: readonly CanonicalEvent[];
  },
  event: CanonicalEvent,
  targets: CommitCanonicalInput["targets"],
): CommitCanonicalInput {
  return {
    root: input.root,
    workspaceId: input.workspaceId,
    transactionId: input.transactionId,
    now: input.now,
    actor: input.actor,
    origin: "ui",
    requestId: input.requestId,
    preparedEventId: input.preparedEventId,
    committedEventId: input.committedEventId,
    domainEvents: [event, ...(input.additionalEvents ?? [])],
    targets,
    ...(input.faultAfterTarget !== undefined ? { faultAfterTarget: input.faultAfterTarget } : {}),
  };
}

export async function createInboxItem(input: CreateInboxItemInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createInboxItemUnlocked(input));
}

async function createInboxItemUnlocked(
  input: CreateInboxItemInput,
  options: {
    provenance?: unknown[];
    eventType?: string;
    eventPayload?: Record<string, unknown>;
  } = {},
): Promise<CanonicalObject> {
  const title = input.title.trim().normalize("NFC");
  const content = input.content.normalize("NFC").replaceAll("\r\n", "\n");
  if (title === "" || title.length > 200) throw new Error("Invalid Inbox item title.");
  const object = withHash({
    $schema: INBOX_SCHEMA,
    id: input.objectId,
    type: "inbox_item",
    schema_version: OBJECT_SCHEMA_VERSION,
    title,
    lifecycle: "inbox",
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    updated_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    provenance: options.provenance ?? [],
    tags: [],
    extensions: {},
    content,
  });
  const event = domainEvent(input, options.eventType ?? "object.created", {
    object_ids: [object.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
    ...(options.eventPayload ?? {}),
  });
  const serialized = prettyJson(object);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
    ]),
  );
  return object;
}

export interface CreateObjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  type: CreatableObjectType;
  title: string;
  content: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
  /**
   * Extra top-level fields written with the object, the way `publishObject` writes a
   * reference. A project carries its settings from the moment it is created, and doing that
   * in a second transaction would leave a version 1 that no page could read.
   */
  additionalFields?: Record<string, unknown>;
}

export class ObjectTypeNotCreatable extends Error {
  constructor(readonly attempted: string) {
    super(`${attempted} is not a type this workspace creates.`);
    this.name = "ObjectTypeNotCreatable";
  }
}

export class ObjectNotPromotable extends Error {
  constructor(readonly actualType: string) {
    super("Only an Inbox item can be promoted.");
    this.name = "ObjectNotPromotable";
  }
}

/** Creates a typed object directly, for work that never passed through the Inbox. */
export async function createObject(input: CreateObjectInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createObjectUnlocked(input));
}

async function createObjectUnlocked(input: CreateObjectInput): Promise<CanonicalObject> {
  if (!isCreatableObjectType(input.type)) throw new ObjectTypeNotCreatable(input.type);
  const title = input.title.trim().normalize("NFC");
  const content = input.content.normalize("NFC").replaceAll("\r\n", "\n");
  const problems = validateObjectPublication({ title, content });
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length > 0) throw new ObjectPublicationValidationError(errors);
  const object = withHash({
    $schema: objectSchemaUri(input.type),
    id: input.objectId,
    type: input.type,
    schema_version: OBJECT_SCHEMA_VERSION,
    title,
    lifecycle: "active",
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    updated_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    provenance: [],
    tags: [],
    extensions: {},
    ...(input.additionalFields ?? {}),
    content,
  });
  const event = domainEvent(input, "object.created", {
    object_ids: [object.id],
    object_type: object.type,
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
    ]),
  );
  return object;
}

export interface PromoteInboxItemInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  type: CreatableObjectType;
  expectedVersion: number;
  expectedHash: string;
  title?: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Turns an Inbox item into what it actually is.
 *
 * The identity is deliberately kept. Promotion is not "delete and recreate": every relation,
 * annotation, and checkpoint already points at this id, and a new id would orphan all of them.
 * Only the type changes, which moves the file to the folder for that type.
 */
export async function promoteInboxItem(input: PromoteInboxItemInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => promoteInboxItemUnlocked(input));
}

async function promoteInboxItemUnlocked(input: PromoteInboxItemInput): Promise<CanonicalObject> {
  if (!isCreatableObjectType(input.type)) throw new ObjectTypeNotCreatable(input.type);
  const current = await readCanonicalObject(input.root, input.objectId);
  if (current === null) throw new Error("Object not found.");
  if (current.object.type !== "inbox_item") throw new ObjectNotPromotable(current.object.type);
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const title = (input.title ?? String(current.object.title)).trim().normalize("NFC");
  const problems = validateObjectPublication({ title, content: current.object.content });
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length > 0) throw new ObjectPublicationValidationError(errors);
  const next = withHash({
    ...current.object,
    $schema: objectSchemaUri(input.type),
    type: input.type,
    title,
    lifecycle: "active",
    updated_at: input.now,
    updated_by: input.actor,
    version: current.object.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    promoted_from: current.object.type,
  });
  const event = domainEvent(input, "object.promoted", {
    object_ids: [next.id],
    prior_type: current.object.type,
    object_type: next.type,
    prior_version: current.object.version,
    new_version: next.version,
    prior_hash: current.object.content_hash,
    new_hash: next.content_hash,
    snapshot: next,
  });
  const serialized = prettyJson(next);
  const nextPath = canonicalObjectPath(next);
  await commitCanonical(
    commitInput(input, event, [
      ...(nextPath === current.relativePath
        ? [{ relativePath: current.relativePath, after: serialized }]
        : [
            { relativePath: nextPath, after: serialized },
            { relativePath: current.relativePath, after: null },
          ]),
      { relativePath: checkpointPath(next.id, next.version), after: serialized },
    ]),
  );
  return next;
}

const QUICK_CAPTURE_SURFACES = new Set([
  "collection",
  "inbox",
  "live-notes",
  "search",
  "trash",
  "plan",
  "execute",
  "workbench",
]);

export class ObjectCaptureContextConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectCaptureContextConflict";
  }
}

async function capturedReference(
  root: string,
  reference: QuickCaptureReference,
): Promise<CanonicalObject> {
  const object = await readObjectVersion(root, reference.object_id, reference.version);
  if (object === null || object.content_hash !== reference.content_hash)
    throw new ObjectCaptureContextConflict(
      "The selected capture context is no longer available at the reviewed version.",
    );
  return object;
}

function normalizedSelection(
  selection: QuickCaptureContextInput["selection"],
): QuickCaptureProvenance["selection"] {
  if (selection === null) return null;
  const normalize = (value: string): string => value.normalize("NFC").replaceAll("\r\n", "\n");
  const text = normalize(selection.text);
  if (text.trim() === "" || text.length > 100_000)
    throw new Error("Selected capture text must contain between 1 and 100000 characters.");
  const prefix = selection.prefix === null ? null : normalize(selection.prefix);
  const suffix = selection.suffix === null ? null : normalize(selection.suffix);
  if ((prefix?.length ?? 0) > 500 || (suffix?.length ?? 0) > 500)
    throw new Error("Capture selection context must not exceed 500 characters per side.");
  return { text, prefix, suffix };
}

export async function quickCapture(input: QuickCaptureInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, async () => {
    if (!QUICK_CAPTURE_SURFACES.has(input.context.surface))
      throw new Error("Invalid Quick Capture surface.");
    if (
      input.context.project_id !== null &&
      (input.context.project_id.trim() === "" || input.context.project_id.length > 100)
    )
      throw new Error("Invalid Quick Capture project context.");
    const contextObject =
      input.context.object === null
        ? null
        : await capturedReference(input.root, input.context.object);
    const sourceObject =
      input.context.source === null
        ? null
        : contextObject !== null &&
            input.context.source.object_id === input.context.object?.object_id &&
            input.context.source.version === input.context.object.version &&
            input.context.source.content_hash === input.context.object.content_hash
          ? contextObject
          : await capturedReference(input.root, input.context.source);
    const representationId = input.context.source?.representation_id;
    if (
      representationId !== undefined &&
      representationId !== null &&
      (representationId.trim() === "" || representationId.length > 200)
    )
      throw new Error("Invalid Quick Capture representation context.");
    const provenance: QuickCaptureProvenance = {
      type: "quick_capture",
      captured_at: input.now,
      capture_command: "kiwi.object.quick-capture",
      surface: input.context.surface,
      project_id: input.context.project_id?.trim() ?? null,
      object:
        contextObject === null || input.context.object === null
          ? null
          : {
              object_id: contextObject.id,
              object_type: contextObject.type,
              object_title: contextObject.title,
              version: input.context.object.version,
              content_hash: input.context.object.content_hash,
            },
      source:
        sourceObject === null || input.context.source === null
          ? null
          : {
              object_id: sourceObject.id,
              object_type: sourceObject.type,
              object_title: sourceObject.title,
              version: input.context.source.version,
              content_hash: input.context.source.content_hash,
              representation_id: input.context.source.representation_id?.trim() ?? null,
            },
      selection: normalizedSelection(input.context.selection),
    };
    return createInboxItemUnlocked(input, {
      provenance: [provenance],
      eventType: "object.quick_captured",
      eventPayload: { capture_context: provenance },
    });
  });
}

function isObject(value: unknown): value is CanonicalObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["type"] === "string" &&
    typeof record["title"] === "string" &&
    typeof record["version"] === "number" &&
    typeof record["content_hash"] === "string" &&
    typeof record["content"] === "string"
  );
}

async function jsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(folder: string): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  }
  await visit(join(root, "objects"));
  return files.sort();
}

export async function listCanonicalObjects(root: string): Promise<CanonicalObject[]> {
  const objects: CanonicalObject[] = [];
  for (const path of await jsonFiles(root)) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isObject(parsed) && basename(path).endsWith(`--${parsed.id}.json`)) objects.push(parsed);
  }
  return objects.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function readCanonicalObject(
  root: string,
  objectId: string,
): Promise<{ object: CanonicalObject; relativePath: string } | null> {
  for (const path of await jsonFiles(root)) {
    if (!basename(path).endsWith(`--${objectId}.json`)) continue;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(parsed) || parsed.id !== objectId) return null;
    return { object: parsed, relativePath: relative(root, path) };
  }
  return null;
}

export interface PublishObjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
  title: string;
  content: string;
  actor: string;
  requestId: string;
  now: string;
  reason?: string;
  restoredFromVersion?: number;
  faultAfterTarget?: number;
  additionalFields?: Record<string, unknown>;
  additionalTargets?: CommitCanonicalInput["targets"];
  /**
   * Events for work committed alongside this save, in the one transaction.
   *
   * A save that also puts a second object on disk is one thing happening, not two, and a journal
   * that recorded only the save would leave the second object with no event that created it.
   */
  additionalEvents?: readonly CanonicalEvent[];
  relocateToTitlePath?: boolean;
}

export class ObjectVersionConflict extends Error {
  constructor(
    readonly actualVersion: number,
    readonly actualHash: string,
  ) {
    super("The object changed since editing began.");
    this.name = "ObjectVersionConflict";
  }
}

export class ObjectPublicationValidationError extends Error {
  constructor(readonly problems: PublicationProblem[]) {
    super("Correct the listed problems before saving.");
    this.name = "ObjectPublicationValidationError";
  }
}

export class ObjectHistoryCorruptionError extends Error {
  constructor(
    readonly objectId: string,
    readonly version: number,
  ) {
    super(`Historical version ${version} for object ${objectId} failed its integrity check.`);
    this.name = "ObjectHistoryCorruptionError";
  }
}

export interface ObjectPublicationImpact {
  relation_count: number;
  incoming_count: number;
  outgoing_count: number;
  related_object_count: number;
  relation_types: string[];
}

export interface ObjectPublicationPreview {
  valid: boolean;
  problems: PublicationProblem[];
  impact: ObjectPublicationImpact;
}

export interface ObjectTrashImpact extends ObjectPublicationImpact {
  collection_membership_count: number;
}

export interface TrashRelationRecord {
  relative_path: string;
  prior: CanonicalRelation;
  tombstone_version: number;
  tombstone_hash: string;
}

export interface ObjectTrashManifest {
  schema_version: 1;
  object_id: string;
  title: string;
  object_type: string;
  original_path: string;
  object_checksum: string;
  trashed_at: string;
  trashed_by: string;
  deletion_event_id: string;
  deletion_transaction_id: string;
  relations: TrashRelationRecord[];
  restoration_constraints: {
    original_path_must_be_available: true;
    relation_tombstones_must_be_current: true;
  };
}

export interface ObjectTrashEntry {
  manifest: ObjectTrashManifest;
  object: CanonicalObject;
  impact: ObjectTrashImpact;
}

export interface ObjectTrashRelationGuard {
  relation_id: string;
  version: number;
  content_hash: string;
}

export class ObjectTrashCorruptionError extends Error {
  constructor(readonly objectId: string) {
    super(`Trash evidence for object ${objectId} failed its integrity check.`);
    this.name = "ObjectTrashCorruptionError";
  }
}

export class ObjectTrashConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectTrashConflict";
  }
}

async function objectPublicationImpact(
  root: string,
  objectId: string,
): Promise<ObjectPublicationImpact> {
  const relations = await relationsForObject(root, objectId);
  const relatedObjects = new Set<string>();
  const relationIds = new Set<string>();
  for (const item of relations) {
    relationIds.add(item.relation.id);
    const relatedId =
      item.direction === "outgoing"
        ? item.relation.object.object_id
        : item.relation.subject.object_id;
    if (relatedId !== objectId) relatedObjects.add(relatedId);
  }
  return {
    relation_count: relationIds.size,
    incoming_count: relations.filter((item) => item.direction === "incoming").length,
    outgoing_count: relations.filter((item) => item.direction === "outgoing").length,
    related_object_count: relatedObjects.size,
    relation_types: [...new Set(relations.map((item) => item.relation.type))].sort(),
  };
}

function trashObjectPath(objectId: string): string {
  return join(".kiwi", "trash", objectId, "object.json");
}

function trashManifestPath(objectId: string): string {
  return join(".kiwi", "trash", objectId, "manifest.json");
}

function trashImpact(
  objectId: string,
  relations: Array<{ relation: CanonicalRelation; direction: "outgoing" | "incoming" }>,
): ObjectTrashImpact {
  const relatedObjects = new Set<string>();
  for (const item of relations) {
    const relatedId =
      item.direction === "outgoing"
        ? item.relation.object.object_id
        : item.relation.subject.object_id;
    if (relatedId !== objectId) relatedObjects.add(relatedId);
  }
  return {
    relation_count: new Set(relations.map((item) => item.relation.id)).size,
    incoming_count: relations.filter((item) => item.direction === "incoming").length,
    outgoing_count: relations.filter((item) => item.direction === "outgoing").length,
    related_object_count: relatedObjects.size,
    relation_types: [...new Set(relations.map((item) => item.relation.type))].sort(),
    collection_membership_count: relations.filter((item) => item.relation.type === "in_collection")
      .length,
  };
}

export async function previewObjectTrash(input: {
  root: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
}): Promise<{
  object: CanonicalObject;
  impact: ObjectTrashImpact;
  relation_guards: ObjectTrashRelationGuard[];
}> {
  const current = await readCanonicalObject(input.root, input.objectId);
  if (current === null) throw new Error("Object not found.");
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  )
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  const relations = await relationsForObject(input.root, input.objectId);
  return {
    object: current.object,
    impact: trashImpact(input.objectId, relations),
    relation_guards: [
      ...new Map(
        relations.map((item) => [
          item.relation.id,
          {
            relation_id: item.relation.id,
            version: item.relation.version,
            content_hash: item.relation.content_hash,
          },
        ]),
      ).values(),
    ],
  };
}

export async function previewObjectPublication(input: {
  root: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
  title: string;
  content: string;
}): Promise<ObjectPublicationPreview> {
  const current = await readCanonicalObject(input.root, input.objectId);
  if (current === null) throw new Error("Object not found.");
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const problems = validateObjectPublication(input);
  return {
    valid: !problems.some((problem) => problem.severity === "error"),
    problems,
    impact: await objectPublicationImpact(input.root, input.objectId),
  };
}

export interface ObjectRestorePreview {
  source: CanonicalObject;
  current_version: number;
  next_version: number;
  history_count: number;
  impact: ObjectPublicationImpact;
}

export async function previewObjectRestore(input: {
  root: string;
  objectId: string;
  restoreVersion: number;
  expectedVersion: number;
  expectedHash: string;
}): Promise<ObjectRestorePreview> {
  const current = await readCanonicalObject(input.root, input.objectId);
  if (current === null) throw new Error("Object not found.");
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const source = await readObjectVersion(input.root, input.objectId, input.restoreVersion);
  if (source === null) throw new Error("Historical version not found.");
  const history = await objectHistory(input.root, input.objectId);
  return {
    source,
    current_version: current.object.version,
    next_version: current.object.version + 1,
    history_count: history.length,
    impact: await objectPublicationImpact(input.root, input.objectId),
  };
}

export interface ObjectVersionGuard {
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
}

export interface BulkTagObjectsInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  targets: ObjectVersionGuard[];
  tagId: string;
  action: "add" | "remove";
  actor: string;
  requestId: string;
  now: string;
}

export interface BulkTagChange {
  object: CanonicalObject;
  base_version: number;
  base_hash: string;
}

export interface BulkTagReceipt {
  action: "add" | "remove";
  tag_id: string;
  requested_count: number;
  changed_count: number;
  skipped_count: number;
  changes: BulkTagChange[];
  undo: {
    action: "add" | "remove";
    tag_id: string;
    targets: Array<{
      object_id: string;
      expected_version: number;
      expected_hash: string;
    }>;
  } | null;
}

export async function bulkTagObjects(input: BulkTagObjectsInput): Promise<BulkTagReceipt> {
  return withCanonicalWrite(input.root, async () => {
    const unique = new Set(input.targets.map((target) => target.objectId));
    if (unique.size !== input.targets.length)
      throw new Error("Bulk object targets must be unique.");
    const current = await Promise.all(
      input.targets.map(async (target) => {
        const found = await readCanonicalObject(input.root, target.objectId);
        if (found === null) throw new Error("Object not found.");
        if (
          found.object.version !== target.expectedVersion ||
          found.object.content_hash !== target.expectedHash
        )
          throw new ObjectVersionConflict(found.object.version, found.object.content_hash);
        return found;
      }),
    );
    const changes: BulkTagChange[] = [];
    const targets: CommitCanonicalInput["targets"] = [];
    for (const found of current) {
      const alreadyTagged = found.object.tags.includes(input.tagId);
      if (
        (input.action === "add" && alreadyTagged) ||
        (input.action === "remove" && !alreadyTagged)
      )
        continue;
      const tags =
        input.action === "add"
          ? [...found.object.tags, input.tagId]
          : found.object.tags.filter((tag) => tag !== input.tagId);
      const next = withHash({
        ...found.object,
        tags,
        updated_at: input.now,
        updated_by: input.actor,
        version: found.object.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      });
      const serialized = prettyJson(next);
      changes.push({
        object: next,
        base_version: found.object.version,
        base_hash: found.object.content_hash,
      });
      targets.push(
        { relativePath: found.relativePath, after: serialized },
        { relativePath: checkpointPath(next.id, next.version), after: serialized },
      );
    }
    if (changes.length > 0) {
      const event = domainEvent(
        input,
        `objects.tag_${input.action === "add" ? "added" : "removed"}`,
        {
          object_ids: changes.map((change) => change.object.id),
          tag_id: input.tagId,
          changes: changes.map((change) => ({
            object_id: change.object.id,
            prior_version: change.base_version,
            new_version: change.object.version,
            prior_hash: change.base_hash,
            new_hash: change.object.content_hash,
          })),
        },
      );
      await commitCanonical(commitInput(input, event, targets));
    }
    return {
      action: input.action,
      tag_id: input.tagId,
      requested_count: input.targets.length,
      changed_count: changes.length,
      skipped_count: input.targets.length - changes.length,
      changes,
      undo:
        changes.length === 0
          ? null
          : {
              action: input.action === "add" ? "remove" : "add",
              tag_id: input.tagId,
              targets: changes.map((change) => ({
                object_id: change.object.id,
                expected_version: change.object.version,
                expected_hash: change.object.content_hash,
              })),
            },
    };
  });
}

export async function publishObject(input: PublishObjectInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => publishObjectUnlocked(input));
}

async function publishObjectUnlocked(input: PublishObjectInput): Promise<CanonicalObject> {
  const current = await readCanonicalObject(input.root, input.objectId);
  if (current === null) throw new Error("Object not found.");
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const problems = validateObjectPublication({ title: input.title, content: input.content });
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length > 0) throw new ObjectPublicationValidationError(errors);
  const next = withHash({
    ...current.object,
    ...(input.additionalFields ?? {}),
    title: input.title.trim().normalize("NFC"),
    content: input.content.normalize("NFC").replaceAll("\r\n", "\n"),
    updated_at: input.now,
    updated_by: input.actor,
    version: current.object.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    ...(input.restoredFromVersion !== undefined
      ? { restored_from_version: input.restoredFromVersion }
      : {}),
  });
  const event = domainEvent(
    input,
    input.restoredFromVersion === undefined ? "object.saved" : "object.restored",
    {
      object_ids: [next.id],
      prior_version: current.object.version,
      new_version: next.version,
      prior_hash: current.object.content_hash,
      new_hash: next.content_hash,
      reason: input.reason ?? null,
      restored_from_version: input.restoredFromVersion ?? null,
      snapshot: next,
    },
  );
  const serialized = prettyJson(next);
  const nextPath = canonicalObjectPath(next);
  const objectTargets: CommitCanonicalInput["targets"] =
    input.relocateToTitlePath === true && nextPath !== current.relativePath
      ? [
          { relativePath: nextPath, after: serialized },
          { relativePath: current.relativePath, after: null },
        ]
      : [{ relativePath: current.relativePath, after: serialized }];
  await commitCanonical(
    commitInput(input, event, [
      ...objectTargets,
      { relativePath: checkpointPath(next.id, next.version), after: serialized },
      ...(input.additionalTargets ?? []),
    ]),
  );
  return next;
}

export async function readObjectVersion(
  root: string,
  objectId: string,
  version: number,
): Promise<CanonicalObject | null> {
  const raw = await readFile(join(root, checkpointPath(objectId, version)), "utf8").catch(
    () => null,
  );
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ObjectHistoryCorruptionError(objectId, version);
  }
  if (!isObject(parsed) || parsed.id !== objectId || parsed.version !== version) {
    throw new ObjectHistoryCorruptionError(objectId, version);
  }
  if (!verifyObjectHash(parsed)) throw new ObjectHistoryCorruptionError(objectId, version);
  return parsed;
}

export async function restoreObjectVersion(
  input: Omit<PublishObjectInput, "title" | "content"> & { restoreVersion: number },
): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, async () => {
    const historical = await readObjectVersion(input.root, input.objectId, input.restoreVersion);
    if (historical === null) throw new Error("Historical version not found.");
    return publishObjectUnlocked({
      ...input,
      title: historical.title,
      content: historical.content,
      restoredFromVersion: input.restoreVersion,
    });
  });
}

export interface CreateRelationInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  relationId: string;
  type: string;
  subjectId: string;
  objectId: string;
  actor: string;
  requestId: string;
  now: string;
}

export async function createRelation(input: CreateRelationInput): Promise<CanonicalRelation> {
  return withCanonicalWrite(input.root, () => createRelationUnlocked(input));
}

async function createRelationUnlocked(input: CreateRelationInput): Promise<CanonicalRelation> {
  if ((await readCanonicalObject(input.root, input.subjectId)) === null)
    throw new Error("Subject not found.");
  if ((await readCanonicalObject(input.root, input.objectId)) === null)
    throw new Error("Object not found.");
  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: input.type.trim().toLocaleLowerCase("en-US").replaceAll(" ", "_"),
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: input.subjectId },
    object: { object_id: input.objectId },
    assertion: "asserted" as const,
    qualifiers: {},
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });
  const event = domainEvent(input, "relation.created", {
    object_ids: [input.subjectId, input.objectId],
    relation_ids: [relation.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: relation.content_hash,
    snapshot: relation,
  });
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: relationPath(relation), after: prettyJson(relation) },
    ]),
  );
  return relation;
}

export interface CopyObjectAsideInput {
  workspaceId: string;
  transactionId: string;
  actor: string;
  requestId: string;
  now: string;
  /** The version being set aside, which the copy takes its type and settings from. */
  source: CanonicalObject;
  /** What the copy points at: the object the source was a version of. */
  relatedObjectId: string;
  relationType: string;
  newObjectId: string;
  relationId: string;
  objectEventId: string;
  relationEventId: string;
  title: string;
  objectFields?: Record<string, unknown>;
  relationFields?: Record<string, unknown>;
}

export interface ObjectCopiedAside {
  object: CanonicalObject;
  relation: CanonicalRelation;
  events: CanonicalEvent[];
  targets: CommitCanonicalInput["targets"];
}

/**
 * A version of an object written out as an object of its own, next to it.
 *
 * This builds the files and the events and writes nothing. The reason is the only case that needs
 * it: keeping both sides of a conflict is one decision, so the surviving version and the copy have
 * to land in the same transaction or a crash between them would lose the side that was being
 * rescued. The caller folds what comes back into its own commit.
 *
 * The copy is version 1 of a new object rather than a branch of the old one. It has no history
 * because it never had one: what it holds was a version of something else, and pretending
 * otherwise would put a version 1 in a checkpoint folder that disagrees with the object it was
 * copied from.
 */
export function copyObjectAside(input: CopyObjectAsideInput): ObjectCopiedAside {
  const object = withHash({
    ...input.source,
    id: input.newObjectId,
    title: input.title.trim().normalize("NFC"),
    lifecycle: "active",
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    updated_by: input.actor,
    version: 1,
    last_event_id: input.objectEventId,
    last_transaction_id: input.transactionId,
    ...(input.objectFields ?? {}),
  });
  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: input.relationType,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: object.id },
    object: { object_id: input.relatedObjectId },
    assertion: "asserted" as const,
    qualifiers: {},
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.relationEventId,
    last_transaction_id: input.transactionId,
    sensitivity: object.sensitivity,
    extensions: {},
    ...(input.relationFields ?? {}),
  });
  const shared = {
    workspaceId: input.workspaceId,
    transactionId: input.transactionId,
    actor: input.actor,
    requestId: input.requestId,
    now: input.now,
  };
  const serialized = prettyJson(object);
  return {
    object,
    relation,
    events: [
      domainEvent({ ...shared, domainEventId: input.objectEventId }, "object.created", {
        object_ids: [object.id],
        object_type: object.type,
        prior_version: null,
        new_version: 1,
        prior_hash: null,
        new_hash: object.content_hash,
        snapshot: object,
      }),
      domainEvent({ ...shared, domainEventId: input.relationEventId }, "relation.created", {
        object_ids: [object.id, input.relatedObjectId],
        relation_ids: [relation.id],
        prior_version: null,
        new_version: 1,
        prior_hash: null,
        new_hash: relation.content_hash,
        snapshot: relation,
      }),
    ],
    targets: [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      { relativePath: relationPath(relation), after: prettyJson(relation) },
    ],
  };
}

function isRelation(value: unknown): value is CanonicalRelation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const subject = record["subject"];
  const object = record["object"];
  return (
    typeof record["id"] === "string" &&
    typeof record["type"] === "string" &&
    subject !== null &&
    typeof subject === "object" &&
    !Array.isArray(subject) &&
    typeof (subject as Record<string, unknown>)["object_id"] === "string" &&
    object !== null &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    typeof (object as Record<string, unknown>)["object_id"] === "string" &&
    (record["assertion"] === "asserted" || record["assertion"] === "retracted") &&
    Number.isInteger(record["version"]) &&
    typeof record["content_hash"] === "string"
  );
}

export async function listCanonicalRelations(root: string): Promise<CanonicalRelation[]> {
  const entries = await readdir(join(root, "relations"), { withFileTypes: true }).catch(() => []);
  const relations: CanonicalRelation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await readFile(join(root, "relations", entry.name), "utf8"),
      ) as unknown;
      if (isRelation(parsed) && entry.name.endsWith(`--${parsed.id}.json`)) relations.push(parsed);
    } catch {
      // Projection and Workspace Health report malformed canonical relation files.
    }
  }
  return relations.sort((left, right) => left.id.localeCompare(right.id));
}

export async function relationsForObject(
  root: string,
  objectId: string,
  includeRetracted = false,
): Promise<
  Array<{
    relation: CanonicalRelation;
    direction: "outgoing" | "incoming";
  }>
> {
  const results: Array<{ relation: CanonicalRelation; direction: "outgoing" | "incoming" }> = [];
  for (const parsed of await listCanonicalRelations(root)) {
    if (!includeRetracted && parsed.assertion !== "asserted") continue;
    if (parsed.subject.object_id === objectId)
      results.push({ relation: parsed, direction: "outgoing" });
    if (parsed.object.object_id === objectId)
      results.push({ relation: parsed, direction: "incoming" });
  }
  return results.sort((left, right) => left.relation.id.localeCompare(right.relation.id));
}

/** The relation that ties a Paper to the file it was read from. */
export const HAS_FILE_RELATION = "has_file";

export interface AttachFileInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  relationId: string;
  objectId: string;
  assetId: string;
  actor: string;
  requestId: string;
  now: string;
}

export class FileAttachmentError extends Error {
  constructor(
    readonly kind: "not_an_asset" | "already_attached" | "not_attached",
    message: string,
  ) {
    super(message);
    this.name = "FileAttachmentError";
  }
}

async function activeFileRelation(
  root: string,
  objectId: string,
  assetId: string,
): Promise<CanonicalRelation | null> {
  const links = await relationsForObject(root, objectId);
  const found = links.find(
    (link) =>
      link.direction === "outgoing" &&
      link.relation.type === HAS_FILE_RELATION &&
      link.relation.object.object_id === assetId,
  );
  return found?.relation ?? null;
}

/**
 * Attaches an imported file to an object.
 *
 * This is an ordinary relation rather than a field on the object, so a Paper can carry the
 * preprint and the published PDF at once, and so detaching leaves a retracted record instead
 * of erasing that the file was ever there.
 */
export async function attachFile(input: AttachFileInput): Promise<CanonicalRelation> {
  const asset = await readCanonicalObject(input.root, input.assetId);
  if (asset === null) throw new Error("Object not found.");
  if (asset.object.type !== "asset") {
    throw new FileAttachmentError("not_an_asset", "Only an imported file can be attached.");
  }
  if ((await activeFileRelation(input.root, input.objectId, input.assetId)) !== null) {
    throw new FileAttachmentError("already_attached", "That file is already attached.");
  }
  return createRelation({
    root: input.root,
    workspaceId: input.workspaceId,
    relationId: input.relationId,
    type: HAS_FILE_RELATION,
    subjectId: input.objectId,
    objectId: input.assetId,
    actor: input.actor,
    requestId: input.requestId,
    now: input.now,
    transactionId: input.transactionId,
    preparedEventId: input.preparedEventId,
    domainEventId: input.domainEventId,
    committedEventId: input.committedEventId,
  });
}

export interface DetachFileInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  assetId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/** Retracts the attachment. The imported file itself is left alone. */
export async function detachFile(input: DetachFileInput): Promise<CanonicalRelation> {
  return withCanonicalWrite(input.root, () => detachFileUnlocked(input));
}

async function detachFileUnlocked(input: DetachFileInput): Promise<CanonicalRelation> {
  const current = await activeFileRelation(input.root, input.objectId, input.assetId);
  if (current === null) {
    throw new FileAttachmentError("not_attached", "That file is not attached.");
  }
  const next = withHash({
    ...current,
    assertion: "retracted" as const,
    updated_at: input.now,
    version: current.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
  });
  const event = domainEvent(input, "relation.retracted", {
    object_ids: [input.objectId, input.assetId],
    relation_ids: [next.id],
    prior_version: current.version,
    new_version: next.version,
    prior_hash: current.content_hash,
    new_hash: next.content_hash,
    snapshot: next,
  });
  const serialized = prettyJson(next);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: relationPath(next), after: serialized },
      { relativePath: relationCheckpointPath(next.id, next.version), after: serialized },
    ]),
  );
  return next;
}

/** Every file currently attached to an object, in attachment order. */
export async function attachedFiles(root: string, objectId: string): Promise<CanonicalObject[]> {
  const links = await relationsForObject(root, objectId);
  const assetIds = links
    .filter((link) => link.direction === "outgoing" && link.relation.type === HAS_FILE_RELATION)
    .map((link) => link.relation.object.object_id);
  const found: CanonicalObject[] = [];
  for (const assetId of assetIds) {
    const asset = await readCanonicalObject(root, assetId);
    if (asset !== null) found.push(asset.object);
  }
  return found;
}

/** Ties an annotation to the Paper it was made while reading. */
export const ANNOTATES_RELATION = "annotates";

export interface CreateAnnotationInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  annotationId: string;
  relationId: string;
  objectId: string;
  annotation: Annotation;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export class AnnotationValidationError extends Error {
  constructor(readonly problems: AnnotationProblem[]) {
    super("Correct the annotation before saving.");
    this.name = "AnnotationValidationError";
  }
}

function annotationObject(
  input: {
    annotationId: string;
    annotation: Annotation;
    actor: string;
    now: string;
  } & CanonicalIds,
  base?: CanonicalObject,
): CanonicalObject {
  return withHash({
    ...(base ?? {}),
    $schema: objectSchemaUri("annotation"),
    id: input.annotationId,
    type: "annotation",
    schema_version: OBJECT_SCHEMA_VERSION,
    title: annotationTitle(input.annotation),
    lifecycle: "active",
    created_at: base?.created_at ?? input.now,
    updated_at: input.now,
    created_by: base?.created_by ?? input.actor,
    updated_by: input.actor,
    version: (base?.version ?? 0) + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: base?.sensitivity ?? ("internal" as const),
    provenance: base?.provenance ?? [],
    tags: base?.tags ?? [],
    extensions: base?.extensions ?? {},
    // The quoted passage is the object's content, which is what makes a highlight turn up in
    // a workspace search without the search needing to know what an annotation is.
    content: input.annotation.quoted,
    annotation: input.annotation,
  });
}

/**
 * Records a mark made while reading.
 *
 * The annotation is its own object rather than a field on the Paper. Hundreds of highlights on
 * one paper would otherwise rewrite that paper hundreds of times, and each mark deserves its
 * own version history anyway.
 */
export async function createAnnotation(input: CreateAnnotationInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createAnnotationUnlocked(input));
}

async function createAnnotationUnlocked(input: CreateAnnotationInput): Promise<CanonicalObject> {
  const problems = validateAnnotation(input.annotation);
  if (problems.length > 0) throw new AnnotationValidationError(problems);
  const subject = await readCanonicalObject(input.root, input.objectId);
  if (subject === null) throw new Error("Object not found.");

  const object = annotationObject(input);
  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: ANNOTATES_RELATION,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: object.id },
    object: { object_id: input.objectId },
    assertion: "asserted" as const,
    qualifiers: { page: input.annotation.page, asset_id: input.annotation.asset_id },
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });

  const event = domainEvent(input, "annotation.created", {
    object_ids: [object.id, input.objectId],
    relation_ids: [relation.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      { relativePath: relationPath(relation), after: prettyJson(relation) },
    ]),
  );
  return object;
}

export interface UpdateAnnotationInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  annotationId: string;
  expectedVersion: number;
  expectedHash: string;
  annotation: Annotation;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export async function updateAnnotation(input: UpdateAnnotationInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => updateAnnotationUnlocked(input));
}

async function updateAnnotationUnlocked(input: UpdateAnnotationInput): Promise<CanonicalObject> {
  const problems = validateAnnotation(input.annotation);
  if (problems.length > 0) throw new AnnotationValidationError(problems);
  const current = await readCanonicalObject(input.root, input.annotationId);
  if (current === null || current.object.type !== "annotation") {
    throw new Error("Annotation not found.");
  }
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const next = annotationObject({ ...input, annotation: input.annotation }, current.object);
  const event = domainEvent(input, "annotation.updated", {
    object_ids: [next.id],
    prior_version: current.object.version,
    new_version: next.version,
    prior_hash: current.object.content_hash,
    new_hash: next.content_hash,
    snapshot: next,
  });
  const serialized = prettyJson(next);
  const nextPath = canonicalObjectPath(next);
  await commitCanonical(
    commitInput(input, event, [
      ...(nextPath === current.relativePath
        ? [{ relativePath: current.relativePath, after: serialized }]
        : [
            { relativePath: nextPath, after: serialized },
            { relativePath: current.relativePath, after: null },
          ]),
      { relativePath: checkpointPath(next.id, next.version), after: serialized },
    ]),
  );
  return next;
}

export interface StoredAnnotation {
  object: CanonicalObject;
  annotation: Annotation;
}

/** Every annotation on an object, in reading order. */
export async function annotationsForObject(
  root: string,
  objectId: string,
  assetId?: string,
): Promise<StoredAnnotation[]> {
  const links = await relationsForObject(root, objectId);
  const annotationIds = links
    .filter((link) => link.direction === "incoming" && link.relation.type === ANNOTATES_RELATION)
    .map((link) => link.relation.subject.object_id);
  const found: StoredAnnotation[] = [];
  for (const id of annotationIds) {
    const stored = await readCanonicalObject(root, id);
    if (stored === null || stored.object.type !== "annotation") continue;
    const annotation = readAnnotation(stored.object["annotation"]);
    if (annotation === null) continue;
    if (assetId !== undefined && annotation.asset_id !== assetId) continue;
    found.push({ object: stored.object, annotation });
  }
  return found.sort((left, right) => compareAnnotations(left.annotation, right.annotation));
}

/**
 * Where a mark was made: which paper, which file, which page.
 *
 * What a quotation needs to be worth clicking. Everything here is read rather than stored on the
 * quotation, because all of it can change: a paper is renamed, its file is replaced, the mark
 * itself is deleted. The answer is null when the mark, its paper or its file is no longer there,
 * and the surface that asked is left to say so rather than being handed half a location and
 * opening page one of something.
 */
export interface AnnotationLocation {
  annotation_id: string;
  object_id: string;
  object_title: string;
  asset_id: string;
  file_title: string;
  page: number;
  page_label: string;
}

export async function locateAnnotation(
  root: string,
  annotationId: string,
): Promise<AnnotationLocation | null> {
  const stored = await readCanonicalObject(root, annotationId);
  if (stored === null || stored.object.type !== "annotation") return null;
  const annotation = readAnnotation(stored.object["annotation"]);
  if (annotation === null) return null;

  const links = await relationsForObject(root, annotationId);
  const paperId = links.find(
    (link) => link.direction === "outgoing" && link.relation.type === ANNOTATES_RELATION,
  )?.relation.object.object_id;
  if (paperId === undefined) return null;
  const paper = await readCanonicalObject(root, paperId);
  if (paper === null) return null;

  // The file the mark is on rather than the paper's primary one. A paper with the published
  // version and the preprint attached has two, and a mark made on page 4 of one of them is not
  // on page 4 of the other.
  //
  // A file that has gone is not a reason to refuse. The Reader opens on it and says so, which is
  // both the truth and more use than a quotation that does nothing when it is clicked.
  const file = await readCanonicalObject(root, annotation.asset_id);
  const filename = file === null ? null : file.object["original_filename"];

  return {
    annotation_id: annotationId,
    object_id: paperId,
    object_title: String(paper.object.title),
    asset_id: annotation.asset_id,
    file_title: String(filename ?? file?.object.title ?? paper.object.title),
    page: annotation.page,
    page_label: annotation.page_label,
  };
}

export interface SendAnnotationsToNoteInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  /** An existing note, or null to create one. */
  noteId: string | null;
  newNoteId: string;
  newNoteTitle: string;
  annotationIds: string[];
  relationIds: string[];
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export interface SendAnnotationsReceipt {
  note: CanonicalObject;
  added: number;
  skipped: number;
}

export class NoteTargetError extends Error {
  constructor(readonly kind: "not_a_note" | "not_found") {
    super(kind === "not_a_note" ? "That is not a Note." : "That Note was not found.");
    this.name = "NoteTargetError";
  }
}

/**
 * One quotation, as it will read in a note.
 *
 * The passage keeps its page and a marker naming the annotation it came from. The marker is
 * what lets the interface offer "open this where it was said" later, and what stops the same
 * highlight being pasted in twice.
 */
function quotationBlock(annotation: Annotation, paperTitle: string, annotationId: string): string {
  const lines: string[] = [];
  if (annotation.quoted.trim() !== "") {
    for (const line of annotation.quoted.trim().split("\n")) lines.push(`> ${line}`);
  }
  if (annotation.comment.trim() !== "") {
    if (lines.length > 0) lines.push("");
    lines.push(annotation.comment.trim());
  }
  if (lines.length === 0) lines.push(`> Figure on page ${annotation.page_label}`);
  lines.push("");
  lines.push(`— ${paperTitle}, p. ${annotation.page_label} [[kiwi:annotation/${annotationId}]]`);
  return lines.join("\n");
}

/** Which annotations a note already quotes, read back from the markers it carries. */
export function quotedAnnotationIds(content: string): Set<string> {
  const found = new Set<string>();
  const pattern = /\[\[kiwi:annotation\/([^\]]+)\]\]/gu;
  let match = pattern.exec(content);
  while (match !== null) {
    if (match[1] !== undefined) found.add(match[1]);
    match = pattern.exec(content);
  }
  return found;
}

/**
 * Copies highlights into a note, keeping a link back to where each was said.
 *
 * Sending the same highlight twice is a no-op rather than a duplicate. Reading is iterative:
 * people send one passage, read on, and send the rest of the page later, and a tool that
 * silently doubles the first one makes a mess that has to be cleaned by hand.
 */
export async function sendAnnotationsToNote(
  input: SendAnnotationsToNoteInput,
): Promise<SendAnnotationsReceipt> {
  return withCanonicalWrite(input.root, () => sendAnnotationsToNoteUnlocked(input));
}

async function sendAnnotationsToNoteUnlocked(
  input: SendAnnotationsToNoteInput,
): Promise<SendAnnotationsReceipt> {
  const gathered: Array<{ id: string; annotation: Annotation; paperTitle: string }> = [];
  for (const annotationId of input.annotationIds) {
    const stored = await readCanonicalObject(input.root, annotationId);
    if (stored === null || stored.object.type !== "annotation") continue;
    const annotation = readAnnotation(stored.object["annotation"]);
    if (annotation === null) continue;
    const links = await relationsForObject(input.root, annotationId);
    const paperId = links.find(
      (link) => link.direction === "outgoing" && link.relation.type === ANNOTATES_RELATION,
    )?.relation.object.object_id;
    const paper = paperId === undefined ? null : await readCanonicalObject(input.root, paperId);
    gathered.push({
      id: annotationId,
      annotation,
      paperTitle: paper === null ? "Unknown source" : String(paper.object.title),
    });
  }
  gathered.sort((left, right) => compareAnnotations(left.annotation, right.annotation));

  const existing =
    input.noteId === null ? null : await readCanonicalObject(input.root, input.noteId);
  if (input.noteId !== null) {
    if (existing === null) throw new NoteTargetError("not_found");
    if (existing.object.type !== "note") throw new NoteTargetError("not_a_note");
  }

  const priorContent = existing === null ? "" : existing.object.content;
  const already = quotedAnnotationIds(priorContent);
  const fresh = gathered.filter((entry) => !already.has(entry.id));
  const blocks = fresh.map((entry) => quotationBlock(entry.annotation, entry.paperTitle, entry.id));
  const content =
    blocks.length === 0
      ? priorContent
      : [priorContent.trimEnd(), ...blocks].filter((part) => part !== "").join("\n\n");

  const targets: CommitCanonicalInput["targets"] = [];
  let note: CanonicalObject;
  if (existing === null) {
    note = withHash({
      $schema: objectSchemaUri("note"),
      id: input.newNoteId,
      type: "note",
      schema_version: OBJECT_SCHEMA_VERSION,
      title: input.newNoteTitle.trim().normalize("NFC"),
      lifecycle: "active",
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      updated_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      provenance: [],
      tags: [],
      extensions: {},
      content,
    });
  } else {
    note = withHash({
      ...existing.object,
      content,
      updated_at: input.now,
      updated_by: input.actor,
      version: existing.object.version + 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
    });
  }
  const serialized = prettyJson(note);
  targets.push(
    { relativePath: existing?.relativePath ?? canonicalObjectPath(note), after: serialized },
    { relativePath: checkpointPath(note.id, note.version), after: serialized },
  );

  // A relation per newly quoted annotation, so the note shows which papers it draws on and a
  // paper shows which notes quote it.
  fresh.forEach((entry, index) => {
    const relationId = input.relationIds[index];
    if (relationId === undefined) return;
    const relation = withHash({
      $schema: RELATION_SCHEMA,
      id: relationId,
      type: "quotes",
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: note.id },
      object: { object_id: entry.id },
      assertion: "asserted" as const,
      qualifiers: {},
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    targets.push({ relativePath: relationPath(relation), after: prettyJson(relation) });
  });

  const event = domainEvent(input, "note.quoted", {
    object_ids: [note.id, ...fresh.map((entry) => entry.id)],
    prior_version: existing?.object.version ?? null,
    new_version: note.version,
    prior_hash: existing?.object.content_hash ?? null,
    new_hash: note.content_hash,
    snapshot: note,
  });
  await commitCanonical(commitInput(input, event, targets));
  return { note, added: fresh.length, skipped: gathered.length - fresh.length };
}

/** Raised when the manuscript a passage was sent to is gone, is not one, or has moved on. */
export class ManuscriptTargetError extends Error {
  constructor(readonly kind: "not_found" | "not_a_manuscript" | "no_such_section") {
    super(
      kind === "not_a_manuscript"
        ? "That is not a Manuscript."
        : kind === "no_such_section"
          ? "That section is no longer in this manuscript."
          : "That Manuscript was not found.",
    );
    this.name = "ManuscriptTargetError";
  }
}

/**
 * A passage that is not a mark yet, sent straight from what somebody has selected.
 *
 * The highlight is made on the way past, for the same reason it is when a passage is sent to a
 * claim: a quotation in a draft that cannot be found again on the page it came from is a
 * quotation somebody has to go looking for later.
 */
export interface ManuscriptExcerpt {
  /** The Paper the passage was read in. */
  objectId: string;
  annotationId: string;
  relationId: string;
  annotation: Annotation;
}

export interface SendToManuscriptInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  manuscriptId: string;
  /** The heading to write under, or null for the end of the manuscript. */
  section: string | null;
  excerpt: ManuscriptExcerpt | null;
  /** Marks that already exist, sent from the sidebar. */
  annotationIds: string[];
  /** One per quotation written, the excerpt first. */
  relationIds: string[];
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/** A passage on its way into a draft, with what its attribution line will need to say. */
interface Quotable {
  id: string;
  annotation: Annotation;
  paperId: string;
  paperTitle: string;
}

export interface SendToManuscriptReceipt {
  manuscript: CanonicalObject;
  /** The heading it went under, or null when it went to the end. */
  section: string | null;
  added: number;
  /** Passages this manuscript was already quoting. */
  skipped: number;
  /** The mark this send made on the way past, when it made one. */
  annotationId: string | null;
}

/** Where a quotation says it came from, and the marker that names the mark it came from. */
function attribution(annotation: Annotation, paperTitle: string, annotationId: string): string {
  const source = paperTitle.replaceAll(/\s+/gu, " ").trim();
  return `— ${source}, p. ${annotation.page_label} [[kiwi:annotation/${annotationId}]]`;
}

/**
 * One quotation, as it will read in a rich manuscript.
 *
 * A blockquote and a line saying where it came from. That line is a node rather than words: it
 * carries the mark the passage was taken from, which is what stops the same passage being
 * written in twice and what lets a reader click it and land on the page it was read on.
 */
function quotationNodes(
  annotation: Annotation,
  paperTitle: string,
  paperId: string,
  annotationId: string,
): DocumentNode[] {
  const quoted = annotation.quoted.trim();
  const comment = annotation.comment.trim();
  const nodes: DocumentNode[] = [
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: quoted === "" ? `Figure on page ${annotation.page_label}` : quoted,
            },
          ],
        },
      ],
    },
  ];
  // What the reader wrote about the passage is theirs, and goes in as prose rather than inside
  // the quotation: it is not part of what the paper said.
  if (comment !== "") nodes.push({ type: "paragraph", content: [{ type: "text", text: comment }] });
  nodes.push({
    type: "paragraph",
    content: [
      {
        type: QUOTATION_NODE,
        attrs: {
          annotation: annotationId,
          // The paper as well as the mark, so the line is still worth clicking after the mark
          // is deleted. It goes to the paper then: less than was asked for, and much more than
          // a click that does nothing.
          target: paperId,
          source: paperTitle.replaceAll(/\s+/gu, " ").trim(),
          page_label: annotation.page_label,
        },
      },
    ],
  });
  return nodes;
}

/**
 * One quotation, as it will read in a LaTeX manuscript.
 *
 * The attribution is a comment rather than text. A draft needs to know where a quotation came
 * from; the typeset paper needs a citation, which is a decision the writer makes with the
 * bibliography in front of them, and a line of unformatted prose appearing in the PDF would be
 * this tool making that decision for them.
 */
function quotationSource(annotation: Annotation, paperTitle: string, annotationId: string): string {
  const quoted = annotation.quoted.trim();
  const comment = annotation.comment.trim();
  const lines = [
    "\\begin{quote}",
    escapeLatex(quoted === "" ? `Figure on page ${annotation.page_label}` : quoted),
    "\\end{quote}",
  ];
  if (comment !== "") lines.push(escapeLatex(comment));
  lines.push(`% ${attribution(annotation, paperTitle, annotationId).replaceAll("\n", " ")}`);
  return lines.join("\n");
}

/**
 * Sends what somebody is reading into a section of a manuscript, in one transaction.
 *
 * The quotation, the mark it was made from, and the relation tying the draft to the paper are
 * written together. A draft that quotes a passage nothing points at is a draft whose sources
 * have to be reconstructed by hand at the end, which is the thing this is for avoiding.
 *
 * The manuscript's version goes up, as it would for any edit. Somebody with it open is holding
 * the version they loaded, so their next save meets the ordinary conflict rather than quietly
 * writing over a quotation that arrived while they were typing.
 */
export async function sendExcerptToManuscript(
  input: SendToManuscriptInput,
): Promise<SendToManuscriptReceipt> {
  return withCanonicalWrite(input.root, () => sendExcerptToManuscriptUnlocked(input));
}

async function sendExcerptToManuscriptUnlocked(
  input: SendToManuscriptInput,
): Promise<SendToManuscriptReceipt> {
  const stored = await readCanonicalObject(input.root, input.manuscriptId);
  if (stored === null) throw new ManuscriptTargetError("not_found");
  if (stored.object.type !== "output") throw new ManuscriptTargetError("not_a_manuscript");

  // The excerpt first: it is the passage in front of the person doing the sending, and the
  // marks from the sidebar follow it in the order they sit on the page.
  const gathered: Quotable[] = [];
  if (input.excerpt !== null) {
    const problems = validateAnnotation(input.excerpt.annotation);
    if (problems.length > 0) throw new AnnotationValidationError(problems);
    const paper = await readCanonicalObject(input.root, input.excerpt.objectId);
    if (paper === null) throw new Error("Object not found.");
    gathered.push({
      id: input.excerpt.annotationId,
      annotation: input.excerpt.annotation,
      paperId: input.excerpt.objectId,
      paperTitle: String(paper.object.title),
    });
  }
  const fromSidebar: Quotable[] = [];
  for (const annotationId of input.annotationIds) {
    const mark = await readCanonicalObject(input.root, annotationId);
    if (mark === null || mark.object.type !== "annotation") continue;
    const annotation = readAnnotation(mark.object["annotation"]);
    if (annotation === null) continue;
    const links = await relationsForObject(input.root, annotationId);
    const paperId = links.find(
      (link) => link.direction === "outgoing" && link.relation.type === ANNOTATES_RELATION,
    )?.relation.object.object_id;
    const paper = paperId === undefined ? null : await readCanonicalObject(input.root, paperId);
    fromSidebar.push({
      id: annotationId,
      annotation,
      paperId: paperId ?? "",
      paperTitle: paper === null ? "Unknown source" : String(paper.object.title),
    });
  }
  fromSidebar.sort((left, right) => compareAnnotations(left.annotation, right.annotation));
  gathered.push(...fromSidebar);

  const mode: DocumentMode = stored.object["document_mode"] === "latex" ? "latex" : "rich";
  const source = stored.object.content;
  const tree = mode === "latex" ? null : readDocument(stored.object["document"]);
  // A rich draft carries its quotations as nodes and a LaTeX one as markers in the source, so
  // what a second send has to check is read from whichever of the two this draft is.
  const already = tree === null ? quotedAnnotationIds(source) : quotedAnnotations(tree);
  const fresh = gathered.filter((entry) => !already.has(entry.id));
  const sections = manuscriptSections(mode, tree, source);
  const section = input.section === null ? null : sectionNamed(sections, input.section);
  if (section === null && input.section !== null)
    throw new ManuscriptTargetError("no_such_section");
  const at = section === null ? endOfManuscript(mode, tree, source) : section.end;

  let content: string;
  const body: Record<string, unknown> = {};
  if (tree === null) {
    const written = fresh.map((entry) =>
      quotationSource(entry.annotation, entry.paperTitle, entry.id),
    );
    content = written.length === 0 ? source : insertInSource(source, at, written.join("\n\n"));
    body["document_mode"] = "latex";
  } else {
    const blocks = fresh.flatMap((entry) =>
      quotationNodes(entry.annotation, entry.paperTitle, entry.paperId, entry.id),
    );
    const written = blocks.length === 0 ? tree : insertInDocument(tree, at, blocks);
    // Derived here as it is on every other save, so the words search reads cannot drift from
    // the words the manuscript says.
    content = documentText(written);
    body["document_mode"] = "rich";
    body["document"] = written;
  }

  const targets: CommitCanonicalInput["targets"] = [];
  const manuscript = withHash({
    ...stored.object,
    ...body,
    content,
    updated_at: input.now,
    updated_by: input.actor,
    version: stored.object.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
  });
  const serialized = prettyJson(manuscript);
  targets.push(
    { relativePath: stored.relativePath, after: serialized },
    { relativePath: checkpointPath(manuscript.id, manuscript.version), after: serialized },
  );

  let annotationId: string | null = null;
  if (input.excerpt !== null) {
    const { annotation, objectId, annotationId: markId, relationId } = input.excerpt;
    const mark = annotationObject({ ...input, annotationId: markId, annotation });
    const annotates = withHash({
      $schema: RELATION_SCHEMA,
      id: relationId,
      type: ANNOTATES_RELATION,
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: mark.id },
      object: { object_id: objectId },
      assertion: "asserted" as const,
      qualifiers: { page: annotation.page, asset_id: annotation.asset_id },
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    const serializedMark = prettyJson(mark);
    targets.push(
      { relativePath: canonicalObjectPath(mark), after: serializedMark },
      { relativePath: checkpointPath(mark.id, mark.version), after: serializedMark },
      { relativePath: relationPath(annotates), after: prettyJson(annotates) },
    );
    annotationId = mark.id;
  }

  // A relation per newly quoted passage, so the manuscript shows what it draws on and a paper
  // shows which drafts are using it.
  fresh.forEach((entry, index) => {
    const relationId = input.relationIds[index];
    if (relationId === undefined) return;
    const relation = withHash({
      $schema: RELATION_SCHEMA,
      id: relationId,
      type: "quotes",
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: manuscript.id },
      object: { object_id: entry.id },
      assertion: "asserted" as const,
      qualifiers: {},
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    targets.push({ relativePath: relationPath(relation), after: prettyJson(relation) });
  });

  const event = domainEvent(input, "manuscript.quoted", {
    object_ids: [manuscript.id, ...fresh.map((entry) => entry.id)],
    prior_version: stored.object.version,
    new_version: manuscript.version,
    prior_hash: stored.object.content_hash,
    new_hash: manuscript.content_hash,
    section: section?.title ?? null,
    snapshot: manuscript,
  });
  await commitCanonical(commitInput(input, event, targets));
  return {
    manuscript,
    section: section?.title ?? null,
    added: fresh.length,
    skipped: gathered.length - fresh.length,
    annotationId,
  };
}

/** Ties a comment thread to the thing it is a comment on. */
export const COMMENTS_ON_RELATION = "comments_on";

export class ThreadValidationError extends Error {
  constructor(readonly problems: ThreadProblem[]) {
    super("Correct the comment before saving.");
    this.name = "ThreadValidationError";
  }
}

/**
 * Raised when someone edits a message they did not write.
 *
 * A thread is a record of who said what. Editing another person's words would make that record
 * a lie, and the version history would show the lie as their revision.
 */
export class ThreadMessageNotYours extends Error {
  constructor(readonly messageId: string) {
    super("You can only edit your own comment.");
    this.name = "ThreadMessageNotYours";
  }
}

/** Raised when the thread is gone: deleted, or never there. Typed so a command can say so. */
export class ThreadNotFound extends Error {
  constructor(readonly threadId: string) {
    super("Comment thread not found.");
    this.name = "ThreadNotFound";
  }
}

export class ThreadMessageMissing extends Error {
  constructor(readonly messageId: string) {
    super("That comment is no longer in the thread.");
    this.name = "ThreadMessageMissing";
  }
}

export interface StoredThread {
  object: CanonicalObject;
  thread: ThreadBody;
}

/**
 * A write that may have changed nothing.
 *
 * Resolving a resolved thread is not a failure and must not be a new version either, two people
 * clicking Resolve on the same thread should leave one record, not two.
 */
export interface ThreadWrite {
  object: CanonicalObject;
  changed: boolean;
}

/**
 * A thread's canonical object, from its body.
 *
 * Exported because sync writes threads too: a merge of two replicas ends here, so that a merged
 * thread is titled, indexed, versioned, and hashed exactly as a replied-to one is.
 */
export function threadObject(
  input: { threadId: string; actor: string; now: string } & CanonicalIds,
  thread: ThreadBody,
  base?: CanonicalObject,
): CanonicalObject {
  return withHash({
    ...(base ?? {}),
    $schema: objectSchemaUri("thread"),
    id: input.threadId,
    type: "thread",
    schema_version: OBJECT_SCHEMA_VERSION,
    title: threadTitle(thread),
    lifecycle: "active",
    created_at: base?.created_at ?? input.now,
    updated_at: input.now,
    created_by: base?.created_by ?? input.actor,
    updated_by: input.actor,
    version: (base?.version ?? 0) + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: base?.sensitivity ?? ("internal" as const),
    provenance: base?.provenance ?? [],
    tags: base?.tags ?? [],
    extensions: base?.extensions ?? {},
    // Every message, so that searching the workspace for a phrase finds the conversation about
    // it and not only the document it is about.
    content: threadContent(thread),
    thread,
  });
}

function newThreadMessage(input: {
  messageId: string;
  body: string;
  authorName: string;
  actor: string;
  now: string;
}): ThreadMessage {
  return {
    id: input.messageId,
    author_id: input.actor,
    author_name: input.authorName,
    body: input.body,
    created_at: input.now,
    edited_at: null,
  };
}

export interface StartThreadInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  threadId: string;
  relationId: string;
  messageId: string;
  anchor: ThreadAnchor;
  body: string;
  authorName: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Starts a comment thread on something.
 *
 * The thread is its own object, like an annotation and for the same reason: a manuscript with
 * forty margin comments would otherwise be rewritten forty times, and each conversation deserves
 * its own history. The `comments_on` relation is what makes the comment turn up in the backlinks
 * of the thing it is about.
 */
export async function createThread(input: StartThreadInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createThreadUnlocked(input));
}

async function createThreadUnlocked(input: StartThreadInput): Promise<CanonicalObject> {
  const thread = startThread(input.anchor, newThreadMessage(input));
  const problems = validateThread(thread);
  if (problems.length > 0) throw new ThreadValidationError(problems);
  const subject = await readCanonicalObject(input.root, input.anchor.object_id);
  if (subject === null) throw new Error("Object not found.");

  const object = threadObject(input, thread);
  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: COMMENTS_ON_RELATION,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: object.id },
    object: { object_id: input.anchor.object_id },
    assertion: "asserted" as const,
    qualifiers: { anchor_kind: input.anchor.kind },
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });

  const event = domainEvent(input, "thread.started", {
    object_ids: [object.id, input.anchor.object_id],
    relation_ids: [relation.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      { relativePath: relationPath(relation), after: prettyJson(relation) },
    ]),
  );
  return object;
}

export interface ThreadWriteInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  threadId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

async function readStoredThread(
  root: string,
  threadId: string,
): Promise<StoredThread & { relativePath: string }> {
  const stored = await readCanonicalObject(root, threadId);
  const thread = stored === null ? null : readThread(stored.object["thread"]);
  if (stored === null || stored.object.type !== "thread" || thread === null) {
    throw new ThreadNotFound(threadId);
  }
  return { object: stored.object, relativePath: stored.relativePath, thread };
}

/**
 * Reads a thread, changes it, and writes it back.
 *
 * `change` returning the thread it was handed means nothing happened, and nothing is written.
 * That is what makes resolving and reopening idempotent without either of them having to know
 * how a thread is stored.
 */
async function changeThread(
  input: ThreadWriteInput,
  eventType: string,
  change: (thread: ThreadBody) => ThreadBody,
): Promise<ThreadWrite> {
  return withCanonicalWrite(input.root, () => changeThreadUnlocked(input, eventType, change));
}

async function changeThreadUnlocked(
  input: ThreadWriteInput,
  eventType: string,
  change: (thread: ThreadBody) => ThreadBody,
): Promise<ThreadWrite> {
  const current = await readStoredThread(input.root, input.threadId);
  const next = change(current.thread);
  if (next === current.thread) return { object: current.object, changed: false };
  const problems = validateThread(next);
  if (problems.length > 0) throw new ThreadValidationError(problems);

  const object = threadObject(input, next, current.object);
  const event = domainEvent(input, eventType, {
    object_ids: [object.id],
    prior_version: current.object.version,
    new_version: object.version,
    prior_hash: current.object.content_hash,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  const nextPath = canonicalObjectPath(object);
  await commitCanonical(
    commitInput(input, event, [
      // Editing the opening message retitles the thread, which moves its file.
      ...(nextPath === current.relativePath
        ? [{ relativePath: current.relativePath, after: serialized }]
        : [
            { relativePath: nextPath, after: serialized },
            { relativePath: current.relativePath, after: null },
          ]),
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
    ]),
  );
  return { object, changed: true };
}

export interface ReplyToThreadInput extends ThreadWriteInput {
  messageId: string;
  body: string;
  authorName: string;
}

/**
 * Appends a reply.
 *
 * There is no expected version here, and that is deliberate. Optimistic concurrency exists to
 * stop one person's save from silently erasing another's, and an append erases nothing: two
 * replies written in the same second both belong in the thread.
 */
export async function addThreadReply(input: ReplyToThreadInput): Promise<CanonicalObject> {
  const written = await changeThread(input, "thread.replied", (thread) =>
    replyToThread(thread, newThreadMessage(input)),
  );
  return written.object;
}

export interface EditThreadMessageInput extends ThreadWriteInput {
  messageId: string;
  body: string;
}

/** Rewrites one's own message. The words as they were stay in the thread's version history. */
export async function editThreadMessage(input: EditThreadMessageInput): Promise<CanonicalObject> {
  const written = await changeThread(input, "thread.message-edited", (thread) => {
    const existing = thread.messages.find((message) => message.id === input.messageId);
    if (existing === undefined) throw new ThreadMessageMissing(input.messageId);
    if (existing.author_id !== input.actor) throw new ThreadMessageNotYours(input.messageId);
    if (existing.body === input.body) return thread;
    return withThreadMessages(
      thread,
      thread.messages.map((message) =>
        message.id === input.messageId
          ? { ...message, body: input.body, edited_at: input.now }
          : message,
      ),
    );
  });
  return written.object;
}

export interface SetThreadStatusInput extends ThreadWriteInput {
  status: ThreadStatus;
}

/** Resolves or reopens. Doing either twice is doing it once. */
export async function setThreadStatus(input: SetThreadStatusInput): Promise<ThreadWrite> {
  const eventType = input.status === "resolved" ? "thread.resolved" : "thread.reopened";
  return changeThread(input, eventType, (thread) => {
    if (thread.status === input.status) return thread;
    if (input.status === "open") {
      return { ...thread, status: "open", resolved_by: null, resolved_at: null };
    }
    return { ...thread, status: "resolved", resolved_by: input.actor, resolved_at: input.now };
  });
}

export interface MoveThreadAnchorInput extends ThreadWriteInput {
  from: number;
  to: number;
  quote: string;
}

/**
 * Points an orphaned thread at a passage again.
 *
 * The quotation is replaced along with the positions, because the words someone selected are
 * what the comment is about now. Keeping the old quotation would orphan the thread again the
 * next time the document loaded.
 */
export async function moveThreadAnchor(input: MoveThreadAnchorInput): Promise<CanonicalObject> {
  const written = await changeThread(input, "thread.reanchored", (thread) =>
    reanchorThread(thread, input.from, input.to, input.quote),
  );
  return written.object;
}

export interface ThreadQuery {
  /** Threads anchored to this object. */
  objectId?: string;
  status?: ThreadStatus;
  /** Threads this account has written in. */
  participant?: string;
  /** Threads that mention this account. */
  mentions?: string;
  /**
   * Threads this account has written in *or* is named in.
   *
   * `participant` and `mentions` narrow together, which is the wrong shape for the one question
   * a person actually asks about themselves: what is going on that I am part of. Being named in a
   * conversation you have not answered yet is the case that matters most, and it is exactly the
   * one an intersection loses.
   */
  involving?: string;
  /** Threads on anything filed in this project. */
  projectId?: string;
}

/** Every object filed in a project, and the project itself, read in one pass over the relations. */
async function objectsInProject(root: string, projectId: string): Promise<Set<string>> {
  const inside = new Set<string>([projectId]);
  for (const relation of await listCanonicalRelations(root)) {
    if (relation.assertion !== "asserted" || relation.type !== IN_PROJECT_RELATION) continue;
    if (relation.object.object_id === projectId) inside.add(relation.subject.object_id);
  }
  return inside;
}

/**
 * The threads a surface wants, oldest first.
 *
 * `participant` and `mentions` are answered from the arrays the thread carries rather than by
 * opening every message, which is the whole reason those arrays are denormalised. The order is
 * the order the conversations were started; a surface that wants document order has the anchor
 * positions, and one that wants newest first can reverse a list it already has.
 */
export async function listThreads(root: string, query: ThreadQuery = {}): Promise<StoredThread[]> {
  const scope =
    query.projectId === undefined ? null : await objectsInProject(root, query.projectId);
  const found: StoredThread[] = [];
  for (const object of await listCanonicalObjects(root)) {
    if (object.type !== "thread" || object.lifecycle !== "active") continue;
    const thread = readThread(object["thread"]);
    if (thread === null) continue;
    if (query.objectId !== undefined && thread.anchor.object_id !== query.objectId) continue;
    if (query.status !== undefined && thread.status !== query.status) continue;
    if (query.participant !== undefined && !thread.participants.includes(query.participant)) {
      continue;
    }
    if (query.mentions !== undefined && !thread.mentions.includes(query.mentions)) continue;
    if (
      query.involving !== undefined &&
      !thread.participants.includes(query.involving) &&
      !thread.mentions.includes(query.involving)
    ) {
      continue;
    }
    if (scope !== null && !scope.has(thread.anchor.object_id)) continue;
    found.push({ object, thread });
  }
  return found.sort((left, right) => left.object.created_at.localeCompare(right.object.created_at));
}

/** What a task is for: the paper, the run, the manuscript it is work on. */
export const TASK_FOR_RELATION = "task_for";

export class TaskValidationError extends Error {
  constructor(readonly problems: TaskProblem[]) {
    super("Correct the task before saving.");
    this.name = "TaskValidationError";
  }
}

export class TaskNotFound extends Error {
  constructor(readonly taskId: string) {
    super("Task not found.");
    this.name = "TaskNotFound";
  }
}

/**
 * Raised when waiting would run in a circle.
 *
 * The message names every step, because the ids mean nothing to the person who clicked and the
 * titles are the only way they will find the three tasks among forty.
 */
export class TaskBlockingCycle extends Error {
  constructor(readonly chain: string[]) {
    super(`That would make a loop: ${chain.join(" waits for ")}.`);
    this.name = "TaskBlockingCycle";
  }
}

export class TaskLinkError extends Error {
  constructor(
    readonly reason: "already_linked" | "not_linked",
    message: string,
  ) {
    super(message);
    this.name = "TaskLinkError";
  }
}

export interface StoredTask {
  object: CanonicalObject;
  task: TaskBody;
}

/**
 * A write that may have changed nothing.
 *
 * Ticking a finished task off again is not a failure and must not be a new version either. See
 * `completeTask` in contracts: the second click keeps the time the work was finished.
 */
export interface TaskWrite {
  object: CanonicalObject;
  changed: boolean;
}

/**
 * A task's canonical object, from its body and its title.
 *
 * The title is the work, "Re-run the power analysis", and lives where every other object keeps
 * its title, so search, history, and the Links dock need to learn nothing new about tasks.
 */
export function taskObject(
  input: { taskId: string; actor: string; now: string } & CanonicalIds,
  task: TaskBody,
  title: string,
  base?: CanonicalObject,
): CanonicalObject {
  return withHash({
    ...(base ?? {}),
    $schema: objectSchemaUri("task"),
    id: input.taskId,
    type: "task",
    schema_version: OBJECT_SCHEMA_VERSION,
    title,
    lifecycle: "active",
    created_at: base?.created_at ?? input.now,
    updated_at: input.now,
    created_by: base?.created_by ?? input.actor,
    updated_by: input.actor,
    version: (base?.version ?? 0) + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: base?.sensitivity ?? ("internal" as const),
    provenance: base?.provenance ?? [],
    tags: base?.tags ?? [],
    extensions: base?.extensions ?? {},
    content: taskContent(task),
    task,
  });
}

export interface CreateTaskInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  taskId: string;
  relationId: string;
  title: string;
  task: TaskBody;
  /** What the work is on, if it is on anything. Written in the same transaction as the task. */
  forObjectId?: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Writes down a piece of work.
 *
 * The thing the task is for is optional and, when it is given, is written as a relation in the
 * same transaction rather than in a second one. A task that exists for a moment attached to
 * nothing is a task that turns up on a board somebody has to guess about.
 */
export async function createTask(input: CreateTaskInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createTaskUnlocked(input));
}

async function createTaskUnlocked(input: CreateTaskInput): Promise<CanonicalObject> {
  const problems = validateTask(input.task);
  if (problems.length > 0) throw new TaskValidationError(problems);
  const title = input.title.trim().normalize("NFC");
  const invalid = validateObjectPublication({ title, content: taskContent(input.task) }).filter(
    (problem) => problem.severity === "error",
  );
  if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);
  if (input.forObjectId !== undefined) {
    const subject = await readCanonicalObject(input.root, input.forObjectId);
    if (subject === null) throw new Error("Object not found.");
  }

  const object = taskObject(input, input.task, title);
  const relation =
    input.forObjectId === undefined
      ? null
      : withHash({
          $schema: RELATION_SCHEMA,
          id: input.relationId,
          type: TASK_FOR_RELATION,
          schema_version: OBJECT_SCHEMA_VERSION,
          subject: { object_id: object.id },
          object: { object_id: input.forObjectId },
          assertion: "asserted" as const,
          qualifiers: {},
          provenance: [],
          created_at: input.now,
          updated_at: input.now,
          created_by: input.actor,
          version: 1,
          last_event_id: input.domainEventId,
          last_transaction_id: input.transactionId,
          sensitivity: "internal" as const,
          extensions: {},
        });

  const event = domainEvent(input, "task.created", {
    object_ids: relation === null ? [object.id] : [object.id, input.forObjectId as string],
    ...(relation === null ? {} : { relation_ids: [relation.id] }),
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      ...(relation === null
        ? []
        : [{ relativePath: relationPath(relation), after: prettyJson(relation) }]),
    ]),
  );
  return object;
}

export interface TaskWriteInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  taskId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

async function readStoredTask(
  root: string,
  taskId: string,
): Promise<StoredTask & { relativePath: string }> {
  const stored = await readCanonicalObject(root, taskId);
  const task = stored === null ? null : readTask(stored.object["task"]);
  if (stored === null || stored.object.type !== "task" || task === null) {
    throw new TaskNotFound(taskId);
  }
  return { object: stored.object, relativePath: stored.relativePath, task };
}

/**
 * Reads a task, changes it, and writes it back.
 *
 * `change` returning the task it was handed, or the same title, means nothing happened and
 * nothing is written. That is what makes completing and reopening idempotent without either of
 * them having to know how a task is stored.
 */
async function changeTask(
  input: TaskWriteInput,
  eventType: string,
  change: (current: StoredTask) => { task: TaskBody; title: string },
): Promise<TaskWrite> {
  return withCanonicalWrite(input.root, () => changeTaskUnlocked(input, eventType, change));
}

async function changeTaskUnlocked(
  input: TaskWriteInput,
  eventType: string,
  change: (current: StoredTask) => { task: TaskBody; title: string },
): Promise<TaskWrite> {
  const current = await readStoredTask(input.root, input.taskId);
  const next = change(current);
  if (next.task === current.task && next.title === current.object.title) {
    return { object: current.object, changed: false };
  }
  const problems = validateTask(next.task);
  if (problems.length > 0) throw new TaskValidationError(problems);
  const invalid = validateObjectPublication({
    title: next.title,
    content: taskContent(next.task),
  }).filter((problem) => problem.severity === "error");
  if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);

  const object = taskObject(input, next.task, next.title, current.object);
  const event = domainEvent(input, eventType, {
    object_ids: [object.id],
    prior_version: current.object.version,
    new_version: object.version,
    prior_hash: current.object.content_hash,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  const nextPath = canonicalObjectPath(object);
  await commitCanonical(
    commitInput(input, event, [
      // Renaming a task moves its file, the way renaming any other object does.
      ...(nextPath === current.relativePath
        ? [{ relativePath: current.relativePath, after: serialized }]
        : [
            { relativePath: nextPath, after: serialized },
            { relativePath: current.relativePath, after: null },
          ]),
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
    ]),
  );
  return { object, changed: true };
}

/** Every task in the workspace, by id, whether or not a board is currently showing it. */
async function tasksById(root: string): Promise<Map<string, StoredTask>> {
  const found = new Map<string, StoredTask>();
  for (const object of await listCanonicalObjects(root)) {
    if (object.type !== "task" || object.lifecycle !== "active") continue;
    const task = readTask(object["task"]);
    if (task !== null) found.set(object.id, { object, task });
  }
  return found;
}

/**
 * Whether a task is still waiting for work that is not finished.
 *
 * A blocker that is no longer in the workspace is not waited for. Somebody deleted it, and a task
 * held in Blocked forever by a task nobody can open is a board that has quietly stopped.
 */
function stillBlocked(task: TaskBody, tasks: ReadonlyMap<string, StoredTask>): boolean {
  return task.blocked_by.some((id) => {
    const blocker = tasks.get(id);
    return blocker !== undefined && blocker.task.status !== "done";
  });
}

/** What each task waits for, which is the graph the cycle check walks. */
function blockingGraph(tasks: ReadonlyMap<string, StoredTask>): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const [id, stored] of tasks) graph.set(id, stored.task.blocked_by);
  return graph;
}

export interface UpdateTaskInput extends TaskWriteInput {
  title?: string;
  status?: TaskStatus;
  assigneeId?: string | null;
  dueOn?: string | null;
  stage?: ProjectPage | null;
  blockedBy?: string[];
  notes?: string;
}

/**
 * Changes what a task says.
 *
 * Every field is optional and an absent one is left alone, because the surfaces that edit a task
 * edit one thing at a time: a due date from a board card, an assignee from a menu. Sending the
 * whole task back would let a stale form quietly undo somebody else's change to a field it was
 * not even showing.
 */
export async function updateTask(input: UpdateTaskInput): Promise<TaskWrite> {
  return withCanonicalWrite(input.root, async () => {
    const tasks = await tasksById(input.root);
    if (input.blockedBy !== undefined) {
      const current = tasks.get(input.taskId);
      const known = current === undefined ? [] : current.task.blocked_by;
      const graph = blockingGraph(tasks);
      for (const blocker of input.blockedBy) {
        if (known.includes(blocker)) continue;
        if (blocker !== input.taskId && !tasks.has(blocker)) {
          throw new TaskNotFound(blocker);
        }
        const cycle = findBlockingCycle(input.taskId, blocker, graph);
        if (cycle !== null) {
          throw new TaskBlockingCycle(
            cycle.map((id) => tasks.get(id)?.object.title ?? "a deleted task"),
          );
        }
      }
    }
    return changeTaskUnlocked(input, "task.updated", (current) => {
      const task: TaskBody = {
        ...current.task,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.assigneeId === undefined ? {} : { assignee_id: input.assigneeId }),
        ...(input.dueOn === undefined ? {} : { due_on: input.dueOn }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.blockedBy === undefined ? {} : { blocked_by: [...new Set(input.blockedBy)] }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      };
      // A task moved out of Done by hand is not finished, whatever the old timestamp said.
      const finished = task.status === "done";
      const settled: TaskBody = finished
        ? { ...task, completed_at: task.completed_at ?? input.now }
        : { ...task, completed_at: null };
      const title = input.title === undefined ? current.object.title : input.title.trim();
      const unchanged =
        JSON.stringify(settled) === JSON.stringify(current.task) && title === current.object.title;
      return { task: unchanged ? current.task : settled, title };
    });
  });
}

/** Marks the work done. Doing it twice is doing it once, and keeps the first time. */
export async function completeStoredTask(input: TaskWriteInput): Promise<TaskWrite> {
  return changeTask(input, "task.completed", (current) => ({
    task: completeTask(current.task, input.now),
    title: current.object.title,
  }));
}

/**
 * Puts the work back on the board.
 *
 * Whether it lands in To do or in Blocked is read from the other tasks here, because this is the
 * layer that can read them. Reopening into To do while what it waits for is unfinished would put
 * work in front of somebody who cannot start it.
 */
export async function reopenStoredTask(input: TaskWriteInput): Promise<TaskWrite> {
  return withCanonicalWrite(input.root, async () => {
    const tasks = await tasksById(input.root);
    return changeTaskUnlocked(input, "task.reopened", (current) => ({
      task: reopenTask(current.task, stillBlocked(current.task, tasks)),
      title: current.object.title,
    }));
  });
}

export interface LinkTaskInput extends TaskWriteInput {
  relationId: string;
  objectId: string;
}

/** Says what a task is work on. */
export async function linkTask(input: LinkTaskInput): Promise<CanonicalRelation> {
  await readStoredTask(input.root, input.taskId);
  if ((await activeTaskRelation(input.root, input.taskId, input.objectId)) !== null) {
    throw new TaskLinkError("already_linked", "That task is already on this.");
  }
  return createRelation({
    ...input,
    type: TASK_FOR_RELATION,
    subjectId: input.taskId,
    objectId: input.objectId,
  });
}

async function activeTaskRelation(
  root: string,
  taskId: string,
  objectId: string,
): Promise<CanonicalRelation | null> {
  for (const { relation, direction } of await relationsForObject(root, taskId)) {
    if (direction !== "outgoing" || relation.type !== TASK_FOR_RELATION) continue;
    if (relation.object.object_id === objectId) return relation;
  }
  return null;
}

/**
 * Takes a task off something.
 *
 * The relation is retracted rather than deleted, the way a detached file's is: the task was on
 * that paper for three weeks, and history should still say so.
 */
export async function unlinkTask(input: LinkTaskInput): Promise<CanonicalRelation> {
  return withCanonicalWrite(input.root, () => unlinkTaskUnlocked(input));
}

async function unlinkTaskUnlocked(input: LinkTaskInput): Promise<CanonicalRelation> {
  const current = await activeTaskRelation(input.root, input.taskId, input.objectId);
  if (current === null) throw new TaskLinkError("not_linked", "That task is not on this.");
  const next = withHash({
    ...current,
    assertion: "retracted" as const,
    updated_at: input.now,
    version: current.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
  });
  const event = domainEvent(input, "relation.retracted", {
    object_ids: [input.taskId, input.objectId],
    relation_ids: [next.id],
    prior_version: current.version,
    new_version: next.version,
    prior_hash: current.content_hash,
    new_hash: next.content_hash,
    snapshot: next,
  });
  const serialized = prettyJson(next);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: relationPath(next), after: serialized },
      { relativePath: relationCheckpointPath(next.id, next.version), after: serialized },
    ]),
  );
  return next;
}

export interface TaskQuery {
  status?: TaskStatus;
  /** Tasks this account is doing. */
  assignee?: string;
  /** Tasks nobody has taken. */
  unassigned?: boolean;
  stage?: ProjectPage;
  /** Tasks that are work on this object. */
  objectId?: string;
  /** Tasks on anything filed in this project, and tasks filed in the project itself. */
  projectId?: string;
}

/** What each task is work on, read in one pass rather than one pass per task. */
async function taskSubjects(root: string): Promise<Map<string, string[]>> {
  const subjects = new Map<string, string[]>();
  for (const relation of await listCanonicalRelations(root)) {
    if (relation.assertion !== "asserted" || relation.type !== TASK_FOR_RELATION) continue;
    const existing = subjects.get(relation.subject.object_id);
    if (existing === undefined)
      subjects.set(relation.subject.object_id, [relation.object.object_id]);
    else existing.push(relation.object.object_id);
  }
  return subjects;
}

/**
 * The tasks a surface wants, soonest due first.
 *
 * One order for every surface, and it is the order the Dashboard needs: `compareDueDates` puts
 * the undated after the dated rather than sorting them among it. A board regroups this by column
 * and keeps the order inside each; a table sorts it again by whatever column was clicked.
 */
export async function listTasks(root: string, query: TaskQuery = {}): Promise<StoredTask[]> {
  const tasks = await tasksById(root);
  const subjects =
    query.objectId === undefined && query.projectId === undefined
      ? new Map<string, string[]>()
      : await taskSubjects(root);
  const scope =
    query.projectId === undefined ? null : await objectsInProject(root, query.projectId);
  const found: StoredTask[] = [];
  for (const stored of tasks.values()) {
    const { task } = stored;
    if (query.status !== undefined && task.status !== query.status) continue;
    if (query.assignee !== undefined && task.assignee_id !== query.assignee) continue;
    if (query.unassigned === true && task.assignee_id !== null) continue;
    if (query.stage !== undefined && task.stage !== query.stage) continue;
    const on = subjects.get(stored.object.id) ?? [];
    if (query.objectId !== undefined && !on.includes(query.objectId)) continue;
    if (scope !== null && !scope.has(stored.object.id) && !on.some((id) => scope.has(id))) continue;
    found.push(stored);
  }
  return found.sort((left, right) => {
    const byDue = compareDueDates(left.task.due_on, right.task.due_on);
    return byDue === 0 ? left.object.created_at.localeCompare(right.object.created_at) : byDue;
  });
}

export interface TrashObjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
  expectedRelations: ObjectTrashRelationGuard[];
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

function verifyRelationHash(relation: CanonicalRelation): boolean {
  return relation.content_hash === sha256(semantic(relation));
}

function isTrashManifest(value: unknown, objectId: string): value is ObjectTrashManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const constraints = record["restoration_constraints"];
  if (
    record["schema_version"] !== 1 ||
    record["object_id"] !== objectId ||
    typeof record["title"] !== "string" ||
    typeof record["object_type"] !== "string" ||
    typeof record["original_path"] !== "string" ||
    typeof record["object_checksum"] !== "string" ||
    typeof record["trashed_at"] !== "string" ||
    typeof record["trashed_by"] !== "string" ||
    typeof record["deletion_event_id"] !== "string" ||
    typeof record["deletion_transaction_id"] !== "string" ||
    !Array.isArray(record["relations"]) ||
    constraints === null ||
    typeof constraints !== "object" ||
    Array.isArray(constraints) ||
    (constraints as Record<string, unknown>)["original_path_must_be_available"] !== true ||
    (constraints as Record<string, unknown>)["relation_tombstones_must_be_current"] !== true
  )
    return false;
  return record["relations"].every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const relation = item as Record<string, unknown>;
    return (
      typeof relation["relative_path"] === "string" &&
      isRelation(relation["prior"]) &&
      typeof relation["tombstone_version"] === "number" &&
      typeof relation["tombstone_hash"] === "string"
    );
  });
}

async function readTrashEntry(root: string, objectId: string): Promise<ObjectTrashEntry> {
  const [manifestRaw, objectRaw] = await Promise.all([
    readFile(join(root, trashManifestPath(objectId)), "utf8").catch(() => null),
    readFile(join(root, trashObjectPath(objectId)), "utf8").catch(() => null),
  ]);
  if (manifestRaw === null || objectRaw === null) throw new ObjectTrashCorruptionError(objectId);
  let manifestValue: unknown;
  let objectValue: unknown;
  try {
    manifestValue = JSON.parse(manifestRaw) as unknown;
    objectValue = JSON.parse(objectRaw) as unknown;
  } catch {
    throw new ObjectTrashCorruptionError(objectId);
  }
  if (
    !isTrashManifest(manifestValue, objectId) ||
    !manifestValue.original_path.startsWith("objects/") ||
    manifestValue.original_path.split("/").some((part) => part === ".." || part === "") ||
    !isObject(objectValue) ||
    objectValue.id !== objectId ||
    objectValue.title !== manifestValue.title ||
    objectValue.type !== manifestValue.object_type ||
    !verifyObjectHash(objectValue) ||
    objectValue.content_hash !== manifestValue.object_checksum ||
    manifestValue.relations.some(
      (item) =>
        item.prior.assertion !== "asserted" ||
        !verifyRelationHash(item.prior) ||
        item.relative_path !== relationPath(item.prior).replaceAll("\\", "/") ||
        item.tombstone_version !== item.prior.version + 1 ||
        (item.prior.subject.object_id !== objectId && item.prior.object.object_id !== objectId),
    )
  )
    throw new ObjectTrashCorruptionError(objectId);
  const relations = manifestValue.relations.map((item) => ({
    relation: item.prior,
    direction:
      item.prior.subject.object_id === objectId ? ("outgoing" as const) : ("incoming" as const),
  }));
  return {
    manifest: manifestValue,
    object: objectValue,
    impact: trashImpact(objectId, relations),
  };
}

export async function listTrash(root: string): Promise<ObjectTrashEntry[]> {
  const folders = await readdir(join(root, ".kiwi", "trash"), { withFileTypes: true }).catch(
    () => [],
  );
  const entries: ObjectTrashEntry[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const [hasManifest, hasObject] = await Promise.all([
      readFile(join(root, trashManifestPath(folder.name)), "utf8")
        .then(() => true)
        .catch(() => false),
      readFile(join(root, trashObjectPath(folder.name)), "utf8")
        .then(() => true)
        .catch(() => false),
    ]);
    if (!hasManifest && !hasObject) continue;
    if (!hasManifest || !hasObject) throw new ObjectTrashCorruptionError(folder.name);
    entries.push(await readTrashEntry(root, folder.name));
  }
  return entries.sort(
    (left, right) =>
      right.manifest.trashed_at.localeCompare(left.manifest.trashed_at) ||
      left.object.id.localeCompare(right.object.id),
  );
}

export async function trashObject(input: TrashObjectInput): Promise<ObjectTrashEntry> {
  return withCanonicalWrite(input.root, async () => {
    const current = await readCanonicalObject(input.root, input.objectId);
    if (current === null) throw new Error("Object not found.");
    if (
      current.object.version !== input.expectedVersion ||
      current.object.content_hash !== input.expectedHash
    )
      throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
    if (
      (await readFile(join(input.root, trashManifestPath(input.objectId)), "utf8").catch(
        () => null,
      )) !== null
    )
      throw new ObjectTrashConflict("This object already has an entry in workspace Trash.");

    const affected = [
      ...new Map(
        (await relationsForObject(input.root, input.objectId)).map((item) => [
          item.relation.id,
          item.relation,
        ]),
      ).values(),
    ];
    const actualRelationGuards = affected
      .map((relation) => ({
        relation_id: relation.id,
        version: relation.version,
        content_hash: relation.content_hash,
      }))
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id));
    const expectedRelationGuards = [...input.expectedRelations].sort((left, right) =>
      left.relation_id.localeCompare(right.relation_id),
    );
    if (
      actualRelationGuards.length !== expectedRelationGuards.length ||
      actualRelationGuards.some((actual, index) => {
        const expected = expectedRelationGuards[index];
        return (
          expected === undefined ||
          expected.relation_id !== actual.relation_id ||
          expected.version !== actual.version ||
          expected.content_hash !== actual.content_hash
        );
      })
    )
      throw new ObjectTrashConflict(
        "Object relations changed after the deletion impact was reviewed.",
      );
    const tombstones = affected.map((relation) =>
      withHash({
        ...relation,
        assertion: "retracted" as const,
        updated_at: input.now,
        version: relation.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      }),
    );
    const manifest: ObjectTrashManifest = {
      schema_version: 1,
      object_id: current.object.id,
      title: current.object.title,
      object_type: current.object.type,
      original_path: current.relativePath.replaceAll("\\", "/"),
      object_checksum: current.object.content_hash,
      trashed_at: input.now,
      trashed_by: input.actor,
      deletion_event_id: input.domainEventId,
      deletion_transaction_id: input.transactionId,
      relations: affected.map((relation, index) => ({
        relative_path: relationPath(relation).replaceAll("\\", "/"),
        prior: relation,
        tombstone_version: tombstones[index]!.version,
        tombstone_hash: tombstones[index]!.content_hash,
      })),
      restoration_constraints: {
        original_path_must_be_available: true,
        relation_tombstones_must_be_current: true,
      },
    };
    const event = domainEvent(input, "object.trashed", {
      object_ids: [current.object.id],
      relation_ids: affected.map((relation) => relation.id),
      prior_version: current.object.version,
      prior_hash: current.object.content_hash,
      new_version: null,
      new_hash: null,
      original_path: manifest.original_path,
      snapshot: current.object,
    });
    const objectJson = prettyJson(current.object);
    const targets: CommitCanonicalInput["targets"] = [
      { relativePath: trashObjectPath(current.object.id), after: objectJson },
      { relativePath: trashManifestPath(current.object.id), after: prettyJson(manifest) },
    ];
    for (const tombstone of tombstones) {
      const serialized = prettyJson(tombstone);
      targets.push(
        { relativePath: relationPath(tombstone), after: serialized },
        {
          relativePath: relationCheckpointPath(tombstone.id, tombstone.version),
          after: serialized,
        },
      );
    }
    targets.push({ relativePath: current.relativePath, after: null });
    await commitCanonical(commitInput(input, event, targets));
    return {
      manifest,
      object: current.object,
      impact: trashImpact(
        input.objectId,
        affected.map((relation) => ({
          relation,
          direction:
            relation.subject.object_id === input.objectId
              ? ("outgoing" as const)
              : ("incoming" as const),
        })),
      ),
    };
  });
}

export interface RestoreTrashedObjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export async function restoreTrashedObject(input: RestoreTrashedObjectInput): Promise<{
  object: CanonicalObject;
  restored_relation_count: number;
}> {
  return withCanonicalWrite(input.root, async () => {
    const entry = await readTrashEntry(input.root, input.objectId);
    if ((await readCanonicalObject(input.root, input.objectId)) !== null)
      throw new ObjectTrashConflict("An active object already uses this identity.");
    if (
      (await readFile(join(input.root, entry.manifest.original_path), "utf8").catch(() => null)) !==
      null
    )
      throw new ObjectTrashConflict("The original canonical path is no longer available.");

    const currentRelations: CanonicalRelation[] = [];
    for (const record of entry.manifest.relations) {
      const raw = await readFile(join(input.root, record.relative_path), "utf8").catch(() => null);
      let value: unknown;
      try {
        value = raw === null ? null : (JSON.parse(raw) as unknown);
      } catch {
        throw new ObjectTrashConflict("A relation changed while this object was in Trash.");
      }
      if (
        !isRelation(value) ||
        value.assertion !== "retracted" ||
        value.version !== record.tombstone_version ||
        value.content_hash !== record.tombstone_hash ||
        !verifyRelationHash(value)
      )
        throw new ObjectTrashConflict("A relation changed while this object was in Trash.");
      currentRelations.push(value);
    }

    const restoredObject = withHash({
      ...entry.object,
      updated_at: input.now,
      updated_by: input.actor,
      version: entry.object.version + 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      restored_from_trash_event: entry.manifest.deletion_event_id,
    });
    const restoredRelations = entry.manifest.relations.map((record, index) =>
      withHash({
        ...record.prior,
        assertion: "asserted" as const,
        updated_at: input.now,
        version: currentRelations[index]!.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      }),
    );
    const event = domainEvent(input, "object.restored_from_trash", {
      object_ids: [restoredObject.id],
      relation_ids: restoredRelations.map((relation) => relation.id),
      deletion_event_id: entry.manifest.deletion_event_id,
      prior_version: entry.object.version,
      new_version: restoredObject.version,
      prior_hash: entry.object.content_hash,
      new_hash: restoredObject.content_hash,
      snapshot: restoredObject,
    });
    const objectJson = prettyJson(restoredObject);
    const targets: CommitCanonicalInput["targets"] = [
      { relativePath: entry.manifest.original_path, after: objectJson },
      {
        relativePath: checkpointPath(restoredObject.id, restoredObject.version),
        after: objectJson,
      },
    ];
    for (const relation of restoredRelations) {
      const serialized = prettyJson(relation);
      targets.push(
        { relativePath: relationPath(relation), after: serialized },
        {
          relativePath: relationCheckpointPath(relation.id, relation.version),
          after: serialized,
        },
      );
    }
    targets.push(
      { relativePath: trashObjectPath(input.objectId), after: null },
      { relativePath: trashManifestPath(input.objectId), after: null },
    );
    await commitCanonical(commitInput(input, event, targets));
    return { object: restoredObject, restored_relation_count: restoredRelations.length };
  });
}

export interface TrashCleanupPolicy {
  enabled: boolean;
  minimum_age_days: number;
}

export interface TrashPurgeEntry {
  object_id: string;
  title: string;
  object_type: string;
  trashed_at: string;
  object_checksum: string;
  relation_count: number;
  related_object_count: number;
  checkpoint_count: number;
}

export interface TrashPurgePreview {
  scope: "all" | "age";
  entry_count: number;
  relation_count: number;
  related_object_count: number;
  asset_count: number;
  object_checkpoint_count: number;
  relation_checkpoint_count: number;
  checkpoint_count: number;
  entries: TrashPurgeEntry[];
  preview_token: string;
  retained_evidence: {
    event_log: true;
    object_checkpoints: true;
    relation_checkpoints: true;
    permanent_tombstone: true;
  };
  limitations: string[];
}

export interface TrashCleanupPolicyPreview {
  policy: TrashCleanupPolicy;
  base_updated_at: string;
  eligible_count: number;
  eligible_entries: Array<Pick<TrashPurgeEntry, "object_id" | "title" | "trashed_at">>;
  preview_token: string;
}

function validateTrashCleanupPolicy(policy: TrashCleanupPolicy): void {
  if (
    typeof policy.enabled !== "boolean" ||
    !Number.isInteger(policy.minimum_age_days) ||
    policy.minimum_age_days < 1 ||
    policy.minimum_age_days > 3650
  )
    throw new Error("Trash cleanup age must be between 1 and 3650 days.");
}

interface TrashPolicyManifest {
  manifest: WorkspaceManifest;
  policy: TrashCleanupPolicy;
}

function trashCleanupPolicyFromManifest(manifest: WorkspaceManifest): TrashCleanupPolicy {
  const features = manifest.features;
  const value =
    features !== undefined && features !== null && typeof features === "object"
      ? (features as Record<string, unknown>)["trash_cleanup"]
      : undefined;
  if (value === undefined) return { enabled: false, minimum_age_days: 30 };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ObjectTrashCorruptionError("policy");
  const record = value as Record<string, unknown>;
  if (
    typeof record["enabled"] !== "boolean" ||
    !Number.isInteger(record["minimum_age_days"]) ||
    Number(record["minimum_age_days"]) < 1 ||
    Number(record["minimum_age_days"]) > 3650
  )
    throw new ObjectTrashCorruptionError("policy");
  return {
    enabled: record["enabled"],
    minimum_age_days: Number(record["minimum_age_days"]),
  };
}

async function trashPolicyManifest(root: string): Promise<TrashPolicyManifest> {
  const raw = await readFile(join(root, MANIFEST_FILENAME), "utf8").catch(() => null);
  const report = readManifest(raw);
  if (report.status !== "ready" || report.manifest === null)
    throw new ObjectTrashCorruptionError("policy");
  return {
    manifest: report.manifest,
    policy: trashCleanupPolicyFromManifest(report.manifest),
  };
}

export async function readTrashCleanupPolicy(root: string): Promise<TrashCleanupPolicy> {
  return (await trashPolicyManifest(root)).policy;
}

function eligibleByAge(entry: ObjectTrashEntry, policy: TrashCleanupPolicy, now: string): boolean {
  const nowMs = Date.parse(now);
  const trashedMs = Date.parse(entry.manifest.trashed_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(trashedMs))
    throw new ObjectTrashCorruptionError(entry.object.id);
  return trashedMs <= nowMs - policy.minimum_age_days * 86_400_000;
}

async function purgeEntrySummary(root: string, entry: ObjectTrashEntry): Promise<TrashPurgeEntry> {
  const checkpoints = await readdir(join(root, ".kiwi", "checkpoints", entry.object.id), {
    withFileTypes: true,
  }).catch(() => []);
  return {
    object_id: entry.object.id,
    title: entry.object.title,
    object_type: entry.object.type,
    trashed_at: entry.manifest.trashed_at,
    object_checksum: entry.object.content_hash,
    relation_count: entry.impact.relation_count,
    related_object_count: entry.impact.related_object_count,
    checkpoint_count: checkpoints.filter((item) => item.isFile() && item.name.endsWith(".json"))
      .length,
  };
}

async function selectedTrashEntries(
  root: string,
  scope: "all" | "age",
  now: string,
): Promise<{ entries: ObjectTrashEntry[]; policy: TrashCleanupPolicy }> {
  const [entries, policy] = await Promise.all([listTrash(root), readTrashCleanupPolicy(root)]);
  if (scope === "age" && !policy.enabled)
    throw new ObjectTrashConflict("Enable age cleanup before running it.");
  return {
    entries:
      scope === "age" ? entries.filter((entry) => eligibleByAge(entry, policy, now)) : entries,
    policy,
  };
}

async function buildTrashPurgePreview(
  root: string,
  scope: "all" | "age",
  now: string,
): Promise<TrashPurgePreview> {
  const selected = await selectedTrashEntries(root, scope, now);
  const summaries = await Promise.all(
    selected.entries.map((entry) => purgeEntrySummary(root, entry)),
  );
  const relationIds = new Set<string>();
  const relatedObjectIds = new Set<string>();
  for (const entry of selected.entries) {
    for (const record of entry.manifest.relations) {
      relationIds.add(record.prior.id);
      const relatedId =
        record.prior.subject.object_id === entry.object.id
          ? record.prior.object.object_id
          : record.prior.subject.object_id;
      if (relatedId !== entry.object.id) relatedObjectIds.add(relatedId);
    }
  }
  const objectCheckpointCount = summaries.reduce(
    (total, entry) => total + entry.checkpoint_count,
    0,
  );
  const relationCheckpointCounts = await Promise.all(
    [...relationIds].map(async (relationId) => {
      const checkpoints = await readdir(join(root, ".kiwi", "relation-checkpoints", relationId), {
        withFileTypes: true,
      }).catch(() => []);
      return checkpoints.filter((item) => item.isFile() && item.name.endsWith(".json")).length;
    }),
  );
  const relationCheckpointCount = relationCheckpointCounts.reduce(
    (total, count) => total + count,
    0,
  );
  const tokenState = {
    scope,
    policy: scope === "age" ? selected.policy : null,
    entries: selected.entries.map((entry) => ({
      object_id: entry.object.id,
      object_checksum: entry.object.content_hash,
      deletion_event_id: entry.manifest.deletion_event_id,
      deletion_transaction_id: entry.manifest.deletion_transaction_id,
      relations: entry.manifest.relations.map((record) => ({
        relation_id: record.prior.id,
        tombstone_version: record.tombstone_version,
        tombstone_hash: record.tombstone_hash,
      })),
    })),
  };
  return {
    scope,
    entry_count: summaries.length,
    relation_count: relationIds.size,
    related_object_count: relatedObjectIds.size,
    asset_count: selected.entries.filter(
      (entry) => entry.object.type === "asset" || entry.object.type === "artifact",
    ).length,
    object_checkpoint_count: objectCheckpointCount,
    relation_checkpoint_count: relationCheckpointCount,
    checkpoint_count: objectCheckpointCount + relationCheckpointCount,
    entries: summaries,
    preview_token: sha256(tokenState),
    retained_evidence: {
      event_log: true,
      object_checkpoints: true,
      relation_checkpoints: true,
      permanent_tombstone: true,
    },
    limitations: [
      "Canonical event and version history remain under the workspace history policy.",
      "Copies may remain in backups, synchronized replicas, exports, or user-controlled Git history.",
      "This command is not a sensitive-history erasure operation.",
    ],
  };
}

export async function previewTrashPurge(input: {
  root: string;
  scope: "all" | "age";
  now: string;
}): Promise<TrashPurgePreview> {
  return buildTrashPurgePreview(input.root, input.scope, input.now);
}

export async function previewTrashCleanupPolicy(input: {
  root: string;
  policy: TrashCleanupPolicy;
  now: string;
}): Promise<TrashCleanupPolicyPreview> {
  validateTrashCleanupPolicy(input.policy);
  const current = await trashPolicyManifest(input.root);
  const entries = await listTrash(input.root);
  const eligible = input.policy.enabled
    ? entries.filter((entry) => eligibleByAge(entry, input.policy, input.now))
    : [];
  const tokenState = {
    current_updated_at: current.manifest.updated_at,
    current_policy: current.policy,
    policy: input.policy,
    eligible: eligible.map((entry) => ({
      object_id: entry.object.id,
      object_checksum: entry.object.content_hash,
      deletion_event_id: entry.manifest.deletion_event_id,
    })),
  };
  return {
    policy: input.policy,
    base_updated_at: current.manifest.updated_at,
    eligible_count: eligible.length,
    eligible_entries: eligible.map((entry) => ({
      object_id: entry.object.id,
      title: entry.object.title,
      trashed_at: entry.manifest.trashed_at,
    })),
    preview_token: sha256(tokenState),
  };
}

export interface SetTrashCleanupPolicyInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  policy: TrashCleanupPolicy;
  previewToken: string;
  actor: string;
  requestId: string;
  now: string;
}

export async function setTrashCleanupPolicy(
  input: SetTrashCleanupPolicyInput,
): Promise<{ policy: TrashCleanupPolicy; changed: boolean }> {
  return withCanonicalWrite(input.root, async () => {
    const preview = await previewTrashCleanupPolicy({
      root: input.root,
      policy: input.policy,
      now: input.now,
    });
    if (preview.preview_token !== input.previewToken)
      throw new ObjectTrashConflict("Trash changed after the cleanup policy was reviewed.");
    const current = await trashPolicyManifest(input.root);
    if (current.manifest.updated_at !== preview.base_updated_at)
      throw new ObjectTrashConflict("Workspace settings changed after the policy was reviewed.");
    if (
      current.policy.enabled === input.policy.enabled &&
      current.policy.minimum_age_days === input.policy.minimum_age_days
    )
      return { policy: current.policy, changed: false };
    const features = {
      ...(current.manifest.features ?? {}),
      trash_cleanup: input.policy,
    };
    const manifest: WorkspaceManifest = {
      ...current.manifest,
      updated_at: input.now,
      features,
    };
    const event = domainEvent(input, "trash.cleanup_policy_changed", {
      prior_policy: current.policy,
      new_policy: input.policy,
      eligible_object_ids: preview.eligible_entries.map((entry) => entry.object_id),
    });
    await commitCanonical(
      commitInput(input, event, [
        { relativePath: MANIFEST_FILENAME, after: serializeManifest(manifest) },
      ]),
    );
    return { policy: input.policy, changed: true };
  });
}

export interface PurgeTrashInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  scope: "all" | "age";
  previewToken: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export interface PurgeTrashReceipt {
  scope: "all" | "age";
  purged_count: number;
  purged_object_ids: string[];
  removed_relation_count: number;
  retained_checkpoint_count: number;
  permanent_tombstone_paths: string[];
  undo: null;
}

function permanentTombstonePath(objectId: string): string {
  return join(".kiwi", "tombstones", `${objectId}.json`);
}

export async function purgeTrash(input: PurgeTrashInput): Promise<PurgeTrashReceipt> {
  return withCanonicalWrite(input.root, async () => {
    const preview = await buildTrashPurgePreview(input.root, input.scope, input.now);
    if (preview.preview_token !== input.previewToken)
      throw new ObjectTrashConflict("Trash changed after permanent deletion was reviewed.");
    if (preview.entry_count === 0)
      return {
        scope: input.scope,
        purged_count: 0,
        purged_object_ids: [],
        removed_relation_count: 0,
        retained_checkpoint_count: 0,
        permanent_tombstone_paths: [],
        undo: null,
      };
    const selected = await selectedTrashEntries(input.root, input.scope, input.now);
    const relationRecords = new Map<string, TrashRelationRecord>();
    for (const entry of selected.entries) {
      if (
        (await readFile(join(input.root, permanentTombstonePath(entry.object.id)), "utf8").catch(
          () => null,
        )) !== null
      )
        throw new ObjectTrashConflict("Permanent tombstone evidence already uses this identity.");
      for (const record of entry.manifest.relations) relationRecords.set(record.prior.id, record);
    }
    for (const record of relationRecords.values()) {
      const raw = await readFile(join(input.root, record.relative_path), "utf8").catch(() => null);
      let relation: unknown;
      try {
        relation = raw === null ? null : (JSON.parse(raw) as unknown);
      } catch {
        throw new ObjectTrashConflict("A relation changed after permanent deletion was reviewed.");
      }
      if (
        !isRelation(relation) ||
        relation.assertion !== "retracted" ||
        relation.version !== record.tombstone_version ||
        relation.content_hash !== record.tombstone_hash ||
        !verifyRelationHash(relation)
      )
        throw new ObjectTrashConflict("A relation changed after permanent deletion was reviewed.");
    }
    const event = domainEvent(input, "trash.purged", {
      object_ids: selected.entries.map((entry) => entry.object.id),
      relation_ids: [...relationRecords.keys()].sort(),
      purge_scope: input.scope,
      retained_checkpoint_count: preview.checkpoint_count,
      history_retained: true,
      undo_available: false,
    });
    const targets: CommitCanonicalInput["targets"] = [];
    const permanentPaths: string[] = [];
    for (const entry of selected.entries) {
      const path = permanentTombstonePath(entry.object.id);
      permanentPaths.push(path.replaceAll("\\", "/"));
      targets.push(
        {
          relativePath: path,
          after: prettyJson({
            schema_version: 1,
            object_id: entry.object.id,
            object_type: entry.object.type,
            object_checksum: entry.object.content_hash,
            deletion_event_id: entry.manifest.deletion_event_id,
            deletion_transaction_id: entry.manifest.deletion_transaction_id,
            purge_event_id: input.domainEventId,
            purge_transaction_id: input.transactionId,
            purged_at: input.now,
            purged_by: input.actor,
            relation_ids: entry.manifest.relations.map((record) => record.prior.id).sort(),
            retained_evidence: {
              event_log: true,
              object_checkpoints: true,
              relation_checkpoints: true,
            },
          }),
        },
        { relativePath: trashObjectPath(entry.object.id), after: null },
        { relativePath: trashManifestPath(entry.object.id), after: null },
      );
    }
    for (const record of relationRecords.values())
      targets.push({ relativePath: record.relative_path, after: null });
    await commitCanonical(commitInput(input, event, targets));
    return {
      scope: input.scope,
      purged_count: selected.entries.length,
      purged_object_ids: selected.entries.map((entry) => entry.object.id),
      removed_relation_count: relationRecords.size,
      retained_checkpoint_count: preview.checkpoint_count,
      permanent_tombstone_paths: permanentPaths,
      undo: null,
    };
  });
}

export interface ObjectOrganizationCollection {
  id: string;
  title: string;
  relation_id: string;
}

export interface ObjectOrganizationSnapshot {
  tags: string[];
  collections: ObjectOrganizationCollection[];
}

export async function objectOrganization(
  root: string,
  objectId: string,
): Promise<ObjectOrganizationSnapshot> {
  const found = await readCanonicalObject(root, objectId);
  if (found === null) throw new Error("Object not found.");
  const objects = new Map((await listCanonicalObjects(root)).map((object) => [object.id, object]));
  const collections: ObjectOrganizationCollection[] = [];
  for (const relation of await listCanonicalRelations(root)) {
    if (
      relation.type !== "in_collection" ||
      relation.assertion !== "asserted" ||
      relation.subject.object_id !== objectId
    )
      continue;
    const collection = objects.get(relation.object.object_id);
    if (collection?.type !== "collection") continue;
    collections.push({ id: collection.id, title: collection.title, relation_id: relation.id });
  }
  return {
    tags: [...found.object.tags],
    collections: collections.sort(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    ),
  };
}

export interface DuplicateObjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
  duplicateObjectId: string;
  relationId: string;
  title: string;
  actor: string;
  requestId: string;
  now: string;
}

export async function duplicateObject(input: DuplicateObjectInput): Promise<{
  object: CanonicalObject;
  relation: CanonicalRelation;
}> {
  return withCanonicalWrite(input.root, async () => {
    const current = await readCanonicalObject(input.root, input.objectId);
    if (current === null) throw new Error("Object not found.");
    if (
      current.object.version !== input.expectedVersion ||
      current.object.content_hash !== input.expectedHash
    )
      throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
    const title = input.title.trim().normalize("NFC");
    if (title === "" || title.length > 200) throw new Error("Invalid duplicate title.");
    const object = withHash({
      ...current.object,
      id: input.duplicateObjectId,
      title,
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      updated_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      duplicated_from: {
        object_id: current.object.id,
        version: current.object.version,
        content_hash: current.object.content_hash,
      },
    });
    const relation = withHash({
      $schema: RELATION_SCHEMA,
      id: input.relationId,
      type: "branched_from",
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: object.id },
      object: { object_id: current.object.id },
      assertion: "asserted" as const,
      qualifiers: { source_version: current.object.version },
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: current.object.sensitivity,
      extensions: {},
    });
    const event = domainEvent(input, "object.duplicated", {
      object_ids: [object.id, current.object.id],
      relation_ids: [relation.id],
      source_object_id: current.object.id,
      source_version: current.object.version,
      prior_version: null,
      new_version: object.version,
      prior_hash: null,
      new_hash: object.content_hash,
      snapshot: object,
    });
    const objectJson = prettyJson(object);
    const relationJson = prettyJson(relation);
    await commitCanonical(
      commitInput(input, event, [
        { relativePath: canonicalObjectPath(object), after: objectJson },
        { relativePath: checkpointPath(object.id, object.version), after: objectJson },
        { relativePath: relationPath(relation), after: relationJson },
        {
          relativePath: relationCheckpointPath(relation.id, relation.version),
          after: relationJson,
        },
      ]),
    );
    return { object, relation };
  });
}

export type CollectionMembershipAction = "collect" | "move" | "remove";

export interface ChangeCollectionMembershipInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  expectedVersion: number;
  expectedHash: string;
  expectedCollectionIds: string[];
  action: CollectionMembershipAction;
  destinationTitle?: string;
  sourceCollectionId?: string;
  collectionObjectId: string;
  relationId: string;
  actor: string;
  requestId: string;
  now: string;
}

export interface CollectionMembershipReceipt {
  action: CollectionMembershipAction;
  object_id: string;
  collection: { id: string; title: string } | null;
  collections: Array<{ id: string; title: string }>;
  changed: boolean;
  undo: {
    action: CollectionMembershipAction;
    destination_title?: string;
    source_collection_id?: string;
    expected_collection_ids: string[];
  } | null;
}

export class ObjectOrganizationConflict extends Error {
  constructor(readonly actualCollectionIds: string[]) {
    super("Collection membership changed before this action completed.");
    this.name = "ObjectOrganizationConflict";
  }
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function changeCollectionMembership(
  input: ChangeCollectionMembershipInput,
): Promise<CollectionMembershipReceipt> {
  return withCanonicalWrite(input.root, async () => {
    const found = await readCanonicalObject(input.root, input.objectId);
    if (found === null) throw new Error("Object not found.");
    if (
      found.object.version !== input.expectedVersion ||
      found.object.content_hash !== input.expectedHash
    )
      throw new ObjectVersionConflict(found.object.version, found.object.content_hash);
    const allObjects = await listCanonicalObjects(input.root);
    const objectById = new Map(allObjects.map((object) => [object.id, object]));
    const relations = await listCanonicalRelations(input.root);
    const active = relations.filter(
      (relation) =>
        relation.type === "in_collection" &&
        relation.assertion === "asserted" &&
        relation.subject.object_id === input.objectId &&
        objectById.get(relation.object.object_id)?.type === "collection",
    );
    const activeIds = active.map((relation) => relation.object.object_id).sort();
    if (!sameIds(activeIds, input.expectedCollectionIds))
      throw new ObjectOrganizationConflict(activeIds);

    const source =
      input.sourceCollectionId === undefined
        ? undefined
        : active.find((relation) => relation.object.object_id === input.sourceCollectionId);
    if ((input.action === "move" || input.action === "remove") && source === undefined)
      throw new ObjectOrganizationConflict(activeIds);

    let destination: CanonicalObject | undefined;
    const destinationTitle = input.destinationTitle?.trim().normalize("NFC");
    if (input.action !== "remove") {
      if (
        destinationTitle === undefined ||
        destinationTitle === "" ||
        destinationTitle.length > 200
      )
        throw new Error("Enter a collection name.");
      destination = allObjects.find(
        (object) =>
          object.type === "collection" &&
          object.title.toLocaleLowerCase("en-US") === destinationTitle.toLocaleLowerCase("en-US"),
      );
    }

    const targets: CommitCanonicalInput["targets"] = [];
    let createdCollection = false;
    if (input.action !== "remove" && destination === undefined) {
      createdCollection = true;
      destination = withHash({
        $schema: COLLECTION_SCHEMA,
        id: input.collectionObjectId,
        type: "collection",
        schema_version: OBJECT_SCHEMA_VERSION,
        title: destinationTitle!,
        lifecycle: "active",
        created_at: input.now,
        updated_at: input.now,
        created_by: input.actor,
        updated_by: input.actor,
        version: 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
        sensitivity: found.object.sensitivity,
        provenance: [],
        tags: [],
        extensions: {},
        content: "",
      });
      const serialized = prettyJson(destination);
      targets.push(
        { relativePath: canonicalObjectPath(destination), after: serialized },
        { relativePath: checkpointPath(destination.id, destination.version), after: serialized },
      );
    }

    const destinationRelation =
      destination === undefined
        ? undefined
        : active.find((relation) => relation.object.object_id === destination!.id);
    const shouldRetract =
      source !== undefined &&
      (input.action !== "move" || source.object.object_id !== destination?.id);
    let nextSource: CanonicalRelation | undefined;
    if (shouldRetract && source !== undefined) {
      nextSource = withHash({
        ...source,
        assertion: "retracted" as const,
        updated_at: input.now,
        version: source.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      });
      const serialized = prettyJson(nextSource);
      targets.push(
        { relativePath: relationPath(nextSource), after: serialized },
        {
          relativePath: relationCheckpointPath(nextSource.id, nextSource.version),
          after: serialized,
        },
      );
    }

    let addedRelation: CanonicalRelation | undefined;
    if (destination !== undefined && destinationRelation === undefined) {
      addedRelation = withHash({
        $schema: RELATION_SCHEMA,
        id: input.relationId,
        type: "in_collection",
        schema_version: OBJECT_SCHEMA_VERSION,
        subject: { object_id: input.objectId },
        object: { object_id: destination.id },
        assertion: "asserted" as const,
        qualifiers: {},
        provenance: [],
        created_at: input.now,
        updated_at: input.now,
        created_by: input.actor,
        version: 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
        sensitivity: found.object.sensitivity,
        extensions: {},
      });
      const serialized = prettyJson(addedRelation);
      targets.push(
        { relativePath: relationPath(addedRelation), after: serialized },
        {
          relativePath: relationCheckpointPath(addedRelation.id, addedRelation.version),
          after: serialized,
        },
      );
    }

    const changed = createdCollection || nextSource !== undefined || addedRelation !== undefined;
    if (changed) {
      const event = domainEvent(input, `object.collection_${input.action}`, {
        object_ids: [input.objectId, ...(destination === undefined ? [] : [destination.id])],
        relation_ids: [
          ...(nextSource === undefined ? [] : [nextSource.id]),
          ...(addedRelation === undefined ? [] : [addedRelation.id]),
        ],
        source_collection_id: source?.object.object_id ?? null,
        destination_collection_id: destination?.id ?? null,
      });
      await commitCanonical(commitInput(input, event, targets));
    }

    const after = await objectOrganization(input.root, input.objectId);
    const sourceCollection =
      source === undefined ? undefined : objectById.get(source.object.object_id);
    return {
      action: input.action,
      object_id: input.objectId,
      collection:
        destination === undefined ? null : { id: destination.id, title: destination.title },
      collections: after.collections.map(({ id, title }) => ({ id, title })),
      changed,
      undo: !changed
        ? null
        : input.action === "collect"
          ? {
              action: "remove",
              source_collection_id: destination!.id,
              expected_collection_ids: after.collections.map((collection) => collection.id),
            }
          : input.action === "remove"
            ? {
                action: "collect",
                destination_title: sourceCollection!.title,
                expected_collection_ids: after.collections.map((collection) => collection.id),
              }
            : {
                action: "move",
                destination_title: sourceCollection!.title,
                source_collection_id: destination!.id,
                expected_collection_ids: after.collections.map((collection) => collection.id),
              },
    };
  });
}

export interface ObjectHistoryEntry {
  version: number;
  content_hash: string;
  title: string;
  updated_at: string;
  updated_by: string;
}

export interface ObjectActivityEntry {
  id: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  transaction_id: string;
  version: number | null;
  reason: string | null;
}

export async function objectActivity(
  root: string,
  objectId: string,
): Promise<ObjectActivityEntry[]> {
  const activity: ObjectActivityEntry[] = [];
  const years = await readdir(join(root, ".kiwi", "events"), { withFileTypes: true }).catch(
    () => [],
  );
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const months = await readdir(join(root, ".kiwi", "events", year.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const raw = await readFile(
        join(root, ".kiwi", "events", year.name, month.name, "events.jsonl"),
        "utf8",
      ).catch(() => "");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (!Array.isArray(event["object_ids"]) || !event["object_ids"].includes(objectId))
            continue;
          if (
            typeof event["id"] !== "string" ||
            typeof event["event_type"] !== "string" ||
            typeof event["occurred_at"] !== "string" ||
            typeof event["actor"] !== "string" ||
            typeof event["transaction_id"] !== "string"
          )
            continue;
          activity.push({
            id: event["id"],
            event_type: event["event_type"],
            occurred_at: event["occurred_at"],
            actor: event["actor"],
            transaction_id: event["transaction_id"],
            version: typeof event["new_version"] === "number" ? event["new_version"] : null,
            reason: typeof event["reason"] === "string" ? event["reason"] : null,
          });
        } catch {
          // A damaged line does not hide later readable history entries.
        }
      }
    }
  }
  return activity.sort(
    (left, right) =>
      left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id),
  );
}

export interface WorkspaceActivityEntry extends ObjectActivityEntry {
  /** Everything the event touched, so a row can name what it was about. */
  object_ids: string[];
  object_type: string | null;
}

export interface WorkspaceActivityFilter {
  actor?: string | undefined;
  objectId?: string | undefined;
  eventType?: string | undefined;
  /** How many of the most recent to return. The rest are counted, not returned. */
  limit?: number | undefined;
}

export interface WorkspaceActivity {
  /** Most recent first, because that is the end somebody reads from. */
  entries: WorkspaceActivityEntry[];
  /** How many matched before the limit was applied. */
  matched: number;
  /** Everybody and every kind of event in the log, whether or not they match the filter. */
  actors: string[];
  event_types: string[];
}

/**
 * Everything that has happened in this workspace, filtered.
 *
 * The journal is the record, and until now nothing read it whole: `objectActivity` answers about
 * one object and the rest of it was on disk with no way in. This walks the same files.
 *
 * The choices worth stating. **The facets come from the log, not from a list in the code**, so
 * the filters offer the people who actually did things and the kinds of event that actually
 * happened -- a menu of every event type Kiwi can emit would mostly be empty choices. **The
 * facets are gathered before the filter is applied**, so choosing one filter never empties the
 * menu you would choose the next one from. And the count of what matched is kept even when the
 * entries are cut to a limit, because "showing 200 of 4,318" is a different page from "4,318".
 */
export async function workspaceActivity(
  root: string,
  filter: WorkspaceActivityFilter = {},
): Promise<WorkspaceActivity> {
  const matches: WorkspaceActivityEntry[] = [];
  const actors = new Set<string>();
  const eventTypes = new Set<string>();
  const years = await readdir(join(root, ".kiwi", "events"), { withFileTypes: true }).catch(
    () => [],
  );
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const months = await readdir(join(root, ".kiwi", "events", year.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const raw = await readFile(
        join(root, ".kiwi", "events", year.name, month.name, "events.jsonl"),
        "utf8",
      ).catch(() => "");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // A damaged line does not hide the readable entries around it.
          continue;
        }
        if (
          typeof event["id"] !== "string" ||
          typeof event["event_type"] !== "string" ||
          typeof event["occurred_at"] !== "string" ||
          typeof event["actor"] !== "string" ||
          typeof event["transaction_id"] !== "string"
        )
          continue;
        // Every write puts three events in the journal: prepared, what happened, committed. The
        // first and last are how the write was made durable, not something that happened to the
        // research, and a log that showed them would be two thirds bookkeeping. Workspace Health
        // is where an unfinished transaction is somebody's problem.
        if (event["event_type"].startsWith("transaction.")) continue;
        actors.add(event["actor"]);
        eventTypes.add(event["event_type"]);
        const objectIds = Array.isArray(event["object_ids"])
          ? event["object_ids"].filter((value): value is string => typeof value === "string")
          : [];
        if (filter.actor !== undefined && event["actor"] !== filter.actor) continue;
        if (filter.eventType !== undefined && event["event_type"] !== filter.eventType) continue;
        if (filter.objectId !== undefined && !objectIds.includes(filter.objectId)) continue;
        matches.push({
          id: event["id"],
          event_type: event["event_type"],
          occurred_at: event["occurred_at"],
          actor: event["actor"],
          transaction_id: event["transaction_id"],
          object_ids: objectIds,
          object_type: typeof event["object_type"] === "string" ? event["object_type"] : null,
          version: typeof event["new_version"] === "number" ? event["new_version"] : null,
          reason: typeof event["reason"] === "string" ? event["reason"] : null,
        });
      }
    }
  }
  matches.sort(
    (left, right) =>
      right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id),
  );
  const limit = filter.limit ?? matches.length;
  return {
    entries: matches.slice(0, Math.max(0, limit)),
    matched: matches.length,
    actors: [...actors].sort((left, right) => left.localeCompare(right)),
    event_types: [...eventTypes].sort((left, right) => left.localeCompare(right)),
  };
}

export async function objectHistory(root: string, objectId: string): Promise<ObjectHistoryEntry[]> {
  const folder = join(root, ".kiwi", "checkpoints", objectId);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const history: ObjectHistoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const version = Number.parseInt(entry.name.replace(/\.json$/u, ""), 10);
    if (!Number.isSafeInteger(version) || version < 1) continue;
    const parsed = await readObjectVersion(root, objectId, version);
    if (parsed === null) continue;
    history.push({
      version: parsed.version,
      content_hash: parsed.content_hash,
      title: parsed.title,
      updated_at: parsed.updated_at,
      updated_by: parsed.updated_by,
    });
  }
  return history.sort((left, right) => left.version - right.version);
}

export function verifyObjectHash(object: CanonicalObject): boolean {
  return object.content_hash === sha256(semantic(object));
}

/**
 * Projects.
 *
 * A project is one piece of research inside a workspace, and it is the container everything
 * else belongs to: a Library shows this project's papers, not the whole workspace's. That
 * containment is an ordinary relation rather than a field on the object, so moving something
 * between projects leaves a record of where it used to be instead of erasing it.
 *
 * Membership is exclusive. An object belongs to exactly one project, which is what makes the
 * question "which project is this in" answerable. Assigning to a second project retracts the
 * first in the same transaction, so there is never a moment where an object is in two.
 */

export const IN_PROJECT_RELATION = "in_project";

export class ProjectValidationError extends Error {
  constructor(readonly problems: Array<{ field: string; message: string }>) {
    super(problems[0]?.message ?? "Correct the project before saving.");
    this.name = "ProjectValidationError";
  }
}

export class NotAProjectError extends Error {
  constructor(readonly detail: string) {
    super("That object is not a project.");
    this.name = "NotAProjectError";
  }
}

/** The settings on a project object, defaulted for anything written before they existed. */
export function projectSettingsOf(object: CanonicalObject): ProjectSettings {
  return readProjectSettings(object["project"]);
}

export interface CreateProjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  objectId: string;
  title: string;
  settings: ProjectSettings;
  actor: string;
  requestId: string;
  now: string;
}

export async function createProject(input: CreateProjectInput): Promise<CanonicalObject> {
  const errors = validateProjectSettings({ title: input.title, settings: input.settings }).filter(
    (problem) => problem.severity === "error",
  );
  if (errors.length > 0) throw new ProjectValidationError(errors);
  return createObject({
    root: input.root,
    workspaceId: input.workspaceId,
    objectId: input.objectId,
    type: "project",
    title: input.title,
    // The description is the object's content so that workspace search finds a project by
    // what it is about, not only by its name.
    content: input.settings.description,
    additionalFields: { project: input.settings },
    actor: input.actor,
    requestId: input.requestId,
    now: input.now,
    transactionId: input.transactionId,
    preparedEventId: input.preparedEventId,
    domainEventId: input.domainEventId,
    committedEventId: input.committedEventId,
  });
}

export interface ConfigureProjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  projectId: string;
  expectedVersion: number;
  expectedHash: string;
  title: string;
  settings: ProjectSettings;
  actor: string;
  requestId: string;
  now: string;
}

/** Renames a project and rewrites its settings, including which pages it shows. */
export async function configureProject(input: ConfigureProjectInput): Promise<CanonicalObject> {
  const current = await readCanonicalObject(input.root, input.projectId);
  if (current === null) throw new Error("Object not found.");
  if (current.object.type !== "project") throw new NotAProjectError(String(current.object.type));
  const errors = validateProjectSettings({ title: input.title, settings: input.settings }).filter(
    (problem) => problem.severity === "error",
  );
  if (errors.length > 0) throw new ProjectValidationError(errors);
  return publishObject({
    root: input.root,
    workspaceId: input.workspaceId,
    objectId: input.projectId,
    expectedVersion: input.expectedVersion,
    expectedHash: input.expectedHash,
    title: input.title,
    content: input.settings.description,
    additionalFields: { project: input.settings },
    // A renamed project should not keep a filename naming the old one. The workspace is meant
    // to be readable as a folder of files, and a stale path is what makes it stop being that.
    relocateToTitlePath: true,
    reason: "Updated project settings",
    actor: input.actor,
    requestId: input.requestId,
    now: input.now,
    transactionId: input.transactionId,
    preparedEventId: input.preparedEventId,
    domainEventId: input.domainEventId,
    committedEventId: input.committedEventId,
  });
}

export interface ProjectDeletionPreview {
  project: CanonicalObject;
  /** What is filed in it, by type, so the confirmation can say what it is about to unfile. */
  counts: Record<string, number>;
  /** Everything filed in it, however many types that is. */
  object_count: number;
}

/** What deleting a project would affect, read before anybody is asked to confirm it. */
export async function previewProjectDeletion(
  root: string,
  projectId: string,
): Promise<ProjectDeletionPreview> {
  const current = await readCanonicalObject(root, projectId);
  if (current === null) throw new Error("Object not found.");
  if (current.object.type !== "project") throw new NotAProjectError(String(current.object.type));
  const objects = await listCanonicalObjects(root);
  const typeById = new Map(objects.map((object) => [object.id, object.type]));
  const counts: Record<string, number> = {};
  let total = 0;
  for (const relation of await listCanonicalRelations(root)) {
    if (relation.type !== IN_PROJECT_RELATION || relation.assertion !== "asserted") continue;
    if (relation.object.object_id !== projectId) continue;
    const type = typeById.get(relation.subject.object_id);
    if (type === undefined) continue;
    counts[type] = (counts[type] ?? 0) + 1;
    total += 1;
  }
  return { project: current.object, counts, object_count: total };
}

export class ProjectDeletionNotConfirmed extends Error {
  constructor() {
    super("Type the project's name to delete it.");
    this.name = "ProjectDeletionNotConfirmed";
  }
}

export interface DeleteProjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  projectId: string;
  /** The project's name, typed. Anything else refuses. */
  confirmation: string;
  actor: string;
  requestId: string;
  now: string;
}

/**
 * Deletes a project and unfiles what was in it.
 *
 * **Nothing anybody wrote is destroyed.** A project is a folder somebody put work into, not the
 * work; deleting it takes away the folder and the filing, and every paper, note, and task that was
 * in it stays in the workspace with no project. That is the only version of this that can be
 * offered at all -- an action that could delete two hundred objects behind one button is not an
 * action, it is an accident waiting to be reported.
 *
 * The project object itself does go, and does not go to the Trash. What it holds is a name, a
 * description, and which pages were switched on, and a typed confirmation is the right weight for
 * that. Everything of consequence survives it.
 */
export async function deleteProject(
  input: DeleteProjectInput,
): Promise<{ project: CanonicalObject; unfiled: number }> {
  return withCanonicalWrite(input.root, async () => {
    const current = await readCanonicalObject(input.root, input.projectId);
    if (current === null) throw new Error("Object not found.");
    if (current.object.type !== "project") throw new NotAProjectError(String(current.object.type));
    if (input.confirmation.trim() !== current.object.title.trim())
      throw new ProjectDeletionNotConfirmed();

    const targets: CommitCanonicalInput["targets"] = [];
    const unfiled: string[] = [];
    for (const relation of await listCanonicalRelations(input.root)) {
      if (relation.type !== IN_PROJECT_RELATION || relation.assertion !== "asserted") continue;
      if (relation.object.object_id !== input.projectId) continue;
      const retracted = withHash({
        ...relation,
        assertion: "retracted" as const,
        updated_at: input.now,
        version: relation.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      });
      const serialized = prettyJson(retracted);
      targets.push({ relativePath: relationPath(retracted), after: serialized });
      targets.push({
        relativePath: relationCheckpointPath(retracted.id, retracted.version),
        after: serialized,
      });
      unfiled.push(relation.subject.object_id);
    }
    targets.push({ relativePath: current.relativePath, after: null });

    const event = domainEvent(input, "project.deleted", {
      object_ids: [input.projectId, ...unfiled],
      object_type: "project",
      prior_version: current.object.version,
      new_version: null,
      prior_hash: current.object.content_hash,
      new_hash: null,
      unfiled_count: unfiled.length,
      snapshot: current.object,
    });
    await commitCanonical(commitInput(input, event, targets));
    return { project: current.object, unfiled: unfiled.length };
  });
}

/** The project an object belongs to, or null while it belongs to none. */
export async function projectForObject(
  root: string,
  objectId: string,
): Promise<CanonicalObject | null> {
  const links = await relationsForObject(root, objectId);
  const found = links.find(
    (link) => link.direction === "outgoing" && link.relation.type === IN_PROJECT_RELATION,
  );
  if (found === undefined) return null;
  const project = await readCanonicalObject(root, found.relation.object.object_id);
  return project?.object.type === "project" ? project.object : null;
}

export interface AssignToProjectInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  relationId: string;
  objectId: string;
  /** Null removes the object from whatever project it is in without putting it in another. */
  projectId: string | null;
  actor: string;
  requestId: string;
  now: string;
}

export interface ProjectAssignment {
  /** Null when the object was removed from every project. */
  projectId: string | null;
  /** Relations written by this assignment: the retraction, the assertion, or both. */
  relations: CanonicalRelation[];
}

export async function assignObjectToProject(
  input: AssignToProjectInput,
): Promise<ProjectAssignment> {
  return withCanonicalWrite(input.root, () => assignObjectToProjectUnlocked(input));
}

async function assignObjectToProjectUnlocked(
  input: AssignToProjectInput,
): Promise<ProjectAssignment> {
  const subject = await readCanonicalObject(input.root, input.objectId);
  if (subject === null) throw new Error("Object not found.");
  if (subject.object.type === "project")
    throw new NotAProjectError("A project cannot be put inside another project.");

  if (input.projectId !== null) {
    const destination = await readCanonicalObject(input.root, input.projectId);
    if (destination === null) throw new Error("Object not found.");
    if (destination.object.type !== "project")
      throw new NotAProjectError(String(destination.object.type));
  }

  const links = await relationsForObject(input.root, input.objectId);
  const existing = links.filter(
    (link) => link.direction === "outgoing" && link.relation.type === IN_PROJECT_RELATION,
  );

  // Assigning to the project it is already in changes nothing. Writing a version anyway would
  // put a meaningless entry in the history of every object every time a page loaded.
  if (
    input.projectId !== null &&
    existing.length === 1 &&
    existing[0]!.relation.object.object_id === input.projectId
  ) {
    return { projectId: input.projectId, relations: [] };
  }
  if (input.projectId === null && existing.length === 0) {
    return { projectId: null, relations: [] };
  }

  const targets: CommitCanonicalInput["targets"] = [];
  const written: CanonicalRelation[] = [];

  for (const link of existing) {
    const retracted = withHash({
      ...link.relation,
      assertion: "retracted" as const,
      updated_at: input.now,
      version: link.relation.version + 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
    });
    const serialized = prettyJson(retracted);
    targets.push({ relativePath: relationPath(retracted), after: serialized });
    targets.push({
      relativePath: relationCheckpointPath(retracted.id, retracted.version),
      after: serialized,
    });
    written.push(retracted);
  }

  if (input.projectId !== null) {
    const asserted = withHash({
      $schema: RELATION_SCHEMA,
      id: input.relationId,
      type: IN_PROJECT_RELATION,
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: input.objectId },
      object: { object_id: input.projectId },
      assertion: "asserted" as const,
      qualifiers: {},
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    const serialized = prettyJson(asserted);
    targets.push({ relativePath: relationPath(asserted), after: serialized });
    targets.push({
      relativePath: relationCheckpointPath(asserted.id, asserted.version),
      after: serialized,
    });
    written.push(asserted);
  }

  const event = domainEvent(input, "object.assigned_to_project", {
    object_ids: [
      input.objectId,
      ...(input.projectId === null ? [] : [input.projectId]),
      ...existing.map((link) => link.relation.object.object_id),
    ],
    relation_ids: written.map((relation) => relation.id),
    prior_version: null,
    new_version: null,
    prior_hash: null,
    new_hash: null,
    project_id: input.projectId,
  });
  await commitCanonical(commitInput(input, event, targets));
  return { projectId: input.projectId, relations: written };
}

export interface ProjectSummary {
  object: CanonicalObject;
  settings: ProjectSettings;
  /** How many objects of each type belong to it, for the Dashboard and the switcher. */
  counts: Record<string, number>;
}

/**
 * Every project in the workspace, most recently touched first.
 *
 * Counts are gathered in one pass over the relations rather than one query per project,
 * because Home lists every project in every workspace and the naive shape is quadratic.
 */
export async function listProjects(root: string): Promise<ProjectSummary[]> {
  const objects = await listCanonicalObjects(root);
  const projects = objects.filter((object) => object.type === "project");
  if (projects.length === 0) return [];

  const typeById = new Map(objects.map((object) => [object.id, object.type]));
  const counts = new Map<string, Record<string, number>>();
  for (const project of projects) counts.set(project.id, {});

  const relations = await listCanonicalRelations(root);
  /** Which project each object is filed in, for the marks below. */
  const projectOf = new Map<string, string>();
  for (const relation of relations) {
    if (relation.type !== IN_PROJECT_RELATION || relation.assertion !== "asserted") continue;
    const bucket = counts.get(relation.object.object_id);
    if (bucket === undefined) continue;
    const type = typeById.get(relation.subject.object_id);
    if (type === undefined) continue;
    bucket[type] = (bucket[type] ?? 0) + 1;
    projectOf.set(relation.subject.object_id, relation.object.object_id);
  }

  // A mark is not filed in a project; the paper it was made on is. It is counted where that
  // paper is, because the question the Dashboard asks is how many marks the project's reading
  // has produced, and "none" for a project with a hundred highlights in it was the answer this
  // used to give.
  for (const relation of relations) {
    if (relation.type !== ANNOTATES_RELATION || relation.assertion !== "asserted") continue;
    if (typeById.get(relation.subject.object_id) !== "annotation") continue;
    const projectId = projectOf.get(relation.object.object_id);
    const bucket = projectId === undefined ? undefined : counts.get(projectId);
    if (bucket === undefined) continue;
    bucket["annotation"] = (bucket["annotation"] ?? 0) + 1;
  }

  return projects
    .map((object) => ({
      object,
      settings: projectSettingsOf(object),
      counts: counts.get(object.id) ?? {},
    }))
    .sort((left, right) => {
      // Archived projects sink, and what was touched most recently rises.
      if (left.settings.archived !== right.settings.archived)
        return left.settings.archived ? 1 : -1;
      return right.object.updated_at.localeCompare(left.object.updated_at);
    });
}

/** Every object belonging to a project, for the pages that list them. */
export async function projectMembers(root: string, projectId: string): Promise<CanonicalObject[]> {
  const relations = await listCanonicalRelations(root);
  const memberIds = new Set(
    relations
      .filter(
        (relation) =>
          relation.type === IN_PROJECT_RELATION &&
          relation.assertion === "asserted" &&
          relation.object.object_id === projectId,
      )
      .map((relation) => relation.subject.object_id),
  );
  return (await listCanonicalObjects(root)).filter((object) => memberIds.has(object.id));
}

/*
 * The protocol: what a project set out to find, and how it said it would look.
 *
 * One per project, held to it by the same `in_project` relation as everything else, so nothing
 * has to learn a second way to ask which project an object belongs to. A project that has never
 * opened the page has no protocol object at all, which is why reading one answers with null
 * rather than writing an empty protocol the moment somebody looks at it.
 */

export class ProtocolValidationError extends Error {
  constructor(readonly problems: ProtocolProblem[]) {
    super(problems[0]?.message ?? "Correct the protocol before saving.");
    this.name = "ProtocolValidationError";
  }
}

export class ProtocolNotFound extends Error {
  constructor(readonly projectId: string) {
    super("This project has no protocol yet.");
    this.name = "ProtocolNotFound";
  }
}

/**
 * An edit that arrived after the freeze.
 *
 * It carries the freeze it ran into rather than only refusing, because the answer to it is to log
 * a deviation against that freeze, and whoever offers that has to be able to say which one.
 */
export class ProtocolFrozen extends Error {
  constructor(
    readonly frozenAt: string,
    readonly frozenVersion: number,
  ) {
    super("This protocol was frozen. Log a deviation rather than editing it.");
    this.name = "ProtocolFrozen";
  }
}

export interface StoredProtocol {
  object: CanonicalObject;
  protocol: ProtocolBody;
}

/** A write that may have changed nothing, the way freezing an already frozen protocol does. */
export interface ProtocolWrite extends StoredProtocol {
  changed: boolean;
}

/**
 * A protocol's title is its question.
 *
 * A workspace where every project's protocol is called "Protocol" is a list of search results
 * nobody can tell apart, and a folder of files whose names say nothing. A question may be longer
 * than a title is allowed to be, so a long one is cut here; the whole of it is in the body, and
 * in what search reads.
 */
export function protocolTitle(protocol: ProtocolBody): string {
  const question = protocol.question.trim().normalize("NFC").replace(/\s+/gu, " ");
  if (question === "") return "Protocol";
  return question.length <= OBJECT_TITLE_MAX_LENGTH
    ? question
    : question.slice(0, OBJECT_TITLE_MAX_LENGTH).trimEnd();
}

/** A protocol's canonical object, from its body. */
function protocolObject(
  input: { protocolId: string; actor: string; now: string } & CanonicalIds,
  protocol: ProtocolBody,
  base?: CanonicalObject,
): CanonicalObject {
  return withHash({
    ...(base ?? {}),
    $schema: objectSchemaUri("protocol"),
    id: input.protocolId,
    type: "protocol",
    schema_version: OBJECT_SCHEMA_VERSION,
    title: protocolTitle(protocol),
    lifecycle: "active",
    created_at: base?.created_at ?? input.now,
    updated_at: input.now,
    created_by: base?.created_by ?? input.actor,
    updated_by: input.actor,
    version: (base?.version ?? 0) + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: base?.sensitivity ?? ("internal" as const),
    provenance: base?.provenance ?? [],
    tags: base?.tags ?? [],
    extensions: base?.extensions ?? {},
    content: protocolContent(protocol),
    protocol,
  });
}

/**
 * The protocol object a project holds, with the path it is stored at.
 *
 * Two would mean two machines each wrote one before they had seen the other's. The older is the
 * one anything else already points at, so it is the one this answers with.
 */
async function findProtocol(
  root: string,
  projectId: string,
): Promise<(StoredProtocol & { relativePath: string }) | null> {
  const members = new Set(
    (await listCanonicalRelations(root))
      .filter(
        (relation) =>
          relation.type === IN_PROJECT_RELATION &&
          relation.assertion === "asserted" &&
          relation.object.object_id === projectId,
      )
      .map((relation) => relation.subject.object_id),
  );
  if (members.size === 0) return null;
  const candidates = (await listCanonicalObjects(root))
    .filter(
      (object) =>
        object.type === "protocol" && object.lifecycle === "active" && members.has(object.id),
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  const oldest = candidates[0];
  if (oldest === undefined) return null;
  const stored = await readCanonicalObject(root, oldest.id);
  if (stored === null) return null;
  return {
    object: stored.object,
    relativePath: stored.relativePath,
    protocol: readProtocol(stored.object["protocol"]),
  };
}

/** What a project has written down, or null while it has written nothing. */
export async function protocolForProject(
  root: string,
  projectId: string,
): Promise<StoredProtocol | null> {
  const found = await findProtocol(root, projectId);
  return found === null ? null : { object: found.object, protocol: found.protocol };
}

export interface EnsureProtocolInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  projectId: string;
  protocolId: string;
  relationId: string;
  actor: string;
  requestId: string;
  now: string;
}

export interface EnsureProtocolResult extends StoredProtocol {
  created: boolean;
}

/**
 * The project's protocol, made if it is not there yet.
 *
 * Opening the page must not write anything, so this is what the first edit calls rather than what
 * the first look calls. Asking twice creates one protocol: the second call finds the first and
 * writes nothing, which is what makes it safe for a page that mounts, unmounts, and mounts again.
 */
export async function ensureProtocol(input: EnsureProtocolInput): Promise<EnsureProtocolResult> {
  return withCanonicalWrite(input.root, () => ensureProtocolUnlocked(input));
}

async function ensureProtocolUnlocked(input: EnsureProtocolInput): Promise<EnsureProtocolResult> {
  const existing = await findProtocol(input.root, input.projectId);
  if (existing !== null) {
    return { object: existing.object, protocol: existing.protocol, created: false };
  }
  const project = await readCanonicalObject(input.root, input.projectId);
  if (project === null) throw new Error("Object not found.");
  if (project.object.type !== "project") throw new NotAProjectError(String(project.object.type));

  const protocol = emptyProtocol();
  const object = protocolObject(input, protocol);
  // The object and the relation that files it in the project are one transaction. A protocol
  // that exists for a moment belonging to no project is a protocol no page can find again.
  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: IN_PROJECT_RELATION,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: object.id },
    object: { object_id: input.projectId },
    assertion: "asserted" as const,
    qualifiers: {},
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });
  const event = domainEvent(input, "protocol.created", {
    object_ids: [object.id, input.projectId],
    relation_ids: [relation.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  const serializedRelation = prettyJson(relation);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      { relativePath: relationPath(relation), after: serializedRelation },
      {
        relativePath: relationCheckpointPath(relation.id, relation.version),
        after: serializedRelation,
      },
    ]),
  );
  return { object, protocol, created: true };
}

export interface ProtocolWriteInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  projectId: string;
  actor: string;
  requestId: string;
  now: string;
}

/**
 * Reads a project's protocol, changes it, and writes it back.
 *
 * `change` returning the protocol it was handed means nothing happened and nothing is written.
 * That is what makes a second freeze a no-change rather than an error, without freezing having
 * to know how a protocol is stored.
 */
async function changeProtocol(
  input: ProtocolWriteInput,
  eventType: string,
  change: (current: StoredProtocol) => ProtocolBody,
): Promise<ProtocolWrite> {
  return withCanonicalWrite(input.root, async () => {
    const current = await findProtocol(input.root, input.projectId);
    if (current === null) throw new ProtocolNotFound(input.projectId);
    const next = change({ object: current.object, protocol: current.protocol });
    if (next === current.protocol) {
      return { object: current.object, protocol: current.protocol, changed: false };
    }
    const problems = validateProtocol(next);
    if (problems.length > 0) throw new ProtocolValidationError(problems);
    const invalid = validateObjectPublication({
      title: protocolTitle(next),
      content: protocolContent(next),
    }).filter((problem) => problem.severity === "error");
    if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);

    const object = protocolObject(
      { ...input, protocolId: current.object.id },
      next,
      current.object,
    );
    const event = domainEvent(input, eventType, {
      object_ids: [object.id],
      prior_version: current.object.version,
      new_version: object.version,
      prior_hash: current.object.content_hash,
      new_hash: object.content_hash,
      snapshot: object,
    });
    const serialized = prettyJson(object);
    const nextPath = canonicalObjectPath(object);
    await commitCanonical(
      commitInput(input, event, [
        // Changing the question renames the protocol, which moves its file the way renaming
        // any other object does.
        ...(nextPath === current.relativePath
          ? [{ relativePath: current.relativePath, after: serialized }]
          : [
              { relativePath: nextPath, after: serialized },
              { relativePath: current.relativePath, after: null },
            ]),
        { relativePath: checkpointPath(object.id, object.version), after: serialized },
      ]),
    );
    return { object, protocol: next, changed: true };
  });
}

/** The parts of a protocol a caller may send back. The freeze and the log are not among them. */
export type ProtocolChanges = Partial<
  Pick<
    ProtocolBody,
    | "question"
    | "sub_questions"
    | "hypotheses"
    | "criteria"
    | "extraction_schema"
    | "method"
    | "preregistration"
    | "document"
  >
>;

export interface UpdateProtocolInput extends ProtocolWriteInput {
  expectedVersion: number;
  expectedHash: string;
  changes: ProtocolChanges;
}

/**
 * Changes what a protocol says, until it is frozen.
 *
 * An absent field is left alone, because the page saves the section that was edited rather than
 * the whole protocol: a stale form must not be able to undo an answer it was never showing.
 */
export async function updateProtocol(input: UpdateProtocolInput): Promise<ProtocolWrite> {
  return changeProtocol(input, "protocol.updated", (current) => {
    if (
      current.object.version !== input.expectedVersion ||
      current.object.content_hash !== input.expectedHash
    ) {
      throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
    }
    const frozenAt = current.protocol.frozen_at;
    if (frozenAt !== null) {
      throw new ProtocolFrozen(frozenAt, current.protocol.frozen_version ?? current.object.version);
    }
    const next = { ...current.protocol, ...input.changes };
    return JSON.stringify(next) === JSON.stringify(current.protocol) ? current.protocol : next;
  });
}

/**
 * Commits the project to what it says.
 *
 * The freeze covers the version that carries it. This write lands as `version + 1`, and that is
 * the version History opens to show exactly what was frozen, so that is the number recorded.
 */
export async function freezeStoredProtocol(input: ProtocolWriteInput): Promise<ProtocolWrite> {
  return changeProtocol(input, "protocol.frozen", (current) =>
    freezeProtocol(current.protocol, input.now, current.object.version + 1),
  );
}

export interface LogProtocolDeviationInput extends ProtocolWriteInput {
  deviation: Omit<Deviation, "id">;
}

/**
 * Writes down a departure from what was frozen.
 *
 * There is no expected version. A deviation is an addition to a list rather than an edit to
 * anything already in it, so two people logging one at once produce two entries, not a conflict.
 */
export async function logProtocolDeviation(
  input: LogProtocolDeviationInput,
): Promise<ProtocolWrite> {
  return changeProtocol(input, "protocol.deviation_logged", (current) =>
    logDeviation(current.protocol, input.deviation),
  );
}

/*
 * Claims: what the project asserts, and what the assertion stands on.
 *
 * A claim is filed in its project by the same `in_project` relation as everything else, so nothing
 * has to learn a second way to ask which project an object belongs to.
 *
 * Evidence is a relation from the thing somebody read to the claim, never a list on the claim. Two
 * people attaching evidence at the same time are two writes to two files rather than two writes to
 * one, and the relation store already answers "what points at this", which is the evidence panel
 * and the backlinks panel asking the same question.
 */

/** Evidence bearing on a claim. The relation type is the stance, so there are exactly two. */
export const SUPPORTS_RELATION = "supports";
export const CONTRADICTS_RELATION = "contradicts";

export class ClaimValidationError extends Error {
  constructor(readonly problems: ClaimProblem[]) {
    super(problems[0]?.message ?? "Correct the claim before saving.");
    this.name = "ClaimValidationError";
  }
}

export class ClaimNotFound extends Error {
  constructor(readonly claimId: string) {
    super("Claim not found.");
    this.name = "ClaimNotFound";
  }
}

/**
 * Raised when the thing being attached cannot be evidence.
 *
 * It carries the type it found, because the answer depends on what was dropped: a claim, which
 * cannot be evidence at all, is a different problem from an object that is simply gone.
 */
export class EvidenceError extends Error {
  constructor(
    readonly reason: "not_found" | "not_evidence",
    readonly objectType: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface StoredClaim {
  object: CanonicalObject;
  claim: ClaimBody;
}

/** A write that may have changed nothing, the way saving a claim nobody edited does. */
export interface ClaimWrite extends StoredClaim {
  changed: boolean;
}

/** One thing pointing at a claim, resolved against the object it points at. */
export interface ClaimEvidence {
  relationId: string;
  objectId: string;
  objectType: string;
  title: string;
  stance: EvidenceStance;
  attachedAt: string;
}

/** A claim and what it is standing on, which is what every surface showing claims needs. */
export interface ClaimSummary extends StoredClaim {
  evidence: ClaimEvidence[];
}

/** A claim's canonical object, from its body. Its title is its statement, cut to fit a row. */
function claimObject(
  input: { claimId: string; actor: string; now: string } & CanonicalIds,
  claim: ClaimBody,
  base?: CanonicalObject,
): CanonicalObject {
  return withHash({
    ...(base ?? {}),
    $schema: objectSchemaUri("claim"),
    id: input.claimId,
    type: "claim",
    schema_version: OBJECT_SCHEMA_VERSION,
    title: claimTitle(claim),
    lifecycle: "active",
    created_at: base?.created_at ?? input.now,
    updated_at: input.now,
    created_by: base?.created_by ?? input.actor,
    updated_by: input.actor,
    version: (base?.version ?? 0) + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: base?.sensitivity ?? ("internal" as const),
    provenance: base?.provenance ?? [],
    tags: base?.tags ?? [],
    extensions: base?.extensions ?? {},
    content: claimContent(claim),
    claim,
  });
}

/** The relation that files an object in a project, ready to be written beside the object. */
function inProjectRelation(
  input: { relationId: string; actor: string; now: string } & CanonicalIds,
  objectId: string,
  projectId: string,
): CanonicalRelation {
  return withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: IN_PROJECT_RELATION,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: objectId },
    object: { object_id: projectId },
    assertion: "asserted" as const,
    qualifiers: {},
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });
}

export interface CreateClaimInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  claimId: string;
  relationId: string;
  projectId: string;
  claim: ClaimBody;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Writes down something the project asserts.
 *
 * The claim and the relation that files it in the project are one transaction. A claim that
 * exists for a moment belonging to no project is a claim the Claims page cannot find again.
 */
export async function createClaim(input: CreateClaimInput): Promise<CanonicalObject> {
  return withCanonicalWrite(input.root, () => createClaimUnlocked(input));
}

async function createClaimUnlocked(input: CreateClaimInput): Promise<CanonicalObject> {
  const problems = validateClaim(input.claim);
  if (problems.length > 0) throw new ClaimValidationError(problems);
  const project = await readCanonicalObject(input.root, input.projectId);
  if (project === null) throw new Error("Object not found.");
  if (project.object.type !== "project") throw new NotAProjectError(String(project.object.type));

  const object = claimObject(input, input.claim);
  const invalid = validateObjectPublication({
    title: object.title,
    content: claimContent(input.claim),
  }).filter((problem) => problem.severity === "error");
  if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);

  const relation = inProjectRelation(input, object.id, input.projectId);
  const event = domainEvent(input, "claim.created", {
    object_ids: [object.id, input.projectId],
    relation_ids: [relation.id],
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  const serializedRelation = prettyJson(relation);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: canonicalObjectPath(object), after: serialized },
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
      { relativePath: relationPath(relation), after: serializedRelation },
      {
        relativePath: relationCheckpointPath(relation.id, relation.version),
        after: serializedRelation,
      },
    ]),
  );
  return object;
}

export interface ClaimWriteInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  claimId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

async function readStoredClaim(
  root: string,
  claimId: string,
): Promise<StoredClaim & { relativePath: string }> {
  const stored = await readCanonicalObject(root, claimId);
  const claim = stored === null ? null : readClaim(stored.object["claim"]);
  if (stored === null || stored.object.type !== "claim" || claim === null) {
    throw new ClaimNotFound(claimId);
  }
  return { object: stored.object, relativePath: stored.relativePath, claim };
}

export interface UpdateClaimInput extends ClaimWriteInput {
  expectedVersion: number;
  expectedHash: string;
  changes: Partial<ClaimBody>;
}

/**
 * Changes what a claim says.
 *
 * An absent field is left alone. The page edits one thing at a time -- a status from a menu, a
 * hypothesis from a chooser -- and sending the whole claim back would let a stale form undo
 * somebody else's change to a field it was not showing.
 */
export async function updateClaim(input: UpdateClaimInput): Promise<ClaimWrite> {
  return withCanonicalWrite(input.root, () => updateClaimUnlocked(input));
}

async function updateClaimUnlocked(input: UpdateClaimInput): Promise<ClaimWrite> {
  const current = await readStoredClaim(input.root, input.claimId);
  if (
    current.object.version !== input.expectedVersion ||
    current.object.content_hash !== input.expectedHash
  ) {
    throw new ObjectVersionConflict(current.object.version, current.object.content_hash);
  }
  const next: ClaimBody = { ...current.claim, ...input.changes };
  if (JSON.stringify(next) === JSON.stringify(current.claim)) {
    return { object: current.object, claim: current.claim, changed: false };
  }
  const problems = validateClaim(next);
  if (problems.length > 0) throw new ClaimValidationError(problems);

  const object = claimObject({ ...input, claimId: current.object.id }, next, current.object);
  const invalid = validateObjectPublication({
    title: object.title,
    content: claimContent(next),
  }).filter((problem) => problem.severity === "error");
  if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);

  const event = domainEvent(input, "claim.updated", {
    object_ids: [object.id],
    prior_version: current.object.version,
    new_version: object.version,
    prior_hash: current.object.content_hash,
    new_hash: object.content_hash,
    snapshot: object,
  });
  const serialized = prettyJson(object);
  const nextPath = canonicalObjectPath(object);
  await commitCanonical(
    commitInput(input, event, [
      // Rewording a claim renames it, which moves its file the way renaming any object does.
      ...(nextPath === current.relativePath
        ? [{ relativePath: current.relativePath, after: serialized }]
        : [
            { relativePath: nextPath, after: serialized },
            { relativePath: current.relativePath, after: null },
          ]),
      { relativePath: checkpointPath(object.id, object.version), after: serialized },
    ]),
  );
  return { object, claim: next, changed: true };
}

/** What this object currently says about this claim, whichever of the two ways it says it. */
async function assertedEvidence(
  root: string,
  claimId: string,
  objectId: string,
): Promise<CanonicalRelation | null> {
  for (const { relation, direction } of await relationsForObject(root, claimId)) {
    if (direction !== "incoming" || !isEvidenceStance(relation.type)) continue;
    if (relation.subject.object_id === objectId) return relation;
  }
  return null;
}

export interface EvidenceWrite {
  relation: CanonicalRelation | null;
  changed: boolean;
  /** What this evidence used to say, when attaching it changed somebody's mind. */
  replaced: EvidenceStance | null;
}

export interface AttachEvidenceInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  claimId: string;
  objectId: string;
  stance: EvidenceStance;
  relationId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Points something at a claim.
 *
 * Attaching what is already attached the same way changes nothing, the way assigning an object to
 * the project it is already in does. Attaching it the other way round is one transaction that
 * retracts the old stance and asserts the new one, so a piece of evidence never both supports and
 * contradicts, and the history still says what it used to say.
 */
export async function attachEvidence(input: AttachEvidenceInput): Promise<EvidenceWrite> {
  return withCanonicalWrite(input.root, () => attachEvidenceUnlocked(input));
}

async function attachEvidenceUnlocked(input: AttachEvidenceInput): Promise<EvidenceWrite> {
  await readStoredClaim(input.root, input.claimId);
  const found = await readCanonicalObject(input.root, input.objectId);
  if (found === null || found.object.lifecycle !== "active") {
    throw new EvidenceError("not_found", "", "That was not found.");
  }
  const type = String(found.object.type);
  if (!isEvidenceObjectType(type)) {
    throw new EvidenceError(
      "not_evidence",
      type,
      type === "claim"
        ? "A claim cannot be evidence for a claim. Attach what the first claim stands on instead."
        : "Evidence is a highlight, a note, a paper, a run, or a dataset.",
    );
  }

  const current = await assertedEvidence(input.root, input.claimId, input.objectId);
  if (current !== null && current.type === input.stance) {
    return { relation: current, changed: false, replaced: null };
  }

  const targets: CommitCanonicalInput["targets"] = [];
  const retractedIds: string[] = [];
  const replaced = current === null ? null : (current.type as EvidenceStance);
  if (current !== null) {
    const retracted = withHash({
      ...current,
      assertion: "retracted" as const,
      updated_at: input.now,
      version: current.version + 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
    });
    const serializedRetracted = prettyJson(retracted);
    targets.push({ relativePath: relationPath(retracted), after: serializedRetracted });
    targets.push({
      relativePath: relationCheckpointPath(retracted.id, retracted.version),
      after: serializedRetracted,
    });
    retractedIds.push(retracted.id);
  }

  const relation = withHash({
    $schema: RELATION_SCHEMA,
    id: input.relationId,
    type: input.stance,
    schema_version: OBJECT_SCHEMA_VERSION,
    subject: { object_id: input.objectId },
    object: { object_id: input.claimId },
    assertion: "asserted" as const,
    qualifiers: {},
    provenance: [],
    created_at: input.now,
    updated_at: input.now,
    created_by: input.actor,
    version: 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
    sensitivity: "internal" as const,
    extensions: {},
  });
  const serialized = prettyJson(relation);
  targets.push({ relativePath: relationPath(relation), after: serialized });
  targets.push({
    relativePath: relationCheckpointPath(relation.id, relation.version),
    after: serialized,
  });

  const event = domainEvent(input, "claim.evidence_attached", {
    object_ids: [input.claimId, input.objectId],
    relation_ids: [...retractedIds, relation.id],
    stance: input.stance,
    prior_version: null,
    new_version: 1,
    prior_hash: null,
    new_hash: relation.content_hash,
    snapshot: relation,
  });
  await commitCanonical(commitInput(input, event, targets));
  return { relation, changed: true, replaced };
}

export interface DetachEvidenceInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  claimId: string;
  objectId: string;
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

/**
 * Takes evidence off a claim.
 *
 * The relation is retracted rather than deleted, the way a detached file's is: that highlight
 * stood behind the claim for three weeks, and the history should still say so. Detaching what is
 * not attached changes nothing rather than failing, so the second of two clicks is not an error
 * somebody has to read.
 */
export async function detachEvidence(input: DetachEvidenceInput): Promise<EvidenceWrite> {
  return withCanonicalWrite(input.root, () => detachEvidenceUnlocked(input));
}

async function detachEvidenceUnlocked(input: DetachEvidenceInput): Promise<EvidenceWrite> {
  await readStoredClaim(input.root, input.claimId);
  const current = await assertedEvidence(input.root, input.claimId, input.objectId);
  if (current === null) return { relation: null, changed: false, replaced: null };

  const next = withHash({
    ...current,
    assertion: "retracted" as const,
    updated_at: input.now,
    version: current.version + 1,
    last_event_id: input.domainEventId,
    last_transaction_id: input.transactionId,
  });
  const event = domainEvent(input, "claim.evidence_detached", {
    object_ids: [input.claimId, input.objectId],
    relation_ids: [next.id],
    stance: next.type,
    prior_version: current.version,
    new_version: next.version,
    prior_hash: current.content_hash,
    new_hash: next.content_hash,
    snapshot: next,
  });
  const serialized = prettyJson(next);
  await commitCanonical(
    commitInput(input, event, [
      { relativePath: relationPath(next), after: serialized },
      { relativePath: relationCheckpointPath(next.id, next.version), after: serialized },
    ]),
  );
  return { relation: next, changed: true, replaced: current.type as EvidenceStance };
}

/** A claim that already exists, chosen from a list. */
export interface ExistingClaimTarget {
  kind: "existing";
  claimId: string;
}

/** A claim this send writes down, filed in a project as `createClaim` files one. */
export interface NewClaimTarget {
  kind: "new";
  claimId: string;
  relationId: string;
  projectId: string;
  claim: ClaimBody;
}

export type EvidenceClaimTarget = ExistingClaimTarget | NewClaimTarget;

/**
 * A passage that is not a mark yet.
 *
 * Sending straight from a selection makes the highlight on the way past, so the quotation can
 * still be found on the page it came from rather than only inside the claim.
 */
export interface EvidenceExcerpt {
  /** The Paper the passage was read in. */
  objectId: string;
  annotationId: string;
  relationId: string;
  annotation: Annotation;
}

export interface SendEvidenceToClaimInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  target: EvidenceClaimTarget;
  excerpt: EvidenceExcerpt | null;
  /** Marks that already exist, sent from the sidebar. */
  objectIds: string[];
  stance: EvidenceStance;
  /** One per piece of evidence, the excerpt first. */
  relationIds: string[];
  actor: string;
  requestId: string;
  now: string;
  faultAfterTarget?: number;
}

export interface SendEvidenceReceipt {
  claim: CanonicalObject;
  claimCreated: boolean;
  /** The mark this send made on the way past, when it made one. */
  annotationId: string | null;
  attached: number;
  /** Pieces that already said this about this claim. */
  skipped: number;
  changed: boolean;
}

/**
 * Sends what somebody is reading to a claim, in one transaction.
 *
 * The claim, the mark, and the relation that points one at the other are written together
 * because none of them is worth having alone. A claim with no evidence is a claim somebody has
 * to go back and find the passage for; an excerpt attached to nothing is a highlight with a
 * reason nobody recorded. Half of this succeeding is worse than none of it.
 */
export async function sendEvidenceToClaim(
  input: SendEvidenceToClaimInput,
): Promise<SendEvidenceReceipt> {
  return withCanonicalWrite(input.root, () => sendEvidenceToClaimUnlocked(input));
}

async function sendEvidenceToClaimUnlocked(
  input: SendEvidenceToClaimInput,
): Promise<SendEvidenceReceipt> {
  const targets: CommitCanonicalInput["targets"] = [];
  const writtenRelations: string[] = [];

  // The claim first. Evidence needs something to point at, and when the claim is new the
  // writing down and the pointing are the same commit.
  let claim: CanonicalObject;
  let claimCreated = false;
  if (input.target.kind === "existing") {
    claim = (await readStoredClaim(input.root, input.target.claimId)).object;
  } else {
    const { claim: body, claimId, projectId, relationId } = input.target;
    const problems = validateClaim(body);
    if (problems.length > 0) throw new ClaimValidationError(problems);
    const project = await readCanonicalObject(input.root, projectId);
    if (project === null) throw new Error("Object not found.");
    if (project.object.type !== "project") throw new NotAProjectError(String(project.object.type));

    claim = claimObject({ ...input, claimId }, body);
    const invalid = validateObjectPublication({
      title: claim.title,
      content: claimContent(body),
    }).filter((problem) => problem.severity === "error");
    if (invalid.length > 0) throw new ObjectPublicationValidationError(invalid);

    const serialized = prettyJson(claim);
    const filed = inProjectRelation({ ...input, relationId }, claim.id, projectId);
    const serializedFiled = prettyJson(filed);
    targets.push(
      { relativePath: canonicalObjectPath(claim), after: serialized },
      { relativePath: checkpointPath(claim.id, claim.version), after: serialized },
      { relativePath: relationPath(filed), after: serializedFiled },
      { relativePath: relationCheckpointPath(filed.id, filed.version), after: serializedFiled },
    );
    writtenRelations.push(filed.id);
    claimCreated = true;
  }

  const evidenceIds: string[] = [];
  let annotationId: string | null = null;
  if (input.excerpt !== null) {
    const { annotation, objectId, annotationId: markId, relationId } = input.excerpt;
    const problems = validateAnnotation(annotation);
    if (problems.length > 0) throw new AnnotationValidationError(problems);
    const paper = await readCanonicalObject(input.root, objectId);
    if (paper === null) throw new Error("Object not found.");

    const mark = annotationObject({ ...input, annotationId: markId, annotation });
    const annotates = withHash({
      $schema: RELATION_SCHEMA,
      id: relationId,
      type: ANNOTATES_RELATION,
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: mark.id },
      object: { object_id: objectId },
      assertion: "asserted" as const,
      qualifiers: { page: annotation.page, asset_id: annotation.asset_id },
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    const serialized = prettyJson(mark);
    targets.push(
      { relativePath: canonicalObjectPath(mark), after: serialized },
      { relativePath: checkpointPath(mark.id, mark.version), after: serialized },
      { relativePath: relationPath(annotates), after: prettyJson(annotates) },
    );
    writtenRelations.push(annotates.id);
    annotationId = mark.id;
    evidenceIds.push(mark.id);
  }
  evidenceIds.push(...input.objectIds);

  let attached = 0;
  let skipped = 0;
  for (const [index, objectId] of evidenceIds.entries()) {
    // The excerpt is being written by this transaction, so it is not on disk to be read back
    // and there is nothing it could already be saying about this claim.
    const fresh = objectId === annotationId;
    if (!fresh) {
      const found = await readCanonicalObject(input.root, objectId);
      if (found === null || found.object.lifecycle !== "active") {
        throw new EvidenceError("not_found", "", "That was not found.");
      }
      const type = String(found.object.type);
      if (!isEvidenceObjectType(type)) {
        throw new EvidenceError(
          "not_evidence",
          type,
          type === "claim"
            ? "A claim cannot be evidence for a claim. Attach what the first claim stands on instead."
            : "Evidence is a highlight, a note, a paper, a run, or a dataset.",
        );
      }
    }

    const current =
      fresh || claimCreated ? null : await assertedEvidence(input.root, claim.id, objectId);
    if (current !== null && current.type === input.stance) {
      skipped += 1;
      continue;
    }
    if (current !== null) {
      const retracted = withHash({
        ...current,
        assertion: "retracted" as const,
        updated_at: input.now,
        version: current.version + 1,
        last_event_id: input.domainEventId,
        last_transaction_id: input.transactionId,
      });
      const serializedRetracted = prettyJson(retracted);
      targets.push(
        { relativePath: relationPath(retracted), after: serializedRetracted },
        {
          relativePath: relationCheckpointPath(retracted.id, retracted.version),
          after: serializedRetracted,
        },
      );
      writtenRelations.push(retracted.id);
    }

    const relationId = input.relationIds[index];
    if (relationId === undefined) continue;
    const relation = withHash({
      $schema: RELATION_SCHEMA,
      id: relationId,
      type: input.stance,
      schema_version: OBJECT_SCHEMA_VERSION,
      subject: { object_id: objectId },
      object: { object_id: claim.id },
      assertion: "asserted" as const,
      qualifiers: {},
      provenance: [],
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      extensions: {},
    });
    const serialized = prettyJson(relation);
    targets.push(
      { relativePath: relationPath(relation), after: serialized },
      { relativePath: relationCheckpointPath(relation.id, relation.version), after: serialized },
    );
    writtenRelations.push(relation.id);
    attached += 1;
  }

  // Everything sent already said this about this claim. Sending the same highlight twice is
  // something people do while reading, and it is not worth a new version of anything.
  if (targets.length === 0) {
    return { claim, claimCreated: false, annotationId: null, attached: 0, skipped, changed: false };
  }

  const event = domainEvent(input, "claim.evidence_sent", {
    object_ids: [claim.id, ...evidenceIds],
    relation_ids: writtenRelations,
    stance: input.stance,
    claim_created: claimCreated,
    prior_version: claimCreated ? null : claim.version,
    new_version: claim.version,
    prior_hash: claimCreated ? null : claim.content_hash,
    new_hash: claim.content_hash,
    snapshot: claim,
  });
  await commitCanonical(commitInput(input, event, targets));
  return { claim, claimCreated, annotationId, attached, skipped, changed: true };
}

export interface ClaimQuery {
  projectId?: string;
  status?: ClaimStatus;
  /** Claims written to answer one line of the protocol: `Q2`, `H1`. */
  answers?: string;
  /** Claims nothing supports, which is the list the page exists to make short. */
  unsupported?: boolean;
}

/**
 * The project's claims, oldest first, each with what it is standing on.
 *
 * Evidence whose object is gone from the workspace is not counted. Somebody deleted the highlight
 * the claim rested on, and a claim still calling itself supported by it is a claim standing on
 * nothing while saying otherwise -- which is what the unsupported list exists to find.
 */
export async function listClaims(root: string, query: ClaimQuery = {}): Promise<ClaimSummary[]> {
  const live = new Map(
    (await listCanonicalObjects(root))
      .filter((object) => object.lifecycle === "active")
      .map((object) => [object.id, object]),
  );

  const projectOf = new Map<string, string>();
  const evidence = new Map<string, ClaimEvidence[]>();
  for (const relation of await listCanonicalRelations(root)) {
    if (relation.assertion !== "asserted") continue;
    if (relation.type === IN_PROJECT_RELATION) {
      projectOf.set(relation.subject.object_id, relation.object.object_id);
      continue;
    }
    if (!isEvidenceStance(relation.type)) continue;
    const source = live.get(relation.subject.object_id);
    if (source === undefined) continue;
    const entry: ClaimEvidence = {
      relationId: relation.id,
      objectId: source.id,
      objectType: String(source.type),
      title: source.title,
      stance: relation.type,
      attachedAt: relation.created_at,
    };
    const existing = evidence.get(relation.object.object_id);
    if (existing === undefined) evidence.set(relation.object.object_id, [entry]);
    else existing.push(entry);
  }

  const found: ClaimSummary[] = [];
  for (const object of live.values()) {
    if (object.type !== "claim") continue;
    const claim = readClaim(object["claim"]);
    if (claim === null) continue;
    if (query.projectId !== undefined && projectOf.get(object.id) !== query.projectId) continue;
    if (query.status !== undefined && claim.status !== query.status) continue;
    if (query.answers !== undefined && !claim.answers.includes(query.answers)) continue;
    const attached = (evidence.get(object.id) ?? []).sort((left, right) => {
      const byTime = left.attachedAt.localeCompare(right.attachedAt);
      return byTime === 0 ? left.relationId.localeCompare(right.relationId) : byTime;
    });
    if (query.unsupported === true && attached.some((entry) => entry.stance === "supports")) {
      continue;
    }
    found.push({ object, claim, evidence: attached });
  }
  // The order they were asserted in, so editing one does not move it up the page.
  return found.sort((left, right) => {
    const byTime = left.object.created_at.localeCompare(right.object.created_at);
    return byTime === 0 ? left.object.id.localeCompare(right.object.id) : byTime;
  });
}
