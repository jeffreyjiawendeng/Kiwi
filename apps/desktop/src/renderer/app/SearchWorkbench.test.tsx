import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchWorkbench } from "./SearchWorkbench.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("local search workbench", () => {
  it("shows deterministic indexed results and their matched fields", async () => {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {
        generation: 3,
        results: [
          {
            id: "object-1",
            type: "inbox_item",
            title: "Measurement uncertainty",
            content: "A calibration result.",
            matched_fields: ["title", "body"],
            generation: 3,
          },
        ],
      },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<SearchWorkbench workspaceId="workspace-1" />);

    await userEvent.type(screen.getByRole("searchbox"), "measurement calibration");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Measurement uncertainty")).toBeInTheDocument();
    expect(screen.getByText(/matched title and body/)).toBeInTheDocument();
    expect(screen.getByText("Index generation 3")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.search.local",
        args: { query: "measurement calibration" },
      }),
    );
  });

  it("distinguishes no local results from an empty workspace", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 1, results: [] },
      })),
    } as unknown as RendererBridge;
    render(<SearchWorkbench workspaceId="workspace-1" />);
    await userEvent.type(screen.getByRole("searchbox"), "absent term");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("No local results. Try a different word.")).toBeInTheDocument();
  });
});
