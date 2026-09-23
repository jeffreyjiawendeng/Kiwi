import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryPage } from "./HistoryPage.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "r", status: "committed", data };
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    event_type: "object.saved",
    occurred_at: new Date().toISOString(),
    actor: "account:ana",
    transaction_id: "transaction-1",
    object_ids: ["object-1"],
    object_type: "note",
    version: 3,
    reason: null,
    ...over,
  };
}

function installBridge(log: Record<string, unknown>) {
  const invokeCommand = vi.fn(async (raw: unknown) => {
    const envelope = raw as { command: string; args: Record<string, unknown> };
    if (envelope.command === "kiwi.projection.list")
      return ok({
        objects: [
          { id: "object-1", title: "Interview notes" },
          { id: "object-2", title: "Field report" },
        ],
      });
    if (envelope.command === "kiwi.event.list") return ok(log);
    return ok({});
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return invokeCommand;
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("the History page", () => {
  it("reads the log into rows that name who did what to what", async () => {
    installBridge({
      entries: [event()],
      matched: 1,
      actors: ["account:ana"],
      event_types: ["object.saved"],
    });
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    const today = await screen.findByRole("region", { name: "Today" });
    expect(within(today).getByText("object saved")).toBeInTheDocument();
    expect(within(today).getByText("ana")).toBeInTheDocument();
    expect(within(today).getByText("Interview notes")).toBeInTheDocument();
  });

  it("offers the people and the actions that are in the log, not a list from the code", async () => {
    installBridge({
      entries: [event()],
      matched: 1,
      actors: ["account:ana", "account:ben"],
      event_types: ["object.created", "object.saved"],
    });
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    const member = await screen.findByRole("combobox", { name: "Member" });
    expect(
      within(member)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Anybody", "ana", "ben"]);
    const action = screen.getByRole("combobox", { name: "Action" });
    expect(
      within(action)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Anything", "object created", "object saved"]);
  });

  it("asks the log again when a filter is chosen", async () => {
    const invokeCommand = installBridge({
      entries: [event()],
      matched: 1,
      actors: ["account:ana"],
      event_types: ["object.saved"],
    });
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Member" }),
      "account:ana",
    );

    await waitFor(() => {
      const call = invokeCommand.mock.calls
        .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
        .filter((envelope) => envelope.command === "kiwi.event.list")
        .at(-1);
      expect(call?.args["actor"]).toBe("account:ana");
    });
  });

  it("says how much of the log is on the page when it had to cut it", async () => {
    installBridge({ entries: [event()], matched: 4318, actors: [], event_types: [] });
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("Showing the most recent 1 of 4318.")).toBeInTheDocument();
  });

  it("opens the object a row was about rather than restoring from here", async () => {
    installBridge({
      entries: [event()],
      matched: 1,
      actors: ["account:ana"],
      event_types: ["object.saved"],
    });
    const onOpenObject = vi.fn();
    render(<HistoryPage workspaceId={WORKSPACE_ID} onOpenObject={onOpenObject} />);

    await userEvent.click(await screen.findByRole("button", { name: "Interview notes" }));

    // Restoring belongs to the dock, where the comparison and the impact already are.
    expect(onOpenObject).toHaveBeenCalledWith("object-1", "");
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("says nothing matches rather than showing an empty page", async () => {
    installBridge({
      entries: [],
      matched: 0,
      actors: ["account:ana"],
      event_types: ["object.saved"],
    });
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Member" }),
      "account:ana",
    );

    expect(await screen.findByText("Nothing matches those filters.")).toBeInTheDocument();
  });
});

describe("names and titles on the History page", () => {
  it("names people the way the roster does, and by id when it does not know them", async () => {
    installBridge({
      entries: [event()],
      matched: 1,
      actors: ["account:ana", "account:ben"],
      event_types: ["object.saved"],
    });
    render(<HistoryPage workspaceId={WORKSPACE_ID} people={new Map([["ana", "Ana Lindqvist"]])} />);

    const today = await screen.findByRole("region", { name: "Today" });
    expect(within(today).getByText("Ana Lindqvist")).toBeInTheDocument();
    const member = screen.getByRole("combobox", { name: "Member" });
    expect(within(member).getByRole("option", { name: "Ana Lindqvist" })).toBeInTheDocument();
    expect(within(member).getByRole("option", { name: "ben" })).toBeInTheDocument();
  });

  it("reads titles a page at a time rather than asking for more than one page holds", async () => {
    // Five hundred in one request was refused, and the refusal was read as "no titles": every
    // row said something was no longer here while everything was.
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as {
        command: string;
        args: { page?: { offset: number; limit: number } };
      };
      if (envelope.command === "kiwi.projection.list") {
        const offset = envelope.args.page?.offset ?? 0;
        const limit = envelope.args.page?.limit ?? 0;
        const objects = Array.from(
          { length: Math.max(0, Math.min(limit, 250 - offset)) },
          (_, index) => ({
            id: `object-${String(offset + index)}`,
            title: `Paper ${String(offset + index)}`,
          }),
        );
        return ok({ objects, total: 250 });
      }
      if (envelope.command === "kiwi.event.list")
        return ok({
          entries: [event({ object_ids: ["object-249"] })],
          matched: 1,
          actors: [],
          event_types: [],
        });
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<HistoryPage workspaceId={WORKSPACE_ID} />);

    const today = await screen.findByRole("region", { name: "Today" });
    expect(within(today).getByText("Paper 249")).toBeInTheDocument();
    const pages = invokeCommand.mock.calls
      .map(
        ([raw]) => raw as { command: string; args: { page?: { offset: number; limit: number } } },
      )
      .filter((envelope) => envelope.command === "kiwi.projection.list")
      .map((envelope) => envelope.args.page);
    expect(pages).toEqual([
      { offset: 0, limit: 200 },
      { offset: 200, limit: 200 },
    ]);
  });
});
