import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MentionPicker } from "./MentionPicker.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

interface Row {
  id: string;
  type: string;
  title: string;
  content?: string;
}

const PAPER: Row = {
  id: "paper-1",
  type: "source",
  title: "Computing Machinery and Intelligence",
  content: "I propose to consider the question",
};

const NOTE: Row = { id: "note-2", type: "note", title: "Reading group, week three" };

const CLAIM: Row = { id: "claim-3", type: "claim", title: "Imitation is not thought" };

function mount(rows: Row[] = [PAPER, NOTE, CLAIM], excludeId?: string) {
  const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as { command: string; args: Record<string, unknown> };
    sent.push(request);
    const text = String(request.args["text"] ?? "");
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed" as const,
      data: {
        objects: rows.filter(
          (row) => text === "" || row.title.toLocaleLowerCase().includes(text.toLocaleLowerCase()),
        ),
      },
    };
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  const onInsert = vi.fn();
  const onCancel = vi.fn();
  render(
    <MentionPicker
      workspaceId="workspace-1"
      {...(excludeId === undefined ? {} : { excludeId })}
      onInsert={onInsert}
      onCancel={onCancel}
    />,
  );
  return { sent, onInsert, onCancel };
}

describe("choosing what an @ points at", () => {
  it("offers papers, notes, manuscripts, and claims together", async () => {
    // One list, because the person typing is thinking of a thing rather than of which folder
    // it is filed in.
    const { sent } = mount();
    expect(await screen.findByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Reading group, week three")).toBeInTheDocument();
    expect(screen.getByText("Imitation is not thought")).toBeInTheDocument();
    expect(sent[0]?.args["object_types"]).toEqual(["source", "note", "output", "claim"]);
  });

  it("says what kind of thing each one is", async () => {
    mount();
    expect(await screen.findByText(/^Paper ·/u)).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Claim")).toBeInTheDocument();
  });

  it("asks the workspace again as the query is typed", async () => {
    // Filtered where the index is rather than in the browser: a workspace does not fit in a
    // list, and a list that had been cut off at a page would report the rest as missing.
    const { sent } = mount();
    await screen.findByText("Reading group, week three");
    await userEvent.type(screen.getByRole("searchbox"), "imitation");
    await waitFor(() => {
      expect(screen.queryByText("Reading group, week three")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Imitation is not thought")).toBeInTheDocument();
    expect(sent.at(-1)?.args["text"]).toBe("imitation");
  });

  it("never leaves a document pointing at itself", async () => {
    mount([PAPER, NOTE], "note-2");
    expect(await screen.findByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.queryByText("Reading group, week three")).not.toBeInTheDocument();
  });

  it("hands back what was chosen", async () => {
    const { onInsert } = mount();
    await userEvent.click(await screen.findByText("Reading group, week three"));
    expect(onInsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-2", type: "note", title: "Reading group, week three" }),
    );
  });

  it("closes on Escape without choosing anything", async () => {
    const { onInsert, onCancel } = mount();
    await screen.findByText("Reading group, week three");
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("says so plainly when there is nothing to link to", async () => {
    mount([]);
    expect(await screen.findByText(/nothing to link to yet/u)).toBeInTheDocument();
  });

  it("never names a path", async () => {
    const { sent } = mount();
    await screen.findByText("Reading group, week three");
    for (const entry of sent) expect(entry.args).not.toHaveProperty("root");
  });
});
