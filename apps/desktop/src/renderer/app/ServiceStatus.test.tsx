import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceStatus } from "./ServiceStatus.js";
import type { RendererBridge } from "./bridge.js";
import type { SyncStanding } from "./sync-status.js";

function standing(): SyncStanding {
  return {
    state: "synchronized",
    label: "Synchronized",
    summary: "Everything written here has reached everybody else in this workspace.",
    pending: [],
    lastSuccess: "Last synchronized 2 minutes ago.",
    failure: null,
  };
}

function installBridge(over: { offline?: boolean } = {}) {
  let offline = over.offline ?? false;
  const setOfflineMode = vi.fn(async (input: { offline: boolean }) => {
    offline = input.offline;
    return offline;
  });
  const readOfflineMode = vi.fn(async () => offline);
  const getAccountServiceStatus = vi.fn(async () => ({ status: "ready" as const }));
  const getRuntimeHealth = vi.fn(async () => ({
    worker: "running",
    workerRestarts: 0,
    commandsInFlight: 0,
    rendererFailure: null,
  }));
  window.kiwiDesktop = {
    readOfflineMode,
    setOfflineMode,
    getAccountServiceStatus,
    getRuntimeHealth,
  } as unknown as RendererBridge;
  return { readOfflineMode, setOfflineMode, getAccountServiceStatus };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("the service status on Home", () => {
  it("says how each part is doing rather than waiting for one to break", async () => {
    installBridge();
    render(<ServiceStatus sharing={standing()} />);

    const panel = await screen.findByRole("region", { name: "Service status" });
    await waitFor(() => expect(within(panel).getByText("Reachable.")).toBeInTheDocument());
    expect(within(panel).getByText("Running.")).toBeInTheDocument();
    expect(within(panel).getByText(/reached everybody else in this workspace/)).toBeInTheDocument();
  });

  it("turns off contacting the service when asked to work offline", async () => {
    const { setOfflineMode } = installBridge();
    render(<ServiceStatus sharing={standing()} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Work offline" }));

    expect(setOfflineMode).toHaveBeenCalledWith({ offline: true });
    await waitFor(() =>
      expect(screen.getByText(/goes out when you turn this off/)).toBeInTheDocument(),
    );
  });

  it("comes up already offline when a previous run chose that", async () => {
    installBridge({ offline: true });
    render(<ServiceStatus sharing={standing()} />);

    const box = await screen.findByRole("checkbox", { name: "Work offline" });
    await waitFor(() => expect(box).toBeChecked());
    expect(
      screen.getByText("Not being contacted, because Kiwi is set to work offline."),
    ).toBeInTheDocument();
  });

  it("keeps looking, because nothing here pushes", async () => {
    const { getAccountServiceStatus } = installBridge();
    vi.useFakeTimers();
    try {
      render(<ServiceStatus sharing={null} pollMs={1000} />);
      await vi.advanceTimersByTimeAsync(2500);
      expect(getAccountServiceStatus.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
