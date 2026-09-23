import { useCallback, useRef, useState } from "react";
import { readBridge, type RendererCommandResult, type RendererError } from "./bridge.js";
import type { UiCommand } from "./commands.js";

export type RunState =
  | { status: "idle" }
  | { status: "running"; commandId: string; requestId: string }
  | { status: "done"; commandId: string; result: RendererCommandResult }
  | { status: "error"; commandId: string; error: RendererError };

export interface CommandRunner {
  state: RunState;
  run(command: UiCommand): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

const PROTOCOL_VERSION = "1.0.0";

function newRequestId(): string {
  return crypto.randomUUID();
}

export function useCommandRunner(): CommandRunner {
  const [state, setState] = useState<RunState>({ status: "idle" });
  const running = useRef<string | null>(null);

  const run = useCallback(async (command: UiCommand): Promise<void> => {
    const bridge = readBridge();
    if (bridge === null || command.command === null) return;

    const requestId = newRequestId();
    running.current = requestId;
    setState({ status: "running", commandId: command.id, requestId });

    let result: RendererCommandResult;
    try {
      result = await bridge.invokeCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        command: command.command,
        args: command.args,
      });
    } catch {
      running.current = null;
      setState({
        status: "error",
        commandId: command.id,
        error: {
          code: "KIWI_UNAVAILABLE",
          message: "Kiwi could not reach the command service.",
          details: {},
          retryable: true,
          recovery_actions: ["retry", "open_logs"],
          correlation_id: requestId,
        },
      });
      return;
    }

    running.current = null;
    if (result.error !== undefined) {
      setState({ status: "error", commandId: command.id, error: result.error });
      return;
    }
    setState({ status: "done", commandId: command.id, result });
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const requestId = running.current;
    if (requestId === null) return;
    await readBridge()?.cancelCommand(requestId);
  }, []);

  const reset = useCallback((): void => {
    setState({ status: "idle" });
  }, []);

  return { state, run, cancel, reset };
}
