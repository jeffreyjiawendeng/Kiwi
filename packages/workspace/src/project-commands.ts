import {
  CITATION_STYLES,
  OPTIONAL_PROJECT_PAGES,
  PROJECT_LIMITS,
  PROJECT_SENSITIVITIES,
  PROJECT_TEMPLATES,
  defaultProjectSettings,
  readProjectSettings,
  validateProjectSettings,
  type ProjectTemplateId,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  NotAProjectError,
  ObjectVersionConflict,
  ProjectDeletionNotConfirmed,
  ProjectValidationError,
  assignObjectToProject,
  configureProject,
  createProject,
  deleteProject,
  listProjects,
  projectForObject,
  projectMembers,
  previewProjectDeletion,
  projectSettingsOf,
  readCanonicalObject,
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

/**
 * The settings a caller may send.
 *
 * `pages` names only the optional pages. The always-on ones are not a choice, so accepting
 * them here would let a caller believe it had switched off the Library.
 */
const settingsProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: PROJECT_LIMITS.description },
    template: { type: "string", enum: PROJECT_TEMPLATES.map((template) => template.id) },
    pages: {
      type: "array",
      maxItems: OPTIONAL_PROJECT_PAGES.length,
      items: { type: "string", enum: [...OPTIONAL_PROJECT_PAGES] },
    },
    citation_style: { type: "string", enum: [...CITATION_STYLES] },
    sensitivity: { type: "string", enum: [...PROJECT_SENSITIVITIES] },
    review_required: { type: "boolean" },
    archived: { type: "boolean" },
  },
} as const;

function projectFailure(cause: unknown): never {
  if (cause instanceof ProjectValidationError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { fields: cause.problems.map((problem) => problem.field).join(",") },
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof ProjectDeletionNotConfirmed) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: {},
      recoveryActions: ["correct_input"],
    });
  }
  if (cause instanceof NotAProjectError) {
    throw new CommandError("KIWI_INVALID_ARGUMENTS", cause.message, {
      details: { detail: cause.detail },
      recoveryActions: ["reload_current"],
    });
  }
  // Somebody else changed the project while this settings screen was open. Left unhandled
  // this reaches the gateway as an internal error, which tells the reader nothing and offers
  // them no way out.
  if (cause instanceof ObjectVersionConflict) {
    throw new CommandError("KIWI_CONFLICT_VERSION", cause.message, {
      details: { actual_version: cause.actualVersion, actual_hash: cause.actualHash },
      recoveryActions: ["reload_current"],
    });
  }
  throw cause;
}

