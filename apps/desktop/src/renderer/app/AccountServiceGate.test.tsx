import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountServiceGate } from "./AccountServiceGate.js";

afterEach(cleanup);

describe("AccountServiceGate", () => {
  it("shows a quiet ready state without exposing infrastructure details", () => {
    render(<AccountServiceGate status={{ status: "ready" }} retrying={false} onRetry={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Kiwi is ready" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    expect(screen.queryByText(/postgres|database|migration|127\.0\.0\.1/i)).not.toBeInTheDocument();
  });

  it("offers one keyboard-accessible retry when unavailable", async () => {
    const onRetry = vi.fn();
    render(
      <AccountServiceGate
        status={{ status: "unavailable", retryable: true }}
        retrying={false}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("prevents duplicate retries while a check is pending", () => {
    render(
      <AccountServiceGate
        status={{ status: "unavailable", retryable: true }}
        retrying
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Trying again..." })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking connection");
  });
});
