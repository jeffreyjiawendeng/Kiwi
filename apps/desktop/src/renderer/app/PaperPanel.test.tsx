import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaperPanel, type PaperRecord } from "./PaperPanel.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

/** What the Library hands this panel: an index row, which carries no reference record. */
const ROW: PaperRecord = {
  id: "object-1",
  type: "source",
  title: "Attention Is All You Need",
  version: 3,
  content_hash: `sha256:${"a".repeat(64)}`,
};

const CANONICAL = {
  ...ROW,
  reference: { kind: "conference", authors: ["Vaswani, Ashish"], year: 2017 },
  summary: "Attention alone beats recurrence.",
};

/**
 * A stub that answers by command name, so a wrong name shows up as a missing field rather than
 * as the same payload arriving everywhere.
 */
function stub(
  overrides: Record<string, unknown> = {},
  files: unknown[] = [],
  missing: string[] = [],
) {
  return vi.fn(async (envelope: unknown) => {
    const command = (envelope as { command: string }).command;
    const data =
      command === "kiwi.object.read"
        ? { object: { ...CANONICAL, ...overrides } }
        : command === "kiwi.object.files"
          ? { files, missing }
          : {};
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data,
    };
  });
}

function panel(invokeCommand: ReturnType<typeof stub>, writable = true) {
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  render(
    <PaperPanel workspaceId="workspace-1" paper={ROW} writable={writable} onOpenFile={() => {}} />,
  );
}

/** Opens the menu holding everything a file can have done to it. */
async function openFileActions(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "File actions" }));
  return screen.getByRole("menu", { name: "File actions" });
}

function sent(invokeCommand: ReturnType<typeof stub>, command: string) {
  return invokeCommand.mock.calls
    .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
    .find((envelope) => envelope.command === command);
}

