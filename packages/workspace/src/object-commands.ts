import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  ANNOTATION_COLORS,
  ANNOTATION_KINDS,
  ANNOTATION_LIMITS,
  CREATABLE_OBJECT_TYPES,
  DOCUMENT_LIMITS,
  DOCUMENT_MODES,
  countWords,
  documentText,
  validateDocument,
  EMPTY_ANNOTATION,
  PAPER_SUMMARY_LIMIT,
  REFERENCE_KINDS,
  REFERENCE_LIMITS,
  normalizeDoi,
  normalizePaperSummary,
  normalizeReference,
  readPaperReadState,
  readPaperSummary,
  readReference,
  validateReference,
  type Annotation,
  type CreatableObjectType,
  type DocumentMode,
  type Reference,
} from "@kiwi/contracts";
import {
  AnnotationValidationError,
  FileAttachmentError,
  ManuscriptTargetError,
  NoteTargetError,
  ObjectHistoryCorruptionError,
  ObjectCaptureContextConflict,
  ObjectNotPromotable,
  ObjectTypeNotCreatable,
  ObjectOrganizationConflict,
  ObjectPublicationValidationError,
  ObjectTrashConflict,
  ObjectTrashCorruptionError,
  ObjectVersionConflict,
  bulkTagObjects,
  changeCollectionMembership,
  annotationsForObject,
  locateAnnotation,
  attachFile,
  attachedFiles,
  createAnnotation,
  sendAnnotationsToNote,
  sendExcerptToManuscript,
  updateAnnotation,
  detachFile,
  createInboxItem,
  createObject,
  promoteInboxItem,
  createRelation,
  duplicateObject,
  listCanonicalObjects,
  listTrash,
  objectActivity,
  workspaceActivity,
  objectHistory,
  objectOrganization,
  previewObjectPublication,
  previewObjectRestore,
  previewObjectTrash,
  previewTrashCleanupPolicy,
  previewTrashPurge,
  purgeTrash,
  quickCapture,
  publishObject,
  readCanonicalObject,
  readObjectVersion,
  relationsForObject,
  restoreObjectVersion,
  restoreTrashedObject,
  readTrashCleanupPolicy,
  setTrashCleanupPolicy,
  trashObject,
} from "./objects.js";
import {
  createExternalDraftConflict,
  listStructuredConflicts,
  resolveStructuredConflict,
} from "./conflicts.js";
import { missingAssetFiles } from "./assets.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
export const rootProperty = { type: "string", minLength: 3, maxLength: 240 };
export const idProperty = { type: "string", minLength: 1, maxLength: 100 };
export const hashProperty = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };

const annotationProperties = {
  kind: { type: "string", enum: [...ANNOTATION_KINDS] },
  asset_id: idProperty,
  page: { type: "integer", minimum: 1, maximum: ANNOTATION_LIMITS.page },
  page_label: { type: "string", maxLength: 40 },
  rects: {
    type: "array",
    maxItems: ANNOTATION_LIMITS.rects,
    items: {
      type: "object",
      required: ["left", "top", "width", "height"],
      additionalProperties: false,
      properties: {
        left: { type: "number" },
        top: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  },
  color: { type: "string", enum: [...ANNOTATION_COLORS] },
  quoted: { type: "string", maxLength: ANNOTATION_LIMITS.quoted },
  comment: { type: "string", maxLength: ANNOTATION_LIMITS.comment },
  image_asset_id: { type: ["string", "null"], maxLength: 100 },
};

/**
 * A mark, as it arrives from an interface.
 *
 * Exported because a mark is not only made by the annotation commands: sending a selection to a
 * claim makes one on the way past, and it has to be the same shape or the two ways in would
 * accept different things.
 */
export const annotationSchema = {
  type: "object",
  required: ["kind", "asset_id", "page", "rects", "color"],
  additionalProperties: false,
  properties: annotationProperties,
};

export {
  workspaceId as commandWorkspaceId,
  ids as commandIds,
  trashFailure as commandTrashFailure,
};

export interface ObjectCommandDeps {
  newId(): string;
  now(): string;
  revealFile?(root: string, relativePath: string): Promise<void>;
  hasRecoveryDraft?(actorId: string, workspaceId: string, objectId: string): Promise<boolean>;
}

function workspaceId(context: { workspaceId: string | null }): string {
  if (context.workspaceId === null) {
    throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before using objects.");
  }
  return context.workspaceId;
}

function ids(deps: ObjectCommandDeps) {
  return {
    transactionId: deps.newId(),
    preparedEventId: deps.newId(),
    domainEventId: deps.newId(),
    committedEventId: deps.newId(),
  };
}

function conflict(cause: unknown): never {
  if (cause instanceof ObjectVersionConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      details: {
        actual_version: cause.actualVersion,
        actual_hash: cause.actualHash,
      },
      recoveryActions: ["reload_current"],
    });
  }
  if (cause instanceof ObjectOrganizationConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      details: { actual_collection_ids: cause.actualCollectionIds.join(",") },
      recoveryActions: ["reload_current"],
    });
  }
  throw cause;
}

function noteTargetFailure(cause: unknown): never {
  if (cause instanceof NoteTargetError) {
    throw new CommandError(
      cause.kind === "not_found" ? "KIWI_NOT_FOUND" : "KIWI_INVALID_ARGUMENTS",
      cause.message,
      { details: { kind: cause.kind }, recoveryActions: ["correct_input"] },
    );
  }
  return annotationFailure(cause);
}

function manuscriptTargetFailure(cause: unknown): never {
  if (cause instanceof ManuscriptTargetError) {
    throw new CommandError(
      cause.kind === "not_a_manuscript" ? "KIWI_INVALID_ARGUMENTS" : "KIWI_NOT_FOUND",
      cause.message,
      { details: { kind: cause.kind }, recoveryActions: ["correct_input"] },
    );
  }
  return annotationFailure(cause);
}

function annotationFailure(cause: unknown): never {
  if (cause instanceof AnnotationValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  return conflict(cause);
}

/**
 * A title reduced to what two records of one paper would still have in common.
 *
 * Case, punctuation and spacing are what differ between a title typed twice and the same title
 * arriving from two exports; the words are not. Anything that is neither a letter nor a digit
 * becomes a space, so `Attention Is All You Need` and `Attention is all you need.` are one key.
 * Null for a title with no words in it, which would otherwise gather every untitled draft into
 * one group.
 */
function titleKey(title: string): string | null {
  const key = title
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return key === "" ? null : key;
}

function attachmentFailure(cause: unknown): never {
  if (cause instanceof FileAttachmentError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { kind: cause.kind },
      recoveryActions: ["reload_current"],
    });
  }
  return conflict(cause);
}

