import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RendererBridge, RendererWorkspaceSyncStatusResult } from "./bridge.js";
import { SYNC_STATUS_INTERVAL_MS, useSyncStatus } from "./useSyncStatus.js";

function answer(
  over: Partial<Extract<RendererWorkspaceSyncStatusResult, { status: "known" }>> = {},
): RendererWorkspaceSyncStatusResult {
  return {
    status: "known",
    connection: "online",
    working_offline: false,
    pending: { registrations: 0, structured_changes: 0, document_operations: 0, total: 0 },
    conflicts: 0,
    last_succeeded_at: new Date().toISOString(),
    last_failure: null,
    ...over,
  };
}

function installBridge(reply: () => Promise<RendererWorkspaceSyncStatusResult>) {
  const readWorkspaceSyncStatus = vi.fn(reply);
  window.kiwiDesktop = { readWorkspaceSyncStatus } as unknown as RendererBridge;
  return readWorkspaceSyncStatus;
}

function focus(state: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(state);
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SYNC_STATUS_INTERVAL_MS);
  });
  await settle();
}

function watch(workspaceId: string | null = "workspace-1") {
  return renderHook((id: string | null) => useSyncStatus(id), { initialProps: workspaceId });
}

// jsdom has no window manager, so nothing is focused unless it is said to be.
beforeEach(() => {
  focus(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.kiwiDesktop;
});

describe("asking what is still waiting to be sent", () => {
  it("asks straight away rather than after the first tick", async () => {
    const asked = installBridge(async () => answer());
    const { result } = watch();

    await waitFor(() => expect(result.current?.state).toBe("synchronized"));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("keeps asking", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => answer());
    watch();
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);

    await tick();

    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("says nothing until an answer arrives", () => {
    installBridge(async () => answer());

    expect(watch().result.current).toBeNull();
  });

  it("does not ask when this window has no workspace open", async () => {
    const asked = installBridge(async () => answer());

    watch(null);
    await settle();

    expect(asked).not.toHaveBeenCalled();
  });

  it("stops asking when the window is not being looked at", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => answer());
    watch();
    await settle();

    focus(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await tick();

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks again on the way back rather than waiting out the tick", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => answer());
    watch();
    await settle();
    focus(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    focus(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await settle();

    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the answer cannot be given", async () => {
    installBridge(async () => ({ status: "unknown" }) as RendererWorkspaceSyncStatusResult);
    const { result } = watch();

    await settle();

    expect(result.current).toBeNull();
  });

  it("says nothing when the request itself fails", async () => {
    installBridge(async () => {
      throw new Error("the bridge is gone");
    });
    const { result } = watch();

    await settle();

    expect(result.current).toBeNull();
  });

  it("does not report one workspace's answer against the next", async () => {
    // Switching workspaces is a render and clearing the answer is an effect, so without this the
    // new workspace shows the old one's queues for a flush.
    installBridge(async () =>
      answer({
        pending: {
          registrations: 0,
          structured_changes: 5,
          document_operations: 0,
          total: 5,
        },
      }),
    );
    const { result, rerender } = watch();
    await waitFor(() => expect(result.current?.state).toBe("syncing"));

    rerender("workspace-2");

    expect(result.current).toBeNull();
  });
});
