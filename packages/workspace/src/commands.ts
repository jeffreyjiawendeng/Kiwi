import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import type { ErrorCode, RecentWorkspace, TrustLevel, WorkspaceSummary } from "@kiwi/contracts";
import {
  WorkspaceError,
  checkWorkspaceHealth,
  createWorkspace,
  openWorkspace,
  repairWorkspaceLayout,
  renameWorkspace,
} from "./store.js";
import { detectSyncFolder, type RecentStore, type TrustStore } from "./session.js";
import { recoverCanonicalTransactions } from "./canonical-transaction.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const ERROR_FOR_KIND: Record<WorkspaceError["kind"], ErrorCode> = {
  path_denied: "KIWI_PATH_DENIED",
  not_found: "KIWI_WORKSPACE_NOT_FOUND",
  already_exists: "KIWI_WORKSPACE_EXISTS",
  not_writable: "KIWI_WORKSPACE_READ_ONLY",
  invalid: "KIWI_WORKSPACE_INVALID",
};

/**
 * Translates a workspace failure into the catalog. The message is authored here rather
 * than reused from the cause, so a filesystem error string never reaches the caller.
 */
function translate(cause: unknown): never {
  if (cause instanceof WorkspaceError) {
    throw new CommandError(ERROR_FOR_KIND[cause.kind], cause.message, { details: cause.detail });
  }
  throw cause;
}

export interface WorkspaceCommandDeps {
  trust: TrustStore;
  recent: RecentStore;
  newWorkspaceId: () => string;
  newId?: () => string;
  now: () => string;
  defaultLocale?: () => string;
  defaultTimeZone?: () => string;
  /** Called after a workspace opens so the host can bind a session. */
  onOpened?: (summary: WorkspaceSummary) => void | Promise<void>;
}

interface CreateArgs {
  root: string;
  title: string;
  profiles?: string[];
}

interface OpenArgs {
  root: string;
}

interface TrustArgs {
  root: string;
  trust: TrustLevel;
}

interface RootArgs {
  root: string;
}

interface RenameArgs extends RootArgs {
  title: string;
}

const rootProperty = { type: "string", minLength: 3, maxLength: 240 };

async function recordOpen(
  deps: WorkspaceCommandDeps,
  summary: WorkspaceSummary,
): Promise<WorkspaceSummary> {
  if (summary.workspaceId !== "") {
    const entry: RecentWorkspace = {
      workspaceId: summary.workspaceId,
      title: summary.title,
      root: summary.root,
      lastOpenedAt: deps.now(),
    };
    await deps.recent.record(entry);
  }
  await deps.onOpened?.(summary);
  return summary;
}

function summaryData(summary: WorkspaceSummary, syncHint: string | null): Record<string, unknown> {
  return { workspace: summary, syncHint };
}

