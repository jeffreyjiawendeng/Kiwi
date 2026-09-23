import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import type { RecoveryDraftStore } from "./recovery-draft-store.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const objectId = { type: "string", minLength: 1, maxLength: 150 };
const version = { type: "integer", minimum: 1, maximum: 2147483647 };
const contentHash = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };

function workspaceId(context: { workspaceId: string | null }): string {
  if (context.workspaceId === null)
    throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before using drafts.");
  return context.workspaceId;
}

export function recoveryDraftCommands(
  store: RecoveryDraftStore,
  now: () => string,
): CommandDefinition[] {
  const read = defineCommand<{ object_id: string }>({
    name: "kiwi.draft.read",
    summary: "Read a local recovery draft for one object",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["object_id"],
      additionalProperties: false,
      properties: { object_id: objectId },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        noChange: true,
        data: {
          draft: await store.read(context.actor.id, workspaceId(context), args.object_id),
        },
      };
    },
  });

  const save = defineCommand<{
    object_id: string;
    base_version: number;
    base_hash: string;
    title: string;
    content: string;
  }>({
    name: "kiwi.draft.save",
    summary: "Save a local recovery draft without publishing it",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["object_id", "base_version", "base_hash", "title", "content"],
      additionalProperties: false,
      properties: {
        object_id: objectId,
        base_version: version,
        base_hash: contentHash,
        title: { type: "string", maxLength: 500 },
        content: { type: "string", maxLength: 1000000 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const draft = await store.save({
        schema_version: 1,
        actor_id: context.actor.id,
        workspace_id: workspaceId(context),
        object_id: args.object_id,
        base_version: args.base_version,
        base_hash: args.base_hash,
        title: args.title,
        content: args.content,
        updated_at: now(),
      });
      return { data: { draft } };
    },
  });

  const discard = defineCommand<{
    object_id: string;
    base_version: number;
    base_hash: string;
  }>({
    name: "kiwi.draft.discard",
    summary: "Discard one exact local recovery draft",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["object_id", "base_version", "base_hash"],
      additionalProperties: false,
      properties: { object_id: objectId, base_version: version, base_hash: contentHash },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const discarded = await store.discard(
        context.actor.id,
        workspaceId(context),
        args.object_id,
        args.base_version,
        args.base_hash,
      );
      return { noChange: !discarded, data: { discarded } };
    },
  });

  return [read, save, discard];
}
