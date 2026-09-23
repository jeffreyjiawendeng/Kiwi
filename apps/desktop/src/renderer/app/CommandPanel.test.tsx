import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPanel } from "./CommandPanel.js";
import { CommandMenu } from "./CommandSurfaces.js";
import { UI_COMMANDS, type UiCommand, type UiContext } from "./commands.js";
import { useCommandRunner } from "./useCommandRunner.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

/** Keeps one runner shared by every command surface while they are tested in isolation. */
function Harness({ bridgeReady = true }: { bridgeReady?: boolean }): React.JSX.Element {
  const runner = useCommandRunner();
  const context: UiContext = { bridgeReady, busy: runner.state.status === "running" };
  const onRun = (command: UiCommand): void => void runner.run(command);

  return (
    <>
      <CommandMenu context={context} onRun={onRun} />
      <CommandPanel context={context} runner={runner} onRun={onRun} />
    </>
  );
}

function installBridge(overrides: Partial<RendererBridge> = {}): RendererBridge {
  const bridge = {
    version: "1.0.0",
    getCapabilities: vi.fn(),
    getStartupStatus: vi.fn(),
    getAbout: vi.fn(),
    listCommands: vi.fn(async () => UI_COMMANDS.map((c) => c.command ?? "")),
    invokeCommand: vi.fn(async (envelope: unknown): Promise<RendererCommandResult> => ({
      protocol_version: "1.0.0",
      request_id: (envelope as { request_id: string }).request_id,
      status: "committed",
      data: { echoed: "hello from Kiwi", length: 15 },
    })),
    cancelCommand: vi.fn(async () => true),
    getRuntimeHealth: vi.fn(async () => ({
      worker: "running",
      workerRestarts: 0,
      commandsInFlight: 0,
      rendererFailure: null,
    })),
    performWindowAction: vi.fn(),
    performRecoveryAction: vi.fn(),
    ...overrides,
  } as unknown as RendererBridge;
  window.kiwiDesktop = bridge;
  return bridge;
}

