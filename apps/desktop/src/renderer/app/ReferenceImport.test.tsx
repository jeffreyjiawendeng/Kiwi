import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReferenceImport } from "./ReferenceImport.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";
import type { PdfDocument, PdfLoader } from "./pdf-document.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

function answer(data: Record<string, unknown>): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request-1",
    status: "committed",
    data,
  };
}

function refused(message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request-1",
    status: "failed",
    error: {
      code: "KIWI_UNAVAILABLE",
      message,
      details: {},
      retryable: true,
      recovery_actions: ["retry"],
      correlation_id: "correlation-1",
    },
  };
}

function previewRow(row: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    row,
    key: `entry-${String(row)}`,
    title: `Paper ${String(row)}`,
    reference: { kind: "article", authors: ["Vaswani, A."], year: 2017, container: "NeurIPS" },
    file_hash: null,
    selected: true,
    duplicate: null,
    problems: [],
    missing: [],
    ...over,
  };
}

/** The receipt the import command answers with, for whatever rows the request carried. */
function receiptFor(entries: unknown): Record<string, unknown> {
  const rows = Array.isArray(entries) ? entries : [];
  return {
    created: rows.map((entry, index) => ({
      id: `object-${String(index)}`,
      title: (entry as { title: string }).title,
      // Said back exactly as it was sent, which is what the receipt is for: the row a Paper came
      // from is the only way its file can be put on it.
      key: (entry as { key?: string }).key,
      duplicate: null,
    })),
    skipped: [],
    found: rows.length,
    reviewed: true,
  };
}

function installBridge(
  options: {
    preview?: Record<string, unknown>;
    importCommand?: (args: Record<string, unknown>) => RendererCommandResult;
    file?: { id: string; name: string } | null;
  } = {},
) {
  const chooseReferenceFile = vi.fn(async () =>
    options.file === undefined
      ? {
          id: "selection-1",
          name: "library.bib",
          size: 4_096,
          modifiedAt: "2026-08-26T12:00:00.000Z",
          declaredMediaType: null,
        }
      : options.file,
  );
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const record = envelope as { command: string; args: Record<string, unknown> };
    if (record.command === "kiwi.bibliography.import-preview")
      return answer(options.preview ?? { found: 1, rows: [previewRow(1)] });
    if (record.command === "kiwi.bibliography.import")
      return options.importCommand === undefined
        ? answer(receiptFor(record.args["entries"]))
        : options.importCommand(record.args);
    // Whatever else the fields beside a row ask about while it is being corrected.
    return answer({ matches: [] });
  });
  const registerDroppedManagedAsset = vi.fn(async () => ({
    id: "selection-drop",
    name: "dropped.bib",
    size: 2_048,
    modifiedAt: "2026-08-26T12:00:00.000Z",
    declaredMediaType: null,
  }));
  window.kiwiDesktop = {
    chooseReferenceFile,
    registerDroppedManagedAsset,
    invokeCommand,
  } as unknown as RendererBridge;
  return { chooseReferenceFile, registerDroppedManagedAsset, invokeCommand };
}

function mount(
  onImported = vi.fn(),
  props: Record<string, unknown> = {},
): { onImported: ReturnType<typeof vi.fn> } {
  render(
    <ReferenceImport
      workspaceId="workspace-1"
      writable
      onClose={vi.fn()}
      onImported={onImported}
      {...props}
    />,
  );
  return { onImported };
}

async function chooseFile(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
  await screen.findByRole("list", { name: "References to import" });
}

