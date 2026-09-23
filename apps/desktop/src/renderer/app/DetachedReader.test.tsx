import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DetachedReader } from "./DetachedReader.js";
import type { RendererBridge } from "./bridge.js";
import type {
  PdfDocument,
  PdfLoader,
  PdfOutlineEntry,
  PdfPage,
  PdfTextItem,
} from "./pdf-document.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.kiwiDesktop;
});

function stubDocument(): PdfDocument {
  const page: PdfPage = {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async (): Promise<PdfTextItem[]> => []),
  };
  return {
    pageCount: 2,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => page),
    outline: vi.fn(async (): Promise<PdfOutlineEntry[]> => []),
    metadata: vi.fn(async () => ({})),
    destroy: vi.fn(),
  };
}

interface Recorded {
  command: string;
  args: Record<string, unknown>;
}

function stubBridge(options: { files?: unknown[]; error?: string; session?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as Recorded;
    recorded.push(request);
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
        files: options.files ?? [
          { id: "asset-1", title: "Method", original_filename: "method-2019.pdf" },
        ],
      },
    };
  });
  const getWorkspaceSession = vi.fn(async () =>
    options.session === false ? null : { summary: { workspaceId: "workspace-1", writable: true } },
  );
  window.kiwiDesktop = { invokeCommand, getWorkspaceSession } as unknown as RendererBridge;
  return { recorded };
}

function show(objectId = "paper-1", assetId = "asset-1"): { loader: ReturnType<typeof vi.fn> } {
  const loader = vi.fn<PdfLoader>(async () => stubDocument());
  render(<DetachedReader objectId={objectId} assetId={assetId} loader={loader} />);
  return { loader };
}

describe("a document in a Reader window of its own", () => {
  it("reads the file the window was given, by id and never by a path", async () => {
    const { recorded } = stubBridge();
    const { loader } = show();

    expect(await screen.findByLabelText("method-2019.pdf reader")).toBeInTheDocument();
    // The reader is drawn before it asks for the document, so under load the call can land a
    // moment after the label does.
    await waitFor(() => expect(loader).toHaveBeenCalledWith("kiwi-asset://workspace-1/asset-1"));
    // The window was opened on its parent's root, and the session is what turns an id into a
    // file. Nothing the renderer sends names a folder.
    const read = recorded.find((entry) => entry.command === "kiwi.object.files");
    expect(read?.args).toEqual({ object_id: "paper-1" });
  });

  it("does not offer to detach a window that is already one", async () => {
    stubBridge();
    show();

    await screen.findByLabelText("method-2019.pdf reader");
    expect(screen.queryByRole("button", { name: "Open in a new window" })).not.toBeInTheDocument();
  });

  it("names the file rather than the paper it belongs to", async () => {
    // The window title is what tells two windows on one paper apart.
    stubBridge({ files: [{ id: "asset-2", title: "Reply" }] });
    show("paper-1", "asset-2");

    expect(await screen.findByLabelText("Reply reader")).toBeInTheDocument();
  });

  it("puts the file's name in the window's title bar", async () => {
    // Three papers open beside a manuscript are three taskbar entries. Titled by the application
    // they are told apart by opening them one at a time.
    stubBridge();
    show();

    await screen.findByLabelText("method-2019.pdf reader");
    expect(window.document.title).toBe("method-2019.pdf - Kiwi");
  });

  it("says so when the file is no longer part of the paper", async () => {
    // Detached, then removed in the window it was detached from. A Reader over a blank page
    // would leave somebody wondering which of the two windows was wrong.
    stubBridge({ files: [{ id: "asset-9", title: "Something else" }] });
    show();

    expect(await screen.findByRole("alert")).toHaveTextContent("no longer part of this paper");
  });

  it("says a document could not be opened rather than showing an empty Reader", async () => {
    stubBridge({ error: "That object was not found." });
    show("gone");

    expect(await screen.findByRole("alert")).toHaveTextContent("That object was not found.");
  });

  it("says so when the window has no workspace open", async () => {
    stubBridge({ session: false });
    show();

    expect(await screen.findByRole("alert")).toHaveTextContent("no workspace open");
  });
});
