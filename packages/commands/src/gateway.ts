import {
  PROTOCOL_VERSION,
  isCompatibleProtocol,
  type Actor,
  type CommandEnvelope,
  type CommandResult,
  type KiwiError,
  type Origin,
} from "@kiwi/contracts";
import { CommandError, commandError } from "./errors.js";
import type { CommandDefinition, CommandRegistry } from "./registry.js";
import {
  createValidator,
  exceedsSizeLimits,
  toFieldProblems,
  type FieldProblem,
  type Validator,
} from "./validation.js";
import { fingerprintArgs, memoryReceiptStore, type ReceiptStore } from "./idempotency.js";

/** Facts the adapter proves about its channel. A caller can never assert these. */
export interface CallerContext {
  actor: Actor;
  origin: Origin;
}

export interface GatewayEvent {
  event: string;
  command: string;
  status: string;
  correlationId: string;
  durationMs: number;
}

export interface GatewayOptions {
  registry: CommandRegistry;
  newCorrelationId: () => string;
  validator?: Validator;
  receipts?: ReceiptStore;
  onEvent?: (event: GatewayEvent) => void;
}

export interface InvokeOptions {
  signal?: AbortSignal;
}

export interface Gateway {
  invoke(envelope: unknown, caller: CallerContext, options?: InvokeOptions): Promise<CommandResult>;
}

const UNKNOWN_REQUEST = "00000000-0000-0000-0000-000000000000";

function failed(requestId: string, error: KiwiError): CommandResult {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    status: "failed",
    error,
  };
}

function problemDetails(problems: FieldProblem[]): Record<string, string | number> {
  const details: Record<string, string | number> = { problem_count: problems.length };
  problems.slice(0, 10).forEach((problem, index) => {
    details[`problem_${index}`] = `${problem.path} ${problem.detail} (${problem.rule})`;
  });
  return details;
}

function translateThrow(cause: unknown, aborted: boolean, correlationId: string): KiwiError {
  if (aborted) {
    return commandError({
      code: "KIWI_CANCELED",
      message: "The operation was canceled.",
      correlationId,
    });
  }
  if (cause instanceof CommandError) {
    return commandError({
      code: cause.code,
      message: cause.message,
      correlationId,
      details: cause.details,
      ...(cause.recoveryActions !== undefined ? { recoveryActions: cause.recoveryActions } : {}),
    });
  }
  // An unplanned throw can carry a path, a query, or a provider payload in its message.
  return commandError({
    code: "KIWI_INTERNAL_REDACTED",
    message: "The command failed. The log holds a redacted record under this reference.",
    correlationId,
  });
}

function replayedResult(
  definition: CommandDefinition,
  envelope: CommandEnvelope,
  receipts: ReceiptStore,
  correlationId: string,
): CommandResult | null {
  const key = envelope.idempotency_key;
  if (key === undefined || definition.idempotency === "not_idempotent") return null;

  const stored = receipts.find(key);
  if (stored === undefined) return null;

  if (
    stored.command !== definition.name ||
    stored.argsFingerprint !== fingerprintArgs(envelope.args)
  ) {
    return failed(
      envelope.request_id,
      commandError({
        code: "KIWI_IDEMPOTENCY_MISMATCH",
        message: "That idempotency key was already used with different arguments.",
        correlationId,
        details: { command: definition.name },
      }),
    );
  }

  return { ...stored.result, request_id: envelope.request_id, replayed: true };
}

function rememberReceipt(
  definition: CommandDefinition,
  envelope: CommandEnvelope,
  receipts: ReceiptStore,
  result: CommandResult,
): void {
  const key = envelope.idempotency_key;
  if (key === undefined || definition.idempotency === "not_idempotent") return;
  if (result.status === "failed" || result.status === "canceled") return;

  receipts.save(key, {
    command: definition.name,
    argsFingerprint: fingerprintArgs(envelope.args),
    result,
  });
}

