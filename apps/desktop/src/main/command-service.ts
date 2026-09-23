import {
  createGateway,
  createRegistry,
  defaultSleep,
  diagnosticsCommands,
  type CallerContext,
  type Counter,
  type Gateway,
} from "@kiwi/commands";
import type { CommandResult } from "@kiwi/contracts";
import type { Logger } from "@kiwi/diagnostics";
import {
  assetCommands,
  bibliographyCommands,
  claimCommands,
  coeditNoteCommands,
  objectCommands,
  projectCommands,
  protocolCommands,
  taskCommands,
  threadCommands,
  workspaceCommands,
} from "@kiwi/workspace";
import type { SessionRegistry } from "./workspace-session.js";
import { uuidV7 } from "./uuid-v7.js";
import { projectionCommands } from "./projection-commands.js";
import type { ProjectionService } from "./projection.js";
import { recoveryDraftCommands } from "./recovery-draft-commands.js";
import type { RecoveryDraftStore } from "./recovery-draft-store.js";

export const UI_CALLER: CallerContext = {
  actor: { kind: "local_user", id: "actor:local/default" },
  origin: { surface: "ui", extension_id: null },
};

export interface CommandService {
  invoke(envelope: unknown, requestId: string | null, actorId?: string): Promise<CommandResult>;
  cancel(requestId: string): boolean;
  inFlight(): number;
  commandNames(): string[];
}

export function createCommandService(
  logger: Logger,
  sessions: SessionRegistry,
  projection?: ProjectionService,
  drafts?: RecoveryDraftStore,
  revealFile?: (root: string, relativePath: string) => Promise<void>,
  openFile?: (root: string, relativePath: string) => Promise<void>,
): CommandService {
  const registry = createRegistry();
  const counter: Counter = { value: 0 };
  const locale = Intl.DateTimeFormat().resolvedOptions();

  for (const definition of diagnosticsCommands({ counter, sleep: defaultSleep })) {
    registry.register(definition);
  }

  for (const definition of workspaceCommands({
    trust: sessions.trust,
    recent: sessions.recent,
    newWorkspaceId: () => uuidV7(),
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
    defaultLocale: () => locale.locale,
    defaultTimeZone: () => locale.timeZone,
  })) {
    registry.register(definition);
  }

  for (const definition of objectCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
    ...(revealFile === undefined ? {} : { revealFile }),
    ...(drafts === undefined
      ? {}
      : {
          hasRecoveryDraft: async (actorId: string, workspaceId: string, objectId: string) =>
            (await drafts.read(actorId, workspaceId, objectId)) !== null,
        }),
  })) {
    registry.register(definition);
  }

  for (const definition of projectCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of threadCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of taskCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of protocolCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of claimCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of bibliographyCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  for (const definition of assetCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
    ...(revealFile === undefined ? {} : { revealFile }),
    ...(openFile === undefined ? {} : { openFile }),
  })) {
    registry.register(definition);
  }

  for (const definition of coeditNoteCommands({
    newId: () => uuidV7(),
    now: () => new Date().toISOString(),
  })) {
    registry.register(definition);
  }

  if (projection !== undefined) {
    for (const definition of projectionCommands(projection)) registry.register(definition);
  }

  if (drafts !== undefined) {
    for (const definition of recoveryDraftCommands(drafts, () => new Date().toISOString()))
      registry.register(definition);
  }

  const gateway: Gateway = createGateway({
    registry,
    newCorrelationId: () => uuidV7(),
    onEvent: (event) => {
      logger.info(event.event, {
        command: event.command,
        result_status: event.status,
        duration_ms: event.durationMs,
      });
    },
  });

  const running = new Map<string, AbortController>();

  return {
    async invoke(envelope, requestId, actorId = UI_CALLER.actor.id) {
      const controller = new AbortController();
      if (requestId !== null) running.set(requestId, controller);
      try {
        return await gateway.invoke(
          envelope,
          { ...UI_CALLER, actor: { kind: "local_user", id: actorId } },
          { signal: controller.signal },
        );
      } finally {
        if (requestId !== null) running.delete(requestId);
      }
    },

    cancel(requestId) {
      const controller = running.get(requestId);
      if (controller === undefined) return false;
      controller.abort();
      return true;
    },

    inFlight() {
      return running.size;
    },

    commandNames() {
      return registry.names();
    },
  };
}

/**
 * The request identifier is read before validation so a cancel request can find the
 * controller. An unusable value simply means the call is not cancellable.
 */
export function readRequestId(envelope: unknown): string | null {
  if (envelope === null || typeof envelope !== "object") return null;
  const value = (envelope as Record<string, unknown>)["request_id"];
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}
