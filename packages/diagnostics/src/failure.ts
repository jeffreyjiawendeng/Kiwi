import type { ErrorCode, KiwiError, RecoveryAction } from "@kiwi/contracts";

export interface FailureInput {
  code: ErrorCode;
  message: string;
  correlationId: string;
  details?: Record<string, string | number | boolean>;
  retryable?: boolean;
  recoveryActions?: RecoveryAction[];
}

/**
 * Builds the user-facing failure envelope. The originating error is never attached, so a
 * stack trace or a provider payload cannot reach the renderer.
 */
export function toKiwiError(input: FailureInput): KiwiError {
  return {
    code: input.code,
    message: input.message,
    details: input.details ?? {},
    retryable: input.retryable ?? false,
    recovery_actions: input.recoveryActions ?? ["restart_application", "open_logs"],
    correlation_id: input.correlationId,
  };
}

/**
 * Describes an unknown thrown value in terms safe to log. The message is not included
 * because a thrown error can carry a file path, a query, or a provider response.
 */
export function describeCause(cause: unknown): Record<string, string | number | boolean> {
  if (cause instanceof Error) {
    return { cause_kind: "error", cause_name: cause.name };
  }
  return { cause_kind: typeof cause };
}