describe("importing a reference library", () => {
  it("reads the file it was given and lists what it would add", async () => {
    const { invokeCommand } = installBridge({
      preview: {
        found: 2,
        rows: [
          previewRow(1),
          previewRow(2, {
            title: "Deep Residual Learning",
            reference: { kind: "article", authors: ["He, K.", "Zhang, X.", "Ren, S."] },
            missing: ["year", "container"],
          }),
        ],
      },
    });
    mount();

    await chooseFile();

    // Where the file is never crosses the bridge. What goes back is the identifier the picker
    // handed over, and the main process turns that into a path on the far side.
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.bibliography.import-preview",
        args: { selection_id: "selection-1" },
      }),
    );
    expect(screen.getByText("library.bib")).toBeInTheDocument();
    expect(screen.getByText("2 references · 2 ticked")).toBeInTheDocument();
    expect(screen.getByText("Vaswani, A. · 2017 · NeurIPS")).toBeInTheDocument();
    // Three names is a list nobody reads on a row they are only identifying.
    expect(screen.getByText("He, K. and others")).toBeInTheDocument();
    // What the exporter left out, said as something to type in rather than as a field name.
    expect(screen.getByText("No year or venue.")).toBeInTheDocument();
  });

  it("shows what a row is a copy of, and leaves it unticked", async () => {
    installBridge({
      preview: {
        found: 2,
        rows: [
          previewRow(1),
          previewRow(2, {
            selected: false,
            duplicate: {
              where: "library",
              by: "doi",
              certain: true,
              object_id: "object-9",
              row: null,
              title: "Attention Is All You Need",
            },
          }),
        ],
      },
    });
    mount();

    await chooseFile();

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[1]!).getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByText('Already in the library as "Attention Is All You Need", with the same DOI.'),
    ).toBeInTheDocument();
    // The copy is unticked but the count still says so, because a person who came to import 2 and
    // leaves having imported 1 should be told before it happens, not after.
    expect(screen.getByText("2 references · 1 ticked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 1 paper" })).toBeEnabled();
  });

  it("creates only the rows still ticked, and says what it did", async () => {
    const { invokeCommand } = installBridge({
      preview: { found: 3, rows: [previewRow(1), previewRow(2), previewRow(3)] },
    });
    const { onImported } = mount();

    await chooseFile();
    await userEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Add 2 papers" }));

    await screen.findByText("2 papers added.");
    const sent = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .filter((envelope) => envelope.command === "kiwi.bibliography.import");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args["entries"]).toEqual([
      expect.objectContaining({ title: "Paper 1" }),
      expect.objectContaining({ title: "Paper 3" }),
    ]);
    // The rows are sent, not the file: the person has read them, and one of them is not going.
    expect(sent[0]?.args["selection_id"]).toBeUndefined();
    expect(sent[0]?.args["source_path"]).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: "Open the library" }));
    expect(onImported).toHaveBeenCalledWith(["object-0", "object-1"]);
  });

  it("says what was not created and why", async () => {
    installBridge({
      preview: { found: 3, rows: [previewRow(1), previewRow(2), previewRow(3)] },
      importCommand: () => ({
        ...answer({
          created: [{ id: "object-1", title: "Paper 1" }],
          skipped: [
            { title: "Paper 2", reason: "duplicate_doi", object_id: "object-9" },
            { title: "Paper 3", reason: "duplicate_doi", object_id: "object-8" },
          ],
          found: 3,
          reviewed: true,
        }),
      }),
    });
    mount();

    await chooseFile();
    await userEvent.click(screen.getByRole("button", { name: "Add 3 papers" }));

    // "1 added" would read as though one was all there was.
    await screen.findByText("1 of 3 rows added.");
    expect(
      screen.getByText("2 rows were not created, because the library already holds that DOI."),
    ).toBeInTheDocument();
  });

  it("sends a library too large for one request in parts, and reports one import", async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      previewRow(index + 1, {
        reference: { kind: "article", authors: [], year: 2024, abstract: "x".repeat(4_000) },
      }),
    );
    const { invokeCommand } = installBridge({ preview: { found: rows.length, rows } });
    mount();

    await chooseFile();
    await userEvent.click(screen.getByRole("button", { name: "Add 100 papers" }));

    await screen.findByText("100 papers added.");
    const sent = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .filter((envelope) => envelope.command === "kiwi.bibliography.import");
    expect(sent.length).toBeGreaterThan(1);
    // Cut into requests by the ceiling, added up into one answer. The person asked for one import.
    expect(sent.flatMap((envelope) => envelope.args["entries"] as unknown[])).toHaveLength(100);
  });

  it("stops when a part fails, and names the rows that never went", async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      previewRow(index + 1, {
        reference: { kind: "article", authors: [], year: 2024, abstract: "y".repeat(4_000) },
      }),
    );
    let calls = 0;
    const { invokeCommand } = installBridge({
      preview: { found: rows.length, rows },
      importCommand: (args) => {
        calls += 1;
        return calls === 1
          ? answer(receiptFor(args["entries"]))
          : refused("The workspace stopped responding.");
      },
    });
    mount();

    await chooseFile();
    await userEvent.click(screen.getByRole("button", { name: "Add 100 papers" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 }).textContent).toContain(
        "and the import stopped",
      ),
    );
    expect(screen.getByText(/were not sent\. The workspace stopped responding\./)).toBeVisible();
    // Further requests to a workspace that has just stopped answering are further ways to be
    // half-imported, so the parts after the failure are reported rather than attempted.
    const attempts = invokeCommand.mock.calls.filter(
      ([envelope]) => (envelope as { command: string }).command === "kiwi.bibliography.import",
    );
    expect(attempts).toHaveLength(2);
  });

  it("refuses a preview it cannot read whole rather than showing part of it", async () => {
    installBridge({ preview: { found: 2, rows: [previewRow(1), { row: 2 }] } });
    mount();

    await userEvent.click(screen.getByRole("button", { name: "Choose a file…" }));

    expect(
      await screen.findByText(
        "Kiwi read that file but could not show what is in it. Choose it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "References to import" })).not.toBeInTheDocument();
  });

  it("passes on what the workspace said when the file could not be read", async () => {
    const chooseReferenceFile = vi.fn(async () => ({
      id: "selection-1",
      name: "library.bib",
      size: 10,
      modifiedAt: "2026-08-26T12:00:00.000Z",
      declaredMediaType: null,
    }));
    window.kiwiDesktop = {
      chooseReferenceFile,
      invokeCommand: vi.fn(async () => refused("No references were found in that file.")),
    } as unknown as RendererBridge;
    mount();

    await userEvent.click(screen.getByRole("button", { name: "Choose a file…" }));

    expect(
      await screen.findByText(
        "No references were found in that file. Choose a file again to retry.",
      ),
    ).toBeInTheDocument();
  });

  it("imports a row as it was corrected, not as it was exported", async () => {
    const { invokeCommand } = installBridge({
      preview: { found: 1, rows: [previewRow(1, { missing: ["year"] })] },
    });
    mount();

    await chooseFile();
    await userEvent.click(screen.getByRole("button", { name: "Correct" }));
    const year = screen.getByLabelText("Year");
    await userEvent.clear(year);
    await userEvent.type(year, "2016");
    await userEvent.click(screen.getByRole("button", { name: "Add 1 paper" }));

    await screen.findByText("1 paper added.");
    const sent = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((envelope) => envelope.command === "kiwi.bibliography.import");
    expect((sent?.args["entries"] as Array<{ reference: { year: number } }>)[0]?.reference).toEqual(
      expect.objectContaining({ year: 2016 }),
    );
  });

  it("reads a library dropped onto the dialog, without ever holding its path", async () => {
    const { registerDroppedManagedAsset, invokeCommand } = installBridge({
      preview: { found: 1, rows: [previewRow(1)] },
    });
    mount();

    const file = new File(["@article{a,}"], "zotero.bib", { type: "text/plain" });
    fireEvent.drop(screen.getByLabelText("Reference library drop target"), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(registerDroppedManagedAsset).toHaveBeenCalledWith(file));
    expect(await screen.findByText("Paper 1")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.bibliography.import-preview",
        args: { selection_id: "selection-drop" },
      }),
    );
  });

  it("reads a library dropped on the window once, without asking for it again", async () => {
    const { chooseReferenceFile, registerDroppedManagedAsset } = installBridge({
      preview: { found: 2, rows: [previewRow(1), previewRow(2)] },
    });
    const file = new File(["@article{a,}"], "zotero.bib", { type: "text/plain" });
    mount(vi.fn(), { dropped: file });

    expect(await screen.findByText("2 references · 2 ticked")).toBeInTheDocument();
    expect(registerDroppedManagedAsset).toHaveBeenCalledTimes(1);
    expect(registerDroppedManagedAsset).toHaveBeenCalledWith(file);
    expect(chooseReferenceFile).not.toHaveBeenCalled();
  });

  it("says a dropped file could not be used rather than opening an empty review", async () => {
    installBridge();
    window.kiwiDesktop = {
      ...window.kiwiDesktop,
      registerDroppedManagedAsset: vi.fn(async () => null),
    } as unknown as RendererBridge;
    mount();

    fireEvent.drop(screen.getByLabelText("Reference library drop target"), {
      dataTransfer: { files: [new File([""], "zotero.bib")] },
    });

    expect(
      await screen.findByText(
        "Kiwi could not use that dropped file. Choose it with the button instead.",
      ),
    ).toBeInTheDocument();
  });

  it("takes one dropped file at a time", async () => {
    const { registerDroppedManagedAsset } = installBridge();
    mount();

    fireEvent.drop(screen.getByLabelText("Reference library drop target"), {
      dataTransfer: { files: [new File([""], "one.bib"), new File([""], "two.bib")] },
    });

    expect(await screen.findByText("Drop one file at a time.")).toBeInTheDocument();
    expect(registerDroppedManagedAsset).not.toHaveBeenCalled();
  });

  it("offers nothing to import in a workspace that cannot be written to", async () => {
    installBridge();
    render(
      <ReferenceImport
        workspaceId="workspace-1"
        writable={false}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Choose a file…" })).toBeDisabled();
    expect(
      screen.getByText("This workspace is read only. Open a writable copy to import references."),
    ).toBeInTheDocument();
  });
});

