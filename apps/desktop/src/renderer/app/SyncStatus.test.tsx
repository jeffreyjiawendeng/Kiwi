import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SyncStatus } from "./SyncStatus.js";
import type { SyncStanding } from "./sync-status.js";

afterEach(cleanup);

function standing(over: Partial<SyncStanding> = {}): SyncStanding {
  return {
    state: "synchronized",
    label: "Synchronized",
    summary: "Everything written here has reached everybody else in this workspace.",
    pending: [],
    lastSuccess: "Last synchronized a moment ago.",
    failure: null,
    ...over,
  };
}

describe("the state in the top bar", () => {
  it("shows the word, not only the colour", () => {
    render(<SyncStatus standing={standing({ state: "offline", label: "Offline" })} />);

    expect(screen.getByRole("button", { name: /Offline/u })).toBeTruthy();
  });

  it("carries the state on the button, for the dot beside the word", () => {
    render(<SyncStatus standing={standing({ state: "conflicted", label: "Conflicts" })} />);

    expect(screen.getByRole("button").getAttribute("data-state")).toBe("conflicted");
  });

  it("draws nothing when there is no state of sharing to report", () => {
    const { container } = render(<SyncStatus standing={null} />);

    expect(container.textContent).toBe("");
  });
});

describe("the detail behind the click", () => {
  it("is closed until it is asked for", () => {
    render(<SyncStatus standing={standing()} />);

    expect(screen.queryByRole("region", { name: "Synchronization" })).toBeNull();
  });

  it("says what is pending, what failed, and when it last succeeded", () => {
    render(
      <SyncStatus
        standing={standing({
          state: "syncing",
          label: "Syncing",
          pending: [{ label: "Saved changes", count: 4 }],
          failure: "Last tried 5 minutes ago. Workspace synchronization is unavailable.",
          lastSuccess: "Last synchronized 20 minutes ago.",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    const detail = screen.getByRole("region", { name: "Synchronization" });
    expect(detail.textContent).toContain("Saved changes");
    expect(detail.textContent).toContain("4");
    expect(detail.textContent).toContain("Workspace synchronization is unavailable.");
    expect(detail.textContent).toContain("Last synchronized 20 minutes ago.");
  });

  it("still says when it last succeeded when there is nothing waiting", () => {
    // A status with no time on it passes for current, which is the thing this is here to stop.
    render(<SyncStatus standing={standing()} />);

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("region", { name: "Synchronization" }).textContent).toContain(
      "Last synchronized a moment ago.",
    );
  });

  it("closes on Escape", () => {
    render(<SyncStatus standing={standing()} />);
    fireEvent.click(screen.getByRole("button"));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("region", { name: "Synchronization" })).toBeNull();
  });

  it("closes when something outside it is pressed", () => {
    render(<SyncStatus standing={standing()} />);
    fireEvent.click(screen.getByRole("button"));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("region", { name: "Synchronization" })).toBeNull();
  });
});
