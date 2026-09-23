import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type CommandEnvelope, type CommandResult } from "@kiwi/contracts";
import { createGateway, type CallerContext, type Gateway, type GatewayEvent } from "./gateway.js";
import { createRegistry, type CommandRegistry } from "./registry.js";
import { diagnosticsCommands, type Counter } from "./diagnostics-commands.js";
import { memoryReceiptStore } from "./idempotency.js";

const UI_CALLER: CallerContext = {
  actor: { kind: "local_user", id: "actor:local/default" },
  origin: { surface: "ui", extension_id: null },
};

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `0198c810-31fd-76db-b8a7-${hex}`;
}

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: uuid(1),
    command: "kiwi.diagnostics.echo",
    args: { message: "hello" },
    ...overrides,
  };
}

let registry: CommandRegistry;
let gateway: Gateway;
let counter: Counter;
let events: GatewayEvent[];
let correlation: number;

function immediateSleep(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 1);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

beforeEach(() => {
  registry = createRegistry();
  counter = { value: 0 };
  events = [];
  correlation = 0;
  for (const definition of diagnosticsCommands({ counter, sleep: immediateSleep })) {
    registry.register(definition);
  }
  gateway = createGateway({
    registry,
    newCorrelationId: () => `corr-${(correlation += 1)}`,
    receipts: memoryReceiptStore(),
    onEvent: (event) => events.push(event),
  });
});

describe("successful command", () => {
  it("returns a committed receipt carrying the request id", async () => {
    const result = await gateway.invoke(envelope(), UI_CALLER);

    expect(result.status).toBe("committed");
    expect(result.request_id).toBe(uuid(1));
    expect(result.protocol_version).toBe(PROTOCOL_VERSION);
    expect(result.data).toEqual({ echoed: "hello", length: 5 });
    expect(result.error).toBeUndefined();
  });

  it("reports the outcome to the observer with a correlation id", async () => {
    await gateway.invoke(envelope(), UI_CALLER);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "command.completed",
      command: "kiwi.diagnostics.echo",
      status: "committed",
      correlationId: "corr-1",
    });
  });

  it("applies validated optional arguments", async () => {
    const result = await gateway.invoke(
      envelope({ args: { message: "ping", repeat: 3 } }),
      UI_CALLER,
    );
    expect(result.data).toEqual({ echoed: "ping ping ping", length: 14 });
  });

  it("carries canonical transaction and event identifiers into the receipt", async () => {
    registry.register({
      name: "kiwi.test.canonical-receipt",
      summary: "return canonical identifiers",
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui"],
      argsSchema: { type: "object", additionalProperties: false, properties: {} },
      resultSchema: { type: "object" },
      async handler() {
        return {
          transactionId: uuid(10),
          eventIds: [uuid(11), uuid(12), uuid(13)],
          data: { saved: true },
        };
      },
    });

    const result = await gateway.invoke(
      envelope({ command: "kiwi.test.canonical-receipt", args: {} }),
      UI_CALLER,
    );

    expect(result.transaction_id).toBe(uuid(10));
    expect(result.event_ids).toEqual([uuid(11), uuid(12), uuid(13)]);
  });
});

describe("envelope validation", () => {
  it.each([
    ["not an object", 42],
    ["null", null],
    ["missing command", { protocol_version: PROTOCOL_VERSION, request_id: uuid(1), args: {} }],
    ["unknown top-level field", { ...envelope(), surprise: true }],
    ["request id that is not a uuid", { ...envelope(), request_id: "1" }],
    ["command name without a namespace", { ...envelope(), command: "echo" }],
    ["command name with capitals", { ...envelope(), command: "Kiwi.Echo" }],
    ["args that are not an object", { ...envelope(), args: [] }],
  ])("rejects %s", async (_label, input) => {
    const result = await gateway.invoke(input, UI_CALLER);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_REQUEST");
    expect(result.error?.correlation_id).toBe("corr-1");
  });

  it("rejects a payload nested past the protocol limit", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) deep = { deep };
    const result = await gateway.invoke(envelope({ args: { message: "x", deep } }), UI_CALLER);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_REQUEST");
  });

  it("rejects an incompatible protocol major version", async () => {
    const result = await gateway.invoke(envelope({ protocol_version: "2.0.0" }), UI_CALLER);

    expect(result.error?.code).toBe("KIWI_PROTOCOL_MISMATCH");
    expect(result.error?.details).toMatchObject({
      requested: "2.0.0",
      supported: PROTOCOL_VERSION,
    });
  });

  it("accepts a compatible protocol minor version", async () => {
    const result = await gateway.invoke(envelope({ protocol_version: "1.4.2" }), UI_CALLER);
    expect(result.status).toBe("committed");
  });
});

