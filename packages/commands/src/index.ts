export { CommandError, commandError, type CommandFailureInput } from "./errors.js";

export {
  createRegistry,
  defineCommand,
  type CancellationPolicy,
  type CommandContext,
  type CommandDefinition,
  type CommandOutcome,
  type CommandRegistry,
  type IdempotencyPolicy,
} from "./registry.js";

export {
  createValidator,
  exceedsSizeLimits,
  toFieldProblems,
  type FieldProblem,
  type Validator,
} from "./validation.js";

export {
  fingerprintArgs,
  memoryReceiptStore,
  type ReceiptStore,
  type StoredReceipt,
} from "./idempotency.js";

export {
  createGateway,
  type CallerContext,
  type Gateway,
  type GatewayEvent,
  type GatewayOptions,
  type InvokeOptions,
} from "./gateway.js";

export {
  defaultSleep,
  diagnosticsCommands,
  type CountArgs,
  type Counter,
  type DiagnosticsDeps,
  type EchoArgs,
  type SlowArgs,
} from "./diagnostics-commands.js";
