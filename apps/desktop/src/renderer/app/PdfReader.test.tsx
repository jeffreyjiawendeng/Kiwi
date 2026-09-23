import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PdfReader } from "./PdfReader.js";
import { SelectionMenu } from "./ReaderAnnotations.js";
import type { PdfDocument, PdfOutlineEntry, PdfPage, PdfTextItem } from "./pdf-document.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.kiwiDesktop;
});

function stubPage(overrides: Partial<PdfPage> = {}): PdfPage {
  return {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async (): Promise<PdfTextItem[]> => []),
    ...overrides,
  };
}

function stubDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    pageCount: 3,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => stubPage()),
    outline: vi.fn(async (): Promise<PdfOutlineEntry[]> => []),
    metadata: vi.fn(async () => ({})),
    destroy: vi.fn(),
    ...overrides,
  };
}

function readerWith(document: PdfDocument) {
  const loader = vi.fn(async () => document);
  return { loader };
}

describe("pdf reader", () => {
  it("opens a document and reports how many pages it has", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    expect(await screen.findByText("of 3")).toBeInTheDocument();
    // The document is addressed by id over the asset scheme, never by a filesystem path.
    expect(loader).toHaveBeenCalledWith("kiwi-asset://workspace-1/asset-1");
  });

  it("draws each page rather than showing its text", async () => {
    const render1 = vi.fn(async () => undefined);
    const document = stubDocument({ page: vi.fn(async () => stubPage({ render: render1 })) });
    const { loader } = readerWith(document);
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    // The whole point of the Reader is the rendered page, figures included. If this ever
    // stops being called, the Reader has quietly become a text viewer.
    await waitFor(() => expect(render1).toHaveBeenCalled());
    const [canvas, scale] = render1.mock.calls[0] as unknown as [HTMLCanvasElement, number];
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(scale).toBeGreaterThan(0);
  });

  it("lays selectable text over the drawing", async () => {
    const document = stubDocument({
      pageCount: 1,
      page: vi.fn(async () =>
        stubPage({
          textItems: vi.fn(async () => [
            { text: "Attention Is All You Need", left: 72, top: 96, width: 300, height: 14 },
          ]),
        }),
      ),
    });
    const { loader } = readerWith(document);
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
  });

  it("moves between pages and keeps the reported page in step", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Page")).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("uses the label a document gives a page, not its index", async () => {
    // Front matter is numbered i, ii, iii. Reporting "page 1" for something printed "i" makes
    // a reference someone writes down wrong.
    const document = stubDocument({
      pageCount: 4,
      pageLabel: (pageNumber) => ["i", "ii", "1", "2"][pageNumber - 1] ?? String(pageNumber),
    });
    const { loader } = readerWith(document);
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 4");

    expect(screen.getByLabelText("Page")).toHaveValue("i");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Page")).toHaveValue("ii");
  });

  it("zooms in and out and reports the scale", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomedIn = screen.getByText(/%$/u).textContent;
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText(/%$/u).textContent).not.toBe(zoomedIn);
  });

  it("offers fit to width and fit to page", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Fit page" }));
    expect(screen.getByRole("button", { name: "Fit page" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(screen.getByRole("button", { name: "Fit width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("returns to the page it was left on", async () => {
    const { loader } = readerWith(stubDocument());
    const view = render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    view.unmount();

    const { loader: again } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={again} />);
    await screen.findByText("of 3");
    expect(screen.getByLabelText("Page")).toHaveValue("2");
  });

  it("keeps each file's place separately", async () => {
    const { loader } = readerWith(stubDocument());
    const view = render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    view.unmount();

    const { loader: other } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-2" loader={other} />);
    await screen.findByText("of 3");
    expect(screen.getByLabelText("Page")).toHaveValue("1");
  });

  it("shows the document's own contents list and jumps from it", async () => {
    const document = stubDocument({
      outline: vi.fn(async () => [
        { title: "Introduction", pageNumber: 1, children: [] },
        { title: "Method", pageNumber: 3, children: [] },
      ]),
    });
    const { loader } = readerWith(document);
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));
    await userEvent.click(await screen.findByRole("button", { name: "Method" }));
    expect(screen.getByLabelText("Page")).toHaveValue("3");
  });

  it("says so plainly when a contents list is absent", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(await screen.findByText("This document has no contents list.")).toBeInTheDocument();
  });

  it("reports a file it cannot open without blaming the person", async () => {
    const loader = vi.fn(async () => {
      throw new Error("InvalidPDFException");
    });
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("could not open this file");
  });

  it("releases the document when the reader closes", async () => {
    const destroy = vi.fn();
    const { loader } = readerWith(stubDocument({ destroy }));
    const view = render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");
    view.unmount();

    // PDF.js holds a worker and the decoded page cache. Leaving them behind on every close
    // is how a reader ends up using a gigabyte.
    await waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it("loads only the pages near the one being read", async () => {
    const page = vi.fn(async () => stubPage());
    const { loader } = readerWith(stubDocument({ pageCount: 400, page }));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 400");

    // A 400-page thesis should open as fast as a two-page note.
    await waitFor(() => expect(page.mock.calls.length).toBeGreaterThan(0));
    expect(page.mock.calls.length).toBeLessThan(5);
  });
});

describe("picking a document up where it was left", () => {
  const KEY = "kiwi.reader.workspace-1.asset-1";

  /** A bridge that answers everything, so the Reader's other reads do not get in the way. */
  function bridge() {
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      sent.push(envelope as { command: string; args: Record<string, unknown> });
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
        data: { annotations: [], threads: [] },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return sent;
  }

  it("opens on the page it was left on", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ page: 3, offset: 0.5 }));
    const { loader } = readerWith(stubDocument({ pageCount: 5 }));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    await screen.findByText("of 5");
    expect(screen.getByLabelText("Page")).toHaveValue("3");
  });

  it("writes down the page and how far down it, once it is showing", async () => {
    const { loader } = readerWith(stubDocument({ pageCount: 5 }));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);

    await screen.findByText("of 5");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    // The offset is a fraction of a page, and nothing here has a measured height, so it is zero.
    // The page is the part that must survive.
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual({
        page: 2,
        offset: 0,
      }),
    );
  });

  it("does not overwrite last week's page while the file is still opening", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ page: 7, offset: 0.25 }));
    let release: (document: PdfDocument) => void = () => undefined;
    const pending = new Promise<PdfDocument>((resolve) => {
      release = resolve;
    });
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={async () => pending} />);

    await screen.findByRole("status");
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify({ page: 7, offset: 0.25 }));
    release(stubDocument({ pageCount: 10 }));
    await screen.findByText("of 10");
    expect(screen.getByLabelText("Page")).toHaveValue("7");
  });

  it("tells the machine's index that the paper has been opened", async () => {
    const sent = bridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="object-1" loader={loader} />,
    );

    await screen.findByText("of 3");
    await waitFor(() =>
      expect(
        sent.find((request) => request.command === "kiwi.projection.mark-opened")?.args,
      ).toEqual({ object_id: "object-1" }),
    );
  });

  it("says nothing about a file that would not open", async () => {
    const sent = bridge();
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="object-1"
        loader={async () => {
          throw new Error("Not a PDF.");
        }}
      />,
    );

    // A file that turns out to be unreadable was not opened, whatever the click that led here
    // intended, and the Library should not claim otherwise.
    await screen.findByRole("alert");
    expect(sent.some((request) => request.command === "kiwi.projection.mark-opened")).toBe(false);
  });
});