describe("argument validation", () => {
  it("names the failing field without repeating its value", async () => {
    const secret = "unpublished-participant-data";
    const result = await gateway.invoke(
      envelope({ args: { message: secret, repeat: 99 } }),
      UI_CALLER,
    );

    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result.error?.details)).toContain("/repeat");
  });

  it("reports every problem rather than only the first", async () => {
    const result = await gateway.invoke(envelope({ args: { repeat: 0, extra: 1 } }), UI_CALLER);
    expect(result.error?.details["problem_count"]).toBeGreaterThan(1);
  });

  it("offers correcting the input as the recovery action", async () => {
    const result = await gateway.invoke(envelope({ args: {} }), UI_CALLER);
    expect(result.error?.recovery_actions).toEqual(["correct_input"]);
    expect(result.error?.retryable).toBe(false);
  });
});

describe("registration and origin", () => {
  it("rejects an unregistered command", async () => {
    const result = await gateway.invoke(envelope({ command: "kiwi.nope.missing" }), UI_CALLER);
    expect(result.error?.code).toBe("KIWI_UNKNOWN_COMMAND");
  });

  it("rejects a surface the command does not permit", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.slow", args: { steps: 1, stepMs: 10 } }),
      {
        actor: { kind: "extension", id: "ext:sample" },
        origin: { surface: "extension", extension_id: "ext:sample" },
      },
    );

    expect(result.error?.code).toBe("KIWI_FORBIDDEN");
    expect(result.error?.details).toMatchObject({ surface: "extension" });
  });

  it("derives actor and origin from the channel rather than the envelope", async () => {
    const seen: string[] = [];
    registry.register({
      name: "kiwi.test.actor",
      summary: "record the actor the handler receives",
      idempotency: "not_idempotent",
      cancellation: "not_cancellable",
      origins: ["ui"],
      argsSchema: { type: "object", additionalProperties: false, properties: {} },
      resultSchema: { type: "object" },
      async handler(_args, context) {
        seen.push(`${context.actor.kind}:${context.actor.id}:${context.origin.surface}`);
        return {};
      },
    });

    await gateway.invoke(
      envelope({
        command: "kiwi.test.actor",
        args: {},
        actor: { kind: "automation", id: "actor:forged" },
        origin: { surface: "api", extension_id: null },
      }),
      UI_CALLER,
    );

    expect(seen).toEqual(["local_user:actor:local/default:ui"]);
  });
});

describe("handler failures", () => {
  it("passes a declared catalog error through", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.fail", args: {} }),
      UI_CALLER,
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
  });

  it("redacts an unplanned throw", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.crash", args: {} }),
      UI_CALLER,
    );

    expect(result.error?.code).toBe("KIWI_INTERNAL_REDACTED");
    expect(JSON.stringify(result)).not.toContain("private-notes");
    expect(JSON.stringify(result)).not.toContain("Users");
  });

  it("never returns a stack trace", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.crash", args: {} }),
      UI_CALLER,
    );
    expect(JSON.stringify(result)).not.toMatch(/\bat \w+ \(/);
  });
});

