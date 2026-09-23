import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReaderSplit, type ReaderDocument } from "./ReaderSplit.js";
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
});

function stubDocument(): PdfDocument {
  const page: PdfPage = {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async (): Promise<PdfTextItem[]> => []),
  };
  return {
    pageCount: 3,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => page),
    outline: vi.fn(async (): Promise<PdfOutlineEntry[]> => []),
    metadata: vi.fn(async () => ({})),
    destroy: vi.fn(),
  };
}

const PAPERS: ReaderDocument[] = [
  { assetId: "asset-a", title: "Method", objectId: "paper-a" },
  { assetId: "asset-b", title: "Reply", objectId: "paper-b" },
  { assetId: "asset-c", title: "Supplement", objectId: "paper-c" },
];

function open(documents: readonly ReaderDocument[], active: string) {
  const loader = vi.fn<PdfLoader>(async () => stubDocument());
  const onDetach = vi.fn<(document: ReaderDocument) => void>();
  const view = render(
    <ReaderSplit
      workspaceId="workspace-1"
      documents={documents}
      activeDocument={active}
      onDetach={onDetach}
      loader={loader}
    />,
  );
  const show = (next: readonly ReaderDocument[], selected: string): void => {
    view.rerender(
      <ReaderSplit
        workspaceId="workspace-1"
        documents={next}
        activeDocument={selected}
        onDetach={onDetach}
        loader={loader}
      />,
    );
  };
  /** The Detach button of the pane showing one document. */
  const detachOf = (assetId: string): HTMLElement => {
    const pane = view.container.querySelector(`[data-document="${assetId}"]`);
    const button = pane?.querySelector('button[aria-label="Open in a new window"]');
    if (button === null || button === undefined) throw new Error(`No Detach in ${assetId}`);
    return button as HTMLElement;
  };
  /** Which document each side is showing, left first. */
  const sides = (): (string | null)[] =>
    [...view.container.querySelectorAll(".reader-split__pane")].map((pane) =>
      pane.getAttribute("data-document"),
    );
  return { loader, onDetach, show, sides, detachOf };
}

describe("reading one document", () => {
  it("has nothing to compare against when it is the only one open", async () => {
    open([PAPERS[0] as ReaderDocument], "asset-a");

    expect(await screen.findByLabelText("Method reader")).toBeInTheDocument();
    const compare = screen.getByRole("button", { name: "Compare" });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute("title", "Open a second document to compare this one against");
  });

  it("offers the comparison as soon as a second document is open", async () => {
    open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");

    expect(screen.getByRole("button", { name: "Compare" })).toBeEnabled();
    // Offered, not taken: one document stays one document until it is asked for.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});

describe("reading two documents side by side", () => {
  it("puts a second document beside the first", async () => {
    const { sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");

    await userEvent.click(screen.getByRole("button", { name: "Compare" }));

    // The selected tab stays on the left; the comparison arrives on the right.
    expect(await screen.findByLabelText("Supplement reader")).toBeInTheDocument();
    expect(screen.getByLabelText("Method reader")).toBeInTheDocument();
    expect(sides()).toEqual(["asset-a", "asset-c"]);
  });

  it("reads both documents by id, never by a path", async () => {
    const { loader } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    await waitFor(() =>
      expect(loader.mock.calls.map(([url]) => url)).toEqual([
        "kiwi-asset://workspace-1/asset-a",
        "kiwi-asset://workspace-1/asset-c",
      ]),
    );
  });

  it("changes what is beside it without disturbing the document being read", async () => {
    const { sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    await userEvent.selectOptions(screen.getByLabelText("Beside it"), "asset-b");

    expect(await screen.findByLabelText("Reply reader")).toBeInTheDocument();
    expect(sides()).toEqual(["asset-a", "asset-b"]);
    // The document being compared against is the only choice offered: the one already on the
    // left is not something to put beside itself.
    expect(screen.getByLabelText("Beside it")).not.toHaveTextContent("Method");
  });

  it("swaps the sides when the tab of the document on the right is selected", async () => {
    const { show, sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    show(PAPERS, "asset-c");

    // Never the same document twice: it moved across, and the paper it was beside stayed.
    await waitFor(() => expect(sides()).toEqual(["asset-c", "asset-a"]));
    expect(screen.getByLabelText("Method reader")).toBeInTheDocument();
    expect(screen.getByLabelText("Supplement reader")).toBeInTheDocument();
  });

  it("keeps the comparison when some other tab is selected", async () => {
    const { show, sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    show(PAPERS, "asset-b");

    await waitFor(() => expect(sides()).toEqual(["asset-b", "asset-c"]));
  });

  it("closes the comparison when the compared document is closed", async () => {
    const { show, sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    show([PAPERS[0] as ReaderDocument, PAPERS[1] as ReaderDocument], "asset-a");

    // Reaching for some other tab would put a document nobody asked for beside this one.
    await waitFor(() => expect(sides()).toEqual(["asset-a"]));
    expect(screen.queryByLabelText("Supplement reader")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
  });

  it("closes the comparison when asked", async () => {
    const { sides } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    await userEvent.click(screen.getByRole("button", { name: "Close comparison" }));

    expect(sides()).toEqual(["asset-a"]);
    expect(screen.getByLabelText("Method reader")).toBeInTheDocument();
  });
});

describe("dividing the width between them", () => {
  it("starts even and moves with the arrow keys", async () => {
    open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));

    const handle = await screen.findByRole("separator", { name: "Width of the left document" });
    expect(handle).toHaveAttribute("aria-valuenow", "50");

    handle.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "58");
    await userEvent.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "54");
    await userEvent.keyboard("{Home}");
    expect(handle).toHaveAttribute("aria-valuenow", "50");
  });

  it("never lets either document become a sliver", async () => {
    open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));

    const handle = await screen.findByRole("separator", { name: "Width of the left document" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight>20/}");
    expect(handle).toHaveAttribute("aria-valuenow", "80");
  });
});

describe("moving a document into a window of its own", () => {
  it("offers each side its own window", async () => {
    const { onDetach, detachOf } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByLabelText("Supplement reader");

    // Either of the two, and no doubt about which: the button is inside the pane it belongs to.
    await userEvent.click(detachOf("asset-c"));

    expect(onDetach).toHaveBeenCalledWith(PAPERS[2]);
  });

  it("detaches the document being read when it is the only one", async () => {
    const { onDetach, detachOf } = open(PAPERS, "asset-a");
    await screen.findByLabelText("Method reader");

    await userEvent.click(detachOf("asset-a"));

    expect(onDetach).toHaveBeenCalledWith(PAPERS[0]);
  });
});
