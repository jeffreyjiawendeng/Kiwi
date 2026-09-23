import {
  CRITERION_KINDS,
  EXTRACTION_FIELD_TYPES,
  HYPOTHESIS_DIRECTIONS,
  HYPOTHESIS_STATUSES,
  PROTOCOL_LIMITS,
  readDocument,
  validateDocument,
  type Criterion,
  type ExtractionField,
  type Hypothesis,
  type Preregistration,
  type SubQuestion,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  NotAProjectError,
  ObjectPublicationValidationError,
  ObjectVersionConflict,
  ProtocolFrozen,
  ProtocolNotFound,
  ProtocolValidationError,
  ensureProtocol,
  freezeStoredProtocol,
  logProtocolDeviation,
  protocolForProject,
  readCanonicalObject,
  updateProtocol,
  type ProtocolChanges,
  type ProtocolWrite,
  type StoredProtocol,
} from "./objects.js";
import {
  commandIds,
  commandWorkspaceId,
  hashProperty,
  idProperty,
  rootProperty,
  type ObjectCommandDeps,
} from "./object-commands.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

/** An id minted inside a protocol: `Q1`, `H2`, `E3`. Short, and never reused. */
const entryIdProperty = { type: "string", minLength: 1, maxLength: 40 };

/**
 * One line of a protocol: a sub-question, a hypothesis, what a criterion says.
 *
 * The limit is the question's, because a hypothesis that will not fit where the question fits is
 * a method wearing a hypothesis's clothes.
 */
const lineProperty = { type: "string", maxLength: PROTOCOL_LIMITS.question };

const dayProperty = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

const subQuestionProperty = {
  type: "object",
  required: ["id", "text"],
  additionalProperties: false,
  properties: { id: entryIdProperty, text: lineProperty },
};

const hypothesisProperty = {
  type: "object",
  required: ["id", "statement", "direction", "status"],
  additionalProperties: false,
  properties: {
    id: entryIdProperty,
    statement: lineProperty,
    direction: { type: "string", enum: [...HYPOTHESIS_DIRECTIONS] },
    status: { type: "string", enum: [...HYPOTHESIS_STATUSES] },
  },
};

const criterionProperty = {
  type: "object",
  required: ["id", "kind", "code", "text"],
  additionalProperties: false,
  properties: {
    id: entryIdProperty,
    kind: { type: "string", enum: [...CRITERION_KINDS] },
    code: entryIdProperty,
    text: lineProperty,
  },
};

const extractionFieldProperty = {
  type: "object",
  required: ["id", "name", "type", "required", "allowed", "unit"],
  additionalProperties: false,
  properties: {
    id: entryIdProperty,
    name: lineProperty,
    type: { type: "string", enum: [...EXTRACTION_FIELD_TYPES] },
    required: { type: "boolean" },
    allowed: { type: "array", maxItems: PROTOCOL_LIMITS.allowed, items: lineProperty },
    unit: { type: ["string", "null"], maxLength: 40 },
  },
};

/**
 * Where the project registered what it was going to do.
 *
 * Every field may be null, and all four are sent together, because a registration that has an id
 * but no registry says nothing anybody can look up.
 */
const preregistrationProperty = {
  type: "object",
  required: ["registry", "id", "url", "on"],
  additionalProperties: false,
  properties: {
    registry: { type: ["string", "null"], maxLength: 200 },
    id: { type: ["string", "null"], maxLength: 200 },
    url: { type: ["string", "null"], maxLength: 2_000 },
    on: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
};

function protocolFailure(cause: unknown): never {
  if (cause instanceof ProtocolValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  /*
   * The edit the freeze exists to refuse.
   *
   * The recovery actions are a fixed list every command in Kiwi shares, so the way out of this
   * one travels in the details instead: the command to call rather than this one, and the freeze
   * a deviation would be logged against.
   */
  if (cause instanceof ProtocolFrozen) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: {
        instead: "kiwi.protocol.log-deviation",
        frozen_at: cause.frozenAt,
        frozen_version: cause.frozenVersion,
      },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof ProtocolNotFound) {
    throw new CommandError("KIWI_NOT_FOUND", cause.message, {
      details: { project_id: cause.projectId },
      recoveryActions: ["reload_current"],
    });
  }
  if (cause instanceof NotAProjectError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { detail: cause.detail },
      recoveryActions: ["reload_current"],
    });
  }
  // Somebody else saved the protocol while this page was open.
  if (cause instanceof ObjectVersionConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      details: { actual_version: cause.actualVersion, actual_hash: cause.actualHash },
      recoveryActions: ["reload_current"],
    });
  }
  if (cause instanceof ObjectPublicationValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { error_count: cause.problems.length },
      recoveryActions: ["correct_input"],
    });
  }
  throw cause;
}

/** What a caller needs to show a protocol and to save it again. */
function protocolView(stored: StoredProtocol) {
  return {
    id: stored.object.id,
    version: stored.object.version,
    content_hash: stored.object.content_hash,
    title: stored.object.title,
    created_at: stored.object.created_at,
    updated_at: stored.object.updated_at,
    protocol: stored.protocol,
  };
}

