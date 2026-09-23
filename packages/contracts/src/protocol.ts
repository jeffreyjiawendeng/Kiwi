export const PROTOCOL_VERSION = "1.0.0";

export type ActorKind = "local_user" | "extension" | "automation";
export type OriginSurface = "ui" | "cli" | "api" | "extension" | "importer" | "ai";

export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface Origin {
  surface: OriginSurface;
  extension_id: string | null;
}

export interface ExpectedObject {
  id: string;
  version: number;
  content_hash?: string;
}

/**
 * Wire shape defined by schemas/command-envelope.schema.json. actor and origin are
 * optional on the wire because the gateway derives them from the authenticated channel
 * and overwrites anything a caller asserts.
 */
export interface CommandEnvelope {
  protocol_version: string;
  request_id: string;
  idempotency_key?: string;
  workspace_id?: string | null;
  command: string;
  args: Record<string, unknown>;
  expected?: { objects?: ExpectedObject[] };
  actor?: Actor;
  origin?: Origin;
  dry_run?: boolean;
}

export type CommandStatus =
  | "committed"
  | "committed_with_projection_pending"
  | "accepted_as_job"
  | "no_change"
  | "canceled"
  | "failed";

export interface CommandResult {
  protocol_version: string;
  request_id: string;
  status: CommandStatus;
  transaction_id?: string;
  event_ids?: string[];
  data?: Record<string, unknown>;
  warnings?: string[];
  error?: KiwiError;
  replayed?: boolean;
}

export const ERROR_CODES = [
  "KIWI_INVALID_REQUEST",
  "KIWI_INVALID_ARGUMENTS",
  "KIWI_UNKNOWN_COMMAND",
  "KIWI_PROTOCOL_MISMATCH",
  "KIWI_NOT_FOUND",
  "KIWI_FORBIDDEN",
  "KIWI_UNAVAILABLE",
  "KIWI_CONFLICT_VERSION",
  "KIWI_CANCELED",
  "KIWI_TIMEOUT",
  "KIWI_IDEMPOTENCY_MISMATCH",
  "KIWI_INTERNAL_REDACTED",
  "KIWI_WORKSPACE_NOT_FOUND",
  "KIWI_WORKSPACE_INVALID",
  "KIWI_WORKSPACE_FUTURE_SCHEMA",
  "KIWI_WORKSPACE_READ_ONLY",
  "KIWI_WORKSPACE_LOCKED",
  "KIWI_WORKSPACE_EXISTS",
  "KIWI_WORKSPACE_UNTRUSTED",
  "KIWI_PATH_DENIED",
  "KIWI_STARTUP_FAILED",
  "KIWI_RENDERER_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const RECOVERY_ACTIONS = [
  "retry",
  "restart_application",
  "open_logs",
  "copy_diagnostic_reference",
  "correct_input",
  "reload_current",
  "quit",
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/**
 * Shape defined by schemas/error.schema.json. details carries structured facts only.
 * It never carries a stack trace, a secret, or research content.
 */
export interface KiwiError {
  code: ErrorCode;
  message: string;
  details: Record<string, string | number | boolean>;
  retryable: boolean;
  recovery_actions: RecoveryAction[];
  correlation_id: string;
}

export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(value);
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Protocol compatibility is decided on the major version only. */
export function isCompatibleProtocol(candidate: string, current = PROTOCOL_VERSION): boolean {
  const [candidateMajor] = candidate.split(".");
  const [currentMajor] = current.split(".");
  return candidateMajor !== undefined && candidateMajor === currentMajor;
}
