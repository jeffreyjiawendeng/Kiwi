import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UndoBar } from "./UndoBar.js";
import { readBridge, type RendererBridge, type RendererCommandResult } from "./bridge.js";
import { forgetUndo, lastUndo } from "./undo-stack.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "r", status: "committed", data };
}

function failed(): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "r",
    status: "failed",
    error: {
      code: "KIWI_CONFLICT_VERSION",
      message: "It changed since.",
      details: {},
      retryable: false,
      recovery_actions: [],
      correlation_id: "corr",
    },
  };
}

function installBridge(undoResult: RendererCommandResult = ok({})) {
  const invokeCommand = vi.fn(async (raw: unknown) => {
    const command = (raw as { command: string }).command;
    if (command === "kiwi.object.trash")
      return ok({
        entry: { object_id: "object-1" },
        undo: { command: "kiwi.object.restore-from-trash", args: { object_id: "object-1" } },
      });
    return undoResult;
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return invokeCommand;
}

/** Does something undoable the way any page would: through the bridge. */
async function trashSomething(): Promise<void> {
  await readBridge()?.invokeCommand({
    protocol_version: "1.0.0",
    request_id: "r",
    workspace_id: WORKSPACE_ID,
    command: "kiwi.object.trash",
    args: { object_id: "object-1" },
  });
}

afterEach(() => {
  cleanup();
  forgetUndo();
  delete window.kiwiDesktop;
});

describe("taking back the last thing that happened", () => {
  it("shows nothing until something undoable happens", () => {
    installBridge();
    render(<UndoBar workspaceId={WORKSPACE_ID} />);

    expect(screen.queryByRole("status", { name: "Undo" })).toBeNull();
  });

  it("notices an undo on any command, without the page having to say so", async () => {
    // The receipt already carried it. Every call goes through the bridge, which is why nothing
    // at the call site had to change.
    installBridge();
    render(<UndoBar workspaceId={WORKSPACE_ID} />);

    await trashSomething();

    expect(
      await screen.findByRole("button", { name: "Undo moving that to the Trash" }),
    ).toBeInTheDocument();
  });

  it("runs the command that reverses it", async () => {
    const invokeCommand = installBridge();
    render(<UndoBar workspaceId={WORKSPACE_ID} />);
    await trashSomething();

    await userEvent.click(
      await screen.findByRole("button", { name: "Undo moving that to the Trash" }),
    );

    await waitFor(() => {
      const sent = invokeCommand.mock.calls
        .map(([raw]) => raw as { command: string; args: Record<string, unknown> })
        .find((call) => call.command === "kiwi.object.restore-from-trash");
      expect(sent?.args).toEqual({ object_id: "object-1" });
    });
    expect(lastUndo()).toBeNull();
  });

  it("says so when the undo could not be run rather than swallowing it", async () => {
    installBridge(failed());
    render(<UndoBar workspaceId={WORKSPACE_ID} />);
    await trashSomething();

    await userEvent.click(
      await screen.findByRole("button", { name: "Undo moving that to the Trash" }),
    );

    expect(await screen.findByText(/could not be undone/u)).toBeInTheDocument();
  });

  it("can be dismissed by somebody who meant to do it", async () => {
    installBridge();
    render(<UndoBar workspaceId={WORKSPACE_ID} />);
    await trashSomething();

    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("button", { name: /^Undo/u })).toBeNull();
  });

  it("goes away on its own, because a bar that stays stops being read", async () => {
    installBridge();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<UndoBar workspaceId={WORKSPACE_ID} />);
      await trashSomething();
      await screen.findByRole("button", { name: "Undo moving that to the Trash" });

      await vi.advanceTimersByTimeAsync(21_000);

      await waitFor(() => expect(screen.queryByRole("button", { name: /^Undo/u })).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