function typedObjectFailure(cause: unknown): never {
  if (cause instanceof ObjectTypeNotCreatable) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { attempted_type: cause.attempted },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof ObjectNotPromotable) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { actual_type: cause.actualType },
      recoveryActions: ["reload_current"],
    });
  }
  return publicationFailure(cause);
}

function publicationFailure(cause: unknown): never {
  if (cause instanceof ObjectPublicationValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { error_count: cause.problems.length },
      recoveryActions: ["correct_input"],
    });
  }
  return conflict(cause);
}

function historyFailure(cause: unknown): never {
  if (cause instanceof ObjectHistoryCorruptionError) {
    throw new CommandError("KIWI_WORKSPACE_INVALID", cause.message, {
      details: { object_id: cause.objectId, version: cause.version },
      recoveryActions: ["open_logs"],
    });
  }
  return conflict(cause);
}

function trashFailure(cause: unknown): never {
  if (cause instanceof ObjectTrashCorruptionError) {
    throw new CommandError("KIWI_WORKSPACE_INVALID", cause.message, {
      details: { object_id: cause.objectId },
      recoveryActions: ["open_logs"],
    });
  }
  if (cause instanceof ObjectTrashConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      recoveryActions: ["reload_current"],
    });
  }
  return conflict(cause);
}

function captureFailure(cause: unknown): never {
  if (cause instanceof ObjectCaptureContextConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      recoveryActions: ["reload_current"],
    });
  }
  return conflict(cause);
}