/** One file in a picked folder, in the shape the picker hands every file over in. */
function pdf(name: string, index: number) {
  return {
    id: `pdf-${String(index + 1)}`,
    name,
    size: 400_000,
    modifiedAt: "2026-08-26T12:00:00.000Z",
    declaredMediaType: "application/pdf",
  };
}

/** A folder, described the way the picker describes one: named, counted, never located. */
function pickedFolder(
  names: string[],
  over: { skipped?: number; truncated?: boolean } = {},
): Record<string, unknown> {
  return {
    name: "Reading list",
    files: names.map(pdf),
    skipped: over.skipped ?? 0,
    truncated: over.truncated ?? false,
  };
}

/** A document that states its own title, which is the case a row is read out of cleanly. */
function statedDocument(title: string): PdfDocument {
  return {
    pageCount: 9,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => ({
      width: 612,
      height: 792,
      render: vi.fn(async () => undefined),
      textItems: vi.fn(async () => []),
    })),
    outline: vi.fn(async () => []),
    metadata: vi.fn(async () => ({
      title,
      author: "Ada Lovelace",
      subject: null,
      keywords: null,
      creationDate: "D:20230415120000+02'00'",
    })),
    destroy: vi.fn(),
  };
}

/** A scan: nothing in the file states anything, and there is no text to read instead. */
function silentDocument(): PdfDocument {
  const stated = statedDocument("");
  return {
    ...stated,
    metadata: vi.fn(async () => ({
      title: null,
      author: null,
      subject: null,
      keywords: null,
      creationDate: null,
    })),
  };
}

