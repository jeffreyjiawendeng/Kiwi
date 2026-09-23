import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BibliographyPage, type BibliographyData } from "./BibliographyPage.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

function data(overrides: Partial<BibliographyData> = {}): BibliographyData {
  return {
    style: "apa",
    numbered: false,
    entries: [
      {
        id: "paper-1",
        key: "lovelace1843",
        number: 1,
        title: "Notes on the Analytical Engine",
        text: "Lovelace, A. (1843). Notes on the Analytical Engine. Notes.",
        segments: [
          { text: "Lovelace, A. (1843). Notes on the Analytical Engine. " },
          { text: "Notes", italic: true },
          { text: "." },
        ],
        in_text: "(Lovelace, 1843)",
        count: 1,
        incomplete: [],
      },
    ],
    broken: [],
    uncited: [],
    bibtex: "@article{lovelace1843,\n  title = {Notes on the Analytical Engine}\n}\n",
    ...overrides,
  };
}

/** The Paper an entry stands for, as `kiwi.object.read` returns it. */
const PAPER = {
  id: "paper-1",
  type: "source",
  title: "Notes on the Analytical Engine",
  version: 3,
  content_hash: "hash-3",
  reference: {
    kind: "article",
    authors: ["Lovelace, Ada"],
    container: "Notes",
    year: 1843,
  },
};

function mount(
  view: BibliographyData | null = data(),
  manuscriptId: string | null = "draft-1",
  /** The one command that answers with a refusal, for the paths that have to survive one. */
  refusing: string | null = null,
) {
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const { command } = envelope as { command: string };
    const answer =
      command === "kiwi.bibliography.for-document"
        ? ((view ?? {}) as unknown as Record<string, unknown>)
        : command === "kiwi.object.read"
          ? { object: PAPER }
          : {};
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed" as const,
      data: answer,
      ...(command === refusing
        ? { error: { code: "KIWI_CONFLICT", message: "Someone else changed that Paper." } }
        : {}),
    };
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  const onOpenObject = vi.fn();
  render(
    <BibliographyPage
      workspaceId="workspace-1"
      style="apa"
      manuscriptId={manuscriptId}
      manuscriptTitle="the draft"
      onOpenObject={onOpenObject}
    />,
  );
  return { invokeCommand, onOpenObject };
}

describe("the reference list", () => {
  it("shows what the manuscript cites, formatted", async () => {
    mount();
    expect(await screen.findByText(/Lovelace, A. \(1843\)/u)).toBeInTheDocument();
  });

  it("italicises the container rather than printing markup", async () => {
    mount();
    const entry = await screen.findByRole("button", { name: "Notes on the Analytical Engine" });
    expect(within(entry).getByText("Notes").tagName).toBe("EM");
  });

  it("opens the Paper an entry stands for", async () => {
    const { onOpenObject } = mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Notes on the Analytical Engine" }),
    );
    expect(onOpenObject).toHaveBeenCalledWith("paper-1", "source");
  });

  it("asks for the list belonging to this manuscript", async () => {
    const { invokeCommand } = mount();
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect((invokeCommand.mock.calls[0]?.[0] as { args: Record<string, unknown> }).args).toEqual({
      object_id: "draft-1",
      style: "apa",
    });
  });

  it("says how often each work is cited, which the entry itself cannot", async () => {
    // A source carrying half the argument and one cited in passing are the same line here.
    mount(data({ entries: [{ ...data().entries[0]!, count: 3 }] }));
    expect(await screen.findByText(/Cited 3 times as \(Lovelace, 1843\)/u)).toBeInTheDocument();
  });

  it("counts one citation as one", async () => {
    mount();
    expect(await screen.findByText(/Cited once/u)).toBeInTheDocument();
  });
});

