import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiagnosticScreen } from "./DiagnosticScreen.js";
import type { RendererError } from "./bridge.js";

const failure: RendererError = {
  code: "KIWI_STARTUP_FAILED",
  message: "Kiwi started but could not finish preparing this session.",
  details: {},
  retryable: true,
  recovery_actions: ["retry", "open_logs", "quit"],
  correlation_id: "0198c810-31fd-76db-b8a7-b26bea93e50c",
};

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("DiagnosticScreen", () => {
  it("announces itself to assistive technology", () => {
    render(<DiagnosticScreen error={failure} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("could not start");
  });

  it("shows the correlation reference the log records use", () => {
    render(<DiagnosticScreen error={failure} />);
    expect(screen.getByText(failure.correlation_id)).toBeInTheDocument();
  });

  it("offers a labelled button for every recovery action", () => {
    render(<DiagnosticScreen error={failure} />);
    expect(screen.getByRole("button", { name: "Restart Kiwi" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open log folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("sends the chosen recovery action through the bridge", async () => {
    const performRecoveryAction = vi.fn(async () => undefined);
    window.kiwiDesktop = {
      version: "1.0.0",
      getCapabilities: vi.fn(),
      getStartupStatus: vi.fn(),
      performWindowAction: vi.fn(),
      performRecoveryAction,
    } as unknown as NonNullable<typeof window.kiwiDesktop>;

    render(<DiagnosticScreen error={failure} />);
    await userEvent.click(screen.getByRole("button", { name: "Open log folder" }));

    expect(performRecoveryAction).toHaveBeenCalledWith("open_logs");
  });

  it("never renders a stack trace", () => {
    const { container } = render(<DiagnosticScreen error={failure} />);
    expect(container.textContent).not.toMatch(/\bat \w+ \(/);
    expect(container.textContent).not.toContain(".ts:");
  });
});
