import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DetachedDocument } from "./DetachedDocument.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.kiwiDesktop;
});

interface Recorded {
  command: string;
  args: Record<string, unknown>;
}

function stubBridge(
  options: { object?: unknown; error?: string; session?: boolean; links?: unknown[] } = {},
) {
  const recorded: Recorded[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as Recorded;
    recorded.push(request);
    if (request.command === "kiwi.projection.links") {
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { links: options.links ?? [] },
      };
    }
    if (request.command === "kiwi.project.list") {
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { projects: [{ id: "project-1", settings: { citation_style: "ieee" } }] },
      };
    }
    if (options.error !== undefined) {
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "failed",
        error: { code: "KIWI_NOT_FOUND", message: options.error },
      };
    }
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {
        object: options.object ?? {
          id: "note-1",
          type: "note",
          title: "Method",
          version: 4,
          content_hash: `sha256:${"a".repeat(64)}`,
          document_mode: "rich",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Detached words" }] }],
          },
        },
      },
    };
  });
  const getWorkspaceSession = vi.fn(async () =>
    options.session === false ? null : { summary: { workspaceId: "workspace-1", writable: true } },
  );
  window.kiwiDesktop = { invokeCommand, getWorkspaceSession } as unknown as RendererBridge;
  return { recorded, invokeCommand };
}

describe("a document in a window of its own", () => {
  it("opens the object the window was given, in the same editor the workbench uses", async () => {
    const { recorded } = stubBridge();
    render(<DetachedDocument objectId="note-1" />);

    expect(await screen.findByText("Detached words")).toBeInTheDocument();
    const read = recorded.find((entry) => entry.command === "kiwi.object.read");
    // An id, never a folder. The window was opened on its parent's root, and the session is
    // what turns that id into a file.
    expect(read?.args).toEqual({ object_id: "note-1" });
  });

  it("does not offer to detach a window that is already one", async () => {
    stubBridge();
    render(<DetachedDocument objectId="note-1" />);

    await screen.findByText("Detached words");
    expect(screen.queryByRole("button", { name: "Open in a new window" })).not.toBeInTheDocument();
  });

  it("reads the project's citation style rather than assuming one", async () => {
    // Two windows on one manuscript that disagree about a citation are two windows disagreeing
    // about the paper.
    window.localStorage.setItem(
      "kiwi.project.selected",
      JSON.stringify({ workspaceId: "workspace-1", root: "C:\\Research", projectId: "project-1" }),
    );
    const { recorded } = stubBridge();
    render(<DetachedDocument objectId="note-1" />);

    await screen.findByText("Detached words");
    await vi.waitFor(() =>
      expect(recorded.some((entry) => entry.command === "kiwi.project.list")).toBe(true),
    );
  });

  it("puts the note's name in the window's title bar", async () => {
    // A note is detached in order to be put somewhere and come back to. Three windows all called
    // "Kiwi" are told apart by opening them one at a time.
    stubBridge();
    render(<DetachedDocument objectId="note-1" />);

    await screen.findByText("Detached words");
    expect(window.document.title).toBe("Method - Kiwi");
  });

  it("brings the note's links with it, because a note is mostly its links", async () => {
    stubBridge({
      links: [
        {
          relation_id: "relation-1",
          direction: "outgoing",
          relation_type: "quotes",
          object_id: "paper-1",
          object_type: "source",
          title: "Attention Is All You Need",
        },
      ],
    });
    render(<DetachedDocument objectId="note-1" />);

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
  });

  it("shows a link as a name, because this window has nowhere to put a second document", async () => {
    stubBridge({
      links: [
        {
          relation_id: "relation-1",
          direction: "incoming",
          relation_type: "mentions",
          object_id: "note-2",
          object_type: "note",
          title: "Reading order",
        },
      ],
    });
    render(<DetachedDocument objectId="note-1" />);

    await screen.findByText("Reading order");
    expect(screen.queryByRole("button", { name: /Reading order/u })).not.toBeInTheDocument();
  });

  it("says a document could not be opened rather than showing an empty editor", async () => {
    stubBridge({ error: "That object was not found." });
    render(<DetachedDocument objectId="gone" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("That object was not found.");
  });

  it("says so when the window has no workspace open", async () => {
    stubBridge({ session: false });
    render(<DetachedDocument objectId="note-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("no workspace open");
  });
});
