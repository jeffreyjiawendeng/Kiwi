import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

function Explodes(): React.JSX.Element {
  throw new Error("component failure with C:\\Users\\ana\\private.md inside");
}

afterEach(cleanup);

describe("ErrorBoundary", () => {
  it("renders children when nothing fails", () => {
    render(
      <ErrorBoundary>
        <p>content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("shows the diagnostic screen instead of an empty window", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Explodes />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(within(controls).getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("does not leak the thrown message into the rendered output", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <ErrorBoundary>
        <Explodes />
      </ErrorBoundary>,
    );
    expect(container.textContent).not.toContain("private.md");
    expect(container.textContent).not.toContain("component failure");
  });
});