/**
 * What the workspace says about rows that were read on this side.
 *
 * Every folder import asks, so every folder test has to answer. The default is a library holding
 * nothing, which is what keeps the other tests about reading files rather than about duplicates.
 */
type LibraryAnswer = (entries: Array<Record<string, unknown>>) => Record<string, unknown> | null;

const HOLDS_NOTHING: LibraryAnswer = (entries) => ({
  found: entries.length,
  rows: entries.map((entry, index) => ({
    row: index,
    key: `row-${String(index)}`,
    title: entry["title"],
    reference: entry["reference"],
    file_hash: entry["file_hash"],
    selected: true,
    duplicate: null,
    problems: [],
    missing: [],
  })),
});

/** Installs a bridge that answers with a folder, and a loader that answers per address. */
/**
 * What the workspace does when a picked file is handed over to be copied in.
 *
 * The default is that every file copies. A folder import ends by copying its PDFs in, so every
 * folder test would otherwise be a test about copying, and only the ones that mean to be are.
 */
type FilingAnswer = (selectionId: string) => string | null;

const COPIES_EVERYTHING: FilingAnswer = (selectionId) => `asset-${selectionId}`;

function installFolderBridge(
  folder: Record<string, unknown> | null,
  documents: Record<string, PdfDocument> = {},
  library: LibraryAnswer = HOLDS_NOTHING,
  filing: FilingAnswer = COPIES_EVERYTHING,
) {
  const chooseAssetFolder = vi.fn(async () => folder);
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const record = envelope as { command: string; args: Record<string, unknown> };
    if (record.command === "kiwi.bibliography.import")
      return answer(receiptFor(record.args["entries"]));
    if (record.command === "kiwi.bibliography.import-preview") {
      const held = library((record.args["entries"] ?? []) as Array<Record<string, unknown>>);
      return held === null ? refused("The workspace is not answering.") : answer(held);
    }
    if (record.command === "kiwi.asset.import-managed") {
      const asset = filing(String(record.args["selection_id"]));
      return asset === null
        ? refused("That file is no longer there.")
        : answer({ asset_id: asset });
    }
    if (record.command === "kiwi.object.attach-file") return answer({ relation: {} });
    return answer({ matches: [] });
  });
  window.kiwiDesktop = {
    chooseAssetFolder,
    chooseReferenceFile: vi.fn(async () => null),
    invokeCommand,
  } as unknown as RendererBridge;
  const loadPdf = vi.fn(async (url: string) => {
    const document = documents[url];
    if (document === undefined) throw new Error("not a PDF");
    return document;
  });
  return { chooseAssetFolder, invokeCommand, loadPdf };
}