export function protocolCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  /**
   * The result of a write that may have changed nothing.
   *
   * Freezing a frozen protocol is reported as a no-change rather than as a new version, so the
   * date the project committed to what it said stays the date it committed to it.
   */
  function written(allocated: ReturnType<typeof commandIds>, write: ProtocolWrite) {
    if (!write.changed) return { noChange: true, data: { protocol: protocolView(write) } };
    return {
      transactionId: allocated.transactionId,
      eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
      data: { protocol: protocolView(write) },
    };
  }

  const ensure = defineCommand<{ root: string; project_id: string }>({
    name: "kiwi.protocol.ensure",
    summary: "Start this project's protocol, or hand back the one it has",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id"],
      additionalProperties: false,
      properties: { root: rootProperty, project_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const project = await readCanonicalObject(args.root, args.project_id);
      if (project === null) {
        throw new CommandError("KIWI_NOT_FOUND", "That project was not found.", {
          recoveryActions: ["reload_current"],
        });
      }
      const allocated = commandIds(deps);
      const made = await ensureProtocol({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        protocolId: deps.newId(),
        relationId: deps.newId(),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(protocolFailure);
      const data = { protocol: protocolView(made), created: made.created };
      if (!made.created) return { noChange: true, data };
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data,
      };
    },
  });

  /**
   * What the project wrote down, or nothing.
   *
   * A project that has never opened the page has no protocol object, and this says so rather
   * than making one. Reading a page must not write to the workspace: a person who opens Protocol
   * to look at it and closes it again has changed nothing, and the history says so.
   */
  const read = defineCommand<{ root: string; project_id: string }>({
    name: "kiwi.protocol.read",
    summary: "Read this project's protocol",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id"],
      additionalProperties: false,
      properties: { root: rootProperty, project_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await protocolForProject(args.root, args.project_id);
      return { data: { protocol: found === null ? null : protocolView(found) } };
    },
  });

  const update = defineCommand<{
    root: string;
    project_id: string;
    expected_version: number;
    expected_hash: string;
    question?: string;
    sub_questions?: SubQuestion[];
    hypotheses?: Hypothesis[];
    criteria?: Criterion[];
    extraction_schema?: ExtractionField[];
    method?: string;
    preregistration?: Preregistration;
    document?: unknown;
  }>({
    name: "kiwi.protocol.update",
    summary: "Change what a protocol says",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        question: { type: "string", maxLength: PROTOCOL_LIMITS.question },
        sub_questions: {
          type: "array",
          maxItems: PROTOCOL_LIMITS.sub_questions,
          items: subQuestionProperty,
        },
        hypotheses: {
          type: "array",
          maxItems: PROTOCOL_LIMITS.hypotheses,
          items: hypothesisProperty,
        },
        criteria: { type: "array", maxItems: PROTOCOL_LIMITS.criteria, items: criterionProperty },
        extraction_schema: {
          type: "array",
          maxItems: PROTOCOL_LIMITS.extraction_schema,
          items: extractionFieldProperty,
        },
        method: { type: "string", maxLength: PROTOCOL_LIMITS.method },
        preregistration: preregistrationProperty,
        // The prose is a node tree, checked by validateDocument the way every other document is.
        document: { type: "object" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      if (args.document !== undefined) {
        const problems = validateDocument(args.document);
        if (problems.length > 0) {
          throw new CommandError(
            "KIWI_INVALID_ARGUMENTS",
            problems[0]?.message ?? "That is not a document.",
            { recoveryActions: ["correct_input"] },
          );
        }
      }
      const changes: ProtocolChanges = {
        ...(args.question === undefined ? {} : { question: args.question }),
        ...(args.sub_questions === undefined ? {} : { sub_questions: args.sub_questions }),
        ...(args.hypotheses === undefined ? {} : { hypotheses: args.hypotheses }),
        ...(args.criteria === undefined ? {} : { criteria: args.criteria }),
        ...(args.extraction_schema === undefined
          ? {}
          : { extraction_schema: args.extraction_schema }),
        ...(args.method === undefined ? {} : { method: args.method }),
        ...(args.preregistration === undefined ? {} : { preregistration: args.preregistration }),
        ...(args.document === undefined ? {} : { document: readDocument(args.document) }),
      };
      const allocated = commandIds(deps);
      const write = await updateProtocol({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        changes,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(protocolFailure);
      return written(allocated, write);
    },
  });

  /**
   * Commits the project to what its protocol says.
   *
   * There is no unfreezing. The way a frozen protocol changes is a deviation, which is the whole
   * point of freezing it, so the only thing a second freeze does is nothing.
   */
  const freeze = defineCommand<{ root: string; project_id: string }>({
    name: "kiwi.protocol.freeze",
    summary: "Freeze this project's protocol",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id"],
      additionalProperties: false,
      properties: { root: rootProperty, project_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await freezeStoredProtocol({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(protocolFailure);
      return written(allocated, write);
    },
  });

  /**
   * Writes down a departure from what was frozen.
   *
   * No expected version. A deviation is an entry appended to a list rather than an edit to
   * anything in it, so two people logging one at the same time produce two entries rather than
   * a conflict one of them has to resolve.
   */
  const logDeviation = defineCommand<{
    root: string;
    project_id: string;
    on: string;
    what: string;
    why: string;
    approved_by: string;
  }>({
    name: "kiwi.protocol.log-deviation",
    summary: "Record a departure from the frozen protocol",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id", "on", "what", "why", "approved_by"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        on: dayProperty,
        what: lineProperty,
        why: lineProperty,
        approved_by: { type: "string", maxLength: 200 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await logProtocolDeviation({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        deviation: {
          on: args.on,
          what: args.what,
          why: args.why,
          approved_by: args.approved_by,
        },
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(protocolFailure);
      return written(allocated, write);
    },
  });

  return [ensure, read, update, freeze, logDeviation];
}