describe("copying one citation", () => {
  function clipboard() {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }

  it("copies the formatted reference for pasting elsewhere", async () => {
    const writeText = clipboard();
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Copy the reference for Notes on the Analytical Engine",
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Lovelace, A. (1843). Notes on the Analytical Engine. Notes.",
      ),
    );
  });

  it("copies the in-text form, which is the other thing a person wants", async () => {
    const writeText = clipboard();
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Copy the in-text citation for Notes on the Analytical Engine",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("(Lovelace, 1843)"));
  });

  it("copies the reference without touching the BibTeX file below", async () => {
    // Both used to be one flag, so copying an entry claimed the whole file had been copied.
    const writeText = clipboard();
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Copy the reference for Notes on the Analytical Engine",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});

describe("fixing an entry here", () => {
  async function openForm(refusing: string | null = null) {
    const mounted = mount(
      data({ entries: [{ ...data().entries[0]!, incomplete: ["year"] }] }),
      "draft-1",
      refusing,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Fix the details for Notes on the Analytical Engine",
      }),
    );
    return mounted;
  }

  it("reads the Paper and fills the form from it", async () => {
    await openForm();
    expect(await screen.findByLabelText("Authors")).toHaveValue("Lovelace, Ada");
    expect(screen.getByLabelText("Year")).toHaveValue(1843);
  });

  it("saves against the version it read, so a stale correction fails rather than overwrites", async () => {
    const { invokeCommand } = await openForm();
    await screen.findByLabelText("Year");
    await userEvent.clear(screen.getByLabelText("Year"));
    await userEvent.type(screen.getByLabelText("Year"), "1844");
    await userEvent.click(screen.getByRole("button", { name: "Save reference" }));

    const saved = invokeCommand.mock.calls
      .map((call) => call[0] as { command: string; args: Record<string, unknown> })
      .find((envelope) => envelope.command === "kiwi.object.set-reference");
    expect(saved?.args["expected_version"]).toBe(3);
    expect(saved?.args["expected_hash"]).toBe("hash-3");
    expect((saved?.args["reference"] as { year: number }).year).toBe(1844);
  });

  it("rebuilds the list, because the entry and its ordering come from what just changed", async () => {
    const { invokeCommand } = await openForm();
    await screen.findByLabelText("Year");
    const before = invokeCommand.mock.calls.filter(
      (call) => (call[0] as { command: string }).command === "kiwi.bibliography.for-document",
    ).length;
    await userEvent.click(screen.getByRole("button", { name: "Save reference" }));
    await waitFor(() =>
      expect(
        invokeCommand.mock.calls.filter(
          (call) => (call[0] as { command: string }).command === "kiwi.bibliography.for-document",
        ).length,
      ).toBe(before + 1),
    );
  });

  it("says why a refused correction was refused", async () => {
    await openForm("kiwi.object.set-reference");
    await screen.findByLabelText("Year");
    await userEvent.click(screen.getByRole("button", { name: "Save reference" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed that Paper.");
    // The form stays open, holding the correction, rather than discarding it.
    expect(screen.getByLabelText("Year")).toBeInTheDocument();
  });

  it("does not open a form it could not read a Paper for", async () => {
    await openForm("kiwi.object.read");
    expect(await screen.findByRole("alert")).toHaveTextContent("could not read that Paper");
    expect(screen.queryByLabelText("Year")).not.toBeInTheDocument();
  });
});

describe("an empty list", () => {
  it("instructs rather than showing an empty list", async () => {
    mount(data({ entries: [] }));
    expect(await screen.findByText(/cites nothing yet/u)).toBeInTheDocument();
  });

  it("explains that a reference list belongs to a manuscript", () => {
    mount(data(), null);
    expect(screen.getByText(/belongs to a manuscript/u)).toBeInTheDocument();
  });
});

describe("what is wrong with it", () => {
  it("names a citation whose Paper has been deleted", async () => {
    // Left alone this reaches the submitted manuscript.
    mount(data({ broken: [{ object_id: "paper-9", reason: "deleted" }] }));
    expect(await screen.findByText("Broken citations")).toBeInTheDocument();
    expect(screen.getByText(/has been deleted/u)).toBeInTheDocument();
  });

  it("explains a Paper with no bibliographic record", async () => {
    mount(data({ broken: [{ object_id: "paper-9", reason: "no_reference" }] }));
    expect(await screen.findByText(/no bibliographic record/u)).toBeInTheDocument();
  });

  it("says nothing about breakage when there is none", async () => {
    mount();
    await screen.findByRole("button", { name: "Notes on the Analytical Engine" });
    expect(screen.queryByText("Broken citations")).not.toBeInTheDocument();
  });

  it("says which fields an entry is still missing", async () => {
    mount(
      data({
        entries: [{ ...data().entries[0]!, incomplete: ["year", "authors"] }],
      }),
    );
    expect(await screen.findByText(/Missing year, authors/u)).toBeInTheDocument();
  });

  it("lists what is in the Library but never cited", async () => {
    mount(data({ uncited: [{ id: "paper-2", title: "Read but not cited" }] }));
    expect(await screen.findByText(/In the Library, not cited \(1\)/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read but not cited" })).toBeInTheDocument();
  });
});

describe("BibTeX", () => {
  it("shows the file, so it can be copied by hand if the clipboard refuses", async () => {
    mount();
    expect(await screen.findByText(/@article\{lovelace1843/u)).toBeInTheDocument();
  });

  it("copies to the clipboard and says it did", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("does not claim to have copied when the clipboard refused", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });
});
