import {
  CLAIM_CONFIDENCES,
  CLAIM_LIMITS,
  CLAIM_STATUSES,
  EMPTY_ANNOTATION,
  EVIDENCE_STANCES,
  emptyClaim,
  type Annotation,
  type ClaimBody,
  type ClaimConfidence,
  type ClaimStatus,
  type EvidenceStance,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  AnnotationValidationError,
  ClaimNotFound,
  ClaimValidationError,
  EvidenceError,
  NotAProjectError,
  ObjectPublicationValidationError,
  ObjectVersionConflict,
  attachEvidence,
  createClaim,
  detachEvidence,
  listClaims,
  sendEvidenceToClaim,
  updateClaim,
  type ClaimSummary,
  type ClaimWrite,
  type EvidenceClaimTarget,
  type EvidenceWrite,
} from "./objects.js";
import {
  annotationSchema,
  commandIds,
  commandWorkspaceId,
  hashProperty,
  idProperty,
  rootProperty,
  type ObjectCommandDeps,
} from "./object-commands.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const statementProperty = { type: "string", minLength: 1, maxLength: CLAIM_LIMITS.statement };
const statusProperty = { type: "string", enum: [...CLAIM_STATUSES] };
const confidenceProperty = { type: "string", enum: [...CLAIM_CONFIDENCES] };
const stanceProperty = { type: "string", enum: [...EVIDENCE_STANCES] };

/**
 * `Q2`, `H1`: a line of the project's protocol.
 *
 * Checked here by its shape rather than against the protocol, because contracts settled that an
 * id nothing carries is kept and shown as missing rather than refused. Deleting a hypothesis must
 * not make every claim written against it unsaveable.
 */
const answerProperty = { type: "string", pattern: "^(Q|H)[0-9]+$" };

const answersProperty = {
  type: "array",
  maxItems: CLAIM_LIMITS.answers,
  items: answerProperty,
};

function claimFailure(cause: unknown): never {
  if (cause instanceof ClaimValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  // A selection that cannot be a mark cannot be evidence either, and the passage is the part
  // somebody can still fix.
  if (cause instanceof AnnotationValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof ClaimNotFound) {
    throw new CommandError("KIWI_NOT_FOUND", cause.message, {
      details: { claim_id: cause.claimId },
      recoveryActions: ["reload_current"],
    });
  }
  /*
   * Something was dropped on a claim that cannot stand behind it.
   *
   * The type travels in the details so the interface can say what it was looking at rather than
   * repeating the general rule back at somebody who has just broken a specific case of it.
   */
  if (cause instanceof EvidenceError) {
    throw new CommandError(
      cause.reason === "not_found" ? "KIWI_NOT_FOUND" : "KIWI_INVALID_ARGUMENTS",
      cause.message,
      {
        details: { reason: cause.reason, object_type: cause.objectType },
        recoveryActions: cause.reason === "not_found" ? ["reload_current"] : ["correct_input"],
      },
    );
  }
  if (cause instanceof NotAProjectError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { detail: cause.detail },
      recoveryActions: ["reload_current"],
    });
  }
  // Somebody else saved this claim while the page was open.
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

/** What a caller needs to show a claim and to save it again. */
function claimView(entry: ClaimSummary) {
  return {
    id: entry.object.id,
    version: entry.object.version,
    content_hash: entry.object.content_hash,
    title: entry.object.title,
    created_at: entry.object.created_at,
    updated_at: entry.object.updated_at,
    claim: entry.claim,
    evidence: entry.evidence.map((piece) => ({
      relation_id: piece.relationId,
      object_id: piece.objectId,
      object_type: piece.objectType,
      title: piece.title,
      stance: piece.stance,
      attached_at: piece.attachedAt,
    })),
  };
}

