import {
  THREAD_ANCHOR_KINDS,
  THREAD_LIMITS,
  THREAD_STATUSES,
  type ThreadAnchor,
  type ThreadStatus,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  ThreadMessageMissing,
  ThreadMessageNotYours,
  ThreadNotFound,
  ThreadValidationError,
  addThreadReply,
  createThread,
  editThreadMessage,
  listThreads,
  moveThreadAnchor,
  readCanonicalObject,
  relationsForObject,
  setThreadStatus,
  trashObject,
  type StoredThread,
} from "./objects.js";
import {
  commandIds,
  commandTrashFailure,
  commandWorkspaceId,
  hashProperty,
  idProperty,
  rootProperty,
  type ObjectCommandDeps,
} from "./object-commands.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

/**
 * The name a message is filed under.
 *
 * It is stored with the message rather than looked up when the thread is read, so the caller has
 * to say what name to use. A name resolved later would be the name the author has now, which is
 * the wrong one to show against words written before they were renamed, and no name at all
 * offline.
 */
const authorNameProperty = { type: "string", minLength: 1, maxLength: THREAD_LIMITS.name };

const bodyProperty = { type: "string", minLength: 1, maxLength: THREAD_LIMITS.body };

const anchorSchema = {
  type: "object",
  required: ["object_id", "kind"],
  additionalProperties: false,
  properties: {
    object_id: idProperty,
    kind: { type: "string", enum: [...THREAD_ANCHOR_KINDS] },
    from: { type: "integer", minimum: 0 },
    to: { type: "integer", minimum: 0 },
    section_id: idProperty,
    quote: { type: "string", maxLength: THREAD_LIMITS.quote },
  },
};

function threadFailure(cause: unknown): never {
  if (cause instanceof ThreadValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof ThreadNotFound) {
    throw new CommandError("KIWI_NOT_FOUND", cause.message, {
      details: { thread_id: cause.threadId },
      recoveryActions: ["reload_current"],
    });
  }
  if (cause instanceof ThreadMessageMissing) {
    throw new CommandError("KIWI_NOT_FOUND", cause.message, {
      details: { message_id: cause.messageId },
      recoveryActions: ["reload_current"],
    });
  }
  // Not an argument problem to correct: the words belong to somebody else, and no rewording of
  // the request will make them yours.
  if (cause instanceof ThreadMessageNotYours) {
    throw new CommandError("KIWI_FORBIDDEN", cause.message, {
      details: { message_id: cause.messageId },
      recoveryActions: ["reload_current"],
    });
  }
  return commandTrashFailure(cause);
}

/** What a caller needs to show a thread and to act on it again. */
function threadView(entry: StoredThread) {
  return {
    id: entry.object.id,
    version: entry.object.version,
    content_hash: entry.object.content_hash,
    title: entry.object.title,
    created_at: entry.object.created_at,
    updated_at: entry.object.updated_at,
    thread: entry.thread,
  };
}