export function createGateway(options: GatewayOptions): Gateway {
  const { registry, newCorrelationId } = options;
  const validator = options.validator ?? createValidator();
  const receipts = options.receipts ?? memoryReceiptStore();

  // Reporting is observation. A failing observer must not change a command outcome.
  function report(event: GatewayEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // ignored on purpose
    }
  }

  async function invoke(
    input: unknown,
    caller: CallerContext,
    invokeOptions: InvokeOptions = {},
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    const correlationId = newCorrelationId();

    if (exceedsSizeLimits(input)) {
      return failed(
        UNKNOWN_REQUEST,
        commandError({
          code: "KIWI_INVALID_REQUEST",
          message: "The request is larger or more deeply nested than the protocol allows.",
          correlationId,
        }),
      );
    }

    const envelopeProblems = validator.validateEnvelope(input);
    if (envelopeProblems.length > 0) {
      return failed(
        UNKNOWN_REQUEST,
        commandError({
          code: "KIWI_INVALID_REQUEST",
          message: "The command envelope does not match the protocol.",
          correlationId,
          details: problemDetails(envelopeProblems),
        }),
      );
    }

    const envelope = input as CommandEnvelope;
    const requestId = envelope.request_id;

    if (!isCompatibleProtocol(envelope.protocol_version)) {
      return failed(
        requestId,
        commandError({
          code: "KIWI_PROTOCOL_MISMATCH",
          message: `This Kiwi build speaks command protocol ${PROTOCOL_VERSION}.`,
          correlationId,
          details: { requested: envelope.protocol_version, supported: PROTOCOL_VERSION },
        }),
      );
    }

    const definition = registry.get(envelope.command);
    if (definition === undefined) {
      return failed(
        requestId,
        commandError({
          code: "KIWI_UNKNOWN_COMMAND",
          message: "That command is not registered in this build.",
          correlationId,
          details: { command: envelope.command },
        }),
      );
    }

    if (!definition.origins.includes(caller.origin.surface)) {
      return failed(
        requestId,
        commandError({
          code: "KIWI_FORBIDDEN",
          message: "That command cannot be invoked from this surface.",
          correlationId,
          details: { command: definition.name, surface: caller.origin.surface },
        }),
      );
    }

    const validateArgs = validator.compile(definition.argsSchema);
    if (!validateArgs(envelope.args)) {
      return failed(
        requestId,
        commandError({
          code: "KIWI_INVALID_ARGUMENTS",
          message: "One or more values are not valid for this command.",
          correlationId,
          details: problemDetails(toFieldProblems(validateArgs.errors)),
        }),
      );
    }

    const replay = replayedResult(definition, envelope, receipts, correlationId);
    if (replay !== null) {
      report({
        event: "command.replayed",
        command: definition.name,
        status: replay.status,
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return replay;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const callerSignal = invokeOptions.signal;
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", abort, { once: true });
    }

    let result: CommandResult;
    try {
      const outcome = await definition.handler(envelope.args, {
        requestId,
        correlationId,
        actor: caller.actor,
        origin: caller.origin,
        workspaceId: envelope.workspace_id ?? null,
        dryRun: envelope.dry_run ?? false,
        signal: controller.signal,
      });

      result = {
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        status: outcome.noChange === true ? "no_change" : "committed",
        ...(outcome.transactionId !== undefined ? { transaction_id: outcome.transactionId } : {}),
        ...(outcome.eventIds !== undefined ? { event_ids: outcome.eventIds } : {}),
        data: outcome.data ?? {},
        ...(outcome.warnings !== undefined ? { warnings: outcome.warnings } : {}),
      };
    } catch (cause) {
      const error = translateThrow(cause, controller.signal.aborted, correlationId);
      result =
        error.code === "KIWI_CANCELED"
          ? {
              protocol_version: PROTOCOL_VERSION,
              request_id: requestId,
              status: "canceled",
              error,
            }
          : failed(requestId, error);
    } finally {
      callerSignal?.removeEventListener("abort", abort);
    }

    rememberReceipt(definition, envelope, receipts, result);

    report({
      event: "command.completed",
      command: definition.name,
      status: result.status,
      correlationId,
      durationMs: Date.now() - startedAt,
    });

    return result;
  }

  return { invoke };
}
