import type { Actor, Origin } from "@kiwi/contracts";

export type IdempotencyPolicy = "not_idempotent" | "idempotent";
export type CancellationPolicy = "not_cancellable" | "cancellable";

export interface CommandContext {
  requestId: string;
  correlationId: string;
  actor: Actor;
  origin: Origin;
  workspaceId: string | null;
  dryRun: boolean;
  signal: AbortSignal;
}

export interface CommandOutcome {
  data?: Record<string, unknown>;
  warnings?: string[];
  noChange?: boolean;
  transactionId?: string;
  eventIds?: string[];
}

export interface CommandDefinition<A = Record<string, unknown>> {
  name: string;
  summary: string;
  argsSchema: object;
  resultSchema: object;
  idempotency: IdempotencyPolicy;
  cancellation: CancellationPolicy;
  /** Surfaces permitted to invoke this command. */
  origins: readonly Origin["surface"][];
  handler(args: A, context: CommandContext): Promise<CommandOutcome>;
}

export interface CommandRegistry {
  register(definition: CommandDefinition): void;
  get(name: string): CommandDefinition | undefined;
  names(): string[];
  definitions(): CommandDefinition[];
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

export function createRegistry(): CommandRegistry {
  const definitions = new Map<string, CommandDefinition>();

  return {
    register(definition) {
      if (!NAME_PATTERN.test(definition.name)) {
        throw new Error(`Command name is not namespaced: ${definition.name}`);
      }
      if (definitions.has(definition.name)) {
        throw new Error(`Command already registered: ${definition.name}`);
      }
      if (definition.origins.length === 0) {
        throw new Error(`Command declares no permitted origin: ${definition.name}`);
      }
      definitions.set(definition.name, definition);
    },

    get(name) {
      return definitions.get(name);
    },

    names() {
      return [...definitions.keys()].sort();
    },

    definitions() {
      return [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/**
 * Binds a definition's argument type to its handler at the definition site. The gateway
 * validates args against argsSchema before the handler runs, so the cast holds only
 * because registration and validation share one schema.
 */
export function defineCommand<A>(definition: CommandDefinition<A>): CommandDefinition {
  return definition as CommandDefinition<never> as CommandDefinition;
}