export function workspaceCommands(deps: WorkspaceCommandDeps): CommandDefinition[] {
  const create = defineCommand<CreateArgs>({
    name: "kiwi.workspace.create",
    summary: "Create a workspace in a chosen folder",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "title"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        profiles: { type: "array", maxItems: 20, items: { type: "string", maxLength: 60 } },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const summary = await createWorkspace({
        root: args.root,
        title: args.title.trim().normalize("NFC"),
        workspaceId: deps.newWorkspaceId(),
        now: deps.now(),
        locale: deps.defaultLocale?.() ?? "en-US",
        timeZone: deps.defaultTimeZone?.() ?? "UTC",
        ...(args.profiles !== undefined ? { profiles: args.profiles } : {}),
      }).catch(translate);

      // Creating a workspace is an explicit act, so it starts trusted.
      await deps.trust.remember({ root: summary.root, trust: "trusted", decidedAt: deps.now() });
      await recordOpen(deps, summary);

      return { data: summaryData(summary, detectSyncFolder(summary.root)) };
    },
  });

  const open = defineCommand<OpenArgs>({
    name: "kiwi.workspace.open",
    summary: "Open an existing workspace folder",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      // An unseen folder is restricted until the user decides. ENG-ARCH-009 forbids
      // acting on workspace content before that.
      const remembered = await deps.trust.lookup(args.root);
      const summary = await openWorkspace({
        root: args.root,
        trust: remembered ?? "restricted",
      }).catch(translate);

      await recordOpen(deps, summary);

      return {
        data: {
          ...summaryData(summary, detectSyncFolder(summary.root)),
          trustDecided: remembered !== null,
        },
      };
    },
  });

  const setTrust = defineCommand<TrustArgs>({
    name: "kiwi.workspace.set-trust",
    summary: "Record a trust decision for a workspace folder",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "trust"],
      additionalProperties: false,
      properties: { root: rootProperty, trust: { enum: ["trusted", "restricted"] } },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      await deps.trust.remember({ root: args.root, trust: args.trust, decidedAt: deps.now() });
      const summary = await openWorkspace({ root: args.root, trust: args.trust }).catch(translate);
      return { data: summaryData(summary, detectSyncFolder(summary.root)) };
    },
  });

  const health = defineCommand<RootArgs>({
    name: "kiwi.workspace.health",
    summary: "Report workspace format, layout, and permission status",
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
      const report = await checkWorkspaceHealth(args.root).catch(translate);
      return { data: { health: report, syncHint: detectSyncFolder(report.root) } };
    },
  });

  const repair = defineCommand<RootArgs>({
    name: "kiwi.workspace.repair-layout",
    summary: "Recreate missing workspace folders without touching records",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: { root: rootProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const repaired = await repairWorkspaceLayout(args.root).catch(translate);
      return {
        data: { repaired },
        noChange: repaired.length === 0,
      };
    },
  });

  const recover = defineCommand<RootArgs>({
    name: "kiwi.workspace.recover-transactions",
    summary: "Recover interrupted canonical workspace writes",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
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
      if (context.workspaceId === null) {
        throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before recovery.");
      }
      const reports = await recoverCanonicalTransactions(args.root, {
        workspaceId: context.workspaceId,
        actor: context.actor.id,
        origin: context.origin.surface,
        requestId: context.requestId,
        now: deps.now(),
        newId: deps.newId ?? deps.newWorkspaceId,
      });
      return {
        data: { recovered: reports },
        eventIds: reports.flatMap((report) =>
          report.event_id === undefined ? [] : [report.event_id],
        ),
        noChange: reports.length === 0,
      };
    },
  });

  const recent = defineCommand<Record<string, never>>({
    name: "kiwi.workspace.recent",
    summary: "List recently opened workspaces",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: { $schema: SCHEMA, type: "object", additionalProperties: false, properties: {} },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler() {
      return { data: { recent: await deps.recent.list() } };
    },
  });

  /**
   * Takes a workspace off the list without touching the folder.
   *
   * The list is Kiwi's memory of where somebody has been, and it is the only thing this removes.
   * A workspace is a folder of files that belong to whoever made it, and an application that
   * offered to "remove" one from a list it keeps -- and deleted their work -- would be the last
   * mistake it ever got to make. The interface says this in the confirmation and this says it in
   * the only place that could do otherwise.
   *
   * The workspace is named by id rather than by folder, because the renderer has no business
   * naming a path and the list already knows where each entry is.
   */
  const forget = defineCommand<{ workspace_id: string }>({
    name: "kiwi.workspace.forget",
    summary: "Remove a workspace from the recent list, leaving the folder untouched",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["workspace_id"],
      additionalProperties: false,
      properties: { workspace_id: { type: "string", minLength: 1, maxLength: 100 } },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const entries = await deps.recent.list();
      const entry = entries.find((item) => item.workspaceId === args.workspace_id);
      if (entry === undefined) {
        // Already gone is the outcome that was asked for, so this is not an error to report.
        return { noChange: true, data: { forgotten: null, recent: entries } };
      }
      await deps.recent.remove(entry.root);
      return { data: { forgotten: entry.title, recent: await deps.recent.list() } };
    },
  });

  const rename = defineCommand<RenameArgs>({
    name: "kiwi.workspace.rename",
    summary: "Rename the active workspace",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "title"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const summary = await renameWorkspace(args.root, args.title, deps.now()).catch(translate);
      await recordOpen(deps, summary);
      return { data: summaryData(summary, detectSyncFolder(summary.root)) };
    },
  });

  return [create, open, setTrust, health, repair, recover, recent, forget, rename];
}