async function chooseFolder(loadPdf: PdfLoader): Promise<void> {
  mount(vi.fn(), { loadPdf });
  await userEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
}

describe("importing a folder of PDFs", () => {
  it("reads every file in the folder into the same table a reference file fills", async () => {
    const { loadPdf } = installFolderBridge(pickedFolder(["a.pdf", "b.pdf"]), {
      "kiwi-selection://pending/pdf-1": statedDocument("Notes on the Analytical Engine"),
      "kiwi-selection://pending/pdf-2": statedDocument("On Computable Numbers"),
    });

    await chooseFolder(loadPdf);

    await screen.findByRole("list", { name: "References to import" });
    // The folder is named where a file would be named, and the rows are the same rows.
    expect(screen.getByText("Reading list")).toBeInTheDocument();
    expect(screen.getByText("2 references · 2 ticked")).toBeInTheDocument();
    expect(screen.getByText("Notes on the Analytical Engine")).toBeInTheDocument();
    expect(screen.getByText("On Computable Numbers")).toBeInTheDocument();
  });

  it("says on the row when a title was arrived at rather than read", async () => {
    // The one thing a folder import owes that a .bib import does not. A row named after its file
    // is a guess, and a guess that does not say so is indistinguishable from a record.
    const { loadPdf } = installFolderBridge(pickedFolder(["Lovelace 1843 notes.pdf"]), {
      "kiwi-selection://pending/pdf-1": silentDocument(),
    });

    await chooseFolder(loadPdf);

    expect(await screen.findByText("Lovelace 1843 notes")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing in this file stated a title, so the row is named after it."),
    ).toBeInTheDocument();
  });

  it("accounts for what the folder held and the table does not show", async () => {
    const { loadPdf } = installFolderBridge(
      pickedFolder(["a.pdf", "damaged.pdf"], { skipped: 4, truncated: true }),
      { "kiwi-selection://pending/pdf-1": statedDocument("Notes on the Analytical Engine") },
    );

    await chooseFolder(loadPdf);

    const account = await screen.findByRole("list", { name: "What this folder held" });
    expect(within(account).getByText("4 other files in the folder were not PDFs.")).toBeVisible();
    expect(
      within(account).getByText(
        "The folder holds more PDFs than Kiwi reads at once. Add these, then choose it again for the rest.",
      ),
    ).toBeVisible();
    // Named, not counted: a PDF that would not open was meant to be a paper.
    expect(within(account).getByText("Kiwi could not open damaged.pdf.")).toBeVisible();
  });

  it("says a folder with no PDFs in it is a folder with no PDFs in it", async () => {
    const { loadPdf } = installFolderBridge(pickedFolder([], { skipped: 12 }));

    await chooseFolder(loadPdf);

    expect(
      await screen.findByText("There are no PDFs in Reading list. Choose another folder."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "References to import" })).not.toBeInTheDocument();
  });

  it("does not open an empty table when nothing in the folder would open", async () => {
    // A table with no rows in it says nothing about why it has no rows in it.
    const { loadPdf } = installFolderBridge(pickedFolder(["a.pdf", "b.pdf"]));

    await chooseFolder(loadPdf);

    expect(
      await screen.findByText(
        "Kiwi could not open anything in Reading list. Kiwi could not open a.pdf and b.pdf.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "References to import" })).not.toBeInTheDocument();
  });

  it("creates the rows a folder yielded the same way it creates any other", async () => {
    const { invokeCommand, loadPdf } = installFolderBridge(pickedFolder(["a.pdf"]), {
      "kiwi-selection://pending/pdf-1": statedDocument("Notes on the Analytical Engine"),
    });

    await chooseFolder(loadPdf);
    await screen.findByRole("list", { name: "References to import" });
    await userEvent.click(screen.getByRole("button", { name: "Add 1 paper" }));

    await screen.findByRole("button", { name: "Open the library" });
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.bibliography.import",
        args: {
          entries: [
            expect.objectContaining({ title: "Notes on the Analytical Engine" }) as unknown,
          ],
        },
      }),
    );
  });

  it("unticks a folder row the library already holds and says what it is a copy of", async () => {
    // The reason the rows go back across the bridge at all. Read on this side, they know what
    // each paper is and nothing about whether Kiwi already has it.
    const { loadPdf } = installFolderBridge(
      pickedFolder(["a.pdf", "b.pdf"]),
      {
        "kiwi-selection://pending/pdf-1": statedDocument("On Computable Numbers"),
        "kiwi-selection://pending/pdf-2": statedDocument("Notes on the Analytical Engine"),
      },
      (entries) => {
        const held = HOLDS_NOTHING(entries) as { found: number; rows: Record<string, unknown>[] };
        const second = held.rows[1];
        if (second !== undefined) {
          second["selected"] = false;
          second["duplicate"] = {
            where: "library",
            by: "doi",
            certain: true,
            object_id: "object-9",
            row: null,
            title: "Notes on the Analytical Engine",
          };
        }
        return held;
      },
    );

    await chooseFolder(loadPdf);

    await screen.findByRole("list", { name: "References to import" });
    expect(screen.getByText("2 references · 1 ticked")).toBeInTheDocument();
    expect(
      screen.getByText(
        'Already in the library as "Notes on the Analytical Engine", with the same DOI.',
      ),
    ).toBeInTheDocument();
  });

  it("asks with what a duplicate is decided on, and not with the whole record", async () => {
    // Five hundred whole records with their abstracts in them would not fit under the size one
    // command may be, and a check cut into parts could not see a folder repeating itself.
    const { invokeCommand, loadPdf } = installFolderBridge(pickedFolder(["a.pdf"]), {
      "kiwi-selection://pending/pdf-1": statedDocument("Notes on the Analytical Engine"),
    });

    await chooseFolder(loadPdf);
    await screen.findByRole("list", { name: "References to import" });

    const asked = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((envelope) => envelope.command === "kiwi.bibliography.import-preview");
    const entries = asked?.args["entries"] as Array<{ reference: Record<string, unknown> }>;
    expect(Object.keys(entries[0]?.reference ?? {})).toEqual(["kind", "authors", "year", "doi"]);
  });

  it("shows the rows and says so when the library could not be checked", async () => {
    // A failed check is not a failed read. Throwing away a folder somebody waited three minutes
    // for, over one missing warning, would be the wrong trade -- but saying nothing would let
    // them assume the checking happened.
    const { loadPdf } = installFolderBridge(
      pickedFolder(["a.pdf"]),
      { "kiwi-selection://pending/pdf-1": statedDocument("On Computable Numbers") },
      () => null,
    );

    await chooseFolder(loadPdf);

    await screen.findByRole("list", { name: "References to import" });
    expect(screen.getByText("On Computable Numbers")).toBeInTheDocument();
    const account = screen.getByRole("list", { name: "What this folder held" });
    expect(
      within(account).getByText(
        "Kiwi could not check these against the library. Anything it already holds will be added again.",
      ),
    ).toBeVisible();
  });

  it("copies each file into the workspace and puts it on the paper its row created", async () => {
    // The half of a folder import a reference file has no equivalent for. A folder is the papers,
    // and stopping at the records would leave somebody pairing four hundred PDFs up by hand.
    const { invokeCommand, loadPdf } = installFolderBridge(pickedFolder(["a.pdf", "b.pdf"]), {
      "kiwi-selection://pending/pdf-1": statedDocument("On Computable Numbers"),
      "kiwi-selection://pending/pdf-2": statedDocument("Notes on the Analytical Engine"),
    });

    await chooseFolder(loadPdf);
    await screen.findByRole("list", { name: "References to import" });
    await userEvent.click(screen.getByRole("button", { name: "Add 2 papers" }));

    await screen.findByRole("button", { name: "Open the library" });
    // The identifier goes over and the path does not, exactly as it does everywhere else.
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.asset.import-managed",
        args: { selection_id: "pdf-1" },
      }),
    );
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.attach-file",
        args: { object_id: "object-1", asset_id: "asset-pdf-2" },
      }),
    );
    expect(
      screen.getByText("2 files were copied into the workspace and attached."),
    ).toBeInTheDocument();
  });

  it("keeps the papers and says which files did not follow them in", async () => {
    // The papers are the greater part of what was wanted. Losing them because a file would not
    // copy would be throwing away the reading to save the filing.
    const { loadPdf } = installFolderBridge(
      pickedFolder(["a.pdf", "b.pdf"]),
      {
        "kiwi-selection://pending/pdf-1": statedDocument("On Computable Numbers"),
        "kiwi-selection://pending/pdf-2": statedDocument("Notes on the Analytical Engine"),
      },
      HOLDS_NOTHING,
      (selectionId) => (selectionId === "pdf-1" ? null : `asset-${selectionId}`),
    );

    await chooseFolder(loadPdf);
    await screen.findByRole("list", { name: "References to import" });
    await userEvent.click(screen.getByRole("button", { name: "Add 2 papers" }));

    expect(await screen.findByText("2 papers added.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Its file was copied in and attached to it. Kiwi could not attach a.pdf. The papers were still added, and the file can be added from the paper.",
      ),
    ).toBeInTheDocument();
  });

  it("says which row each paper came from, so a file cannot land on the wrong one", async () => {
    const { invokeCommand, loadPdf } = installFolderBridge(pickedFolder(["a.pdf"]), {
      "kiwi-selection://pending/pdf-1": statedDocument("On Computable Numbers"),
    });

    await chooseFolder(loadPdf);
    await screen.findByRole("list", { name: "References to import" });
    await userEvent.click(screen.getByRole("button", { name: "Add 1 paper" }));

    await screen.findByRole("button", { name: "Open the library" });
    const sent = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((envelope) => envelope.command === "kiwi.bibliography.import");
    const entries = sent?.args["entries"] as Array<{ key: string }>;
    // The picker's identifier for the file, which is what the row has been keyed by since it
    // was read, and what the receipt has to say back for the file to find its way home.
    expect(entries[0]?.key).toBe("pdf-1");
  });
});