export function projectCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  const create = defineCommand<{
    root: string;
    title: string;
    template?: ProjectTemplateId;
    description?: string;
  }>({
    name: "kiwi.project.create",
    summary: "Create a project inside this workspace",
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
        title: { type: "string", minLength: 1, maxLength: PROJECT_LIMITS.title, pattern: "\\S" },
        template: { type: "string", enum: PROJECT_TEMPLATES.map((template) => template.id) },
        description: { type: "string", maxLength: PROJECT_LIMITS.description },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      // The template is the only thing that decides which pages start on, so the defaults are
      // built from it rather than merged over a general project.
      const settings = defaultProjectSettings(args.template ?? "general");
      const project = await createProject({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        objectId: deps.newId(),
        title: args.title,
        settings: { ...settings, description: args.description ?? "" },
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(projectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { project, settings: projectSettingsOf(project) },
      };
    },
  });

  const list = defineCommand<{ root: string }>({
    name: "kiwi.project.list",
    summary: "List the projects in this workspace",
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
      const projects = await listProjects(args.root);
      return {
        data: {
          projects: projects.map((entry) => ({
            id: entry.object.id,
            title: entry.object.title,
            version: entry.object.version,
            content_hash: entry.object.content_hash,
            updated_at: entry.object.updated_at,
            created_at: entry.object.created_at,
            settings: entry.settings,
            counts: entry.counts,
          })),
        },
      };
    },
  });

  const configure = defineCommand<{
    root: string;
    project_id: string;
    expected_version: number;
    expected_hash: string;
    title: string;
    settings: Record<string, unknown>;
  }>({
    name: "kiwi.project.configure",
    summary: "Rename a project and set which pages it shows",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id", "expected_version", "expected_hash", "title", "settings"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        expected_version: { type: "integer", minimum: 1 },
        expected_hash: hashProperty,
        title: { type: "string", minLength: 1, maxLength: PROJECT_LIMITS.title, pattern: "\\S" },
        settings: settingsProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const current = await readCanonicalObject(args.root, args.project_id);
      if (current === null) throw new CommandError("KIWI_NOT_FOUND", "That project was not found.");
      const settings = readProjectSettings({
        ...projectSettingsOf(current.object),
        ...args.settings,
      });
      const warnings = validateProjectSettings({ title: args.title, settings }).filter(
        (problem) => problem.severity === "warning",
      );
      const allocated = commandIds(deps);
      const project = await configureProject({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        expectedVersion: args.expected_version,
        expectedHash: args.expected_hash,
        title: args.title,
        settings,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(projectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        // Warnings are returned rather than thrown. "Results has no Analysis behind it" is
        // worth saying and is not a reason to refuse the change.
        data: { project, settings: projectSettingsOf(project), warnings },
      };
    },
  });

  const assign = defineCommand<{
    root: string;
    object_id: string;
    project_id: string | null;
  }>({
    name: "kiwi.project.assign",
    summary: "Put an object in a project, or take it out of every project",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "project_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_id: idProperty,
        project_id: { type: ["string", "null"], minLength: 1, maxLength: 100 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      if ((await readCanonicalObject(args.root, args.object_id)) === null)
        throw new CommandError("KIWI_NOT_FOUND", "That object was not found.");
      const allocated = commandIds(deps);
      const receipt = await assignObjectToProject({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        relationId: deps.newId(),
        objectId: args.object_id,
        projectId: args.project_id,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(projectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        // An object already in that project writes nothing, and says so rather than
        // reporting a change that did not happen.
        noChange: receipt.relations.length === 0,
        data: { project_id: receipt.projectId },
      };
    },
  });

  const members = defineCommand<{ root: string; project_id: string; limit?: number }>({
    name: "kiwi.project.members",
    summary: "List the objects belonging to a project, most recently changed first",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await projectMembers(args.root, args.project_id);
      // Newest first, because every caller so far wants "what has been happening here"
      // rather than the whole list in file order.
      const ordered = [...found].sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at),
      );
      return {
        data: {
          objects: ordered.slice(0, args.limit ?? 50).map((object) => ({
            id: object.id,
            type: object.type,
            title: object.title,
            version: object.version,
            content_hash: object.content_hash,
            updated_at: object.updated_at,
            updated_by: object.updated_by,
          })),
          total: ordered.length,
        },
      };
    },
  });

  const membership = defineCommand<{ root: string; object_id: string }>({
    name: "kiwi.project.membership",
    summary: "Read which project an object belongs to",
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
      const project = await projectForObject(args.root, args.object_id);
      return {
        data: {
          project:
            project === null
              ? null
              : {
                  id: project.id,
                  title: project.title,
                  version: project.version,
                  content_hash: project.content_hash,
                  settings: projectSettingsOf(project),
                },
        },
      };
    },
  });

  const previewDelete = defineCommand<{ root: string; project_id: string }>({
    name: "kiwi.project.validate-delete",
    summary: "Report what deleting a project would affect",
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
      const preview = await previewProjectDeletion(args.root, args.project_id).catch(
        projectFailure,
      );
      return { noChange: true, data: { ...preview } };
    },
  });

  const remove = defineCommand<{ root: string; project_id: string; confirmation: string }>({
    name: "kiwi.project.delete",
    summary: "Delete a project, leaving everything filed in it in the workspace",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "project_id", "confirmation"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        project_id: idProperty,
        confirmation: { type: "string", minLength: 1, maxLength: PROJECT_LIMITS.title },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const allocated = commandIds(deps);
      const outcome = await deleteProject({
        root: args.root,
        workspaceId: commandWorkspaceId(context),
        projectId: args.project_id,
        confirmation: args.confirmation,
        actor: context.actor.id,
        requestId: context.requestId,
        now: deps.now(),
        ...allocated,
      }).catch(projectFailure);
      return {
        transactionId: allocated.transactionId,
        eventIds: [allocated.preparedEventId, allocated.domainEventId, allocated.committedEventId],
        data: { ...outcome },
      };
    },
  });

  return [create, list, configure, assign, members, membership, previewDelete, remove];
}
