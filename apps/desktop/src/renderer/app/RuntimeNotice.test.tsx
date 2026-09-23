import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RuntimeNotice } from "./RuntimeNotice.js";
import type { RendererBridge, RendererRuntimeHealth } from "./bridge.js";

function installHealth(health: Partial<RendererRuntimeHealth>): void {
  window.kiwiDesktop = {
    getRuntimeHealth: vi.fn(async () => ({
      worker: "running",
      workerRestarts: 0,
      commandsInFlight: 0,
      rendererFailure: null,
      ...health,
    })),
  } as unknown as RendererBridge;
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("RuntimeNotice", () => {
  it("shows nothing when everything is healthy", async () => {
    installHealth({});
    render(<RuntimeNotice pollMs={10_000} />);
    await waitFor(() => expect(window.kiwiDesktop?.getRuntimeHealth).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a renderer reload without taking focus", async () => {
    installHealth({
      rendererFailure: {
        reason: "crashed",
        exitCode: 1,
        recoverable: true,
        occurredAt: "2026-08-22T00:00:00.000Z",
      },
    });
    render(<RuntimeNotice pollMs={10_000} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("stopped responding and reloaded");
    expect(document.activeElement).toBe(document.body);
  });

  it("reports a worker that was given up on", async () => {
    installHealth({ worker: "failed", workerRestarts: 4 });
    render(<RuntimeNotice pollMs={10_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("background worker stopped");
  });

  it("reports recovered worker restarts", async () => {
    installHealth({ worker: "running", workerRestarts: 1 });
    render(<RuntimeNotice pollMs={10_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("restarted 1 time");
  });

  it("can be dismissed", async () => {
    installHealth({ worker: "failed", workerRestarts: 4 });
    render(<RuntimeNotice pollMs={10_000} />);

    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays silent when health polling fails", async () => {
    window.kiwiDesktop = {
      getRuntimeHealth: vi.fn(async () => {
        throw new Error("channel closed");
      }),
    } as unknown as RendererBridge;

    render(<RuntimeNotice pollMs={10_000} />);
    await waitFor(() => expect(window.kiwiDesktop?.getRuntimeHealth).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