export function threadCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  const start = defineCommand<{
    root: string;
    anchor: ThreadAnchor;
    body: string;
    author_name: string;
  }>({
    name: "kiwi.thread.start",
    summary: "Comment on an object, a passage, or an annotation",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "anchor", "body", "author_name"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        anchor: anchorSchema,
        body: bodyProperty,
        author_name: authorNameProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const workspaceId = commandWorkspaceId(context);
      const commented = await readCanonicalObject(args.root, args.anchor.object_id);
      if (commented === null) {
        throw new CommandError("KIWI_NOT_FOUND", "That object was not found.", {
          recoveryActions: ["reload_current"],
        });
      }
      const allocated = commandIds(deps);
      const object = await createThread({
        root: args.root,
        workspaceId,
        threadId: deps.newId(),
        relationId: deps.newId(),
        messageId: deps.newId(),
        anchor: args.anchor,
        body: args.body,
        authorName: args.author_name,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(threadFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  /**
   * A reply takes no expected version.
   *
   * Appending is commutative: two people replying in the same second both belong in the result.
   * Optimistic concurrency is there to stop a silent overwrite, and an append overwrites nothing.
   */
  const reply = defineCommand<{
    root: string;
    thread_id: string;
    body: string;
    author_name: string;
  }>({
    name: "kiwi.thread.reply",
    summary: "Add a comment to a thread",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "thread_id", "body", "author_name"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        thread_id: idProperty,
        body: bodyProperty,
        author_name: authorNameProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const object = await addThreadReply({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        threadId: args.thread_id,
        messageId: deps.newId(),
        body: args.body,
        authorName: args.author_name,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(threadFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  const editMessage = defineCommand<{
    root: string;
    thread_id: string;
    message_id: string;
    body: string;
  }>({
    name: "kiwi.thread.edit-message",
    summary: "Reword your own comment",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "thread_id", "message_id", "body"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        thread_id: idProperty,
        message_id: idProperty,
        body: bodyProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const object = await editThreadMessage({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        threadId: args.thread_id,
        messageId: args.message_id,
        body: args.body,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(threadFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  function statusCommand(name: string, summary: string, status: ThreadStatus) {
    return defineCommand<{ root: string; thread_id: string }>({
      name,
      summary,
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui", "cli", "api"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "thread_id"],
        additionalProperties: false,
        properties: { root: rootProperty, thread_id: idProperty },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const allocated = commandIds(deps);
        const written = await setThreadStatus({
          root: args.root,
          workspaceId: commandWorkspaceId(context),
          threadId: args.thread_id,
          status,
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        }).catch(threadFailure);
        // Two people clicking Resolve on the same thread leave one record between them, and the
        // second is told plainly that there was nothing left to do.
        if (!written.changed) return { noChange: true, data: { object: written.object } };
        return {
          transactionId: allocated.transactionId,
          eventIds: [
            allocated.preparedEventId,
            allocated.domainEventId,
            allocated.committedEventId,
          ],
          data: { object: written.object },
        };
      },
    });
  }

  const resolve = statusCommand("kiwi.thread.resolve", "Mark a comment thread settled", "resolved");
  const reopen = statusCommand("kiwi.thread.reopen", "Reopen a settled comment thread", "open");

  const reanchor = defineCommand<{
    root: string;
    thread_id: string;
    from: number;
    to: number;
    quote: string;
  }>({
    name: "kiwi.thread.reanchor",
    summary: "Point an orphaned comment at the text it belongs to",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "thread_id", "from", "to", "quote"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        thread_id: idProperty,
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        quote: { type: "string", minLength: 1, maxLength: THREAD_LIMITS.quote },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      if (args.to <= args.from) {
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "Select the text the comment is about.", {
          recoveryActions: ["correct_input"],
        });
      }
      const allocated = commandIds(deps);
      const object = await moveThreadAnchor({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        threadId: args.thread_id,
        from: args.from,
        to: args.to,
        quote: args.quote,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(threadFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  /**
   * The comment inbox.
   *
   * `mine`, `mentions`, and `involving_me` are asked about the caller rather than named, because
   * that is the question the inbox is for and the account doing the asking is the one already in
   * the context.
   *
   * `involving_me` is the union of the first two rather than a third thing, because "what am I
   * part of" is one question and answering it with two calls would leave the caller deduplicating
   * a thread it is both named in and has replied to.
   */
  const list = defineCommand<{
    root: string;
    object_id?: string;
    status?: ThreadStatus;
    mine?: boolean;
    mentions?: boolean;
    involving_me?: boolean;
    project_id?: string;
  }>({
    name: "kiwi.thread.list",
    summary: "List comment threads, oldest first",
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
        object_id: idProperty,
        status: { type: "string", enum: [...THREAD_STATUSES] },
        mine: { type: "boolean" },
        mentions: { type: "boolean" },
        involving_me: { type: "boolean" },
        project_id: idProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      commandWorkspaceId(context);
      const found = await listThreads(args.root, {
        ...(args.object_id === undefined ? {} : { objectId: args.object_id }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.mine === true ? { participant: context.actor.id } : {}),
        ...(args.mentions === true ? { mentions: context.actor.id } : {}),
        ...(args.involving_me === true ? { involving: context.actor.id } : {}),
        ...(args.project_id === undefined ? {} : { projectId: args.project_id }),
      });
      return { noChange: true, data: { threads: found.map(threadView) } };
    },
  });

  /**
   * Deleting is the one thread operation that can destroy what somebody else wrote, so it is the
   * one that keeps a version check. The relations are read here rather than asked of the caller:
   * a comment panel has no way to know what a thread is linked to.
   */
  const remove = defineCommand<{
    root: string;
    thread_id: string;
    expected_version: number;
    expected_hash: string;
  }>({
    name: "kiwi.thread.delete",
    summary: "Move a comment thread to Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "thread_id", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        thread_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const workspaceId = commandWorkspaceId(context);
      const stored = await readCanonicalObject(args.root, args.thread_id);
      if (stored === null || stored.object.type !== "thread") {
        throw new CommandError("KIWI_NOT_FOUND", "Comment thread not found.", {
          details: { thread_id: args.thread_id },
          recoveryActions: ["reload_current"],
        });
      }
      const linked = await relationsForObject(args.root, args.thread_id);
      const allocated = commandIds(deps);
      const entry = await trashObject({
        root: args.root,
        workspaceId,
        objectId: args.thread_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        expectedRelations: linked.map(({ relation }) => ({
          relation_id: relation.id,
          version: relation.version,
          content_hash: relation.content_hash,
        })),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(threadFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          entry,
          undo: { command: "kiwi.object.restore-from-trash", args: { object_id: args.thread_id } },
        },
      };
    },
  });

  return [start, reply, editMessage, resolve, reopen, reanchor, list, remove];
}
