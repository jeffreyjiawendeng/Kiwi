import { CommandError } from "./errors.js";
import { defineCommand, type CommandDefinition } from "./registry.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

export interface EchoArgs {
  message: string;
  repeat?: number;
}

export interface CountArgs {
  amount: number;
}

export interface SlowArgs {
  steps: number;
  stepMs: number;
}

/** A durable effect for exercising idempotency, standing in for canonical storage. */
export interface Counter {
  value: number;
}

export interface DiagnosticsDeps {
  counter: Counter;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function diagnosticsCommands(deps: DiagnosticsDeps): CommandDefinition[] {
  const echo = defineCommand<EchoArgs>({
    name: "kiwi.diagnostics.echo",
    summary: "Return the supplied message",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["message"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 200 },
        repeat: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    resultSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["echoed", "length"],
      additionalProperties: false,
      properties: {
        echoed: { type: "string" },
        length: { type: "integer" },
      },
    },
    async handler(args) {
      const echoed = Array.from({ length: args.repeat ?? 1 }, () => args.message).join(" ");
      return { data: { echoed, length: echoed.length } };
    },
  });

  const count = defineCommand<CountArgs>({
    name: "kiwi.diagnostics.count",
    summary: "Add to a counter that survives repeated delivery of one idempotency key",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["amount"],
      additionalProperties: false,
      properties: { amount: { type: "integer", minimum: 1, maximum: 100 } },
    },
    resultSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["total"],
      additionalProperties: false,
      properties: { total: { type: "integer" } },
    },
    async handler(args) {
      deps.counter.value += args.amount;
      return { data: { total: deps.counter.value } };
    },
  });

  const slow = defineCommand<SlowArgs>({
    name: "kiwi.diagnostics.slow",
    summary: "Run a cancellable operation in bounded steps",
    idempotency: "not_idempotent",
    cancellation: "cancellable",
    origins: ["ui", "cli"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["steps", "stepMs"],
      additionalProperties: false,
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 60 },
        stepMs: { type: "integer", minimum: 10, maximum: 2000 },
      },
    },
    resultSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["completedSteps"],
      additionalProperties: false,
      properties: { completedSteps: { type: "integer" } },
    },
    async handler(args, context) {
      let completed = 0;
      for (let step = 0; step < args.steps; step += 1) {
        await deps.sleep(args.stepMs, context.signal);
        completed += 1;
      }
      return { data: { completedSteps: completed } };
    },
  });

  const fail = defineCommand<Record<string, never>>({
    name: "kiwi.diagnostics.fail",
    summary: "Fail with a specific catalog error",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: { $schema: SCHEMA, type: "object", additionalProperties: false, properties: {} },
    resultSchema: { $schema: SCHEMA, type: "object", additionalProperties: false, properties: {} },
    async handler() {
      throw new CommandError("KIWI_UNAVAILABLE", "The diagnostic dependency is not available.");
    },
  });

  const crash = defineCommand<Record<string, never>>({
    name: "kiwi.diagnostics.crash",
    summary: "Throw an unplanned error carrying text that must not reach the caller",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli"],
    argsSchema: { $schema: SCHEMA, type: "object", additionalProperties: false, properties: {} },
    resultSchema: { $schema: SCHEMA, type: "object", additionalProperties: false, properties: {} },
    async handler() {
      throw new Error("unplanned failure reading C:\\Users\\ana\\private-notes.md");
    },
  });

  return [echo, count, slow, fail, crash];
}