export function objectCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  const create = defineCommand<{ root: string; title: string; content: string }>({
    name: "kiwi.object.create-inbox",
    summary: "Create a canonical Inbox item",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "title", "content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        content: { type: "string", maxLength: 1_000_000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const object = await createInboxItem({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: deps.newId(),
        title: args.title,
        content: args.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      });
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const createTyped = defineCommand<{
    root: string;
    type: CreatableObjectType;
    title: string;
    content: string;
  }>({
    name: "kiwi.object.create",
    summary: "Create a canonical object of a chosen type",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "type", "title", "content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        // The enumeration lives in contracts so the schema cannot drift from what the
        // workspace layer will actually accept.
        type: { type: "string", enum: [...CREATABLE_OBJECT_TYPES] },
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        content: { type: "string", maxLength: 1_000_000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const object = await createObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: deps.newId(),
        type: args.type,
        title: args.title,
        content: args.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(typedObjectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const promote = defineCommand<{
    root: string;
    object_id: string;
    type: CreatableObjectType;
    expected_version: number;
    expected_hash: string;
    title?: string;
  }>({
    name: "kiwi.object.promote",
    summary: "Promote an Inbox item to the type it actually is",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "type", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        type: { type: "string", enum: [...CREATABLE_OBJECT_TYPES] },
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const allocated = ids(deps);
      const object = await promoteInboxItem({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        type: args.type,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        ...(args.title === undefined ? {} : { title: args.title }),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(typedObjectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const setReference = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    reference: Reference;
  }>({
    name: "kiwi.object.set-reference",
    summary: "Record the bibliographic details a citation is built from",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "reference"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        reference: {
          type: "object",
          required: ["kind", "authors"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: [...REFERENCE_KINDS] },
            authors: {
              type: "array",
              maxItems: REFERENCE_LIMITS.authors,
              items: { type: "string", maxLength: REFERENCE_LIMITS.authorLength },
            },
            container: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.container },
            year: { type: ["integer", "null"] },
            doi: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.doi },
            url: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.url },
            volume: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.volume },
            issue: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.issue },
            pages: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.pages },
            publisher: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.publisher },
            abstract: { type: ["string", "null"], maxLength: REFERENCE_LIMITS.abstract },
          },
        },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      if (current.object.type !== "source") {
        throw new CommandError(
          "KIWI_INVALID_ARGUMENTS",
          "Only a Paper carries bibliographic details.",
          { details: { actual_type: String(current.object.type) } },
        );
      }
      // Normalizing before validating means a pasted doi.org link is accepted and stored as
      // the bare DOI, rather than rejected for not looking like one.
      const reference = normalizeReference(readReference(args.reference));
      const problems = validateReference(reference, new Date(deps.now()));
      const errors = problems.filter((problem) => problem.severity === "error");
      if (errors.length > 0) {
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "Correct the reference before saving.", {
          details: { fields: [...new Set(errors.map((problem) => problem.field))].join(",") },
          recoveryActions: ["correct_input"],
        });
      }
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: String(current.object.title),
        content: current.object.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: "Updated reference",
        additionalFields: { reference },
        ...allocated,
      }).catch(publicationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, reference },
      };
    },
  });

  /**
   * Which other Papers already carry a DOI.
   *
   * A DOI is the one field in a reference that is meant to identify the work rather than describe
   * it, so it is the only one worth checking as it is typed. Files are already deduplicated by
   * their sha256 on import; this is the other entrance, where somebody types the details of a
   * paper that is in the library twice under two titles.
   *
   * A question and not a rule. Two records for one DOI is sometimes deliberate, a chapter beside
   * the book it is in, a record kept while a merge is decided, and a save that refused would
   * leave somebody holding the correct DOI unable to write it down. What is returned is what the
   * interface needs to say who the other one is; what to do about it is the reader's.
   */
  const doiMatches = defineCommand<{ root: string; doi: string; object_id?: string }>({
    name: "kiwi.object.doi-matches",
    summary: "Find the Papers already carrying a DOI",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "doi"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        doi: { type: "string", maxLength: REFERENCE_LIMITS.doi },
        /** The Paper being edited, which is never a duplicate of itself. */
        object_id: idProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      // Something that is not a DOI cannot be the same DOI as anything. Saving says so in its own
      // words; here a half-typed field is simply not yet a question worth answering.
      const doi = normalizeDoi(args.doi);
      if (doi === null) return { noChange: true, data: { doi: null, matches: [] } };
      const objects = await listCanonicalObjects(args.root);
      const matches = objects
        .filter((object) => object.type === "source" && object.id !== args.object_id)
        .map((object) => {
          const raw = object["reference"];
          if (raw === undefined || raw === null) return null;
          // Both sides normalized, so a record imported before the DOI was tidied still matches
          // what somebody types today.
          const reference = readReference(raw);
          if (reference.doi === null || normalizeDoi(reference.doi) !== doi) return null;
          return { id: object.id, title: object.title, year: reference.year };
        })
        .filter((match): match is { id: string; title: string; year: number | null } => {
          return match !== null;
        });
      return { noChange: true, data: { doi, matches } };
    },
  });

  /**
   * The Papers in the library that look like the same work.
   *
   * Two kinds of evidence, and only two. A shared DOI is the strong one: a DOI names the work
   * rather than describing it, so two records carrying one are two records of one paper unless
   * somebody meant otherwise. A shared title is the weak one, and it is here because the record
   * that arrived without a DOI is exactly the record the DOI check cannot see.
   *
   * Deliberately not a similarity score. A threshold that calls two different papers the same one
   * is worse than a pair this misses, because what it feeds is a list of records somebody is
   * deciding whether to throw away. Same words, in the same order, or nothing.
   *
   * What is attached is counted for the same reason. Kiwi does not merge, so choosing between two
   * records means choosing which set of files and annotations to keep, and that is not a fact
   * anybody should have to go and look up one record at a time.
   */
  const duplicateCandidates = defineCommand<{ root: string }>({
    name: "kiwi.object.duplicate-candidates",
    summary: "Group the Papers that look like the same work",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const papers = (await listCanonicalObjects(args.root))
        .filter((object) => object.type === "source")
        .map((object) => ({ object, reference: readReference(object["reference"]) }));

      const byDoi = new Map<string, typeof papers>();
      for (const paper of papers) {
        const doi = paper.reference.doi === null ? null : normalizeDoi(paper.reference.doi);
        if (doi === null) continue;
        byDoi.set(doi, [...(byDoi.get(doi) ?? []), paper]);
      }

      // A Paper appears in one group only, and the DOI is where it appears if it has one that
      // somebody else also has. The same pair listed twice under two headings is one decision
      // presented as two.
      const claimed = new Set<string>();
      for (const [, group] of byDoi) {
        if (group.length > 1) for (const paper of group) claimed.add(paper.object.id);
      }

      const byTitle = new Map<string, typeof papers>();
      for (const paper of papers) {
        if (claimed.has(paper.object.id)) continue;
        const key = titleKey(paper.object.title);
        if (key === null) continue;
        byTitle.set(key, [...(byTitle.get(key) ?? []), paper]);
      }

      const found = [
        ...[...byDoi].map(([key, group]) => ({ reason: "doi" as const, key, group })),
        ...[...byTitle].map(([key, group]) => ({ reason: "title" as const, key, group })),
      ].filter((candidate) => candidate.group.length > 1);

      const groups = [];
      for (const candidate of found) {
        const records = [];
        for (const paper of candidate.group) {
          const files = await attachedFiles(args.root, paper.object.id);
          const annotations = await annotationsForObject(args.root, paper.object.id);
          records.push({
            id: paper.object.id,
            title: paper.object.title,
            // Saving anything about one of these quotes both, so they travel with the record
            // rather than being read again once somebody has decided.
            version: paper.object.version,
            content_hash: paper.object.content_hash,
            updated_at: paper.object.updated_at,
            reference: paper.reference,
            files: files.length,
            annotations: annotations.length,
          });
        }
        groups.push({ reason: candidate.reason, key: candidate.key, records });
      }
      return { noChange: true, data: { groups } };
    },
  });

  const setSummary = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    summary: string;
  }>({
    name: "kiwi.object.set-summary",
    summary: "Record a one-line summary of an object in the reader's own words",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "summary"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        summary: { type: "string", maxLength: PAPER_SUMMARY_LIMIT },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    /**
     * Any object, not only a Paper. A reference is restricted to a Paper because a citation is
     * built from it and nothing else has one; a sentence saying what a thing is applies to a
     * Manuscript and a Note just as well, and a restriction with no reason behind it is one more
     * rule to explain.
     */
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const summary = normalizePaperSummary(args.summary);
      if (summary === readPaperSummary(current.object["summary"])) {
        // A form somebody opened and closed is not a change. Publishing it anyway would put a
        // version in the history that restores to exactly what it was restored from.
        return { noChange: true, data: { object: current.object, summary } };
      }
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: String(current.object.title),
        content: current.object.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: "Updated summary",
        additionalFields: { summary },
        ...allocated,
      }).catch(publicationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, summary },
      };
    },
  });

  const setRead = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    read: boolean;
  }>({
    name: "kiwi.object.set-read",
    summary: "Mark an object read or unread",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "read"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        read: { type: "boolean" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    /**
     * The state to end in, rather than a toggle.
     *
     * Two people marking the same paper read from two windows both mean it to be read, and a
     * toggle would leave it unread. Saying which state was intended also makes the command
     * idempotent, so a retry after a lost answer is not a second flip.
     */
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      if (args.read === readPaperReadState(current.object["read"])) {
        // Marking a paper read twice is not an edit. Publishing it anyway would fill the history
        // of a paper somebody keeps returning to with versions that changed nothing.
        return { noChange: true, data: { object: current.object, read: args.read } };
      }
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: String(current.object.title),
        content: current.object.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: args.read ? "Marked read" : "Marked unread",
        additionalFields: { read: args.read },
        ...allocated,
      }).catch(publicationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, read: args.read },
      };
    },
  });

  const attach = defineCommand<{ root: string; object_id: string; asset_id: string }>({
    name: "kiwi.object.attach-file",
    summary: "Attach an imported file to an object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "asset_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty, asset_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      if ((await readCanonicalObject(args.root, args.object_id)) === null)
        throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const allocated = ids(deps);
      const relation = await attachFile({
        root: args.root,
        workspaceId: workspaceId(context),
        relationId: deps.newId(),
        objectId: args.object_id,
        assetId: args.asset_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(attachmentFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          relation,
          undo: {
            command: "kiwi.object.detach-file",
            args: { object_id: args.object_id, asset_id: args.asset_id },
          },
        },
      };
    },
  });

  const detach = defineCommand<{ root: string; object_id: string; asset_id: string }>({
    name: "kiwi.object.detach-file",
    summary: "Detach a file from an object without deleting the file",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "asset_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty, asset_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const relation = await detachFile({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        assetId: args.asset_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(attachmentFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { relation },
      };
    },
  });

  const files = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.files",
    summary: "List the files attached to an object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    /**
     * Says which of the files are gone, so that the interface can say so before somebody reads.
     *
     * Finding out that a file is missing at the moment you try to open it is the failure this
     * exists to prevent: by then the Reader is already up, and the answer arrives as an error over
     * an empty page instead of as a fact about the paper.
     *
     * The listing is where the check belongs because the listing is what is looked at first, and
     * it already reads every attached object. It costs one `lstat` a file.
     */
    async handler(args) {
      const files = await attachedFiles(args.root, args.object_id);
      return {
        noChange: true,
        data: { files, missing: await missingAssetFiles(args.root, files) },
      };
    },
  });

  const setPrimaryFile = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    asset_id: string;
  }>({
    name: "kiwi.object.set-primary-file",
    summary: "Choose the file an object opens to",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "asset_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        asset_id: idProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    /**
     * The file has to be attached already, and this only writes the name.
     *
     * Choosing a file that is not on the Paper would leave a name nothing can match, which reads
     * the same as no choice at all, so it is refused here rather than stored and quietly ignored
     * every time the Paper is opened. Attaching stays a separate command: a file arrives on a
     * Paper for its own reasons, and which one is opened is a later decision about the ones there.
     */
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const attached = await attachedFiles(args.root, args.object_id);
      if (!attached.some((file) => file.id === args.asset_id))
        throw new CommandError(
          "KIWI_INVALID_ARGUMENTS",
          "That file is not attached to this object.",
          { details: { kind: "not_attached" }, recoveryActions: ["reload_current"] },
        );
      if (current.object["primary_asset_id"] === args.asset_id) {
        // Choosing the file that is already chosen is not an edit.
        return { noChange: true, data: { object: current.object, asset_id: args.asset_id } };
      }
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: String(current.object.title),
        content: current.object.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: "Chose the primary file",
        additionalFields: { primary_asset_id: args.asset_id },
        ...allocated,
      }).catch(publicationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, asset_id: args.asset_id },
      };
    },
  });

  const createAnnotationCommand = defineCommand<{
    root: string;
    object_id: string;
    annotation: Annotation;
  }>({
    name: "kiwi.annotation.create",
    summary: "Record a mark made while reading a file",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "annotation"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty, annotation: annotationSchema },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const object = await createAnnotation({
        root: args.root,
        workspaceId: workspaceId(context),
        annotationId: deps.newId(),
        relationId: deps.newId(),
        objectId: args.object_id,
        annotation: { ...EMPTY_ANNOTATION, ...args.annotation },
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(annotationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const updateAnnotationCommand = defineCommand<{
    root: string;
    annotation_id: string;
    expected_version: number;
    expected_hash: string;
    annotation: Annotation;
  }>({
    name: "kiwi.annotation.update",
    summary: "Change an annotation's comment, colour, or region",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "annotation_id", "expected_version", "expected_hash", "annotation"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        annotation_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        annotation: annotationSchema,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const object = await updateAnnotation({
        root: args.root,
        workspaceId: workspaceId(context),
        annotationId: args.annotation_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        annotation: { ...EMPTY_ANNOTATION, ...args.annotation },
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(annotationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const listAnnotations = defineCommand<{ root: string; object_id: string; asset_id?: string }>({
    name: "kiwi.annotation.list",
    summary: "List the annotations on an object, in reading order",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty, asset_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await annotationsForObject(args.root, args.object_id, args.asset_id);
      return {
        noChange: true,
        data: {
          annotations: found.map((entry) => ({
            id: entry.object.id,
            version: entry.object.version,
            content_hash: entry.object.content_hash,
            title: entry.object.title,
            updated_at: entry.object.updated_at,
            // A mark's tags come with it. They are ordinary object tags, added by the same
            // command as any other, but a Reader that had to ask for each mark's separately
            // would make one call per mark to show a row of chips.
            tags: entry.object.tags,
            // Who made the mark. A document read by three people carries three people's marks,
            // and a Reader that could not tell them apart could not offer to show one person's
            // and not another's. The id is the one the mark was written under; what that person
            // is called is the account service's business, not the workspace's.
            created_by: entry.object.created_by,
            annotation: entry.annotation,
          })),
        },
      };
    },
  });

  /**
   * Where a mark was made, so a quotation can be followed back to the page it came from.
   *
   * The quotation stores the mark and nothing else that matters, because everything else moves:
   * the paper is renamed, its file is replaced, the mark is deleted. Asking at the moment somebody
   * clicks is what makes the answer current, and one small read is cheap next to the alternative,
   * which is a note full of stale page numbers.
   */
  const locate = defineCommand<{ root: string; annotation_id: string }>({
    name: "kiwi.annotation.locate",
    summary: "Say which paper, file and page a mark is on",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "annotation_id"],
      additionalProperties: false,
      properties: { root: rootProperty, annotation_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      // Null rather than an error. A quotation outliving the mark it was taken from is an
      // ordinary thing for a workspace people delete from, not a fault to be reported.
      return {
        noChange: true,
        data: { location: await locateAnnotation(args.root, args.annotation_id) },
      };
    },
  });

  const sendToNote = defineCommand<{
    root: string;
    annotation_ids: string[];
    note_id?: string;
    note_title?: string;
  }>({
    name: "kiwi.annotation.send-to-note",
    summary: "Copy annotations into a note, keeping a link back to each",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "annotation_ids"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        annotation_ids: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          uniqueItems: true,
          items: idProperty,
        },
        note_id: idProperty,
        note_title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      if (args.note_id === undefined && (args.note_title ?? "").trim() === "") {
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "Choose a note or name a new one.", {
          recoveryActions: ["correct_input"],
        });
      }
      const allocated = ids(deps);
      const receipt = await sendAnnotationsToNote({
        root: args.root,
        workspaceId: workspaceId(context),
        noteId: args.note_id ?? null,
        newNoteId: deps.newId(),
        newNoteTitle: args.note_title ?? "Notes",
        annotationIds: args.annotation_ids,
        // One relation id per annotation, allocated up front so the transaction writes in
        // a single commit rather than growing ids as it goes.
        relationIds: args.annotation_ids.map(() => deps.newId()),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(noteTargetFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          note: receipt.note,
          added: receipt.added,
          skipped: receipt.skipped,
        },
      };
    },
  });

  const sendToManuscript = defineCommand<{
    root: string;
    manuscript_id: string;
    section?: string;
    annotation_ids?: string[];
    excerpt?: { object_id: string; annotation: Annotation };
  }>({
    name: "kiwi.annotation.send-to-manuscript",
    summary: "Write a passage into a section of a manuscript, keeping a link back to it",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "manuscript_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        manuscript_id: idProperty,
        // The heading, not its position. A position moves the moment somebody adds a paragraph
        // above it; the heading is what the person choosing it read off the list.
        section: { type: "string", minLength: 1, maxLength: 200 },
        annotation_ids: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: idProperty,
        },
        excerpt: {
          type: "object",
          required: ["object_id", "annotation"],
          additionalProperties: false,
          properties: { object_id: idProperty, annotation: annotationSchema },
        },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const annotationIds = args.annotation_ids ?? [];
      if (args.excerpt === undefined && annotationIds.length === 0) {
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "Choose what to send.", {
          recoveryActions: ["correct_input"],
        });
      }
      const allocated = ids(deps);
      const excerpt =
        args.excerpt === undefined
          ? null
          : {
              objectId: args.excerpt.object_id,
              annotationId: deps.newId(),
              relationId: deps.newId(),
              annotation: args.excerpt.annotation,
            };
      const receipt = await sendExcerptToManuscript({
        root: args.root,
        workspaceId: workspaceId(context),
        manuscriptId: args.manuscript_id,
        section: args.section ?? null,
        excerpt,
        annotationIds,
        // One relation id per quotation, allocated up front so the transaction writes in a
        // single commit rather than growing ids as it goes.
        relationIds: [
          ...(excerpt === null ? [] : [deps.newId()]),
          ...annotationIds.map(() => deps.newId()),
        ],
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(manuscriptTargetFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          manuscript: receipt.manuscript,
          section: receipt.section,
          added: receipt.added,
          skipped: receipt.skipped,
          annotation_id: receipt.annotationId,
        },
      };
    },
  });

  const setDocument = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    document?: unknown;
    source?: string;
    mode: DocumentMode;
    title?: string;
  }>({
    name: "kiwi.object.set-document",
    summary: "Save the body of a Note or Manuscript",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "mode"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        // The node tree is not described field by field here. Its shape is the editor's, it
        // nests arbitrarily, and validateDocument checks what actually matters: that it is a
        // tree, and that it is not larger than a document should be.
        document: { type: "object" },
        source: { type: "string", maxLength: DOCUMENT_LIMITS.text },
        mode: { type: "string", enum: [...DOCUMENT_MODES] },
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");

      let content: string;
      let fields: Record<string, unknown>;
      if (args.mode === "latex") {
        // LaTeX is plain text already, so it is the content. Storing a node tree for it would
        // be a second representation of something that has only one.
        content = args.source ?? "";
        fields = { document_mode: "latex", document: null };
      } else {
        const problems = validateDocument(args.document);
        if (problems.length > 0) {
          throw new CommandError("KIWI_INVALID_ARGUMENTS", problems[0]?.message ?? "Invalid.", {
            recoveryActions: ["correct_input"],
          });
        }
        // The words are derived here rather than sent by the interface, so what search reads
        // can never drift from what the document says.
        content = documentText(args.document);
        fields = { document_mode: "rich", document: args.document };
      }

      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title ?? String(current.object.title),
        content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: "Edited document",
        additionalFields: fields,
        relocateToTitlePath: args.title !== undefined,
        ...allocated,
      }).catch(publicationFailure);

      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, words: countWords(content) },
      };
    },
  });

  const quickCaptureCommand = defineCommand<{
    root: string;
    title: string;
    content: string;
    context: {
      surface: string;
      project_id: string | null;
      object: { object_id: string; version: number; content_hash: string } | null;
      source: {
        object_id: string;
        version: number;
        content_hash: string;
        representation_id: string | null;
      } | null;
      selection: { text: string; prefix: string | null; suffix: string | null } | null;
    };
  }>({
    name: "kiwi.object.quick-capture",
    summary: "Create an Inbox item with exact active context and selected text provenance",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "title", "content", "context"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        content: { type: "string", maxLength: 1_000_000 },
        context: {
          type: "object",
          required: ["surface", "project_id", "object", "source", "selection"],
          additionalProperties: false,
          properties: {
            surface: {
              enum: [
                "collection",
                "inbox",
                "live-notes",
                "search",
                "trash",
                "plan",
                "execute",
                "workbench",
              ],
            },
            project_id: {
              anyOf: [
                { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
                { type: "null" },
              ],
            },
            object: {
              anyOf: [
                {
                  type: "object",
                  required: ["object_id", "version", "content_hash"],
                  additionalProperties: false,
                  properties: {
                    object_id: idProperty,
                    version: { type: "integer", minimum: 1 },
                    content_hash: hashProperty,
                  },
                },
                { type: "null" },
              ],
            },
            source: {
              anyOf: [
                {
                  type: "object",
                  required: ["object_id", "version", "content_hash", "representation_id"],
                  additionalProperties: false,
                  properties: {
                    object_id: idProperty,
                    version: { type: "integer", minimum: 1 },
                    content_hash: hashProperty,
                    representation_id: {
                      anyOf: [
                        { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
                        { type: "null" },
                      ],
                    },
                  },
                },
                { type: "null" },
              ],
            },
            selection: {
              anyOf: [
                {
                  type: "object",
                  required: ["text", "prefix", "suffix"],
                  additionalProperties: false,
                  properties: {
                    text: { type: "string", minLength: 1, maxLength: 100_000, pattern: "\\S" },
                    prefix: {
                      anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }],
                    },
                    suffix: {
                      anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }],
                    },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const object = await quickCapture({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: deps.newId(),
        title: args.title,
        content: args.content,
        context: args.context,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(captureFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, capture_context: object.provenance[0] },
      };
    },
  });

  const list = defineCommand<{ root: string }>({
    name: "kiwi.object.list",
    summary: "List canonical workspace objects",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      return { noChange: true, data: { objects: await listCanonicalObjects(args.root) } };
    },
  });

  const read = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.read",
    summary: "Read a canonical object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await readCanonicalObject(args.root, args.object_id);
      if (found === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      return { noChange: true, data: { object: found.object } };
    },
  });

  const organization = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.organization",
    summary: "Read object tags and collection memberships",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      return {
        noChange: true,
        data: { organization: await objectOrganization(args.root, args.object_id) },
      };
    },
  });

  const validateTrash = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
  }>({
    name: "kiwi.object.validate-trash",
    summary: "Preview exact dependency impact before moving an object to Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const preview = await previewObjectTrash({
        root: args.root,
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
      }).catch(trashFailure);
      return { noChange: true, data: { preview } };
    },
  });

  const moveToTrash = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    expected_relations: Array<{
      relation_id: string;
      version: number;
      content_hash: string;
    }>;
  }>({
    name: "kiwi.object.trash",
    summary: "Move one canonical object to recoverable workspace Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "expected_relations"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        expected_relations: {
          type: "array",
          maxItems: 10000,
          items: {
            type: "object",
            required: ["relation_id", "version", "content_hash"],
            additionalProperties: false,
            properties: {
              relation_id: idProperty,
              version: { type: "integer", minimum: 1 },
              content_hash: hashProperty,
            },
          },
        },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const activeWorkspaceId = workspaceId(context);
      if (
        (await deps.hasRecoveryDraft?.(context.actor.id, activeWorkspaceId, args.object_id)) ===
        true
      )
        throw new CommandError(
          "KIWI_INVALID_REQUEST",
          "Save or discard the local recovery draft before moving this object to Trash.",
          { recoveryActions: ["correct_input"] },
        );
      const allocated = ids(deps);
      const entry = await trashObject({
        root: args.root,
        workspaceId: activeWorkspaceId,
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        expectedRelations: args.expected_relations,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(trashFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          entry,
          undo: {
            command: "kiwi.object.restore-from-trash",
            args: { object_id: args.object_id },
          },
        },
      };
    },
  });

  const trashList = defineCommand<{ root: string }>({
    name: "kiwi.object.trash-list",
    summary: "List recoverable objects in workspace Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const entries = await listTrash(args.root).catch(trashFailure);
      return { noChange: true, data: { entries } };
    },
  });

  const restoreFromTrash = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.restore-from-trash",
    summary: "Restore an object and its relations from workspace Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const restored = await restoreTrashedObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(trashFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: restored,
      };
    },
  });

  const trashPolicy = defineCommand<{ root: string }>({
    name: "kiwi.object.trash-policy",
    summary: "Read the optional workspace Trash age policy",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      return {
        noChange: true,
        data: { policy: await readTrashCleanupPolicy(args.root).catch(trashFailure) },
      };
    },
  });

  const validateTrashPolicy = defineCommand<{
    root: string;
    enabled: boolean;
    minimum_age_days: number;
  }>({
    name: "kiwi.object.validate-trash-policy",
    summary: "Preview exact current targets before changing the Trash age policy",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "enabled", "minimum_age_days"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        enabled: { type: "boolean" },
        minimum_age_days: { type: "integer", minimum: 1, maximum: 3650 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const preview = await previewTrashCleanupPolicy({
        root: args.root,
        policy: { enabled: args.enabled, minimum_age_days: args.minimum_age_days },
        now: deps.now(),
      }).catch(trashFailure);
      return { noChange: true, data: { preview } };
    },
  });

  const setTrashPolicy = defineCommand<{
    root: string;
    enabled: boolean;
    minimum_age_days: number;
    preview_token: string;
  }>({
    name: "kiwi.object.set-trash-policy",
    summary: "Set the reviewed workspace Trash age policy without running cleanup",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "enabled", "minimum_age_days", "preview_token"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        enabled: { type: "boolean" },
        minimum_age_days: { type: "integer", minimum: 1, maximum: 3650 },
        preview_token: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const result = await setTrashCleanupPolicy({
        root: args.root,
        workspaceId: workspaceId(context),
        policy: { enabled: args.enabled, minimum_age_days: args.minimum_age_days },
        previewToken: args.preview_token,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(trashFailure);
      if (!result.changed) return { noChange: true, data: result };
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: result,
      };
    },
  });

  const validateTrashPurge = defineCommand<{ root: string; scope: "all" | "age" }>({
    name: "kiwi.object.validate-trash-purge",
    summary: "Preview exact irreversible workspace Trash purge scope",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "scope"],
      additionalProperties: false,
      properties: { root: rootProperty, scope: { enum: ["all", "age"] } },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const preview = await previewTrashPurge({
        root: args.root,
        scope: args.scope,
        now: deps.now(),
      }).catch(trashFailure);
      return { noChange: true, data: { preview } };
    },
  });

  const purgeWorkspaceTrash = defineCommand<{
    root: string;
    scope: "all" | "age";
    preview_token: string;
  }>({
    name: "kiwi.object.purge-trash",
    summary: "Permanently remove reviewed workspace Trash snapshots without Undo",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "scope", "preview_token"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        scope: { enum: ["all", "age"] },
        preview_token: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const receipt = await purgeTrash({
        root: args.root,
        workspaceId: workspaceId(context),
        scope: args.scope,
        previewToken: args.preview_token,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(trashFailure);
      if (receipt.purged_count === 0) return { noChange: true, data: { receipt } };
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { receipt },
      };
    },
  });

  const rename = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    title: string;
  }>({
    name: "kiwi.object.rename",
    summary: "Rename a canonical object and its readable file path",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "title"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.object_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title,
        content: current.object.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        reason: "Renamed object",
        relocateToTitlePath: true,
        ...allocated,
      }).catch(conflict);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          object,
          undo: {
            command: "kiwi.object.rename",
            args: {
              object_id: object.id,
              expected_version: object.version,
              expected_hash: object.content_hash,
              title: current.object.title,
            },
          },
        },
      };
    },
  });

  const tag = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    tag_id: string;
    action: "add" | "remove";
  }>({
    name: "kiwi.object.tag",
    summary: "Add or remove one tag on a canonical object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "tag_id", "action"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        tag_id: { type: "string", minLength: 1, maxLength: 150, pattern: "\\S" },
        action: { enum: ["add", "remove"] },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const receipt = await bulkTagObjects({
        root: args.root,
        workspaceId: workspaceId(context),
        targets: [
          {
            objectId: args.object_id,
            expectedVersion: args.expected_version,
            expectedHash: args.expected_hash,
          },
        ],
        tagId: args.tag_id,
        action: args.action,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(conflict);
      if (receipt.changed_count === 0) return { noChange: true, data: { receipt, undo: null } };
      const changed = receipt.changes[0]!;
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          object: changed.object,
          receipt,
          undo: {
            command: "kiwi.object.tag",
            args: {
              object_id: changed.object.id,
              expected_version: changed.object.version,
              expected_hash: changed.object.content_hash,
              tag_id: args.tag_id,
              action: args.action === "add" ? "remove" : "add",
            },
          },
        },
      };
    },
  });

  const duplicate = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    title: string;
  }>({
    name: "kiwi.object.duplicate",
    summary: "Duplicate a canonical object with explicit ancestry",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "title"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const result = await duplicateObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        duplicateObjectId: deps.newId(),
        relationId: deps.newId(),
        title: args.title,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(conflict);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object: result.object, relation: result.relation },
      };
    },
  });

  function collectionCommand(action: "collect" | "move" | "remove"): CommandDefinition {
    return defineCommand<{
      root: string;
      object_id: string;
      expected_version: number;
      expected_hash: string;
      expected_collection_ids: string[];
      destination_title?: string;
      source_collection_id?: string;
    }>({
      name: `kiwi.object.${action === "remove" ? "remove-from-collection" : action}`,
      summary:
        action === "collect"
          ? "Add an object to a collection without copying it"
          : action === "move"
            ? "Move one collection membership to another collection"
            : "Remove an object from a collection without deleting it",
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui", "cli", "api"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: [
          "root",
          "object_id",
          "expected_version",
          "expected_hash",
          "expected_collection_ids",
          ...(action === "remove" ? ["source_collection_id"] : ["destination_title"]),
          ...(action === "move" ? ["source_collection_id"] : []),
        ],
        additionalProperties: false,
        properties: {
          root: rootProperty,
          object_id: idProperty,
          expected_version: { type: "integer", minimum: 1 },
          expected_hash: hashProperty,
          expected_collection_ids: {
            type: "array",
            uniqueItems: true,
            maxItems: 500,
            items: idProperty,
          },
          destination_title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
          source_collection_id: idProperty,
        },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const allocated = ids(deps);
        const receipt = await changeCollectionMembership({
          root: args.root,
          workspaceId: workspaceId(context),
          objectId: args.object_id,
          expectedVersion: args.expected_version,
          expectedHash: args.expected_hash,
          expectedCollectionIds: args.expected_collection_ids,
          action,
          ...(args.destination_title === undefined
            ? {}
            : { destinationTitle: args.destination_title }),
          ...(args.source_collection_id === undefined
            ? {}
            : { sourceCollectionId: args.source_collection_id }),
          collectionObjectId: deps.newId(),
          relationId: deps.newId(),
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        }).catch(conflict);
        if (!receipt.changed) return { noChange: true, data: { receipt, undo: null } };
        return {
          transactionId: allocated.transactionId,
          eventIds: [
            allocated.preparedEventId,
            allocated.domainEventId,
            allocated.committedEventId,
          ],
          data: {
            receipt,
            undo:
              receipt.undo === null
                ? null
                : {
                    command: `kiwi.object.${receipt.undo.action === "remove" ? "remove-from-collection" : receipt.undo.action}`,
                    args: {
                      object_id: args.object_id,
                      expected_version: args.expected_version,
                      expected_hash: args.expected_hash,
                      expected_collection_ids: receipt.undo.expected_collection_ids,
                      ...(receipt.undo.destination_title === undefined
                        ? {}
                        : { destination_title: receipt.undo.destination_title }),
                      ...(receipt.undo.source_collection_id === undefined
                        ? {}
                        : { source_collection_id: receipt.undo.source_collection_id }),
                    },
                  },
          },
        };
      },
    });
  }

  const collect = collectionCommand("collect");
  const move = collectionCommand("move");
  const removeFromCollection = collectionCommand("remove");

  const reveal = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.reveal",
    summary: "Reveal a canonical object in the operating system file browser",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await readCanonicalObject(args.root, args.object_id);
      if (found === null) throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      await deps.revealFile?.(args.root, found.relativePath);
      return {
        noChange: true,
        data: { object_id: args.object_id, revealed: deps.revealFile !== undefined },
      };
    },
  });

  const validatePublish = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    title: string;
    content: string;
  }>({
    name: "kiwi.object.validate-save",
    summary: "Validate a proposed object version and report dependency impact",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "title", "content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", maxLength: 500 },
        content: { type: "string", maxLength: 1_000_100 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const preview = await previewObjectPublication({
        root: args.root,
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title,
        content: args.content,
      }).catch(conflict);
      return { noChange: true, data: { preview } };
    },
  });

  const publish = defineCommand<{
    root: string;
    object_id: string;
    expected_version: number;
    expected_hash: string;
    title: string;
    content: string;
    reason?: string;
  }>({
    name: "kiwi.object.save",
    summary: "Save a new immutable object version",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "expected_version", "expected_hash", "title", "content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        content: { type: "string", maxLength: 1_000_000 },
        reason: { type: "string", maxLength: 500 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const preview = await previewObjectPublication({
        root: args.root,
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title,
        content: args.content,
      }).catch(conflict);
      const errors = preview.problems.filter((problem) => problem.severity === "error");
      if (errors.length > 0) {
        throw new CommandError(
          "KIWI_INVALID_ARGUMENTS",
          "Correct the listed problems before saving.",
          {
            details: { error_count: errors.length },
            recoveryActions: ["correct_input"],
          },
        );
      }
      const allocated = ids(deps);
      const object = await publishObject({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title,
        content: args.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...allocated,
      }).catch(publicationFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, preview },
        warnings: preview.problems
          .filter((problem) => problem.severity === "warning")
          .map((problem) => problem.message),
      };
    },
  });

  const history = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.object.history",
    summary: "Read immutable object version history",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const [history, activity] = await Promise.all([
        objectHistory(args.root, args.object_id),
        objectActivity(args.root, args.object_id),
      ]).catch(historyFailure);
      return { noChange: true, data: { history, activity } };
    },
  });

  /**
   * The whole journal, filtered, for the History page.
   *
   * A limit is taken and a total is returned beside it: "showing 200 of 4,318" is a different
   * page from "4,318", and a page that quietly cut the list would be the second pretending to be
   * the first.
   */
  const activityLog = defineCommand<{
    root: string;
    actor?: string;
    object_id?: string;
    event_type?: string;
    limit?: number;
  }>({
    name: "kiwi.event.list",
    summary: "List what has happened in this workspace, filtered",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        actor: { type: "string", minLength: 1, maxLength: 200 },
        object_id: idProperty,
        event_type: { type: "string", minLength: 1, maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const activity = await workspaceActivity(args.root, {
        actor: args.actor,
        objectId: args.object_id,
        eventType: args.event_type,
        limit: args.limit ?? 200,
      }).catch(historyFailure);
      return { noChange: true, data: { ...activity } };
    },
  });

  const readVersion = defineCommand<{
    root: string;
    object_id: string;
    version: number;
  }>({
    name: "kiwi.object.read-version",
    summary: "Read one immutable historical object version",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "version"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        version: { type: "integer", minimum: 1 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const object = await readObjectVersion(args.root, args.object_id, args.version).catch(
        historyFailure,
      );
      if (object === null)
        throw new CommandError("KIWI_NOT_FOUND", "That historical version was not found.");
      return { noChange: true, data: { object } };
    },
  });

  const validateRestore = defineCommand<{
    root: string;
    object_id: string;
    restore_version: number;
    expected_version: number;
    expected_hash: string;
  }>({
    name: "kiwi.object.validate-restore",
    summary: "Validate historical restoration and report dependency impact",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "restore_version", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        restore_version: { type: "integer", minimum: 1 },
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      workspaceId(context);
      const preview = await previewObjectRestore({
        root: args.root,
        objectId: args.object_id,
        restoreVersion: args.restore_version,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
      }).catch(historyFailure);
      return { noChange: true, data: { preview } };
    },
  });

  const restore = defineCommand<{
    root: string;
    object_id: string;
    restore_version: number;
    expected_version: number;
    expected_hash: string;
    reason?: string;
  }>({
    name: "kiwi.object.restore-version",
    summary: "Restore historical content as a new object version",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "restore_version", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        restore_version: { type: "integer", minimum: 1 },
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        reason: { type: "string", maxLength: 500 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const preview = await previewObjectRestore({
        root: args.root,
        objectId: args.object_id,
        restoreVersion: args.restore_version,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
      }).catch(historyFailure);
      const allocated = ids(deps);
      const object = await restoreObjectVersion({
        root: args.root,
        workspaceId: workspaceId(context),
        objectId: args.object_id,
        restoreVersion: args.restore_version,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...allocated,
      }).catch(historyFailure);
      const updatedHistory = await objectHistory(args.root, args.object_id).catch(historyFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          object,
          restore: {
            source_version: args.restore_version,
            new_version: object.version,
            history_count: updatedHistory.length,
            impact: preview.impact,
          },
        },
      };
    },
  });

  function bulkTagCommand(action: "add" | "remove"): CommandDefinition {
    return defineCommand<{
      root: string;
      tag_id: string;
      targets: Array<{
        object_id: string;
        expected_version: number;
        expected_hash: string;
      }>;
    }>({
      name: `kiwi.object.bulk-${action}-tag`,
      summary: `${action === "add" ? "Add" : "Remove"} a tag on selected canonical objects`,
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui", "cli", "api"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "tag_id", "targets"],
        additionalProperties: false,
        properties: {
          root: rootProperty,
          tag_id: { type: "string", minLength: 1, maxLength: 150, pattern: "\\S" },
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: {
              type: "object",
              required: ["object_id", "expected_version", "expected_hash"],
              additionalProperties: false,
              properties: {
                object_id: idProperty,
                expected_version: { type: "integer", minimum: 1 },
                expected_hash: hashProperty,
              },
            },
          },
        },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const allocated = ids(deps);
        const receipt = await bulkTagObjects({
          root: args.root,
          workspaceId: workspaceId(context),
          targets: args.targets.map((target) => ({
            objectId: target.object_id,
            expectedVersion: target.expected_version,
            expectedHash: target.expected_hash,
          })),
          tagId: args.tag_id,
          action,
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        }).catch(conflict);
        if (receipt.changed_count === 0) return { noChange: true, data: { receipt } };
        return {
          transactionId: allocated.transactionId,
          eventIds: [
            allocated.preparedEventId,
            allocated.domainEventId,
            allocated.committedEventId,
          ],
          data: { receipt },
        };
      },
    });
  }

  const bulkAddTag = bulkTagCommand("add");
  const bulkRemoveTag = bulkTagCommand("remove");

  const relate = defineCommand<{
    root: string;
    type: string;
    subject_id: string;
    object_id: string;
  }>({
    name: "kiwi.relation.create",
    summary: "Create a typed directed relation",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "type", "subject_id", "object_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        type: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
        subject_id: idProperty,
        object_id: idProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const relation = await createRelation({
        root: args.root,
        workspaceId: workspaceId(context),
        relationId: deps.newId(),
        type: args.type,
        subjectId: args.subject_id,
        objectId: args.object_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      });
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { relation },
      };
    },
  });

  const relations = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.relation.for-object",
    summary: "List incoming and outgoing relations for an object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      return {
        noChange: true,
        data: { relations: await relationsForObject(args.root, args.object_id) },
      };
    },
  });

  const listConflicts = defineCommand<{ root: string; object_id?: string }>({
    name: "kiwi.conflict.list",
    summary: "List preserved structured-object conflicts",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const conflicts = await listStructuredConflicts(args.root);
      return {
        noChange: true,
        data: {
          conflicts:
            args.object_id === undefined
              ? conflicts
              : conflicts.filter((item) => item.object_id === args.object_id),
        },
      };
    },
  });

  const resolveConflict = defineCommand<{
    root: string;
    conflict_id: string;
    resolution: "mine" | "theirs";
    expected_version: number;
    expected_hash: string;
    keep_other?: boolean;
  }>({
    name: "kiwi.conflict.resolve",
    summary: "Resolve a structured conflict as a new version",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "conflict_id", "resolution", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        conflict_id: idProperty,
        resolution: { enum: ["mine", "theirs"] },
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        keep_other: { type: "boolean" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      // The copy is a new object with a new relation, so it needs identifiers and events of its
      // own even though it lands in the same transaction as the save.
      const keepOther =
        args.keep_other === true
          ? {
              objectId: deps.newId(),
              relationId: deps.newId(),
              objectEventId: deps.newId(),
              relationEventId: deps.newId(),
            }
          : null;
      const resolved = await resolveStructuredConflict({
        root: args.root,
        workspaceId: workspaceId(context),
        conflictId: args.conflict_id,
        resolution: args.resolution,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...(keepOther === null ? {} : { keepOther }),
        ...allocated,
      }).catch(conflict);
      return {
        transactionId: allocated.transactionId,
        eventIds: [
          allocated.preparedEventId,
          allocated.domainEventId,
          ...(keepOther === null ? [] : [keepOther.objectEventId, keepOther.relationEventId]),
          allocated.committedEventId,
        ],
        data: resolved,
      };
    },
  });

  const recordExternalConflict = defineCommand<{
    root: string;
    object_id: string;
    base_version: number;
    base_hash: string;
    mine_title: string;
    mine_content: string;
  }>({
    name: "kiwi.conflict.record-external",
    summary: "Preserve an editor draft that conflicts with an external file edit",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "base_version", "base_hash", "mine_title", "mine_content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        base_version: { type: "integer", minimum: 1 },
        base_hash: hashProperty,
        mine_title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        mine_content: { type: "string", maxLength: 1_000_000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const conflictRecord = await createExternalDraftConflict({
        root: args.root,
        workspaceId: workspaceId(context),
        conflictId: deps.newId(),
        objectId: args.object_id,
        baseVersion: args.base_version,
        baseHash: args.base_hash,
        mineTitle: args.mine_title,
        mineContent: args.mine_content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      });
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { conflict: conflictRecord },
      };
    },
  });

  return [
    create,
    quickCaptureCommand,
    list,
    read,
    organization,
    validateTrash,
    moveToTrash,
    trashList,
    restoreFromTrash,
    trashPolicy,
    validateTrashPolicy,
    setTrashPolicy,
    validateTrashPurge,
    purgeWorkspaceTrash,
    createTyped,
    promote,
    setReference,
    doiMatches,
    duplicateCandidates,
    setSummary,
    setRead,
    setDocument,
    createAnnotationCommand,
    updateAnnotationCommand,
    listAnnotations,
    locate,
    sendToNote,
    sendToManuscript,
    attach,
    detach,
    files,
    setPrimaryFile,
    rename,
    tag,
    duplicate,
    collect,
    move,
    removeFromCollection,
    reveal,
    validatePublish,
    publish,
    history,
    activityLog,
    readVersion,
    validateRestore,
    restore,
    bulkAddTag,
    bulkRemoveTag,
    relate,
    relations,
    listConflicts,
    recordExternalConflict,
    resolveConflict,
  ];
}