describe("a Paper's own summary", () => {
  it("reads the written fields off the object rather than off the index row", async () => {
    // The row the Library draws from holds no reference. A form seeded from it would open empty
    // over a Paper that has one, and saving would write the empty one back.
    const invokeCommand = stub();
    panel(invokeCommand);

    await screen.findByText("Attention alone beats recurrence.");
    await userEvent.click(screen.getByRole("button", { name: "Edit reference" }));
    expect(screen.getByLabelText("Authors")).toHaveValue("Vaswani, Ashish");
    expect(screen.getByLabelText("Year")).toHaveValue(2017);
  });

  it("will not open the reference form before the record has arrived", async () => {
    const invokeCommand = stub();
    panel(invokeCommand);

    expect(screen.getByRole("button", { name: "Edit reference" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit reference" })).toBeEnabled(),
    );
  });

  it("says there is no summary rather than showing an empty line", async () => {
    const invokeCommand = stub({ summary: "" });
    panel(invokeCommand);

    expect(await screen.findByText("No summary yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write a summary" })).toBeInTheDocument();
  });

  it("writes a summary and shows the line the command stored", async () => {
    const invokeCommand = stub({ summary: "" });
    panel(invokeCommand);

    await screen.findByText("No summary yet.");
    await userEvent.click(screen.getByRole("button", { name: "Write a summary" }));
    await userEvent.type(screen.getByLabelText("Summary"), "Attention alone beats recurrence.");
    await userEvent.click(screen.getByRole("button", { name: "Save summary" }));

    await screen.findByText("Summary saved.");
    expect(sent(invokeCommand, "kiwi.object.set-summary")?.args).toMatchObject({
      object_id: "object-1",
      expected_version: 3,
      summary: "Attention alone beats recurrence.",
    });
  });

  it("starts an edit from what is stored, and leaves it there when cancelled", async () => {
    const invokeCommand = stub();
    panel(invokeCommand);

    await screen.findByText("Attention alone beats recurrence.");
    await userEvent.click(screen.getByRole("button", { name: "Edit summary" }));
    expect(screen.getByLabelText("Summary")).toHaveValue("Attention alone beats recurrence.");

    await userEvent.clear(screen.getByLabelText("Summary"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Attention alone beats recurrence.")).toBeInTheDocument();
    expect(sent(invokeCommand, "kiwi.object.set-summary")).toBeUndefined();
  });

  it("keeps what was typed when the command refuses it", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const command = (envelope as { command: string }).command;
      if (command === "kiwi.object.set-summary") {
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: {
            code: "KIWI_CONFLICT_VERSION",
            message: "Somebody else changed this Paper. Reopen it and write the summary again.",
            details: {},
            retryable: false,
            recovery_actions: ["reload"],
            correlation_id: "correlation-1",
          },
        };
      }
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: command === "kiwi.object.read" ? { object: CANONICAL } : { files: [] },
      };
    });
    panel(invokeCommand as unknown as ReturnType<typeof stub>);

    await screen.findByText("Attention alone beats recurrence.");
    await userEvent.click(screen.getByRole("button", { name: "Edit summary" }));
    await userEvent.type(screen.getByLabelText("Summary"), " Reread it.");
    await userEvent.click(screen.getByRole("button", { name: "Save summary" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Somebody else changed this Paper");
    expect(screen.getByLabelText("Summary")).toHaveValue(
      "Attention alone beats recurrence. Reread it.",
    );
  });

  it("offers no summary to write on a workspace opened read-only", async () => {
    const invokeCommand = stub();
    panel(invokeCommand, false);

    await screen.findByText("Attention alone beats recurrence.");
    expect(screen.queryByRole("button", { name: "Edit summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit reference" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument();
  });
});

describe("the mark saying a Paper has been read", () => {
  it("marks an unread Paper read, and says which state it asked for", async () => {
    const invokeCommand = stub();
    panel(invokeCommand);

    await waitFor(() => expect(screen.getByRole("button", { name: "Mark read" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }));

    await screen.findByText("Marked read.");
    // The mark shares its line with the version, so it is read off that line rather than found
    // as a word of its own.
    expect(screen.getByText(/^Read/u)).toBeInTheDocument();
    expect(sent(invokeCommand, "kiwi.object.set-read")?.args).toMatchObject({
      object_id: "object-1",
      expected_version: 3,
      read: true,
    });
  });

  it("offers to unmark a Paper the workspace already has a mark on", async () => {
    const invokeCommand = stub({ read: true });
    panel(invokeCommand);

    // The mark is on the object, not on the index row this panel opened from, so the button has
    // to wait for the record before it can say what the click will do.
    await screen.findByRole("button", { name: "Mark unread" });
    await userEvent.click(screen.getByRole("button", { name: "Mark unread" }));

    await screen.findByText("Marked unread.");
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(sent(invokeCommand, "kiwi.object.set-read")?.args).toMatchObject({ read: false });
  });

  it("marks against the version the workspace last returned, not the row it opened from", async () => {
    const marked = {
      ...CANONICAL,
      read: true,
      version: 4,
      content_hash: `sha256:${"b".repeat(64)}`,
    };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const sending = envelope as { command: string };
      const data =
        sending.command === "kiwi.object.read"
          ? { object: CANONICAL }
          : sending.command === "kiwi.object.set-read"
            ? { object: marked }
            : sending.command === "kiwi.object.files"
              ? { files: [] }
              : {};
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data,
      };
    });
    panel(invokeCommand as unknown as ReturnType<typeof stub>);

    await waitFor(() => expect(screen.getByRole("button", { name: "Mark read" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await screen.findByText("Marked read.");
    await userEvent.click(screen.getByRole("button", { name: "Mark unread" }));

    // Marking read and changing your mind is two writes to one Paper. The second one has to be
    // made against what the first produced, or it is a conflict over an edit nobody else made.
    const marks = invokeCommand.mock.calls
      .map(([sending]) => sending as { command: string; args: Record<string, unknown> })
      .filter((sending) => sending.command === "kiwi.object.set-read");
    expect(marks.map((sending) => sending.args["expected_version"])).toEqual([3, 4]);
  });
});

describe("the file a Paper opens to", () => {
  const PREPRINT = {
    id: "asset-preprint",
    title: "preprint.pdf",
    original_filename: "preprint.pdf",
    byte_size: 900,
  };
  const PUBLISHED = {
    id: "asset-published",
    title: "published.pdf",
    original_filename: "published.pdf",
    byte_size: 1200,
  };

  /** Each file as one string, in the order the workspace attached them. */
  async function rows(): Promise<string[]> {
    const menu = await openFileActions();
    return [...menu.querySelectorAll(".paper-panel__file")].map((row) => row.textContent ?? "");
  }

  it("reads the one file it has, and says how big it is", async () => {
    const invokeCommand = stub({}, [PREPRINT]);
    panel(invokeCommand);

    // One file is not a choice, so it is the button rather than a list with one row in it.
    expect(await screen.findByRole("button", { name: "Read PDF \u00b7 900 B" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Read PDF" })).not.toBeInTheDocument();
  });

  it("says which file opens without offering a choice between one thing", async () => {
    const invokeCommand = stub({}, [PREPRINT]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: /^Read PDF/ });
    const menu = await openFileActions();
    expect(within(menu).getByText(/opens by default/)).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Open this one by default" }),
    ).not.toBeInTheDocument();
  });

  it("opens the first file attached until somebody says otherwise", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED]);
    panel(invokeCommand);

    // Nothing is stored on this Paper, so the preprint is the answer for the same reason it was
    // the answer when it was the only file on it.
    await screen.findByRole("button", { name: "Read PDF" });
    const listed = await rows();
    expect(listed[0]).toContain("opens by default");
    expect(listed[1]).not.toContain("opens by default");
  });

  it("offers every file where there is more than one, with the default first", async () => {
    const invokeCommand = stub({}, [PUBLISHED, PREPRINT]);
    panel(invokeCommand);

    await userEvent.click(await screen.findByRole("button", { name: "Read PDF" }));
    const menu = screen.getByRole("menu", { name: "Read PDF" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["published.pdf \u00b7 1 KB", "preprint.pdf \u00b7 900 B"]);
  });

  it("chooses the published version over the preprint", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: "Read PDF" });
    let menu = await openFileActions();
    const actions = [...menu.querySelectorAll(".paper-panel__file")];
    await userEvent.click(
      within(actions[1] as HTMLElement).getByRole("menuitem", {
        name: "Open this one by default",
      }),
    );

    await screen.findByText("This is the file the Reader will open.");
    expect(sent(invokeCommand, "kiwi.object.set-primary-file")?.args).toMatchObject({
      object_id: "object-1",
      expected_version: 3,
      asset_id: "asset-published",
    });
    menu = await openFileActions();
    const after = [...menu.querySelectorAll(".paper-panel__file")].map(
      (row) => row.textContent ?? "",
    );
    expect(after[1]).toContain("opens by default");
    expect(after[0]).not.toContain("opens by default");
  });

  it("opens what is still attached when the chosen file has been detached", async () => {
    // Detaching does not write the Paper, so the name it carries can outlive the file. The panel
    // works the answer out from what is attached rather than offering a file that is not there.
    const invokeCommand = stub({ primary_asset_id: "asset-published" }, [PREPRINT]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: /^Read PDF/ });
    const listed = await rows();
    expect(listed[0]).toContain("preprint.pdf");
    expect(listed[0]).toContain("opens by default");
  });

  it("offers no choice of file on a workspace opened read-only", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED]);
    panel(invokeCommand, false);

    await screen.findByRole("button", { name: "Read PDF" });
    const menu = await openFileActions();
    expect(
      within(menu).queryByRole("menuitem", { name: "Open this one by default" }),
    ).not.toBeInTheDocument();
    // Which one opens is still worth saying on a workspace nobody can write to.
    expect(within(menu).getByText(/opens by default/)).toBeInTheDocument();
  });

  it("says a file is missing before the Reader is asked to draw it", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED], ["asset-published"]);
    panel(invokeCommand);

    await userEvent.click(await screen.findByRole("button", { name: "Read PDF" }));
    const menu = screen.getByRole("menu", { name: "Read PDF" });
    expect(within(menu).getByRole("menuitem", { name: /published.pdf/ })).toBeDisabled();
    // The rest of the Paper is unaffected. One file being gone is not the Paper being broken.
    expect(within(menu).getByRole("menuitem", { name: /preprint.pdf/ })).toBeEnabled();
  });

  it("says so on the button when the only file is the one that is missing", async () => {
    const invokeCommand = stub({}, [PREPRINT], ["asset-preprint"]);
    panel(invokeCommand);

    const read = await screen.findByRole("button", { name: "File is missing" });
    expect(read).toBeDisabled();
  });

  it("offers no default to a file nothing can open, but still offers to detach it", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED], ["asset-published"]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: "Read PDF" });
    const menu = await openFileActions();
    const row = within([...menu.querySelectorAll(".paper-panel__file")][1] as HTMLElement);
    expect(row.getByText("File is missing")).toBeInTheDocument();
    expect(
      row.queryByRole("menuitem", { name: "Open this one by default" }),
    ).not.toBeInTheDocument();
    // Detaching is how somebody says the Paper was never really about that file, and it works
    // whether or not the bytes are there to detach from.
    expect(row.getByRole("menuitem", { name: "Detach" })).toBeEnabled();
  });

  it("says both when the file that opens by default is the one that is missing", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED], ["asset-preprint"]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: "Read PDF" });
    const listed = await rows();
    // The default does not quietly move to the file that still works. It would read as though
    // nothing were wrong, and the file somebody meant to read would be the one nobody mentions.
    expect(listed[0]).toContain("opens by default");
    expect(listed[0]).toContain("File is missing");
    expect(listed[1]).not.toContain("opens by default");
  });

  it("hands a file to the system without asking the workspace to change", async () => {
    const invokeCommand = stub({}, [PREPRINT]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: /^Read PDF/ });
    const menu = await openFileActions();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open outside Kiwi" }));

    expect(sent(invokeCommand, "kiwi.asset.open-managed")?.args).toEqual({
      asset_id: "asset-preprint",
    });
    await screen.findByText("Handed to the application the system uses for this file.");
  });

  it("offers the escape hatch on a workspace opened read-only", async () => {
    const invokeCommand = stub({}, [PREPRINT]);
    panel(invokeCommand, false);

    // Reading a file outside Kiwi writes nothing, and a workspace nobody can write to is exactly
    // where somebody is most likely to be stuck with a file Kiwi will not draw.
    await screen.findByRole("button", { name: /^Read PDF/ });
    const menu = await openFileActions();
    expect(within(menu).getByRole("menuitem", { name: "Open outside Kiwi" })).toBeEnabled();
  });

  it("will not offer to open a file that is not there", async () => {
    const invokeCommand = stub({}, [PREPRINT, PUBLISHED], ["asset-published"]);
    panel(invokeCommand);

    await screen.findByRole("button", { name: "Read PDF" });
    const menu = await openFileActions();
    const listed = [...menu.querySelectorAll(".paper-panel__file")];
    // The escape hatch is a way out of Kiwi, not a way out of the file being gone.
    expect(
      within(listed[1] as HTMLElement).queryByRole("menuitem", { name: "Open outside Kiwi" }),
    ).not.toBeInTheDocument();
    expect(
      within(listed[0] as HTMLElement).getByRole("menuitem", { name: "Open outside Kiwi" }),
    ).toBeEnabled();
  });

  it("says a Paper has no file rather than offering to read nothing", async () => {
    const invokeCommand = stub({}, []);
    panel(invokeCommand);

    expect(await screen.findByRole("button", { name: "No file attached" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attach a PDF" })).toBeEnabled();
  });
});

describe("a DOI that is already in the library", () => {
  /** A workspace that answers the duplicate question with whatever this test wants found. */
  function stubWithMatches(matches: unknown[]) {
    return vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      const data =
        request.command === "kiwi.object.read"
          ? { object: CANONICAL }
          : request.command === "kiwi.object.files"
            ? { files: [], missing: [] }
            : request.command === "kiwi.object.doi-matches"
              ? { doi: request.args["doi"], matches }
              : {};
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "no_change",
        data,
      };
    });
  }

  async function enterDoi(invokeCommand: ReturnType<typeof stub>, doi: string) {
    panel(invokeCommand);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit reference" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit reference" }));
    await userEvent.click(screen.getByLabelText("DOI"));
    if (doi !== "") await userEvent.type(screen.getByLabelText("DOI"), doi);
    // Leaving the field is what asks the question. A check on every keystroke would ask the
    // workspace about eleven prefixes of one number.
    await userEvent.tab();
  }

  it("names the paper already carrying the DOI, and asks about nothing else", async () => {
    const invokeCommand = stubWithMatches([
      { id: "object-2", title: "Attention Is All You Need", year: 2017 },
    ]);
    await enterDoi(invokeCommand, "10.1000/xyz123");

    expect(
      await screen.findByText(/Another paper in this library has this DOI/u),
    ).toHaveTextContent("Attention Is All You Need (2017)");
    // The Paper being edited is excluded by name, so re-saving a record does not report itself.
    expect(sent(invokeCommand, "kiwi.object.doi-matches")?.args).toEqual({
      doi: "10.1000/xyz123",
      object_id: "object-1",
    });
  });

  it("saves the reference anyway", async () => {
    const invokeCommand = stubWithMatches([
      { id: "object-2", title: "The other copy", year: null },
    ]);
    await enterDoi(invokeCommand, "10.1000/xyz123");
    await screen.findByText(/Another paper in this library has this DOI/u);
    await userEvent.click(screen.getByRole("button", { name: "Save reference" }));

    // A duplicate is a remark, not a refusal: two records under one DOI is sometimes deliberate,
    // and a save that refused would leave somebody holding the correct DOI unable to write it down.
    expect(await screen.findByText("Reference saved.")).toBeInTheDocument();
    expect(sent(invokeCommand, "kiwi.object.set-reference")?.args).toMatchObject({
      reference: expect.objectContaining({ doi: "10.1000/xyz123" }),
    });
  });

  it("says nothing when the field is left empty", async () => {
    const invokeCommand = stubWithMatches([
      { id: "object-2", title: "The other copy", year: null },
    ]);
    await enterDoi(invokeCommand, "");

    expect(sent(invokeCommand, "kiwi.object.doi-matches")).toBeUndefined();
    expect(screen.queryByText(/has this DOI/u)).not.toBeInTheDocument();
  });

  it("keeps quiet when the workspace will not answer", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const command = (envelope as { command: string }).command;
      if (command === "kiwi.object.doi-matches")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: { code: "KIWI_FORBIDDEN", message: "Open a workspace." },
        };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "no_change",
        data: command === "kiwi.object.read" ? { object: CANONICAL } : { files: [], missing: [] },
      };
    });
    await enterDoi(invokeCommand as ReturnType<typeof stub>, "10.1000/xyz123");

    // This is a remark beside a field that saves either way. An alarm about a failed remark
    // would be worse than the silence.
    expect(screen.queryByText(/has this DOI/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("what has already been made of a Paper", () => {
  /** The index's answer: one note, reached through a highlight on this paper. */
  function withQuoting() {
    return vi.fn(async (envelope: unknown) => {
      const command = (envelope as { command: string }).command;
      const data =
        command === "kiwi.object.read"
          ? { object: CANONICAL }
          : command === "kiwi.object.files"
            ? { files: [], missing: [] }
            : command === "kiwi.projection.links"
              ? {
                  links: [
                    {
                      relation_id: "relation-1",
                      relation_type: "quotes",
                      direction: "incoming",
                      object_id: "note-1",
                      object_type: "note",
                      title: "Reading group, week three",
                      via: { object_id: "annotation-1", title: "attention is all you need" },
                    },
                  ],
                }
              : {};
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data,
      };
    });
  }

  it("lists the Notes that quote it", async () => {
    const invokeCommand = withQuoting();
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<PaperPanel workspaceId="workspace-1" paper={ROW} onOpenFile={() => {}} />);
    expect(await screen.findByText("Reading group, week three")).toBeInTheDocument();
    expect(screen.getByText("Note · quotes this")).toBeInTheDocument();
  });

  it("opens the Note that quoted it", async () => {
    const invokeCommand = withQuoting();
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onOpenObject = vi.fn();
    render(
      <PaperPanel
        workspaceId="workspace-1"
        paper={ROW}
        onOpenFile={() => {}}
        onOpenObject={onOpenObject}
      />,
    );
    await userEvent.click(await screen.findByText("Reading group, week three"));
    expect(onOpenObject).toHaveBeenCalledWith("note-1", "note");
  });
});