describe("cancellation", () => {
  it("returns a canceled receipt when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = gateway.invoke(
      envelope({ command: "kiwi.diagnostics.slow", args: { steps: 30, stepMs: 20 } }),
      UI_CALLER,
      { signal: controller.signal },
    );

    controller.abort();
    const result = await pending;

    expect(result.status).toBe("canceled");
    expect(result.error?.code).toBe("KIWI_CANCELED");
  });

  it("produces no late success after cancellation", async () => {
    const controller = new AbortController();
    const settled: CommandResult[] = [];
    const pending = gateway
      .invoke(
        envelope({ command: "kiwi.diagnostics.slow", args: { steps: 30, stepMs: 20 } }),
        UI_CALLER,
        { signal: controller.signal },
      )
      .then((result) => settled.push(result));

    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("canceled");
  });

  it("fails immediately when the signal is already aborted", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.slow", args: { steps: 5, stepMs: 10 } }),
      UI_CALLER,
      { signal: AbortSignal.abort() },
    );
    expect(result.status).toBe("canceled");
  });

  it("completes normally when nothing aborts", async () => {
    const result = await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.slow", args: { steps: 2, stepMs: 10 } }),
      UI_CALLER,
    );
    expect(result.status).toBe("committed");
    expect(result.data).toEqual({ completedSteps: 2 });
  });
});

describe("idempotency", () => {
  const key = uuid(9);

  it("applies a durable effect once for a repeated key", async () => {
    const input = envelope({
      command: "kiwi.diagnostics.count",
      args: { amount: 5 },
      idempotency_key: key,
    });

    const first = await gateway.invoke(input, UI_CALLER);
    const second = await gateway.invoke({ ...input, request_id: uuid(2) }, UI_CALLER);

    expect(counter.value).toBe(5);
    expect(first.data).toEqual({ total: 5 });
    expect(second.data).toEqual({ total: 5 });
  });

  it("marks the replayed result and echoes the new request id", async () => {
    const input = envelope({
      command: "kiwi.diagnostics.count",
      args: { amount: 2 },
      idempotency_key: key,
    });

    await gateway.invoke(input, UI_CALLER);
    const second = await gateway.invoke({ ...input, request_id: uuid(3) }, UI_CALLER);

    expect(second.replayed).toBe(true);
    expect(second.request_id).toBe(uuid(3));
    expect(events.at(-1)?.event).toBe("command.replayed");
  });

  it("rejects a reused key carrying different arguments", async () => {
    await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.count", args: { amount: 1 }, idempotency_key: key }),
      UI_CALLER,
    );
    const changed = await gateway.invoke(
      envelope({
        command: "kiwi.diagnostics.count",
        args: { amount: 7 },
        idempotency_key: key,
        request_id: uuid(4),
      }),
      UI_CALLER,
    );

    expect(changed.error?.code).toBe("KIWI_IDEMPOTENCY_MISMATCH");
    expect(counter.value).toBe(1);
  });

  it("applies the effect twice without a key", async () => {
    const input = envelope({ command: "kiwi.diagnostics.count", args: { amount: 3 } });
    await gateway.invoke(input, UI_CALLER);
    await gateway.invoke({ ...input, request_id: uuid(5) }, UI_CALLER);
    expect(counter.value).toBe(6);
  });

  it("does not store a receipt for a failed command", async () => {
    const failKey = uuid(11);
    await gateway.invoke(
      envelope({ command: "kiwi.diagnostics.fail", args: {}, idempotency_key: failKey }),
      UI_CALLER,
    );
    const retried = await gateway.invoke(
      envelope({
        command: "kiwi.diagnostics.fail",
        args: {},
        idempotency_key: failKey,
        request_id: uuid(6),
      }),
      UI_CALLER,
    );
    expect(retried.replayed).toBeUndefined();
  });
});

describe("observer isolation", () => {
  it("still returns a result when the observer throws", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("observer failure");
    });
    const noisy = createGateway({ registry, newCorrelationId: () => "corr-x", onEvent });

    const result = await noisy.invoke(envelope(), UI_CALLER);

    expect(result.status).toBe("committed");
    expect(onEvent).toHaveBeenCalled();
  });
});