function actionButton(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Command actions" })).getByRole("button", {
    name,
  });
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("receipt", () => {
  it("shows a committed receipt carrying the request id", async () => {
    installBridge();
    render(<Harness />);

    await userEvent.click(actionButton("Run echo command"));

    await waitFor(() => expect(screen.getByText("committed")).toBeInTheDocument());
    expect(screen.getByText("hello from Kiwi")).toBeInTheDocument();
  });

  it("starts from an explicit empty state", () => {
    installBridge();
    render(<Harness />);
    expect(screen.getByText("No command has run yet.")).toBeInTheDocument();
  });

  it("sends a well formed envelope", async () => {
    const bridge = installBridge();
    render(<Harness />);

    await userEvent.click(actionButton("Run echo command"));

    await waitFor(() => expect(bridge.invokeCommand).toHaveBeenCalled());
    const [envelope] = (bridge.invokeCommand as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [Record<string, unknown>];

    expect(envelope["protocol_version"]).toBe("1.0.0");
    expect(envelope["command"]).toBe("kiwi.diagnostics.echo");
    expect(envelope["request_id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope["args"]).toEqual({ message: "hello from Kiwi" });
  });

  it("marks a replayed delivery", async () => {
    installBridge({
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: "r-1",
        status: "committed",
        data: { total: 5 },
        replayed: true,
      })),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Add 5 to the counter"));
    await waitFor(() =>
      expect(screen.getByText("Replayed from an earlier receipt")).toBeInTheDocument(),
    );
  });
});

describe("errors", () => {
  it("shows the field problems and the reference without a stack trace", async () => {
    installBridge({
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: "r-2",
        status: "failed",
        error: {
          code: "KIWI_INVALID_ARGUMENTS",
          message: "One or more values are not valid for this command.",
          details: {
            problem_count: 2,
            problem_0: "/message must NOT have fewer than 1 characters (minLength)",
            problem_1: "/repeat must be <= 10 (maximum)",
          },
          retryable: false,
          recovery_actions: ["correct_input"],
          correlation_id: "corr-77",
        },
      })),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Send invalid input"));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/not valid for this command/)).toBeInTheDocument();
    expect(within(alert).getByText(/minLength/)).toBeInTheDocument();
    expect(within(alert).getByText("corr-77")).toBeInTheDocument();
    expect(alert.textContent).not.toMatch(/\bat \w+ \(/);
  });

  it("recovers to the empty state when dismissed", async () => {
    installBridge({
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: "r-3",
        status: "failed",
        error: {
          code: "KIWI_INTERNAL_REDACTED",
          message: "The command failed.",
          details: {},
          retryable: true,
          recovery_actions: ["retry"],
          correlation_id: "corr-9",
        },
      })),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Trigger an unplanned failure"));
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(screen.getByText("No command has run yet.")).toBeInTheDocument();
  });

  it("reports a bridge rejection rather than hanging", async () => {
    installBridge({
      invokeCommand: vi.fn(async () => {
        throw new Error("channel closed");
      }),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Run echo command"));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not reach the command");
  });
});

describe("cancellation", () => {
  it("offers Cancel while running and sends the request id", async () => {
    let release: (value: RendererCommandResult) => void = () => undefined;
    const bridge = installBridge({
      invokeCommand: vi.fn(
        () =>
          new Promise<RendererCommandResult>((resolve) => {
            release = resolve;
          }),
      ),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Run cancellable operation"));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await userEvent.click(cancel);

    expect(bridge.cancelCommand).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/));

    release({
      protocol_version: "1.0.0",
      request_id: "r-4",
      status: "canceled",
      error: {
        code: "KIWI_CANCELED",
        message: "The operation was canceled.",
        details: {},
        retryable: true,
        recovery_actions: ["retry"],
        correlation_id: "corr-4",
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("was canceled");
  });

  it("disables other commands while one is running", async () => {
    installBridge({
      invokeCommand: vi.fn(() => new Promise<RendererCommandResult>(() => undefined)),
    });
    render(<Harness />);

    await userEvent.click(actionButton("Run cancellable operation"));

    await waitFor(() => expect(actionButton("Run echo command")).toBeDisabled());
  });
});

describe("surface consistency", () => {
  it("offers every command in the button group, the menu, and the command center", async () => {
    installBridge();
    render(<Harness />);

    const group = screen.getByRole("group", { name: "Command actions" });
    await userEvent.click(screen.getByRole("button", { name: "Commands" }));
    const menu = screen.getByRole("menu", { name: "Commands" });
    const center = screen.getByRole("list", { name: "Matching commands" });

    for (const command of UI_COMMANDS) {
      expect(within(group).getByRole("button", { name: command.title })).toBeInTheDocument();
      expect(
        within(menu).getByRole("menuitem", { name: new RegExp(command.title) }),
      ).toBeInTheDocument();
      expect(within(center).getByRole("button", { name: command.title })).toBeInTheDocument();
    }
  });

  it("invokes the identical command from all three surfaces", async () => {
    const bridge = installBridge();
    render(<Harness />);

    const group = screen.getByRole("group", { name: "Command actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Run echo command" }));
    await screen.findByText("committed");

    await userEvent.click(screen.getByRole("button", { name: "Commands" }));
    const menu = screen.getByRole("menu", { name: "Commands" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Run echo command/ }));
    await screen.findByText("committed");

    const center = screen.getByRole("list", { name: "Matching commands" });
    await userEvent.click(within(center).getByRole("button", { name: "Run echo command" }));
    await screen.findByText("committed");

    const calls = (
      bridge.invokeCommand as unknown as { mock: { calls: [Record<string, unknown>][] } }
    ).mock.calls;
    expect(calls).toHaveLength(3);

    const shapes = calls.map(([envelope]) => ({
      command: envelope["command"],
      args: envelope["args"],
    }));
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
  });

  it("gives the same disabled reason on every surface", async () => {
    installBridge();
    render(<Harness bridgeReady={false} />);

    const group = screen.getByRole("group", { name: "Command actions" });
    expect(within(group).getByRole("button", { name: "Run echo command" })).toBeDisabled();

    const center = screen.getByRole("list", { name: "Matching commands" });
    expect(within(center).getByRole("button", { name: "Run echo command" })).toBeDisabled();
    expect(
      within(center).getAllByText("The desktop bridge is unavailable.").length,
    ).toBeGreaterThan(0);
  });

  it("filters the command center", async () => {
    installBridge();
    render(<Harness />);

    await userEvent.type(screen.getByRole("searchbox", { name: "Command center" }), "cancellable");

    const center = screen.getByRole("list", { name: "Matching commands" });
    expect(within(center).getAllByRole("button")).toHaveLength(1);
    expect(
      within(center).getByRole("button", { name: "Run cancellable operation" }),
    ).toBeInTheDocument();
  });

  it("reports when nothing matches", async () => {
    installBridge();
    render(<Harness />);

    await userEvent.type(screen.getByRole("searchbox", { name: "Command center" }), "zzzz");
    expect(screen.getByText("No command matches.")).toBeInTheDocument();
  });
});