export function claimCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  function written(allocated: ReturnType<typeof commandIds>, write: ClaimWrite | EvidenceWrite) {
    const data =
      "claim" in write
        ? { object: write.object, claim: write.claim }
        : { relation: write.relation, replaced: write.replaced };
    if (!write.changed) return { noChange: true, data };
    return {
      transactionId: allocated.transactionId,
      eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
      data,
    };
  }

  const create = defineCommand<{
    root: string;
    project_id: string;
    statement: string;
    status?: ClaimStatus;
    confidence?: ClaimConfidence;
    answers?: string[];
  }>({
    name: "kiwi.claim.create",
    summary: "Write down something the project asserts",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id", "statement"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        statement: statementProperty,
        status: statusProperty,
        confidence: confidenceProperty,
        answers: answersProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const claim: ClaimBody = {
        ...emptyClaim(),
        statement: args.statement,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
        ...(args.answers === undefined ? {} : { answers: args.answers }),
      };
      const object = await createClaim({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        claimId: deps.newId(),
        relationId: deps.newId(),
        projectId: args.project_id,
        claim,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(claimFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object, claim },
      };
    },
  });

  /**
   * Changes what a claim says.
   *
   * An absent field is left alone, because the page edits one thing at a time: a status from a
   * menu, a hypothesis from a chooser. A stale form must not undo a field it was not showing.
   */
  const update = defineCommand<{
    root: string;
    claim_id: string;
    expected_version: number;
    expected_hash: string;
    statement?: string;
    status?: ClaimStatus;
    confidence?: ClaimConfidence;
    answers?: string[];
  }>({
    name: "kiwi.claim.update",
    summary: "Change what a claim says",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "claim_id", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        claim_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        statement: statementProperty,
        status: statusProperty,
        confidence: confidenceProperty,
        answers: answersProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await updateClaim({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        claimId: args.claim_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        changes: {
          ...(args.statement === undefined ? {} : { statement: args.statement }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
          ...(args.answers === undefined ? {} : { answers: args.answers }),
        },
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(claimFailure);
      return written(allocated, write);
    },
  });

  /**
   * Points a highlight, a note, a paper, a run, or a dataset at a claim.
   *
   * There is no expected version. Evidence is a relation of its own rather than a field on the
   * claim, so two people attaching at once are two writes that cannot collide -- which is the
   * reason the claim does not carry a list of them.
   */
  const attach = defineCommand<{
    root: string;
    claim_id: string;
    object_id: string;
    stance: EvidenceStance;
  }>({
    name: "kiwi.claim.attach-evidence",
    summary: "Attach evidence for or against a claim",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "claim_id", "object_id", "stance"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        claim_id: idProperty,
        object_id: idProperty,
        stance: stanceProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await attachEvidence({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        claimId: args.claim_id,
        objectId: args.object_id,
        stance: args.stance,
        relationId: deps.newId(),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(claimFailure);
      return written(allocated, write);
    },
  });

  /**
   * Sends what somebody is reading to a claim.
   *
   * One command rather than three calls from the interface, because the claim, the mark, and the
   * relation between them have to land together. Three calls can stop after two, and what is left
   * behind then is a claim nobody wrote the evidence for, or a highlight with a reason that was
   * never recorded.
   */
  const sendEvidence = defineCommand<{
    root: string;
    claim_id?: string;
    project_id?: string;
    statement?: string;
    answers?: string[];
    object_ids?: string[];
    excerpt?: { object_id: string; annotation: Annotation };
    stance?: EvidenceStance;
  }>({
    name: "kiwi.claim.send-evidence",
    summary: "Send a passage to a claim, writing the claim down if it is new",
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
        claim_id: idProperty,
        project_id: idProperty,
        statement: statementProperty,
        answers: answersProperty,
        object_ids: {
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
        stance: stanceProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const objectIds = args.object_ids ?? [];
      if (args.excerpt === undefined && objectIds.length === 0) {
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "Choose what to send.", {
          recoveryActions: ["correct_input"],
        });
      }
      if (args.claim_id !== undefined && args.project_id !== undefined) {
        throw new CommandError(
          "KIWI_INVALID_ARGUMENTS",
          "Send this to a claim, or write a new one. Not both.",
          { recoveryActions: ["correct_input"] },
        );
      }
      if (
        args.claim_id === undefined &&
        (args.project_id === undefined || args.statement === undefined)
      ) {
        throw new CommandError(
          "KIWI_INVALID_ARGUMENTS",
          "Choose a claim, or say what the new one asserts.",
          { recoveryActions: ["correct_input"] },
        );
      }

      const allocated = commandIds(deps);
      // A new claim is a draft whatever it is being sent, because one piece of evidence is not
      // what makes a claim supported -- the relation this writes is.
      const target: EvidenceClaimTarget =
        args.claim_id === undefined
          ? {
              kind: "new",
              claimId: deps.newId(),
              relationId: deps.newId(),
              projectId: args.project_id ?? "",
              claim: {
                ...emptyClaim(),
                statement: args.statement ?? "",
                ...(args.answers === undefined ? {} : { answers: args.answers }),
              },
            }
          : { kind: "existing", claimId: args.claim_id };
      const excerpt =
        args.excerpt === undefined
          ? null
          : {
              objectId: args.excerpt.object_id,
              annotationId: deps.newId(),
              relationId: deps.newId(),
              annotation: { ...EMPTY_ANNOTATION, ...args.excerpt.annotation },
            };
      const receipt = await sendEvidenceToClaim({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        target,
        excerpt,
        objectIds,
        stance: args.stance ?? "supports",
        // One relation id per piece of evidence, allocated up front so the transaction writes
        // in a single commit rather than growing ids as it goes.
        relationIds: [...(excerpt === null ? [] : [""]), ...objectIds].map(() => deps.newId()),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(claimFailure);

      const data = {
        claim: receipt.claim,
        claim_created: receipt.claimCreated,
        annotation_id: receipt.annotationId,
        attached: receipt.attached,
        skipped: receipt.skipped,
      };
      if (!receipt.changed) return { noChange: true, data };
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data,
      };
    },
  });

  const detach = defineCommand<{ root: string; claim_id: string; object_id: string }>({
    name: "kiwi.claim.detach-evidence",
    summary: "Take evidence off a claim",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "claim_id", "object_id"],
      additionalProperties: false,
      properties: { root: rootProperty, claim_id: idProperty, object_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await detachEvidence({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        claimId: args.claim_id,
        objectId: args.object_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(claimFailure);
      return written(allocated, write);
    },
  });

  /**
   * The claims, with what each one stands on.
   *
   * `unsupported` is answered from the relations rather than by opening every claim, and it means
   * nothing asserted supports it -- a claim whose only supporting highlight has been deleted is
   * unsupported again, which is the point of asking.
   */
  const list = defineCommand<{
    root: string;
    project_id?: string;
    status?: ClaimStatus;
    answers?: string;
    unsupported?: boolean;
  }>({
    name: "kiwi.claim.list",
    summary: "List claims and what supports them",
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
        project_id: idProperty,
        status: statusProperty,
        answers: answerProperty,
        unsupported: { type: "boolean" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      commandWorkspaceId(context);
      const found = await listClaims(args.root, {
        ...(args.project_id === undefined ? {} : { projectId: args.project_id }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.answers === undefined ? {} : { answers: args.answers }),
        ...(args.unsupported === true ? { unsupported: true } : {}),
      });
      return { noChange: true, data: { claims: found.map(claimView) } };
    },
  });

  return [attach, create, detach, list, sendEvidence, update];
}
