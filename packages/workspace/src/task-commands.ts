import {
  PROJECT_PAGES,
  TASK_LIMITS,
  TASK_STATUSES,
  emptyTask,
  type ProjectPage,
  type TaskStatus,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  TaskBlockingCycle,
  TaskLinkError,
  TaskNotFound,
  TaskValidationError,
  completeStoredTask,
  createTask,
  linkTask,
  listTasks,
  readCanonicalObject,
  relationsForObject,
  reopenStoredTask,
  trashObject,
  unlinkTask,
  updateTask,
  type StoredTask,
  type TaskWrite,
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

const titleProperty = { type: "string", minLength: 1, maxLength: 300 };
const notesProperty = { type: "string", maxLength: TASK_LIMITS.notes };
const statusProperty = { type: "string", enum: [...TASK_STATUSES] };
const stageProperty = { type: ["string", "null"], enum: [...PROJECT_PAGES, null] };

/**
 * Null is a value here, not an omission.
 *
 * Taking a task off somebody and leaving it as it was are different intentions, and a schema that
 * could only omit the field would have no way to say the first one.
 */
const assigneeProperty = { type: ["string", "null"], minLength: 1, maxLength: 200 };
const dueProperty = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

function taskFailure(cause: unknown): never {
  if (cause instanceof TaskValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: [...new Set(cause.problems.map((problem) => problem.field))].join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof TaskNotFound) {
    throw new CommandError("KIWI_NOT_FOUND", cause.message, {
      details: { task_id: cause.taskId },
      recoveryActions: ["reload_current"],
    });
  }
  // The message already names every task in the loop, so it is the message the person sees.
  if (cause instanceof TaskBlockingCycle) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { cycle: cause.chain.join(" > ") },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof TaskLinkError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { reason: cause.reason },
      recoveryActions: ["reload_current"],
    });
  }
  return commandTrashFailure(cause);
}

/** What a caller needs to show a task and to act on it again. */
function taskView(entry: StoredTask) {
  return {
    id: entry.object.id,
    version: entry.object.version,
    content_hash: entry.object.content_hash,
    title: entry.object.title,
    created_at: entry.object.created_at,
    updated_at: entry.object.updated_at,
    task: entry.task,
  };
}

