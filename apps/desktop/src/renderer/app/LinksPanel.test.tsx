import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LinksPanel } from "./LinksPanel.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

interface Row {
  relation_id: string;
  relation_type: string;
  direction: "incoming" | "outgoing";
  object_id: string;
  object_type: string;
  title: string;
  via?: { object_id: string; title: string };
}

const QUOTED_PAPER: Row = {
  relation_id: "relation-1",
  relation_type: "quotes",
  direction: "outgoing",
  object_id: "paper-1",
  object_type: "source",
  title: "Computing Machinery and Intelligence",
  via: { object_id: "annotation-1", title: "the imitation game" },
};

const QUOTING_NOTE: Row = {
  relation_id: "relation-2",
  relation_type: "quotes",
  direction: "incoming",
  object_id: "note-1",
  object_type: "note",
  title: "Reading group, week three",
  via: { object_id: "annotation-2", title: "machines can think" },
};

function mount(rows: Row[], options: { open?: boolean } = {}) {
  const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as { command: string; args: Record<string, unknown> };
    sent.push(request);
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed" as const,
      data: { links: rows },
    };
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  const onOpen = vi.fn();
  render(
    <LinksPanel
      workspaceId="workspace-1"
      objectId="note-1"
      {...(options.open === false ? {} : { onOpen })}
    />,
  );
  return { sent, onOpen };
}

describe("what a thing draws on and what draws on it", () => {
  it("puts the two directions under headings of their own", async () => {
    // Both, always. A panel that showed one would leave somebody wondering which they were
    // reading, and the answer to "what links here" is half of the answer to "what links".
    mount([QUOTED_PAPER, QUOTING_NOTE]);
    expect(await screen.findByText("Draws on")).toBeInTheDocument();
    expect(screen.getByText("Linked from")).toBeInTheDocument();
    expect(screen.getByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Reading group, week three")).toBeInTheDocument();
  });

  it("leaves out a heading with nothing under it", async () => {
    mount([QUOTED_PAPER]);
    expect(await screen.findByText("Draws on")).toBeInTheDocument();
    expect(screen.queryByText("Linked from")).not.toBeInTheDocument();
  });

  it("says what the thing is and how it is connected", async () => {
    mount([QUOTED_PAPER]);
    expect(await screen.findByText("Paper · quoted")).toBeInTheDocument();
  });

  it("counts several quotations of one paper as one line", async () => {
    // Three passages out of one paper is one thing the note draws on, said three ways.
    mount([
      QUOTED_PAPER,
      { ...QUOTED_PAPER, relation_id: "relation-3" },
      { ...QUOTED_PAPER, relation_id: "relation-4" },
    ]);
    expect(await screen.findByText("Paper · quoted, 3 times")).toBeInTheDocument();
    expect(screen.getAllByText("Computing Machinery and Intelligence")).toHaveLength(1);
  });

  it("keeps a quotation and a mention of the same paper apart", async () => {
    mount([
      QUOTED_PAPER,
      { ...QUOTED_PAPER, relation_id: "relation-5", relation_type: "mentions" },
    ]);
    expect(await screen.findByText("Paper · quoted")).toBeInTheDocument();
    expect(screen.getByText("Paper · mentioned")).toBeInTheDocument();
  });

  it("opens what a link points at", async () => {
    const { onOpen } = mount([QUOTED_PAPER]);
    await userEvent.click(await screen.findByText("Computing Machinery and Intelligence"));
    expect(onOpen).toHaveBeenCalledWith("paper-1", "source");
  });

  it("is a name rather than a link where there is nowhere to send anyone", async () => {
    mount([QUOTED_PAPER], { open: false });
    expect(await screen.findByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so plainly when nothing links to it", async () => {
    mount([]);
    expect(await screen.findByText("Nothing links to this yet.")).toBeInTheDocument();
  });

  it("asks the index rather than walking the workspace", async () => {
    const { sent } = mount([QUOTED_PAPER]);
    await screen.findByText("Computing Machinery and Intelligence");
    expect(sent[0]?.command).toBe("kiwi.projection.links");
    expect(sent[0]?.args).toEqual({ object_id: "note-1" });
  });

  it("never names a path", async () => {
    const { sent } = mount([QUOTED_PAPER]);
    await screen.findByText("Computing Machinery and Intelligence");
    for (const entry of sent) expect(entry.args).not.toHaveProperty("root");
  });
});
