import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  COLLECTION_SORT_DIRECTIONS,
  COLLECTION_READ_VALUES,
  COLLECTION_SORT_FIELDS,
  DEFAULT_COLLECTION_QUERY,
  readCollectionFilters,
  REFERENCE_KINDS,
  type CollectionQuery,
  type CollectionSortDirection,
  type CollectionSortField,
} from "@kiwi/contracts";
import type { ProjectionService, ProjectionTarget } from "./projection.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const rootProperty = { type: "string", minLength: 3, maxLength: 240 };

function target(root: string, context: { workspaceId: string | null }): ProjectionTarget {
  if (context.workspaceId === null)
    throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before using its index.");
  return { root, workspaceId: context.workspaceId };
}

export function projectionCommands(service: ProjectionService): CommandDefinition[] {
  const status = defineCommand<{ root: string }>({
    name: "kiwi.projection.status",
    summary: "Report disposable workspace index status",
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
      return {
        noChange: true,
        data: { projection: await service.status(target(args.root, context)) },
      };
    },
  });

  const list = defineCommand<{
    root: string;
    object_types?: string[];
    text?: string;
    filters?: unknown;
    sort?: { field: CollectionSortField; direction: CollectionSortDirection };
    page?: { offset: number; limit: number };
  }>({
    name: "kiwi.projection.list",
    summary: "List objects from the current projection generation",
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
        object_types: {
          type: "array",
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
        text: { type: "string", maxLength: 500 },
        filters: {
          type: "object",
          additionalProperties: false,
          properties: {
            // The kinds come from the reference contract for the same reason the sort fields do:
            // a value the schema rejects and the menu offers is a chip that empties the table.
            kinds: {
              type: "array",
              maxItems: REFERENCE_KINDS.length,
              uniqueItems: true,
              items: { enum: [...REFERENCE_KINDS] },
            },
            tags: {
              type: "array",
              maxItems: 50,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 150 },
            },
            authors: {
              type: "array",
              maxItems: 50,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            years: {
              type: "array",
              maxItems: 50,
              uniqueItems: true,
              items: { type: "integer", minimum: 0, maximum: 3000 },
            },
            // Named here for the same reason as the kinds. The interface sends every group on
            // every list, so a group the schema does not know about is not a filter that fails
            // to narrow, it is a Library that will not load at all.
            read: {
              type: "array",
              maxItems: COLLECTION_READ_VALUES.length,
              uniqueItems: true,
              items: { enum: [...COLLECTION_READ_VALUES] },
            },
          },
        },
        sort: {
          type: "object",
          required: ["field", "direction"],
          additionalProperties: false,
          properties: {
            // Listed from the contract rather than typed out, because a sort field the schema
            // rejects and the interface offers is a control that does nothing.
            field: { enum: [...COLLECTION_SORT_FIELDS] },
            direction: { enum: [...COLLECTION_SORT_DIRECTIONS] },
          },
        },
        page: {
          type: "object",
          required: ["offset", "limit"],
          additionalProperties: false,
          properties: {
            offset: { type: "integer", minimum: 0, maximum: 1000000 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const query: CollectionQuery = {
        object_types: args.object_types ?? DEFAULT_COLLECTION_QUERY.object_types,
        text: args.text ?? DEFAULT_COLLECTION_QUERY.text,
        filters: readCollectionFilters(args.filters),
        sort: args.sort ?? DEFAULT_COLLECTION_QUERY.sort,
        page: args.page ?? DEFAULT_COLLECTION_QUERY.page,
      };
      return { noChange: true, data: await service.list(target(args.root, context), query) };
    },
  });

  const search = defineCommand<{ root: string; query: string }>({
    name: "kiwi.search.local",
    summary: "Search the local projection",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "query"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        query: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return { noChange: true, data: await service.search(target(args.root, context), args.query) };
    },
  });

  const relations = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.projection.relations",
    summary: "Read projected relations in both directions",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: { type: "string", minLength: 1, maxLength: 150 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        noChange: true,
        data: await service.relations(target(args.root, context), args.object_id),
      };
    },
  });

  /**
   * The same relations, resolved into named links.
   *
   * `kiwi.projection.relations` hands back pairs of ids, which is what a caller doing graph work
   * wants. A panel wants what this object draws on and what has quoted it, with the names on. One
   * command for all three surfaces that show links, so that they cannot disagree about what a
   * link is.
   */
  const links = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.projection.links",
    summary: "Read named links on an object, in both directions",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: { type: "string", minLength: 1, maxLength: 150 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        noChange: true,
        data: await service.links(target(args.root, context), args.object_id),
      };
    },
  });

  /**
   * Notes that this machine has just opened an item.
   *
   * A command rather than something the renderer writes for itself, because the Library orders
   * rows by it and the ordering happens in SQLite. It changes the disposable index and nothing
   * in the workspace, which is why it is allowed on a workspace opened read-only.
   */
  const markOpened = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.projection.mark-opened",
    summary: "Record that this machine opened an item",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: { type: "string", minLength: 1, maxLength: 150 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        data: { opened: await service.markOpened(target(args.root, context), args.object_id) },
      };
    },
  });

  const rebuild = defineCommand<{ root: string }>({
    name: "kiwi.projection.rebuild",
    summary: "Rebuild the disposable workspace projection",
    idempotency: "idempotent",
    cancellation: "cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        data: { projection: await service.rebuild(target(args.root, context), context.signal) },
      };
    },
  });

  const clearAndRebuild = defineCommand<{ root: string }>({
    name: "kiwi.projection.clear-and-rebuild",
    summary: "Delete the disposable index and rebuild it from canonical files",
    idempotency: "idempotent",
    cancellation: "cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      return {
        data: {
          projection: await service.clearAndRebuild(target(args.root, context), context.signal),
        },
      };
    },
  });

  return [status, list, relations, links, search, markOpened, rebuild, clearAndRebuild];
}
