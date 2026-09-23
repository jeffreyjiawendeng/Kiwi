import type { ErrorCode, KiwiError, RecoveryAction } from "@kiwi/contracts";

export interface CommandFailureInput {
  code: ErrorCode;
  message: string;
  correlationId: string;
  details?: Record<string, string | number | boolean>;
  retryable?: boolean;
  recoveryActions?: RecoveryAction[];
}

const DEFAULT_RECOVERY: Record<ErrorCode, RecoveryAction[]> = {
  KIWI_INVALID_REQUEST: ["correct_input"],
  KIWI_INVALID_ARGUMENTS: ["correct_input"],
  KIWI_UNKNOWN_COMMAND: ["correct_input"],
  KIWI_PROTOCOL_MISMATCH: ["restart_application"],
  KIWI_NOT_FOUND: ["reload_current"],
  KIWI_FORBIDDEN: ["reload_current"],
  KIWI_UNAVAILABLE: ["retry"],
  KIWI_CONFLICT_VERSION: ["reload_current"],
  KIWI_CANCELED: ["retry"],
  KIWI_TIMEOUT: ["retry"],
  KIWI_IDEMPOTENCY_MISMATCH: ["correct_input"],
  KIWI_INTERNAL_REDACTED: ["retry", "open_logs"],
  KIWI_WORKSPACE_NOT_FOUND: ["correct_input"],
  KIWI_WORKSPACE_INVALID: ["open_logs"],
  KIWI_WORKSPACE_FUTURE_SCHEMA: ["open_logs"],
  KIWI_WORKSPACE_READ_ONLY: ["reload_current"],
  KIWI_WORKSPACE_LOCKED: ["retry"],
  KIWI_WORKSPACE_EXISTS: ["correct_input"],
  KIWI_WORKSPACE_UNTRUSTED: ["reload_current"],
  KIWI_PATH_DENIED: ["correct_input"],
  KIWI_STARTUP_FAILED: ["retry", "open_logs", "quit"],
  KIWI_RENDERER_FAILED: ["retry", "open_logs", "quit"],
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "KIWI_UNAVAILABLE",
  "KIWI_TIMEOUT",
  "KIWI_INTERNAL_REDACTED",
  "KIWI_WORKSPACE_LOCKED",
]);

export function commandError(input: CommandFailureInput): KiwiError {
  return {
    code: input.code,
    message: input.message,
    details: input.details ?? {},
    retryable: input.retryable ?? RETRYABLE.has(input.code),
    recovery_actions: input.recoveryActions ?? DEFAULT_RECOVERY[input.code],
    correlation_id: input.correlationId,
  };
}

/**
 * Raised by a handler to fail a command with a specific catalog entry. Anything else a
 * handler throws becomes KIWI_INTERNAL_REDACTED so an unplanned message cannot reach the
 * caller.
 */
export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, string | number | boolean>;
  readonly recoveryActions: RecoveryAction[] | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: Omit<CommandFailureInput, "code" | "message" | "correlationId"> = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = options.details ?? {};
    this.recoveryActions = options.recoveryActions;
  }
}
