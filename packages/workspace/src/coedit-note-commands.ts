import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  CoeditVersionConflict,
  createCoeditNote,
  listCoeditNotes,
  readCoeditNote,
  replaceCoeditNoteText,
} from "./coedit-notes.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const rootProperty = { type: "string", minLength: 3, maxLength: 240 };
const idProperty = { type: "string", minLength: 1, maxLength: 150 };
const hashProperty = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };

export interface CoeditNoteCommandDeps {
  newId(): string;
  now(): string;
}

function workspaceId(context: { workspaceId: string | null }): string {
  if (context.workspaceId === null)
    throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before using live notes.");
  return context.workspaceId;
}

function ids(deps: CoeditNoteCommandDeps) {
  return {
    transactionId: deps.newId(),
    preparedEventId: deps.newId(),
    domainEventId: deps.newId(),
    committedEventId: deps.newId(),
  };
}

function conflict(cause: unknown): never {
  if (cause instanceof CoeditVersionConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      details: { actual_hash: cause.actualHash },
      recoveryActions: ["reload_current"],
    });
  }
  throw cause;
}

export function coeditNoteCommands(deps: CoeditNoteCommandDeps): CommandDefinition[] {
  const create = defineCommand<{ root: string; title: string; content: string }>({
    name: "kiwi.note.create",
    summary: "Create a convergent live note",
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
      const changed = await createCoeditNote({
        root: args.root,
        workspaceId: workspaceId(context),
        documentId: deps.newId(),
        title: args.title,
        content: args.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        newOperationId: deps.newId,
        ...allocated,
      });
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: changed,
      };
    },
  });

  const list = defineCommand<{ root: string }>({
    name: "kiwi.note.list",
    summary: "List live notes",
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
      return { noChange: true, data: { notes: await listCoeditNotes(args.root) } };
    },
  });

  const read = defineCommand<{ root: string; document_id: string }>({
    name: "kiwi.note.read",
    summary: "Read a live note",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "document_id"],
      additionalProperties: false,
      properties: { root: rootProperty, document_id: idProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const note = await readCoeditNote(args.root, args.document_id);
      if (note === null) throw new CommandError("KIWI_NOT_FOUND", "That live note was not found.");
      return { noChange: true, data: { note } };
    },
  });

  const replace = defineCommand<{
    root: string;
    document_id: string;
    expected_hash: string;
    content: string;
  }>({
    name: "kiwi.note.replace-text",
    summary: "Apply a convergent live-note text change",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "document_id", "expected_hash", "content"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        document_id: idProperty,
        expected_hash: hashProperty,
        content: { type: "string", maxLength: 1_000_000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = ids(deps);
      const changed = await replaceCoeditNoteText({
        root: args.root,
        workspaceId: workspaceId(context),
        documentId: args.document_id,
        expectedHash: args.expected_hash,
        content: args.content,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        newOperationId: deps.newId,
        ...allocated,
      }).catch(conflict);
      return changed.operations.length === 0
        ? { noChange: true, data: changed }
        : {
            transactionId: allocated.transactionId,
            eventIds: [
              allocated.preparedEventId,
              allocated.domainEventId,
              allocated.committedEventId,
            ],
            data: changed,
          };
    },
  });

  return [create, list, read, replace];
}