export function taskCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  /**
   * The result of a write that may have changed nothing.
   *
   * A no-change write is reported as one rather than as a new version, so that a board ticking
   * the same task on two machines leaves one record between them.
   */
  function written(allocated: ReturnType<typeof commandIds>, write: TaskWrite) {
    if (!write.changed) return { noChange: true, data: { object: write.object } };
    return {
      transactionId: allocated.transactionId,
      eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
      data: { object: write.object },
    };
  }

  const create = defineCommand<{
    root: string;
    title: string;
    for_object_id?: string;
    assignee_id?: string | null;
    due_on?: string | null;
    stage?: ProjectPage | null;
    notes?: string;
  }>({
    name: "kiwi.task.create",
    summary: "Write down a piece of work",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "title"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        title: titleProperty,
        for_object_id: idProperty,
        assignee_id: assigneeProperty,
        due_on: dueProperty,
        stage: stageProperty,
        notes: notesProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const workspaceId = commandWorkspaceId(context);
      if (args.for_object_id !== undefined) {
        const subject = await readCanonicalObject(args.root, args.for_object_id);
        if (subject === null) {
          throw new CommandError("KIWI_NOT_FOUND", "That object was not found.", {
            recoveryActions: ["reload_current"],
          });
        }
      }
      const allocated = commandIds(deps);
      const object = await createTask({
        root: args.root,
        workspaceId,
        taskId: deps.newId(),
        relationId: deps.newId(),
        title: args.title,
        task: {
          ...emptyTask(),
          ...(args.assignee_id === undefined ? {} : { assignee_id: args.assignee_id }),
          ...(args.due_on === undefined ? {} : { due_on: args.due_on }),
          ...(args.stage === undefined ? {} : { stage: args.stage }),
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
        ...(args.for_object_id === undefined ? {} : { forObjectId: args.for_object_id }),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(taskFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { object },
      };
    },
  });

  /**
   * Changes one field, or several.
   *
   * An absent field is left alone rather than cleared, because the surfaces that edit a task edit
   * one thing at a time: a due date dragged on a board, an assignee picked from a menu. Sending
   * the whole task back would let a stale card undo a change to a field it was not showing.
   */
  const update = defineCommand<{
    root: string;
    task_id: string;
    title?: string;
    status?: TaskStatus;
    assignee_id?: string | null;
    due_on?: string | null;
    stage?: ProjectPage | null;
    blocked_by?: string[];
    notes?: string;
  }>({
    name: "kiwi.task.update",
    summary: "Change what a task says",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "task_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        task_id: idProperty,
        title: titleProperty,
        status: statusProperty,
        assignee_id: assigneeProperty,
        due_on: dueProperty,
        stage: stageProperty,
        blocked_by: { type: "array", maxItems: TASK_LIMITS.blocked_by, items: idProperty },
        notes: notesProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const write = await updateTask({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        taskId: args.task_id,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.assignee_id === undefined ? {} : { assigneeId: args.assignee_id }),
        ...(args.due_on === undefined ? {} : { dueOn: args.due_on }),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(taskFailure);
      return written(allocated, write);
    },
  });

  /**
   * Ticking off and putting back.
   *
   * Both are separate from `update` because both are one click, and one click arrives twice often
   * enough that the second must be a no-change rather than an error.
   */
  function transition(
    name: string,
    summary: string,
    run: (
      input: {
        root: string;
        workspaceId: string;
        taskId: string;
        actor: string;
        requestId: string;
        now: string;
      } & ReturnType<typeof commandIds>,
    ) => Promise<TaskWrite>,
  ) {
    return defineCommand<{ root: string; task_id: string }>({
      name,
      summary,
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui", "cli", "api"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "task_id"],
        additionalProperties: false,
        properties: { root: rootProperty, task_id: idProperty },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const allocated = commandIds(deps);
        const write = await run({
          root: args.root,
          workspaceId: commandWorkspaceId(context),
          taskId: args.task_id,
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        }).catch(taskFailure);
        return written(allocated, write);
      },
    });
  }

  const complete = transition("kiwi.task.complete", "Mark a task done", completeStoredTask);
  const reopen = transition("kiwi.task.reopen", "Put a finished task back on the board", (input) =>
    reopenStoredTask(input),
  );

  function attachment(name: string, summary: string, attach: boolean) {
    return defineCommand<{ root: string; task_id: string; object_id: string }>({
      name,
      summary,
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui", "cli", "api"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "task_id", "object_id"],
        additionalProperties: false,
        properties: { root: rootProperty, task_id: idProperty, object_id: idProperty },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const allocated = commandIds(deps);
        const input = {
          root: args.root,
          workspaceId: commandWorkspaceId(context),
          taskId: args.task_id,
          relationId: deps.newId(),
          objectId: args.object_id,
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        };
        const relation = await (attach ? linkTask(input) : unlinkTask(input)).catch(taskFailure);
        return {
          transactionId: allocated.transactionId,
          eventIds: [
            allocated.preparedEventId,
            allocated.domainEventId,
            allocated.committedEventId,
          ],
          data: { relation },
        };
      },
    });
  }

  const link = attachment("kiwi.task.link", "Say what a task is work on", true);
  const unlink = attachment("kiwi.task.unlink", "Take a task off something", false);

  /**
   * The board, the table, and "My tasks", from one call.
   *
   * `mine` is asked about the caller rather than named, for the same reason the comment inbox
   * asks it that way: the account doing the asking is already in the context, and a renderer that
   * had to name an account could name the wrong one.
   */
  const list = defineCommand<{
    root: string;
    status?: TaskStatus;
    mine?: boolean;
    unassigned?: boolean;
    stage?: ProjectPage;
    object_id?: string;
    project_id?: string;
  }>({
    name: "kiwi.task.list",
    summary: "List tasks, soonest due first",
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
        status: statusProperty,
        mine: { type: "boolean" },
        unassigned: { type: "boolean" },
        stage: { type: "string", enum: [...PROJECT_PAGES] },
        object_id: idProperty,
        project_id: idProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      commandWorkspaceId(context);
      const found = await listTasks(args.root, {
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.mine === true ? { assignee: context.actor.id } : {}),
        ...(args.unassigned === true ? { unassigned: true } : {}),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.object_id === undefined ? {} : { objectId: args.object_id }),
        ...(args.project_id === undefined ? {} : { projectId: args.project_id }),
      });
      return { noChange: true, data: { tasks: found.map(taskView) } };
    },
  });

  /**
   * Deleting keeps a version check, the way deleting a thread does: it is the one task operation
   * that destroys something another person may have been relying on. The relations are read here
   * rather than asked of the caller, because a board card has no way to know what a task is on.
   */
  const remove = defineCommand<{
    root: string;
    task_id: string;
    expected_version: number;
    expected_hash: string;
  }>({
    name: "kiwi.task.delete",
    summary: "Move a task to Trash",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "task_id", "expected_version", "expected_hash"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        task_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const workspaceId = commandWorkspaceId(context);
      const stored = await readCanonicalObject(args.root, args.task_id);
      if (stored === null || stored.object.type !== "task") {
        throw new CommandError("KIWI_NOT_FOUND", "Task not found.", {
          details: { task_id: args.task_id },
          recoveryActions: ["reload_current"],
        });
      }
      const linked = await relationsForObject(args.root, args.task_id);
      const allocated = commandIds(deps);
      const entry = await trashObject({
        root: args.root,
        workspaceId,
        objectId: args.task_id,
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
      }).catch(taskFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: {
          entry,
          undo: { command: "kiwi.object.restore-from-trash", args: { object_id: args.task_id } },
        },
      };
    },
  });

  return [create, update, complete, reopen, link, unlink, list, remove];
}