describe("annotating in the reader", () => {
  interface Recorded {
    command: string;
    args: Record<string, unknown>;
  }

  function bridgeWith(annotations: unknown[] = [], threads: () => unknown[] = () => []) {
    const recorded: Recorded[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Recorded;
      recorded.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list") {
        return { ...base, status: "no_change" as const, data: { annotations } };
      }
      if (request.command === "kiwi.thread.list") {
        return { ...base, status: "no_change" as const, data: { threads: threads() } };
      }
      return { ...base, data: {} };
    });
    window.kiwiDesktop = {
      invokeCommand,
      // Offline, because a mark commented on aboard a train is the case the Reader is for.
      getAccountAuthState: async () => ({
        status: "authenticated",
        account: { id: "ada", email: "ada@example.org", email_verified: true },
        connection: "offline",
      }),
    } as unknown as RendererBridge;
    return { recorded, invokeCommand };
  }

  /** One open conversation hanging off the stored mark. */
  function storedThread() {
    return {
      id: "thread-1",
      version: 1,
      content_hash: `sha256:${"e".repeat(64)}`,
      title: "Does this hold for long documents?",
      created_at: "2026-08-25T12:00:00.000Z",
      updated_at: "2026-08-25T12:00:00.000Z",
      thread: {
        anchor: { object_id: "annotation-1", kind: "annotation" },
        status: "open",
        resolved_by: null,
        resolved_at: null,
        messages: [
          {
            id: "message-1",
            author_id: "account:ada",
            author_name: "Ada",
            body: "Does this hold for long documents?",
            created_at: "2026-08-25T12:00:00.000Z",
            edited_at: null,
          },
        ],
        participants: ["account:ada"],
        mentions: [],
      },
    };
  }

  function storedMark(overrides: Record<string, unknown> = {}) {
    return {
      id: "annotation-1",
      version: 1,
      content_hash: `sha256:${"d".repeat(64)}`,
      title: "Attention is all you need",
      updated_at: "2026-08-25T12:00:00.000Z",
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted: "Attention is all you need",
        comment: "",
        image_asset_id: null,
        ...((overrides["annotation"] as Record<string, unknown> | undefined) ?? {}),
      },
      ...overrides,
    };
  }

  it("opens on the mark a quotation was followed back to", async () => {
    // Following a quotation is a request to look at a passage, not at the paper it is in. The
    // Reader turns to the page and selects the mark, so the words are where the eye already is.
    bridgeWith([
      storedMark({
        annotation: {
          kind: "highlight",
          asset_id: "asset-1",
          page: 3,
          page_label: "3",
          rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
          color: "yellow",
          quoted: "machines can think",
          comment: "",
          image_asset_id: null,
        },
      }),
    ]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        reveal={{ annotationId: "annotation-1", token: 1 }}
        loader={loader}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Page")).toHaveValue("3"));
    const selected = window.document.querySelector("li.is-active");
    expect(selected?.textContent).toContain("p. 3");
  });

  it("stays on the file when the mark it was sent to has been deleted", async () => {
    // The passage is gone from the page. Turning to page one and selecting nothing would be a
    // Reader pretending it had found something.
    bridgeWith([]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        reveal={{ annotationId: "annotation-gone", token: 1 }}
        loader={loader}
      />,
    );

    await screen.findByText("of 3");
    expect(screen.getByLabelText("Page")).toHaveValue("1");
    expect(window.document.querySelector("li.is-active")).toBeNull();
  });

  it("asks for the marks on the file being read", async () => {
    const { recorded } = bridgeWith();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");

    await waitFor(() =>
      expect(recorded.find((request) => request.command === "kiwi.annotation.list")).toBeDefined(),
    );
    // A Paper may hold a preprint and a published PDF; only the marks on this one belong here.
    expect(recorded.find((request) => request.command === "kiwi.annotation.list")?.args).toEqual({
      object_id: "paper-1",
      asset_id: "asset-1",
    });
  });

  it("lists existing marks with their page and passage", async () => {
    bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    expect(await screen.findByText("Attention is all you need")).toBeInTheDocument();
    expect(screen.getByText("p. 1")).toBeInTheDocument();
  });

  it("draws a mark over the page it belongs to", async () => {
    bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    const mark = await screen.findByRole("button", {
      name: "highlight Attention is all you need",
    });
    // Fractions of the page, so the mark lands correctly at any zoom.
    expect(mark).toHaveStyle({ left: "10%", top: "20%" });
  });

  it("adds a comment to a mark", async () => {
    const { recorded } = bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add comment" }));
    await userEvent.type(screen.getByLabelText("Comment"), "Check against Bahdanau");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        recorded.find((request) => request.command === "kiwi.annotation.update"),
      ).toBeDefined(),
    );
    const update = recorded.find((request) => request.command === "kiwi.annotation.update");
    expect(update?.args).toMatchObject({
      annotation_id: "annotation-1",
      expected_version: 1,
      annotation: { comment: "Check against Bahdanau" },
    });
  });

  it("recolors a mark without losing its region", async () => {
    const { recorded } = bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Recolor to green" }));
    const update = recorded.find((request) => request.command === "kiwi.annotation.update");
    expect(update?.args["annotation"]).toMatchObject({ color: "green" });
    expect(
      ((update?.args["annotation"] as Record<string, unknown>)["rects"] as unknown[]).length,
    ).toBe(1);
  });

  it("deletes a mark through Trash rather than erasing it", async () => {
    const { recorded } = bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    // A deleted highlight is recoverable like anything else in the workspace.
    expect(recorded.find((request) => request.command === "kiwi.object.trash")?.args).toMatchObject(
      { object_id: "annotation-1" },
    );
  });

  it("says which marks are being talked about without opening them", async () => {
    bridgeWith([storedMark()], () => [storedThread()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    expect(await screen.findByText("1 open comment")).toBeInTheDocument();
    // The conversation itself waits until the mark is chosen; the count is the whole hint.
    expect(screen.queryByText("Does this hold for long documents?")).not.toBeInTheDocument();
  });

  it("opens the conversation under the mark, and files a new one against it", async () => {
    let started = false;
    const { recorded } = bridgeWith([storedMark()], () => (started ? [storedThread()] : []));
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    await userEvent.click(
      // The sidebar entry, which is named by its page; the mark drawn on the page is not.
      await screen.findByRole("button", { name: /^p\. 1/u }),
    );
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Start a comment" }),
      "Does this hold for long documents?",
    );
    started = true;
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Does this hold for long documents?")).toBeInTheDocument();
    // Anchored to the mark, not to the Paper: the passage is what the question is about, and
    // the name is the address because the display name cannot be read offline.
    expect(recorded.find((request) => request.command === "kiwi.thread.start")?.args).toEqual({
      anchor: { object_id: "annotation-1", kind: "annotation" },
      body: "Does this hold for long documents?",
      author_name: "ada@example.org",
    });
  });

  it("says what to do when nothing is marked yet", async () => {
    bridgeWith([]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );

    expect(await screen.findByText(/drag a rectangle around a figure/u)).toBeInTheDocument();
  });

  it("offers no annotation controls in a read-only workspace", async () => {
    bridgeWith([storedMark()]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable={false}
        loader={loader}
      />,
    );

    await screen.findByText("Attention is all you need");
    expect(screen.queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("reads a file with no Paper behind it without offering to mark it", async () => {
    // Opening a loose managed file is legitimate; there is just nothing to hang marks from.
    const { recorded } = bridgeWith([]);
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    expect(recorded.some((request) => request.command === "kiwi.annotation.list")).toBe(false);
  });
});

describe("finding words in a document", () => {
  function searchable(...pages: string[][]): PdfDocument {
    return stubDocument({
      pageCount: pages.length,
      page: vi.fn(async (number) =>
        stubPage({
          textItems: vi.fn(async () =>
            (pages[number - 1] ?? []).map((text, index) => ({
              text,
              left: 72,
              top: 96 + index * 20,
              width: 300,
              height: 14,
            })),
          ),
        }),
      ),
    });
  }

  it("counts the matches and says where you are among them", async () => {
    const { loader } = readerWith(searchable(["ribosome assembly"], ["ribosome"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 2");

    await userEvent.type(screen.getByLabelText("Find in document"), "ribosome{Enter}");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });

  it("says so when nothing matches, rather than looking broken", async () => {
    const { loader } = readerWith(searchable(["ribosome"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 1");

    await userEvent.type(screen.getByLabelText("Find in document"), "telepathy{Enter}");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("moves to the page a match is on", async () => {
    const { loader } = readerWith(searchable(["nothing here"], ["nothing"], ["ribosome"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.type(screen.getByLabelText("Find in document"), "ribosome{Enter}");
    await screen.findByText("1 of 1");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByLabelText("Page")).toHaveValue("3");
  });

  it("wraps around at the end", async () => {
    const { loader } = readerWith(searchable(["aa aa"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 1");

    await userEvent.type(screen.getByLabelText("Find in document"), "aa{Enter}");
    await screen.findByText("1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });

  it("clears the marks when the box is emptied", async () => {
    // Leaving the last search highlighted over a document nobody is searching is worse than
    // showing nothing.
    const { loader } = readerWith(searchable(["ribosome"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 1");

    const box = screen.getByLabelText("Find in document");
    await userEvent.type(box, "ribosome{Enter}");
    await screen.findByText("1 of 1");
    await userEvent.clear(box);
    await waitFor(() => expect(screen.queryByText("1 of 1")).not.toBeInTheDocument());
  });

  it("has nothing to step through before a search is run", async () => {
    const { loader } = readerWith(searchable(["ribosome"]));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 1");
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
  });
});

describe("jumping to a page by its own label", () => {
  /** Four pages of front matter in roman, then a body that starts again at 1. */
  function thesis(): PdfDocument {
    const labels = ["i", "ii", "iii", "iv", "1", "2", "3"];
    return stubDocument({
      pageCount: labels.length,
      pageLabel: (pageNumber) => labels[pageNumber - 1] ?? String(pageNumber),
    });
  }

  async function openThesis(): Promise<HTMLElement> {
    const { loader } = readerWith(thesis());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 7");
    return screen.getByLabelText("Page");
  }

  it("goes to the page printed with that number, not the page in that position", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "1{Enter}");

    // The body's first page, which is the fifth sheet. Going to the cover instead is the
    // mistake this whole feature exists to stop.
    expect(screen.getByText("#5")).toBeInTheDocument();
    expect(input).toHaveValue("1");
  });

  it("lets a label longer than one character be typed", async () => {
    const input = await openThesis();

    // A box that acted on every keystroke would jump away at the "i" and never see the "v".
    await userEvent.clear(input);
    await userEvent.type(input, "iv");
    expect(input).toHaveValue("iv");
    await userEvent.type(input, "{Enter}");

    expect(screen.getByText("#4")).toBeInTheDocument();
  });

  it("ignores the case it was typed in", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "III{Enter}");

    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  it("takes the position in the file when no page is printed with that number", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "6{Enter}");

    // Nothing prints "6", so it is read as the sixth sheet, which prints "2".
    expect(screen.getByText("#6")).toBeInTheDocument();
    expect(input).toHaveValue("2");
  });

  it("stays where it is when the document has no such page", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "xiv{Enter}");

    // Refusing to move is the honest answer. Guessing at a page is worse.
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(input).toHaveValue("i");
  });

  it("acts on the number when the box is left rather than losing it", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "ii");
    fireEvent.blur(input);

    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("puts the box back to the page in view when the typing is abandoned", async () => {
    const input = await openThesis();

    await userEvent.clear(input);
    await userEvent.type(input, "iii{Escape}");

    expect(input).toHaveValue("i");
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  it("says nothing about sheets for a document numbered the way it is ordered", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    // Saying "#1" beside a page called "1" is noise.
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
  });
});

describe("navigating by thumbnail", () => {
  it("shows a thumbnail per page and jumps from one", async () => {
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Pages" }));
    const list = await screen.findByRole("navigation", { name: "Pages" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);

    await userEvent.click(within(list).getAllByRole("button")[2]!);
    expect(screen.getByLabelText("Page")).toHaveValue("3");
  });

  it("does not draw every page the moment the sidebar opens", async () => {
    // Four hundred thumbnails at once freezes the window for exactly the documents the
    // sidebar exists to help with.
    const page = vi.fn(async () => stubPage());
    const { loader } = readerWith(stubDocument({ pageCount: 40, page }));
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 40");
    const before = page.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Pages" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy());
    expect(page.mock.calls.length - before).toBeLessThan(40);
  });
});

describe("a nested contents list", () => {
  it("keeps the sections under the chapter they belong to", async () => {
    // A flat list loses which chapter each heading is in, which is most of what a contents
    // list is for.
    const document = stubDocument({
      outline: vi.fn(async () => [
        {
          title: "Results",
          pageNumber: 4,
          children: [{ title: "Yield", pageNumber: 5, children: [] }],
        },
      ]),
    });
    const { loader } = readerWith(document);
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));
    const chapter = (await screen.findByRole("button", { name: "Results" })).closest("li");
    expect(chapter).not.toBeNull();
    expect(within(chapter!).getByRole("button", { name: "Yield" })).toBeInTheDocument();
  });
});

describe("capturing a figure", () => {
  interface Sent {
    command: string;
    args: Record<string, unknown>;
  }

  function captureBridge(overrides: { capture?: unknown } = {}) {
    const sent: Sent[] = [];
    const captureManagedAsset = vi.fn(async () => ({
      id: "selection-1",
      name: "page-1.png",
      size: 10,
      modifiedAt: "2026-08-25T12:00:00.000Z",
      declaredMediaType: "image/png",
    }));
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Sent;
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list") return { ...base, data: { annotations: [] } };
      if (request.command === "kiwi.asset.import-managed")
        return { ...base, data: { asset: { id: "image-1" } } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = {
      invokeCommand,
      captureManagedAsset: overrides.capture ?? captureManagedAsset,
    } as unknown as RendererBridge;
    return { sent, captureManagedAsset };
  }

  /** jsdom has no layout, so the page reports a box the pointer arithmetic can use. */
  function giveThePageASize(): void {
    const page = window.document.querySelector<HTMLElement>(".pdf-page");
    if (page === null) return;
    page.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 600,
        height: 800,
        right: 600,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  function dragOnPage(): void {
    const page = window.document.querySelector<HTMLElement>(".pdf-page");
    if (page === null) throw new Error("no page rendered");
    fireEvent.pointerDown(page, { button: 0, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(page, { clientX: 300, clientY: 400 });
    fireEvent.pointerUp(page, { clientX: 300, clientY: 400 });
  }

  it("offers capture only when there is a Paper to hang the mark on", async () => {
    captureBridge();
    const { loader } = readerWith(stubDocument());
    render(<PdfReader workspaceId="workspace-1" assetId="asset-1" loader={loader} />);
    await screen.findByText("of 3");
    // A file on its own has nothing to attach an annotation to.
    expect(screen.queryByRole("button", { name: "Capture area" })).not.toBeInTheDocument();
  });

  it("ignores a click that was not a drag", async () => {
    const { captureManagedAsset } = captureBridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    await userEvent.click(screen.getByRole("button", { name: "Capture area" }));
    giveThePageASize();

    const page = window.document.querySelector<HTMLElement>(".pdf-page");
    fireEvent.pointerDown(page!, { button: 0, clientX: 60, clientY: 80 });
    fireEvent.pointerUp(page!, { clientX: 61, clientY: 81 });
    expect(captureManagedAsset).not.toHaveBeenCalled();
  });

  it("says the capture failed rather than storing an empty picture", async () => {
    // jsdom has no working canvas, which is exactly what a broken graphics stack looks like
    // on a real machine.
    captureBridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    await userEvent.click(screen.getByRole("button", { name: "Capture area" }));
    giveThePageASize();
    dragOnPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not capture/u);
  });

  it("stops capturing when asked", async () => {
    captureBridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    const capture = screen.getByRole("button", { name: "Capture area" });
    await userEvent.click(capture);
    expect(capture).toHaveAttribute("aria-pressed", "true");
    // Pressing the tool that is on is the way back to reading.
    await userEvent.click(capture);
    expect(capture).toHaveAttribute("aria-pressed", "false");
  });

  it("puts down the capture tool when a note is picked up", async () => {
    // Both want the same click. Leaving capture on while a note is being placed would make a
    // stray drag a figure nobody asked to keep.
    captureBridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    await userEvent.click(screen.getByRole("button", { name: "Capture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Sticky note" }));

    expect(screen.getByRole("button", { name: "Capture area" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("marking a place rather than a passage", () => {
  interface Sent {
    command: string;
    args: Record<string, unknown>;
  }

  function pointBridge(marks: unknown[] = []) {
    const sent: Sent[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Sent;
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function pointMark(id: string, kind: "note" | "text", comment: string) {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"e".repeat(64)}`,
      title: comment,
      updated_at: "2026-08-26T12:00:00.000Z",
      annotation: {
        kind,
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.4, top: 0.3, width: 0.02, height: 0.02 }],
        color: "yellow",
        quoted: "",
        comment,
        image_asset_id: null,
      },
    };
  }

  /** jsdom has no layout, so the page reports a box the pointer arithmetic can use. */
  function giveThePageASize(): void {
    const page = window.document.querySelector<HTMLElement>(".pdf-page");
    if (page === null) throw new Error("no page rendered");
    page.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 600,
        height: 800,
        right: 600,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  function clickThePage(): void {
    const page = window.document.querySelector<HTMLElement>(".pdf-page");
    if (page === null) throw new Error("no page rendered");
    fireEvent.pointerDown(page, { button: 0, clientX: 60, clientY: 80 });
  }

  async function readerFor(marks: unknown[] = []) {
    const bridge = pointBridge(marks);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    return bridge;
  }

  it("leaves a sticky note at the place on the page that was clicked", async () => {
    const { sent } = await readerFor();
    await userEvent.click(screen.getByRole("button", { name: "Sticky note" }));
    giveThePageASize();
    clickThePage();

    await screen.findByRole("form", { name: "New sticky note" });
    await userEvent.type(screen.getByLabelText("Note"), "No sample size anywhere");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sent.some((entry) => entry.command === "kiwi.annotation.create")).toBe(true),
    );
    const created = sent.find((entry) => entry.command === "kiwi.annotation.create")?.args;
    const annotation = created?.["annotation"] as {
      kind: string;
      page: number;
      comment: string;
      quoted: string;
      rects: Array<{ left: number; top: number; width: number }>;
    };
    expect(annotation.kind).toBe("note");
    expect(annotation.page).toBe(1);
    expect(annotation.comment).toBe("No sample size anywhere");
    // Nothing was selected, so there is no passage to quote. The anchor is the click itself.
    expect(annotation.quoted).toBe("");
    expect(annotation.rects).toHaveLength(1);
    const rect = annotation.rects[0]!;
    expect(rect.left + rect.width / 2).toBeCloseTo(0.1, 6);
    expect(rect.top + rect.width / 2).toBeCloseTo(0.1, 6);
  });

  it("puts the tool away once one mark has been placed", async () => {
    // The next click belongs to whatever is being typed, not to a second pin somewhere else.
    await readerFor();
    await userEvent.click(screen.getByRole("button", { name: "Sticky note" }));
    giveThePageASize();
    clickThePage();

    await screen.findByRole("form", { name: "New sticky note" });
    expect(screen.getByRole("button", { name: "Sticky note" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("will not make a mark that says nothing", async () => {
    const { sent } = await readerFor();
    await userEvent.click(screen.getByRole("button", { name: "Text box" }));
    giveThePageASize();
    clickThePage();

    await screen.findByRole("form", { name: "New text box" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Words on the page"), "Figure 2 is mislabelled");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    // Nothing was written down while the words were being typed.
    expect(sent.some((entry) => entry.command === "kiwi.annotation.create")).toBe(false);
  });

  it("leaves nothing behind when the mark is abandoned", async () => {
    const { sent } = await readerFor();
    await userEvent.click(screen.getByRole("button", { name: "Sticky note" }));
    giveThePageASize();
    clickThePage();

    await screen.findByRole("form", { name: "New sticky note" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("form", { name: "New sticky note" })).not.toBeInTheDocument();
    expect(sent.some((entry) => entry.command === "kiwi.annotation.create")).toBe(false);
  });

  it("draws a text box on the page and keeps a sticky note a pin", async () => {
    await readerFor([
      pointMark("annotation-1", "text", "Figure 2 is mislabelled"),
      pointMark("annotation-2", "note", "No sample size anywhere"),
    ]);

    const box = await waitFor(() => {
      const found = window.document.querySelector(".pdf-mark--text");
      if (found === null) throw new Error("no text box drawn");
      return found;
    });
    expect(box.textContent).toBe("Figure 2 is mislabelled");
    // A pin says nothing on the page; it is opened to be read, and the mark carries its words
    // for anything that needs them.
    const pin = window.document.querySelector(".pdf-mark--note");
    expect(pin?.textContent).toBe("");
    expect(pin?.getAttribute("aria-label")).toBe("note No sample size anywhere");
    expect(pin?.getAttribute("title")).toBe("No sample size anywhere");
  });

  it("does not offer the tools to a reader that cannot write", async () => {
    pointBridge();
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable={false}
        loader={loader}
      />,
    );
    await screen.findByText("of 3");

    expect(screen.queryByRole("button", { name: "Sticky note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Text box" })).not.toBeInTheDocument();
  });
});

describe("sending marks to a note", () => {
  function noteBridge(marks: unknown[], notes: Array<{ id: string; title: string }> = []) {
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      if (request.command === "kiwi.projection.list")
        return { ...base, data: { objects: notes.map((note) => ({ ...note, type: "note" })) } };
      if (request.command === "kiwi.annotation.send-to-note")
        return { ...base, data: { note: { id: "note-9" } } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function mark(id: string) {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"d".repeat(64)}`,
      title: "Attention is all you need",
      updated_at: "2026-08-25T12:00:00.000Z",
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted: "Attention is all you need",
        comment: "",
        image_asset_id: null,
      },
    };
  }

  it("sends one mark to a new note named after the paper", async () => {
    const { sent } = noteBridge([mark("annotation-1")]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        title="Vaswani 2017"
        loader={loader}
      />,
    );
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to note" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 annotation/u });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Notes on Vaswani 2017");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sent.some((entry) => entry.command === "kiwi.annotation.send-to-note")).toBe(true),
    );
    expect(
      sent.find((entry) => entry.command === "kiwi.annotation.send-to-note")?.args,
    ).toMatchObject({
      annotation_ids: ["annotation-1"],
      note_title: "Notes on Vaswani 2017",
    });
  });

  it("offers the notes that already exist, so marks can be gathered by theme", async () => {
    // Gathering highlights from several papers into one thematic note is the point.
    noteBridge([mark("annotation-1")], [{ id: "note-1", title: "Attention mechanisms" }]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to note" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 annotation/u });
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Attention mechanisms" })).toBeTruthy(),
    );
  });

  it("sends the whole reading in one action", async () => {
    const { sent } = noteBridge([mark("annotation-1"), mark("annotation-2")]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader workspaceId="workspace-1" assetId="asset-1" objectId="paper-1" loader={loader} />,
    );
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send all to a note" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 2 annotations/u });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        sent.find((entry) => entry.command === "kiwi.annotation.send-to-note")?.args[
          "annotation_ids"
        ],
      ).toEqual(["annotation-1", "annotation-2"]),
    );
  });

  it("does not offer to send from a read-only reader", async () => {
    noteBridge([mark("annotation-1")]);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable={false}
        loader={loader}
      />,
    );
    await screen.findByText("of 3");
    expect(screen.queryByRole("button", { name: "Send all to a note" })).not.toBeInTheDocument();
  });
});

describe("sending marks to a claim", () => {
  function claimBridge(
    marks: unknown[],
    claims: Array<{ id: string; title: string }> = [],
  ): { sent: Array<{ command: string; args: Record<string, unknown> }> } {
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      if (request.command === "kiwi.claim.list") return { ...base, data: { claims } };
      if (request.command === "kiwi.claim.send-evidence")
        return { ...base, data: { claim: { id: "claim-9" }, claim_created: true } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function marked(id: string) {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"d".repeat(64)}`,
      title: "Reaction times fell by 12%",
      updated_at: "2026-08-25T12:00:00.000Z",
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted: "Reaction times fell by 12%",
        comment: "",
        image_asset_id: null,
      },
    };
  }

  function reader(props: Record<string, unknown> = {}): void {
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        projectId="project-1"
        loader={loader}
        {...props}
      />,
    );
  }

  function lastSend(
    sent: Array<{ command: string; args: Record<string, unknown> }>,
  ): Record<string, unknown> | undefined {
    return [...sent].reverse().find((entry) => entry.command === "kiwi.claim.send-evidence")?.args;
  }

  it("sends a mark to a claim the project has already written", async () => {
    const { sent } = claimBridge(
      [marked("annotation-1")],
      [{ id: "claim-1", title: "Sleep debt slows reaction time." }],
    );
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("option", { name: "Sleep debt slows reaction time." }),
      ).toBeTruthy(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    expect(lastSend(sent)).toEqual({
      claim_id: "claim-1",
      object_ids: ["annotation-1"],
      stance: "supports",
    });
  });

  it("writes a new claim and attaches the mark in the same send", async () => {
    // One command, not three. Two of three landing is a claim standing on nothing.
    const { sent } = claimBridge([marked("annotation-1")]);
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await userEvent.type(
      within(dialog).getByLabelText("What the project asserts"),
      "Sleep debt slows reaction time.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    expect(lastSend(sent)).toEqual({
      project_id: "project-1",
      statement: "Sleep debt slows reaction time.",
      object_ids: ["annotation-1"],
      stance: "supports",
    });
  });

  it("sends a passage that argues against a claim", async () => {
    const { sent } = claimBridge(
      [marked("annotation-1")],
      [{ id: "claim-1", title: "Sleep debt slows reaction time." }],
    );
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("option", { name: "Sleep debt slows reaction time." }),
      ).toBeTruthy(),
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("This passage"),
      "Contradicts the claim",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)?.["stance"]).toBe("contradicts"));
  });

  it("refuses to write a claim that asserts nothing", async () => {
    const { sent } = claimBridge([marked("annotation-1")]);
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(lastSend(sent)).toBeUndefined();
  });

  it("does not offer to write a claim with no project open", async () => {
    // A claim is filed in a project. With none open there is nothing a new one could belong to.
    claimBridge([marked("annotation-1")], [{ id: "claim-1", title: "Sleep debt slows recall." }]);
    reader({ projectId: null });
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Sleep debt slows recall." })).toBeTruthy(),
    );
    expect(within(dialog).queryByRole("option", { name: "New claim" })).toBeNull();
  });

  it("says so when there is no claim to send to and no project to write one in", async () => {
    claimBridge([marked("annotation-1")]);
    reader({ projectId: null });
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    expect(within(dialog).getByText(/Open a project to write one/u)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("says why a send was refused and leaves the mark where it was", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      const base = { protocol_version: "1.0.0", request_id: "request" };
      if (request.command === "kiwi.annotation.list")
        return { ...base, status: "committed" as const, data: { annotations: [marked("a1")] } };
      if (request.command === "kiwi.claim.list")
        return {
          ...base,
          status: "committed" as const,
          data: { claims: [{ id: "claim-1", title: "Sleep debt slows reaction time." }] },
        };
      return {
        ...base,
        status: "failed" as const,
        error: {
          code: "KIWI_NOT_FOUND",
          message: "That claim was not found.",
          details: {},
          retryable: false,
          recovery_actions: ["reload_current"],
          correlation_id: "correlation",
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("option", { name: "Sleep debt slows reaction time." }),
      ).toBeTruthy(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That claim was not found.");
    expect(screen.getByText("Reaction times fell by 12%")).toBeTruthy();
  });

  it("does not offer to send from a read-only reader", async () => {
    claimBridge([marked("annotation-1")]);
    reader({ writable: false });
    await screen.findByText("of 3");
    expect(screen.queryByRole("button", { name: "Send to claim" })).toBeNull();
  });

  it("never names a folder", async () => {
    const { sent } = claimBridge(
      [marked("annotation-1")],
      [{ id: "claim-1", title: "Sleep debt slows reaction time." }],
    );
    reader();
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to claim" }));
    const dialog = await screen.findByRole("dialog", { name: /Send 1 passage to a claim/u });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    for (const entry of sent) expect(entry.args["root"]).toBeUndefined();
  });
});

describe("sending a passage into a manuscript", () => {
  function draftBridge(
    manuscripts: Array<{ id: string; title: string }> = [{ id: "output-1", title: "The paper" }],
  ) {
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: [quoted("annotation-1")] } };
      if (request.command === "kiwi.projection.list")
        return {
          ...base,
          data: { objects: manuscripts.map((entry) => ({ ...entry, type: "output" })) },
        };
      if (request.command === "kiwi.object.read")
        return {
          ...base,
          data: {
            object: {
              id: "output-1",
              document_mode: "rich",
              content: "Introduction\nMethod",
              document: {
                type: "doc",
                content: [
                  {
                    type: "heading",
                    attrs: { level: 1 },
                    content: [{ type: "text", text: "Introduction" }],
                  },
                  { type: "paragraph", content: [{ type: "text", text: "Reading is iterative." }] },
                  {
                    type: "heading",
                    attrs: { level: 1 },
                    content: [{ type: "text", text: "Method" }],
                  },
                ],
              },
            },
          },
        };
      if (request.command === "kiwi.annotation.send-to-manuscript")
        return { ...base, data: { section: "Introduction", added: 1, skipped: 0 } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function quoted(id: string) {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"d".repeat(64)}`,
      title: "Reaction times fell by 12%",
      updated_at: "2026-08-25T12:00:00.000Z",
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted: "Reaction times fell by 12%",
        comment: "",
        image_asset_id: null,
      },
    };
  }

  function reader(props: Record<string, unknown> = {}): void {
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        projectId="project-1"
        loader={loader}
        {...props}
      />,
    );
  }

  function lastSend(
    sent: Array<{ command: string; args: Record<string, unknown> }>,
  ): Record<string, unknown> | undefined {
    return [...sent]
      .reverse()
      .find((entry) => entry.command === "kiwi.annotation.send-to-manuscript")?.args;
  }

  async function openChooser(): Promise<HTMLElement> {
    await screen.findByText("of 3");
    await userEvent.click(await screen.findByRole("button", { name: "Send to manuscript" }));
    return screen.findByRole("dialog", { name: /Send 1 passage to a manuscript/u });
  }

  it("writes the passage into the section the writer chose", async () => {
    const { sent } = draftBridge();
    reader();
    const dialog = await openChooser();
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Method" })).toBeTruthy(),
    );
    await userEvent.selectOptions(within(dialog).getByLabelText("Section"), "Method");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    expect(lastSend(sent)).toEqual({
      manuscript_id: "output-1",
      section: "Method",
      annotation_ids: ["annotation-1"],
    });
  });

  it("offers the sections the manuscript has now", async () => {
    // Read when the chooser opens. A heading offered from memory is a heading somebody may have
    // renamed since, and the send would not find it.
    draftBridge();
    reader();
    const dialog = await openChooser();

    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Introduction" })).toBeTruthy(),
    );
    expect(within(dialog).getByRole("option", { name: "End of the manuscript" })).toBeTruthy();
  });

  it("names no section when the passage goes to the end", async () => {
    const { sent } = draftBridge();
    reader();
    const dialog = await openChooser();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    expect(lastSend(sent)).toEqual({
      manuscript_id: "output-1",
      annotation_ids: ["annotation-1"],
    });
  });

  it("says so when there is no manuscript to send to", async () => {
    draftBridge([]);
    reader();
    const dialog = await openChooser();

    await waitFor(() =>
      expect(within(dialog).getByText(/no manuscripts yet/u)).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("does not offer to send from a read-only reader", async () => {
    draftBridge();
    reader({ writable: false });
    await screen.findByText("of 3");
    expect(screen.queryByRole("button", { name: "Send to manuscript" })).toBeNull();
  });

  it("never names a folder", async () => {
    const { sent } = draftBridge();
    reader();
    const dialog = await openChooser();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(lastSend(sent)).toBeDefined());
    for (const entry of sent) expect(entry.args["root"]).toBeUndefined();
  });
});

describe("SelectionMenu", () => {
  it("offers to send the passage straight to a claim, marking it on the way", async () => {
    // The excerpt and the claim are one gesture: somebody reading a sentence that settles
    // something should not have to highlight it, find it in the sidebar, and send it.
    const onSendToClaim = vi.fn();
    render(
      <SelectionMenu
        busy={false}
        onHighlight={vi.fn()}
        onUnderline={vi.fn()}
        onSendToClaim={onSendToClaim}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send to claim" }));
    expect(onSendToClaim).toHaveBeenCalled();
  });

  it("offers to send the passage straight into a draft", async () => {
    // Same gesture as the claim: a sentence you know belongs in the paper should go there while
    // you are looking at it, and be a mark on the page afterwards.
    const onSendToManuscript = vi.fn();
    render(
      <SelectionMenu
        busy={false}
        onHighlight={vi.fn()}
        onUnderline={vi.fn()}
        onSendToManuscript={onSendToManuscript}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send to manuscript" }));
    expect(onSendToManuscript).toHaveBeenCalled();
  });

  it("leaves the offer out when the Reader cannot write", () => {
    render(
      <SelectionMenu busy={false} onHighlight={vi.fn()} onUnderline={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Send to claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to manuscript" })).toBeNull();
  });
});

describe("tagging marks and filtering by tag", () => {
  interface Sent {
    command: string;
    args: Record<string, unknown>;
  }

  function tagBridge(marks: unknown[]): { sent: Sent[] } {
    const sent: Sent[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Sent;
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function taggedMark(id: string, quoted: string, tags: string[]) {
    return {
      id,
      version: 4,
      content_hash: `sha256:${"c".repeat(64)}`,
      title: quoted,
      updated_at: "2026-08-27T12:00:00.000Z",
      tags,
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted,
        comment: "",
        image_asset_id: null,
      },
    };
  }

  async function readerFor(marks: unknown[], writable = true) {
    const bridge = tagBridge(marks);
    const { loader } = readerWith(stubDocument());
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable={writable}
        loader={loader}
      />,
    );
    await screen.findByText("of 3");
    return bridge;
  }

  it("tags a mark by the same command that tags anything else", async () => {
    const { sent } = await readerFor([taggedMark("annotation-1", "Attention is all you need", [])]);
    await userEvent.click(await screen.findByRole("button", { name: "Add tag" }));
    await userEvent.type(screen.getByLabelText("Tag"), "Method");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(sent.some((entry) => entry.command === "kiwi.object.tag")).toBe(true),
    );
    // The name is turned into an id on the way, so `Method` here is the `method` the Library
    // filters by rather than a second tag that reads the same.
    expect(sent.find((entry) => entry.command === "kiwi.object.tag")?.args).toMatchObject({
      object_id: "annotation-1",
      expected_version: 4,
      tag_id: "tag:user/method",
      action: "add",
    });
  });

  it("shows the tags a mark carries and takes one off", async () => {
    const { sent } = await readerFor([
      taggedMark("annotation-1", "Attention is all you need", ["tag:user/to-read-next"]),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "Remove tag to read next" }));

    await waitFor(() =>
      expect(sent.some((entry) => entry.command === "kiwi.object.tag")).toBe(true),
    );
    expect(sent.find((entry) => entry.command === "kiwi.object.tag")?.args).toMatchObject({
      object_id: "annotation-1",
      tag_id: "tag:user/to-read-next",
      action: "remove",
    });
  });

  it("narrows the reading to the marks that carry a chosen tag", async () => {
    // A tag is only worth adding if it can be asked for afterwards. On a paper read closely
    // there are a hundred marks, and twenty of them are the reason for the tag.
    await readerFor([
      taggedMark("annotation-1", "The method section", ["tag:user/method"]),
      taggedMark("annotation-2", "Something else entirely", []),
    ]);
    expect(await screen.findByText("Something else entirely")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /method 1/u }));

    expect(screen.getByText("The method section")).toBeTruthy();
    expect(screen.queryByText("Something else entirely")).toBeNull();
  });

  it("offers each tag once, however many marks carry it", async () => {
    await readerFor([
      taggedMark("annotation-1", "First", ["tag:user/method"]),
      taggedMark("annotation-2", "Second", ["tag:user/method"]),
    ]);
    const filter = await screen.findByRole("group", { name: "Filter by tag" });
    expect(within(filter).getAllByRole("button", { name: /method/u })).toHaveLength(1);
  });

  it("sends what the filter left rather than the whole document", async () => {
    // Sending marks somebody has just said they are not looking at would put the rest of the
    // reading into a note that was asked for on one tag.
    const { sent } = await readerFor([
      taggedMark("annotation-1", "The method section", ["tag:user/method"]),
      taggedMark("annotation-2", "Something else entirely", []),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /method 1/u }));
    await userEvent.click(screen.getByRole("button", { name: "Send these to a note" }));

    const dialog = await screen.findByRole("dialog", { name: /Send 1 annotation/u });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        sent.find((entry) => entry.command === "kiwi.annotation.send-to-note")?.args[
          "annotation_ids"
        ],
      ).toEqual(["annotation-1"]),
    );
  });

  it("shows a reader who cannot write the tags without offering to change them", async () => {
    await readerFor([taggedMark("annotation-1", "Attention", ["tag:user/method"])], false);
    // The chip is worth reading, and the filter is worth using, on a workspace nobody can write.
    expect(await screen.findByRole("button", { name: /method 1/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add tag" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove tag method" })).toBeNull();
  });
});

describe("marks that lost their place", () => {
  interface Sent {
    command: string;
    args: Record<string, unknown>;
  }

  function bridgeWith(marks: unknown[]): { sent: Sent[] } {
    const sent: Sent[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Sent;
      sent.push(request);
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  function storedMark(id: string, quoted: string, page = 1) {
    return {
      id,
      version: 2,
      content_hash: `sha256:${"c".repeat(64)}`,
      title: quoted,
      updated_at: "2026-08-27T12:00:00.000Z",
      tags: [],
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page,
        page_label: String(page),
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted,
        comment: "",
        image_asset_id: null,
      },
    };
  }

  /** A file whose every page says one thing, so a quotation either survives it or does not. */
  function documentSaying(text: string): PdfDocument {
    return stubDocument({
      page: vi.fn(async () =>
        stubPage({
          textItems: vi.fn(async () => [{ text, left: 72, top: 96, width: 300, height: 14 }]),
        }),
      ),
    });
  }

  async function readerOf(document: PdfDocument, marks: unknown[]) {
    const bridge = bridgeWith(marks);
    const { loader } = readerWith(document);
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable
        loader={loader}
      />,
    );
    await screen.findByText("of 3");
    return bridge;
  }

  it("lists a mark whose passage is no longer in the file, and says so", async () => {
    // The preprint has been replaced by the published version, and a paragraph went with it.
    await readerOf(documentSaying("An entirely different paragraph."), [
      storedMark("annotation-1", "Attention is all you need"),
    ]);

    const lost = await screen.findByRole("region", { name: "Marks that lost their place" });
    expect(within(lost).getByText("Attention is all you need")).toBeTruthy();
    expect(within(lost).getByText("Not found in the file any more")).toBeTruthy();
  });

  it("leaves a mark whose passage is still there where it was", async () => {
    await readerOf(documentSaying("We show that attention is all you need."), [
      storedMark("annotation-1", "Attention is all you need"),
    ]);
    await screen.findByText("Attention is all you need");

    expect(screen.queryByRole("region", { name: "Marks that lost their place" })).toBeNull();
  });

  it("does not draw a mark that has lost its place on the page", async () => {
    // Its rectangles say where the passage used to be. A highlight drawn there would be a
    // misquotation Kiwi made on the reader's behalf, over words nobody chose.
    await readerOf(documentSaying("The method we describe here."), [
      storedMark("annotation-1", "The method we describe here"),
      storedMark("annotation-2", "A sentence that has gone"),
    ]);
    await screen.findByRole("region", { name: "Marks that lost their place" });

    expect(
      screen.getByRole("button", { name: "highlight The method we describe here" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "highlight A sentence that has gone" })).toBeNull();
  });

  it("keeps an orphan rather than deleting it, and leaves the deleting to the reader", async () => {
    const { sent } = await readerOf(documentSaying("Nothing of the sort."), [
      storedMark("annotation-1", "Attention is all you need"),
    ]);
    const lost = await screen.findByRole("region", { name: "Marks that lost their place" });

    expect(within(lost).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(sent.some((entry) => entry.command === "kiwi.object.trash")).toBe(false);
  });

  it("keeps a mark on a page the file no longer has", async () => {
    // A twelve page preprint cut to three. Page nine is gone, and the mark on it must not be.
    await readerOf(documentSaying("Whatever the first pages say."), [
      storedMark("annotation-1", "A passage on page nine", 9),
    ]);

    const lost = await screen.findByRole("region", { name: "Marks that lost their place" });
    expect(within(lost).getByText("A passage on page nine")).toBeTruthy();
  });
});

describe("marks other people made", () => {
  const ADA = "account:ada";
  const WEI = "account:wei";

  function bridgeWith(marks: unknown[], members: unknown[]): void {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed" as const,
      };
      if (request.command === "kiwi.annotation.list")
        return { ...base, data: { annotations: marks } };
      return { ...base, data: {} };
    });
    window.kiwiDesktop = {
      invokeCommand,
      getAccountAuthState: async () => ({
        status: "authenticated",
        account: { id: "ada", email: "ada@example.org", email_verified: true },
        connection: "online",
      }),
      manageWorkspaceCollaboration: async () => ({
        status: "ok",
        settings: {
          workspace: { id: "workspace-1", title: "Reading group", role: "owner" },
          members,
          invitations: [],
        },
      }),
    } as unknown as RendererBridge;
  }

  function member(userId: string, name: string, email: string) {
    return { user_id: userId, email, display_name: name, phone: null, role: "member" };
  }

  function markBy(author: string, id: string, quoted: string) {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"f".repeat(64)}`,
      title: quoted,
      updated_at: "2026-08-27T12:00:00.000Z",
      tags: [],
      created_by: author,
      annotation: {
        kind: "highlight",
        asset_id: "asset-1",
        page: 1,
        page_label: "1",
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted,
        comment: "",
        image_asset_id: null,
      },
    };
  }

  /** A file that says both passages, so nothing here is orphaned for a reason of its own. */
  function readingGroup(marks: unknown[]) {
    bridgeWith(marks, [
      member("ada", "Ada Lovelace", "ada@example.org"),
      member("wei", "Wei Zhang", "wei@example.org"),
    ]);
    const { loader } = readerWith(
      stubDocument({
        page: vi.fn(async () =>
          stubPage({
            textItems: vi.fn(async () => [
              {
                text: "Attention is all you need, and the method we describe here is the whole of it.",
                left: 72,
                top: 96,
                width: 300,
                height: 14,
              },
            ]),
          }),
        ),
      }),
    );
    render(
      <PdfReader
        workspaceId="workspace-1"
        assetId="asset-1"
        objectId="paper-1"
        writable
        loader={loader}
      />,
    );
    return screen.findByText("of 3");
  }

  it("says whose a mark is when it is not yours, and leaves your own unsigned", async () => {
    await readingGroup([
      markBy(ADA, "annotation-1", "Attention is all you need"),
      markBy(WEI, "annotation-2", "the method we describe here"),
    ]);

    // Their name is on their mark, and yours is on nothing: a byline on every row of your own
    // reading is your own name a hundred times over.
    expect(
      await screen.findByRole("button", { name: /^p\.\s*1\s*Wei Zhang\s*the method we describe/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^p\.\s*1\s*Attention is all you need$/ }),
    ).toBeTruthy();
    // You are still on the switches, where the point is to be able to turn yourself off.
    const people = screen.getByRole("group", { name: "Show marks by" });
    expect(within(people).getByRole("button", { name: /^You/ })).toBeTruthy();
  });

  it("turns one person's layer off, and back on again", async () => {
    await readingGroup([
      markBy(ADA, "annotation-1", "Attention is all you need"),
      markBy(WEI, "annotation-2", "the method we describe here"),
    ]);
    const people = await screen.findByRole("group", { name: "Show marks by" });
    const wei = within(people).getByRole("button", { name: /Wei Zhang/ });

    await userEvent.click(wei);
    // Off is off everywhere: not listed beside the page, and not drawn on it.
    expect(screen.queryByText("the method we describe here")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "highlight the method we describe here" }),
    ).toBeNull();
    // Yours stayed where it was. Hiding somebody is not a filter over the document.
    expect(screen.getByText("Attention is all you need")).toBeTruthy();

    await userEvent.click(wei);
    expect(screen.getByText("the method we describe here")).toBeTruthy();
  });

  it("draws somebody else's mark in their colour without changing the colour they chose", async () => {
    await readingGroup([markBy(WEI, "annotation-2", "the method we describe here")]);

    const drawn = await screen.findByRole("button", {
      name: "highlight the method we describe here",
    });
    // The mark is still the yellow Wei made it. What is added is an edge saying whose it is.
    expect(drawn.className).toContain("pdf-mark--yellow");
    expect(/pdf-mark--author-[1-6]\b/.test(drawn.className)).toBe(true);
  });

  it("offers no layers on a document only you have marked", async () => {
    // One person reading alone is not a choice of layers, and a switch with your own name on it
    // is a control that does nothing worth doing.
    await readingGroup([markBy(ADA, "annotation-1", "Attention is all you need")]);
    await screen.findByText("Attention is all you need");

    expect(screen.queryByRole("group", { name: "Show marks by" })).toBeNull();
  });
});
