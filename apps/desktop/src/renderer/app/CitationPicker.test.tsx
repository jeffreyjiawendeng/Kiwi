import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CitationPicker } from "./CitationPicker.js";
import { citationLabel } from "./citation-extension.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

interface Row {
  id: string;
  title: string;
  reference?: Record<string, unknown>;
}

const LOVELACE: Row = {
  id: "paper-1",
  title: "Notes on the Analytical Engine",
  reference: { kind: "article", authors: ["Ada Lovelace"], year: 1843, container: "Notes" },
};

const TURING: Row = {
  id: "paper-2",
  title: "Computing Machinery and Intelligence",
  reference: { kind: "article", authors: ["Alan Turing"], year: 1950, container: "Mind" },
};

function mount(objects: Row[] = [LOVELACE, TURING], style: "apa" | "ieee" = "apa") {
  const invokeCommand = vi.fn(async (envelope: unknown) => ({
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "committed" as const,
    data: (envelope as { command: string }).command === "kiwi.projection.list" ? { objects } : {},
  }));
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  const onInsert = vi.fn();
  const onCancel = vi.fn();
  render(
    <CitationPicker
      workspaceId="workspace-1"
      style={style}
      onInsert={onInsert}
      onCancel={onCancel}
    />,
  );
  return { invokeCommand, onInsert, onCancel };
}

describe("choosing a paper", () => {
  it("lists the Papers in the Library", async () => {
    mount();
    expect(await screen.findByText("Notes on the Analytical Engine")).toBeInTheDocument();
    expect(screen.getByText("Computing Machinery and Intelligence")).toBeInTheDocument();
  });

  it("filters by author, title, and year", async () => {
    mount();
    await screen.findByText("Notes on the Analytical Engine");
    await userEvent.type(screen.getByLabelText("Find a paper"), "turing");
    await waitFor(() =>
      expect(screen.queryByText("Notes on the Analytical Engine")).not.toBeInTheDocument(),
    );

    await userEvent.clear(screen.getByLabelText("Find a paper"));
    await userEvent.type(screen.getByLabelText("Find a paper"), "1843");
    await waitFor(() =>
      expect(screen.queryByText("Computing Machinery and Intelligence")).not.toBeInTheDocument(),
    );
  });

  it("inserts the link to the Paper rather than the words", async () => {
    // Storing "(Lovelace, 1843)" would freeze the citation at whatever style was current when
    // it was typed.
    const { onInsert } = mount();
    await userEvent.click(await screen.findByText("Notes on the Analytical Engine"));
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "paper-1", title: "Notes on the Analytical Engine" }),
      "",
    );
  });

  it("carries a page when one was given", async () => {
    const { onInsert } = mount();
    await screen.findByText("Notes on the Analytical Engine");
    await userEvent.type(screen.getByLabelText(/Page or section/u), "p. 45");
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith(expect.anything(), "p. 45");
  });

  it("shows how the citation will read in this style", async () => {
    mount();
    await screen.findByText("Notes on the Analytical Engine");
    expect(screen.getByText("(Lovelace, 1843)")).toBeInTheDocument();
  });

  it("shows a numeric style as a number", async () => {
    mount([LOVELACE], "ieee");
    await screen.findByText("Notes on the Analytical Engine");
    expect(screen.getByText("[1]")).toBeInTheDocument();
  });

  it("says what to do when the Library is empty", async () => {
    mount([]);
    expect(await screen.findByText(/no Papers in this project yet/u)).toBeInTheDocument();
  });

  it("distinguishes an empty Library from a filter that matched nothing", async () => {
    mount();
    await screen.findByText("Notes on the Analytical Engine");
    await userEvent.type(screen.getByLabelText("Find a paper"), "telepathy");
    expect(await screen.findByText("Nothing here matches that.")).toBeInTheDocument();
  });

  it("says so when a Paper has no authors recorded", async () => {
    mount([{ id: "paper-3", title: "Anonymous", reference: { kind: "article" } }]);
    expect(await screen.findByText("No authors recorded")).toBeInTheDocument();
  });

  it("can be abandoned", async () => {
    const { onCancel } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("asks the Library only for Papers", async () => {
    const { invokeCommand } = mount();
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    const args = (invokeCommand.mock.calls[0]?.[0] as { args: Record<string, unknown> }).args;
    expect(args["object_types"]).toEqual(["source"]);
  });
});

describe("what a citation shows", () => {
  const lookup = (label: string | null) => ({ label: () => label });

  it("prefers the live label, because the style may have changed", () => {
    expect(
      citationLabel(
        { objectId: "paper-1", key: "k", locator: "", label: "(Old, 1999)" },
        lookup("[3]"),
      ),
    ).toBe("[3]");
  });

  it("falls back to what was stored while the bibliography is still loading", () => {
    // Better than a flash of empty brackets on every document open.
    expect(
      citationLabel(
        { objectId: "paper-1", key: "k", locator: "", label: "(Lovelace, 1843)" },
        lookup(null),
      ),
    ).toBe("(Lovelace, 1843)");
  });

  it("marks a citation that resolves to nothing at all", () => {
    // An author who cannot see the break will submit the manuscript with it.
    expect(
      citationLabel({ objectId: "gone", key: "k", locator: "", label: "" }, lookup(null)),
    ).toBe("(?)");
  });
});
