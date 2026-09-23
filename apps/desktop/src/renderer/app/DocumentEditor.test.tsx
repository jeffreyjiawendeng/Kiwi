import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentEditor, type DocumentRecord } from "./DocumentEditor.js";
import type { RendererBridge } from "./bridge.js";
import { CARET_CHANNEL, forgetCaret } from "./caret.js";
import type { PdfDocument, PdfPage } from "./pdf-document.js";
import type { PresentPerson } from "./presence.js";
import { announcePresence, forgetPresence } from "./remote-carets.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.kiwiDesktop;
});

interface Recorded {
  command: string;
  args: Record<string, unknown>;
}

function stubBridge(failure?: string) {
  const recorded: Recorded[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as Recorded;
    recorded.push(request);
    if (failure !== undefined) {
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "failed",
        error: { code: "KIWI_CONFLICT_VERSION", message: failure },
      };
    }
    return {
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {
        object: {
          id: "note-1",
          type: "note",
          title: "Reading",
          version: 2,
          content_hash: `sha256:${"e".repeat(64)}`,
        },
        words: 3,
      },
    };
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return { recorded, invokeCommand };
}

function record(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "note-1",
    type: "note",
    title: "Reading",
    version: 1,
    content_hash: `sha256:${"a".repeat(64)}`,
    document: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Existing words" }] }],
    },
    document_mode: "rich",
    ...overrides,
  };
}

describe("document editor", () => {
  it("opens what was written before", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    expect(await screen.findByText("Existing words")).toBeInTheDocument();
  });

  it("offers the formatting a researcher expects", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    for (const label of [
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Superscript",
      "Subscript",
      "Heading 1",
      "Bulleted list",
      "Numbered list",
      "Quote",
      "Insert table",
      "Undo",
      "Redo",
    ]) {
      expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("keeps a raised marker raised", async () => {
    // The mark has to be in the schema, not only in the exporters: a document opened by an editor
    // that does not know the mark comes back saved without it.
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Rats" },
                  { type: "text", text: "12", marks: [{ type: "superscript" }] },
                ],
              },
            ],
          },
        })}
      />,
    );

    expect(await screen.findByText("Rats")).toBeInTheDocument();
    expect(document.querySelector("sup")?.textContent).toBe("12");
  });

  it("saves the node tree rather than markup", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    const save = recorded.find((entry) => entry.command === "kiwi.object.set-document");
    expect(save?.args).toMatchObject({ object_id: "note-1", expected_version: 1, mode: "rich" });
    // A document model, not a blob of HTML. Character-level co-editing over serialized markup
    // is close to impossible to make correct.
    expect((save?.args["document"] as { type: string }).type).toBe("doc");
  });

  it("quotes the new version after a save, so the next one is not stale", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    const saves = recorded.filter((entry) => entry.command === "kiwi.object.set-document");
    expect(saves).toHaveLength(2);
    expect(saves[0]?.args["expected_version"]).toBe(1);
    expect(saves[1]?.args["expected_version"]).toBe(2);
  });

  it("reports a refused save rather than pretending the work is stored", async () => {
    stubBridge("That document changed since editing began.");
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed since editing began");
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
  });

  it("counts words", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ content: "one two three four" })}
      />,
    );
    expect(await screen.findByText("4 words")).toBeInTheDocument();
  });

  it("offers no formatting and no editing in a read-only workspace", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} writable={false} />);

    await screen.findByText("Existing words");
    expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("edits LaTeX as source rather than as a node tree", async () => {
    // LaTeX is plain text already. Storing a node tree for it would be a second
    // representation of something that has only one.
    const { recorded } = stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          document_mode: "latex",
          content: "\\section{Method}",
        })}
      />,
    );

    expect(screen.getByLabelText("LaTeX source")).toHaveValue("\\section{Method}");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    const save = recorded.find((entry) => entry.command === "kiwi.object.set-document");
    expect(save?.args).toMatchObject({ mode: "latex", source: "\\section{Method}" });
    expect(save?.args["document"]).toBeUndefined();
  });

  it("opens a damaged document empty rather than refusing to open it", async () => {
    stubBridge();
    render(
      <DocumentEditor workspaceId="workspace-1" record={record({ document: "not a document" })} />,
    );
    // Losing access to a whole note because one field is wrong is worse than showing it blank.
    await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument());
  });
});

describe("maths and figures in the rich editor", () => {
  it("offers equations and figures beside the ordinary formatting", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    // A researcher writing in the Google-Docs mode still needs maths, and maths means LaTeX.
    expect(await screen.findByRole("button", { name: "Inline equation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Display equation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Insert figure" })).toBeInTheDocument();
  });

  it("renders a stored equation rather than showing its source", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "mathInline", attrs: { latex: "\\alpha_i > 0" } }],
              },
            ],
          },
        })}
      />,
    );

    const rendered = await screen.findByTestId("math-node");
    expect(rendered.querySelector(".katex")).not.toBeNull();
  });

  it("renders a matrix, which is what a display equation is usually for", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [
              {
                type: "mathBlock",
                attrs: { latex: "A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}" },
              },
            ],
          },
        })}
      />,
    );

    const rendered = await screen.findByTestId("math-node");
    expect(rendered.querySelector(".katex")).not.toBeNull();
  });

  it("shows a half-written equation instead of blanking the document", async () => {
    // Every equation passes through an invalid state while it is being typed.
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [{ type: "mathBlock", attrs: { latex: "\\frac{1}{" } }],
          },
        })}
      />,
    );

    expect(await screen.findByTestId("math-node")).toBeInTheDocument();
  });

  it("saves the equation source, not its rendering", async () => {
    const { recorded } = stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [{ type: "mathBlock", attrs: { latex: "E = mc^2" } }],
          },
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    const save = recorded.find((entry) => entry.command === "kiwi.object.set-document");
    expect(JSON.stringify(save?.args["document"])).toContain("E = mc^2");
  });

  it("imports a figure and points the document at the managed asset", async () => {
    // A document holding a filesystem path would break on any other machine, and would not
    // survive the workspace being moved.
    const recorded: Recorded[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Recorded;
      recorded.push(request);
      if (request.command === "kiwi.asset.import-managed") {
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "committed",
          data: { asset: { id: "asset-figure", original_filename: "sites.png" } },
        };
      }
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: {
          object: {
            id: "note-1",
            type: "note",
            title: "Reading",
            version: 2,
            content_hash: `sha256:${"e".repeat(64)}`,
          },
          words: 0,
        },
      };
    });
    const chooseManagedAsset = vi.fn(async () => ({ id: "selection-1" }));
    window.kiwiDesktop = { invokeCommand, chooseManagedAsset } as unknown as RendererBridge;

    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Insert figure" }));

    await waitFor(() =>
      expect(recorded.some((entry) => entry.command === "kiwi.asset.import-managed")).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const save = recorded.find((entry) => entry.command === "kiwi.object.set-document");
    expect(JSON.stringify(save?.args["document"])).toContain(
      "kiwi-asset://workspace-1/asset-figure",
    );
  });

  it("says nothing happened when the file dialog is cancelled", async () => {
    const chooseManagedAsset = vi.fn(async () => null);
    const { recorded } = stubBridge();
    (window.kiwiDesktop as unknown as Record<string, unknown>)["chooseManagedAsset"] =
      chooseManagedAsset;

    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Insert figure" }));

    expect(recorded.some((entry) => entry.command === "kiwi.asset.import-managed")).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("compiling a manuscript", () => {
  function compilerBridge(outcome: Record<string, unknown> = {}) {
    const compiles: Array<Record<string, unknown>> = [];
    const compileLatex = vi.fn(async (input: Record<string, unknown>) => {
      compiles.push(input);
      return {
        status: "ok",
        ran: "cloud",
        pdf: "data:application/pdf;base64,JVBERi0=",
        problems: [],
        ...outcome,
      };
    });
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {},
    }));
    window.kiwiDesktop = { invokeCommand, compileLatex } as unknown as RendererBridge;
    return { compiles };
  }

  it("compiles a LaTeX manuscript from its source", async () => {
    const { compiles } = compilerBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "\\section{Method}" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    await waitFor(() => expect(compiles).toHaveLength(1));
    expect(compiles[0]?.["source"]).toBe("\\section{Method}");
  });

  it("compiles a rich manuscript by converting it first", async () => {
    // Both writing modes reach a PDF through the same compiler.
    const { compiles } = compilerBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          title: "A paper",
          document: {
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Method" }] },
            ],
          },
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    await waitFor(() => expect(compiles).toHaveLength(1));
    const source = String(compiles[0]?.["source"]);
    expect(source).toContain("\\documentclass");
    expect(source).toContain("\\section{Method}");
    expect(source).toContain("\\title{A paper}");
  });

  it("sends the figures a rich document refers to", async () => {
    const { compiles } = compilerBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          document: {
            type: "doc",
            content: [
              { type: "image", attrs: { src: "kiwi-asset://workspace-1/asset-fig", alt: "Map" } },
            ],
          },
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    await waitFor(() => expect(compiles).toHaveLength(1));
    // Without the bundle the compiler cannot find the figure, and the paper typesets with a
    // grey box where the plot should be.
    expect(compiles[0]?.["files"]).toEqual([{ name: "figure-asset-fig", asset_id: "asset-fig" }]);
  });

  it("lets the author choose the engine", async () => {
    const { compiles } = compilerBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "x" })}
      />,
    );

    await userEvent.selectOptions(await screen.findByLabelText("Compiler"), "pdflatex");
    await userEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(compiles).toHaveLength(1));
    expect(compiles[0]?.["engine"]).toBe("pdflatex");
  });

  it("says where the compile ran", async () => {
    // Which TeX produced the PDF is the first question when output looks wrong.
    compilerBridge({ ran: "local" });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "x" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText(/on this computer/u)).toBeInTheDocument();
  });

  it("offers the document when one was produced", async () => {
    compilerBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "x" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByRole("link", { name: "Open the PDF" })).toBeInTheDocument();
  });

  it("reports errors with the line they happened on", async () => {
    compilerBridge({
      status: "failed",
      pdf: null,
      problems: [
        { severity: "error", file: "kiwi-document.tex", line: 12, message: "Missing $ inserted." },
      ],
    });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "x" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Did not compile")).toBeInTheDocument();
    expect(screen.getByText("line 12")).toBeInTheDocument();
    expect(screen.getByText("Missing $ inserted.")).toBeInTheDocument();
  });

  it("shows warnings without calling the compile a failure", async () => {
    compilerBridge({
      problems: [{ severity: "warning", file: null, line: 3, message: "Reference undefined" }],
    });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "x" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Compile" }));
    expect(await screen.findByText("Compiled")).toBeInTheDocument();
    expect(screen.getByText("Reference undefined")).toBeInTheDocument();
  });
});

describe("exporting a manuscript", () => {
  function exportBridge(outcome: Record<string, unknown> = {}) {
    const exports: Array<Record<string, unknown>> = [];
    const exportDocument = vi.fn(async (input: Record<string, unknown>) => {
      exports.push(input);
      return {
        status: "written",
        destination: "a-paper",
        files: ["a-paper.tex"],
        notes: [],
        ...outcome,
      };
    });
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {},
    }));
    window.kiwiDesktop = { invokeCommand, exportDocument } as unknown as RendererBridge;
    return { exports };
  }

  it("sends the same source the compiler would have been given", async () => {
    // A PDF that differs from the exported source is a difference nobody notices until a
    // co-author opens the folder.
    const { exports } = exportBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          title: "A paper",
          document: {
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Method" }] },
            ],
          },
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Export LaTeX" }));
    await waitFor(() => expect(exports).toHaveLength(1));
    expect(exports[0]?.["format"]).toBe("tex");
    expect(exports[0]?.["title"]).toBe("A paper");
    expect(String(exports[0]?.["source"])).toContain("\\section{Method}");
  });

  it("names every file it wrote", async () => {
    exportBridge({ files: ["a-paper.tex", "references.bib", "figure-1.png"] });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "\\section{M}" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Export LaTeX" }));
    expect(await screen.findByText("Exported to a-paper")).toBeInTheDocument();
    expect(screen.getByText("references.bib")).toBeInTheDocument();
  });

  it("sends the tree and the citations as they read, for Word", async () => {
    // Word has no bibliography step of its own. Sending keys would leave a co-author reading
    // \cite{smith2019} in the middle of a sentence.
    const { exports } = exportBridge({ destination: "a-paper.docx", files: [] });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          title: "A paper",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
          },
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Export Word" }));
    await waitFor(() => expect(exports).toHaveLength(1));
    expect(exports[0]?.["format"]).toBe("docx");
    expect(exports[0]?.["document"]).toMatchObject({ type: "doc" });
    expect(exports[0]).toHaveProperty("citation_labels");
    expect(await screen.findByText("Exported to a-paper.docx")).toBeInTheDocument();
  });

  it("does not offer Word for a manuscript written in LaTeX", async () => {
    // Word is written from the node tree, and a LaTeX manuscript has source instead. Offering
    // the button would promise a conversion that does not exist.
    exportBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "\\section{M}" })}
      />,
    );

    expect(await screen.findByRole("button", { name: "Export LaTeX" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export Word" })).not.toBeInTheDocument();
  });

  it("says what the export could not carry", async () => {
    // An export that reports success while having dropped a figure is the version that reaches
    // a journal.
    exportBridge({ notes: ["1 figure could not be read and was left out."] });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "\\section{M}" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Export LaTeX" }));
    expect(
      await screen.findByText("1 figure could not be read and was left out."),
    ).toBeInTheDocument();
  });

  it("reports nothing at all when the folder dialog is cancelled", async () => {
    exportBridge({ status: "cancelled" });
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "\\section{M}" })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Export LaTeX" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Export result" })).not.toBeInTheDocument(),
    );
  });
});

describe("finding and replacing", () => {
  /** The text of a saved node tree, which is what a replacement has to have changed. */
  function textOf(node: unknown): string {
    const value = (node ?? {}) as { text?: string; content?: unknown[] };
    if (typeof value.text === "string") return value.text;
    return (value.content ?? []).map(textOf).join("");
  }

  function lastSavedText(recorded: Recorded[]): string {
    const saves = recorded.filter((entry) => entry.command === "kiwi.object.set-document");
    return textOf(saves.at(-1)?.args["document"]);
  }

  function prose(text: string): DocumentRecord {
    return record({
      document: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    });
  }

  async function openFind(): Promise<void> {
    await userEvent.click(await screen.findByRole("button", { name: "Find and replace" }));
  }

  it("counts what the manuscript matches", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat and the hat")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");

    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    // A silent search leaves a person retyping a query that was right the first time.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "zebra");

    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("opens on Ctrl+F, wherever the caret is in the manuscript", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat")} />);

    fireEvent.keyDown(await screen.findByRole("region", { name: "Reading editor" }), {
      key: "f",
      ctrlKey: true,
    });

    expect(await screen.findByLabelText("Find")).toBeInTheDocument();
  });

  it("narrows a search to the case that was typed", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("The the")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Match case"));
    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  });

  it("narrows a search to whole words", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("there the")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Whole word"));
    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  });

  it("replaces the match a person is standing on, and only that one", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat and the hat")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    await userEvent.type(screen.getByLabelText("Replace with"), "a");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(lastSavedText(recorded)).toBe("a cat and the hat");
  });

  it("replaces every match at once", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat and the hat")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    await userEvent.type(screen.getByLabelText("Replace with"), "a");
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(lastSavedText(recorded)).toBe("a cat and a hat");
    expect(await screen.findByText("Replaced 2")).toBeInTheDocument();
  });

  it("puts a replace-all back with one undo", async () => {
    // A replace-all that takes forty undos to reverse is a trap: by the time it has been undone
    // by hand, the manuscript has been edited forty more times.
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={prose("the cat and the hat")} />);

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    await userEvent.type(screen.getByLabelText("Replace with"), "a");
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(lastSavedText(recorded)).toBe("the cat and the hat");
  });

  it("keeps the formatting of what it replaced", async () => {
    // Replacing a term inside a bold run and getting plain text back is a correction that has
    // to be made twice.
    const { recorded } = stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", marks: [{ type: "bold" }], text: "the cat" }],
              },
            ],
          },
        })}
      />,
    );

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "cat");
    await userEvent.type(screen.getByLabelText("Replace with"), "hat");
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const saves = recorded.filter((entry) => entry.command === "kiwi.object.set-document");
    const paragraph = (saves.at(-1)?.args["document"] as { content: Array<{ content: unknown[] }> })
      .content[0];
    // One node, not two: the replacement carries the same marks, so it merges back into the run
    // it was written into.
    expect(paragraph?.content).toMatchObject([{ text: "the hat", marks: [{ type: "bold" }] }]);
  });

  it("searches the LaTeX source the same way", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          type: "output",
          document_mode: "latex",
          content: "the cat and the hat",
        })}
      />,
    );

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");
    await userEvent.type(screen.getByLabelText("Replace with"), "a");
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));

    expect(screen.getByLabelText("LaTeX source")).toHaveValue("a cat and a hat");
  });

  it("still searches source that cannot be written to", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        writable={false}
        record={record({ type: "output", document_mode: "latex", content: "the cat" })}
      />,
    );

    await openFind();
    await userEvent.type(screen.getByLabelText("Find"), "the");

    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Replace with")).not.toBeInTheDocument();
  });
});

describe("tables", () => {
  interface DocNode {
    type: string;
    content?: DocNode[];
  }

  function savedDocument(recorded: Recorded[]): DocNode {
    const saves = recorded.filter((entry) => entry.command === "kiwi.object.set-document");
    return saves.at(-1)?.args["document"] as DocNode;
  }

  function savedTable(recorded: Recorded[]): DocNode | undefined {
    return savedDocument(recorded).content?.find((node) => node.type === "table");
  }

  /** A three by three table with a header row, put in by the toolbar the way a person would. */
  async function insertTable(): Promise<HTMLElement> {
    await userEvent.click(await screen.findByRole("button", { name: "Insert table" }));
    return screen.findByRole("toolbar", { name: "Table" });
  }

  it("offers no table operations until the caret is in a table", async () => {
    // Eight buttons that do nothing are eight buttons in the way of the four that do.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    expect(await screen.findByRole("button", { name: "Insert table" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Table" })).not.toBeInTheDocument();
  });

  it("offers every row and column operation once the caret is in one", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    for (const label of [
      "Insert row above",
      "Insert row below",
      "Insert column left",
      "Insert column right",
      "Header row",
      "Delete row",
      "Delete column",
      "Delete table",
    ]) {
      expect(within(controls).getByRole("button", { name: label })).toBeEnabled();
    }
  });

  it("adds a row below the one the caret is in", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    await userEvent.click(within(controls).getByRole("button", { name: "Insert row below" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedTable(recorded)?.content).toHaveLength(4);
  });

  it("adds a column to the right of the one the caret is in", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    await userEvent.click(within(controls).getByRole("button", { name: "Insert column right" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // Every row, not only the one the caret was in: a table with a ragged row is not a table.
    for (const row of savedTable(recorded)?.content ?? []) {
      expect(row.content).toHaveLength(4);
    }
  });

  it("deletes a row", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    await userEvent.click(within(controls).getByRole("button", { name: "Delete row" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedTable(recorded)?.content).toHaveLength(2);
  });

  it("deletes the table, and stops offering the operations", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    await userEvent.click(within(controls).getByRole("button", { name: "Delete table" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedTable(recorded)).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: "Table" })).not.toBeInTheDocument(),
    );
  });

  it("turns the header row off", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    const controls = await insertTable();
    const header = within(controls).getByRole("button", { name: "Header row" });
    // A table put in with a header row shows the button pressed, wherever the caret sits in it.
    expect(header).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(header);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const firstRow = savedTable(recorded)?.content?.[0];
    expect(firstRow?.content?.every((cell) => cell.type === "tableCell")).toBe(true);
    expect(within(controls).getByRole("button", { name: "Header row" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("opens the same operations under a right-click inside the table", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await insertTable();
    fireEvent.contextMenu(document.querySelector(".document-editor__surface") as HTMLElement);

    const menu = await screen.findByRole("menu", { name: "Table" });
    expect(within(menu).getByRole("menuitem", { name: "Insert row below" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Header row" })).toBeChecked();
  });

  it("acts on the table from the menu, and closes it", async () => {
    const { recorded } = stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await insertTable();
    fireEvent.contextMenu(document.querySelector(".document-editor__surface") as HTMLElement);

    const menu = await screen.findByRole("menu", { name: "Table" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Insert row above" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedTable(recorded)?.content).toHaveLength(4);
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Table" })).not.toBeInTheDocument(),
    );
  });

  it("closes the menu on Escape without closing anything else", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await insertTable();
    fireEvent.contextMenu(document.querySelector(".document-editor__surface") as HTMLElement);
    const menu = await screen.findByRole("menu", { name: "Table" });
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Table" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("toolbar", { name: "Table" })).toBeInTheDocument();
  });

  it("leaves a right-click outside a table alone", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await screen.findByText("Existing words");
    fireEvent.contextMenu(document.querySelector(".document-editor__surface") as HTMLElement);

    expect(screen.queryByRole("menu", { name: "Table" })).not.toBeInTheDocument();
  });
});

describe("outline", () => {
  const SOURCE = "\\section{Method}\nWe counted.\n\\section{Results}\nSix.\n";
  const SWAPPED = "\\section{Results}\nSix.\n\\section{Method}\nWe counted.\n";

  function sectioned(): DocumentRecord {
    return record({
      document: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Method" }] },
          { type: "paragraph", content: [{ type: "text", text: "We counted them twice" }] },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Participants" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "Sixty" }] },
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Results" }] },
          { type: "paragraph", content: [{ type: "text", text: "Six" }] },
        ],
      },
    });
  }

  function source(content: string): DocumentRecord {
    return record({ type: "output", document_mode: "latex", content });
  }

  async function openOutline(): Promise<HTMLElement[]> {
    await userEvent.click(screen.getByRole("button", { name: "Outline" }));
    const panel = await screen.findByRole("navigation", { name: "Outline" });
    return within(panel).queryAllByRole("listitem");
  }

  /** The headings as the manuscript itself has them, in the order they are written. */
  function written(): (string | null)[] {
    const surface = document.querySelector(".document-editor__surface");
    return [...(surface?.querySelectorAll("h1, h2") ?? [])].map((node) => node.textContent);
  }

  it("lists the headings with the words under each", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={sectioned()} />);
    await screen.findByText("We counted them twice");

    const rows = await openOutline();

    expect(rows.map((row) => within(row).getByRole("button").getAttribute("aria-label"))).toEqual([
      // A section's count includes its subsections, and no heading counts as prose.
      "Method, 5 words",
      "Participants, 1 word",
      "Results, 1 word",
    ]);
  });

  it("says so when there is nothing to outline", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await screen.findByText("Existing words");

    await openOutline();

    expect(screen.getByText("No headings yet")).toBeInTheDocument();
  });

  it("moves a section and everything under it", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={sectioned()} />);
    await screen.findByText("We counted them twice");
    const rows = await openOutline();

    fireEvent.dragStart(rows[0] as HTMLElement);
    fireEvent.drop(rows[2] as HTMLElement);

    // Participants travelled with Method rather than staying where it was.
    expect(written()).toEqual(["Results", "Method", "Participants"]);
  });

  it("leaves the manuscript alone when a section is dropped inside itself", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={sectioned()} />);
    await screen.findByText("We counted them twice");
    const rows = await openOutline();

    fireEvent.dragStart(rows[0] as HTMLElement);
    fireEvent.drop(rows[1] as HTMLElement);

    expect(written()).toEqual(["Method", "Participants", "Results"]);
  });

  it("reorders the source of a LaTeX manuscript", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    const rows = await openOutline();

    fireEvent.dragStart(rows[0] as HTMLElement);
    fireEvent.drop(rows[1] as HTMLElement);

    expect(screen.getByLabelText("LaTeX source")).toHaveValue(SWAPPED);
  });

  it("moves a section from the keyboard", async () => {
    // A panel that can only be operated by dragging is a panel some people cannot operate.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    const rows = await openOutline();

    fireEvent.keyDown(within(rows[0] as HTMLElement).getByRole("button"), {
      key: "ArrowDown",
      altKey: true,
    });

    expect(screen.getByLabelText("LaTeX source")).toHaveValue(SWAPPED);
  });

  it("puts the caret at the heading that was clicked", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    const rows = await openOutline();

    await userEvent.click(within(rows[1] as HTMLElement).getByRole("button"));

    const field = screen.getByLabelText("LaTeX source") as HTMLTextAreaElement;
    expect(field.selectionStart).toBe(SOURCE.indexOf("\\section{Results}"));
  });

  it("outlines a manuscript that cannot be written to, without offering to rearrange it", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" writable={false} record={source(SOURCE)} />);
    const rows = await openOutline();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("draggable", "false");
  });
});

describe("latex source", () => {
  const SOURCE = "\\section{Method}\nWe counted. % twice\n";

  function source(content: string): DocumentRecord {
    return record({ type: "output", document_mode: "latex", content });
  }

  /** What the painting behind the field says a stretch of the source is. */
  function inked(kind: string): (string | null)[] {
    const ink = document.querySelector(".latex-source__ink");
    return [...(ink?.querySelectorAll(`.latex-token--${kind}`) ?? [])].map(
      (node) => node.textContent,
    );
  }

  function field(): HTMLTextAreaElement {
    return screen.getByLabelText("LaTeX source") as HTMLTextAreaElement;
  }

  it("paints the source behind the field", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    expect(inked("command")).toEqual(["\\section"]);
    expect(inked("comment")).toEqual(["% twice"]);
    // The field still holds the source itself, unchanged: the colour is underneath it.
    expect(field()).toHaveValue(SOURCE);
  });

  it("repaints as the source is typed", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    fireEvent.change(field(), { target: { value: "$x + 1$" } });

    expect(inked("math")).toEqual(["$x + 1$"]);
  });

  it("marks the brace the caret is on and the one it pairs with", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    field().setSelectionRange(9, 9);
    fireEvent.select(field());

    expect(inked("match")).toEqual(["{", "}"]);
  });

  it("marks both ends of an environment from inside its name", async () => {
    stubBridge();
    const latex = "\\begin{proof}\nx\n\\end{proof}\n";
    render(<DocumentEditor workspaceId="workspace-1" record={source(latex)} />);
    await screen.findByLabelText("LaTeX source");

    field().setSelectionRange(9, 9);
    fireEvent.select(field());

    expect(inked("match").join("")).toBe("\\begin{proof}\\end{proof}");
  });

  it("drops the marks when the caret leaves the field", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");
    field().setSelectionRange(9, 9);
    fireEvent.select(field());

    fireEvent.blur(field());

    expect(inked("match")).toEqual([]);
  });

  it("paints a manuscript that cannot be written to, and does not let it be typed in", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" writable={false} record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    expect(inked("command")).toEqual(["\\section"]);
    expect(field()).toHaveAttribute("readonly");
  });

  it("folds the section the caret is in, and marks where it went", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    // The field cannot hide part of its own value, so the run is cut out of what it holds.
    expect(field()).toHaveValue("\\section{Method}\n");
    expect(document.querySelectorAll(".latex-source__ink .latex-fold")).toHaveLength(1);
  });

  it("opens what was folded", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");
    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    await userEvent.click(screen.getByRole("button", { name: "Unfold all" }));

    expect(field()).toHaveValue(SOURCE);
    expect(document.querySelectorAll(".latex-fold")).toHaveLength(0);
  });

  it("keeps typing at a marker in front of what it hides", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");
    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    fireEvent.change(field(), { target: { value: "\\section{Method}!\n" } });

    // The exclamation mark went onto the heading line, not into the hidden body.
    await userEvent.click(screen.getByRole("button", { name: "Unfold all" }));
    expect(field()).toHaveValue("\\section{Method}!\nWe counted. % twice\n");
  });

  it("opens a fold to show a match found inside it", async () => {
    // Find and replace addresses positions in the source, folded or not, so the field has to open
    // what hides one rather than send the caret to a line that is not on screen.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");
    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    await userEvent.click(screen.getByRole("button", { name: "Find and replace" }));
    await userEvent.type(screen.getByLabelText("Find"), "counted");
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));

    expect(field()).toHaveValue(SOURCE);
    expect(field().selectionStart).toBe(SOURCE.indexOf("counted"));
  });

  it("folds a manuscript that cannot be written to", async () => {
    // Folding is a way of looking at the source rather than a change to it.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" writable={false} record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");

    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    expect(field()).toHaveValue("\\section{Method}\n");
  });
});

describe("previewing beside the source", () => {
  const PDF = "data:application/pdf;base64,JVBERi0=";

  function source(content: string): DocumentRecord {
    return record({ type: "output", document_mode: "latex", content });
  }

  /** A compiler that answers with a PDF, and can be made to take its time over the second one. */
  function previewBridge(options: { hold?: boolean } = {}) {
    const compiles: Array<Record<string, unknown>> = [];
    const waiting: Array<() => void> = [];
    const compileLatex = vi.fn(async (input: Record<string, unknown>) => {
      compiles.push(input);
      if (options.hold === true && compiles.length > 1) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return { status: "ok", ran: "local", pdf: PDF, problems: [] };
    });
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: {},
    }));
    window.kiwiDesktop = { invokeCommand, compileLatex } as unknown as RendererBridge;
    return { compiles, waiting };
  }

  /** PDF.js needs a canvas, which the test environment does not have. */
  function stubLoader() {
    const draw = vi.fn(async () => undefined);
    const page: PdfPage = {
      width: 612,
      height: 792,
      render: draw,
      textItems: vi.fn(async () => []),
    };
    const opened: PdfDocument = {
      pageCount: 1,
      pageLabel: (number) => String(number),
      page: vi.fn(async () => page),
      outline: vi.fn(async () => []),
      metadata: vi.fn(async () => ({})),
      destroy: vi.fn(),
    };
    return { loader: vi.fn(async () => opened), draw };
  }

  it("draws the compiled PDF beside the source", async () => {
    previewBridge();
    const { loader, draw } = stubLoader();
    render(<DocumentEditor workspaceId="workspace-1" record={source("x")} pdfLoader={loader} />);

    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await waitFor(() => expect(draw).toHaveBeenCalled());
    expect(loader).toHaveBeenCalledWith(PDF);
    // A second pane rather than a second mode: the source is still there to type in.
    expect(screen.getByLabelText("LaTeX source")).toBeInTheDocument();
  });

  it("compiles when the preview is opened, and not again on its own", async () => {
    vi.useFakeTimers();
    const { compiles } = previewBridge();
    const { loader } = stubLoader();
    render(<DocumentEditor workspaceId="workspace-1" record={source("x")} pdfLoader={loader} />);
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => Promise.resolve());
    expect(compiles).toHaveLength(1);

    // Nothing has been typed, so there is nothing a second compile would produce.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(compiles).toHaveLength(1);
  });

  it("recompiles once typing has stopped rather than while it goes on", async () => {
    vi.useFakeTimers();
    const { compiles } = previewBridge();
    const { loader } = stubLoader();
    render(<DocumentEditor workspaceId="workspace-1" record={source("x")} pdfLoader={loader} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => Promise.resolve());

    fireEvent.change(screen.getByLabelText("LaTeX source"), { target: { value: "y" } });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    // Compiling here would mean a compiler process per keystroke.
    expect(compiles).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(compiles).toHaveLength(2);
    expect(compiles[1]?.["source"]).toBe("y");
  });

  it("keeps the last PDF on screen, dimmed, while a new one is made", async () => {
    const { compiles, waiting } = previewBridge({ hold: true });
    const { loader, draw } = stubLoader();
    render(<DocumentEditor workspaceId="workspace-1" record={source("x")} pdfLoader={loader} />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
    await waitFor(() => expect(draw).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(compiles).toHaveLength(2));

    // A pane that empties itself every time typing stops is harder to work beside than one
    // that is a few seconds out of date and says so.
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByRole("img", { name: "Page 1" })).toBeInTheDocument();
    expect(within(preview).getByText("Compiling")).toBeInTheDocument();
    expect(preview.querySelector(".latex-preview__pages--stale")).not.toBeNull();

    await act(async () => {
      for (const resolve of waiting) resolve();
    });
  });

  it("previews a manuscript that cannot be edited", async () => {
    // A preview is a picture of the last compile, not a change to the source.
    previewBridge();
    const { loader, draw } = stubLoader();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={source("x")}
        writable={false}
        pdfLoader={loader}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await waitFor(() => expect(draw).toHaveBeenCalled());
  });
});

describe("pointing at a figure by what it is, not by its number", () => {
  function figure(caption: string, id?: string) {
    return {
      type: "image",
      attrs: {
        src: "kiwi-asset://workspace-1/asset-1",
        alt: caption,
        ...(id === undefined ? {} : { kiwiId: id }),
      },
    };
  }

  function withDocument(...content: unknown[]): DocumentRecord {
    return record({ document: { type: "doc", content } });
  }

  it("inserts a reference to the target that was chosen", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={withDocument(
          { type: "paragraph", content: [{ type: "text", text: "As shown in " }] },
          figure("Apparatus"),
          figure("Yield"),
        )}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Insert cross-reference" }));
    const picker = await screen.findByRole("dialog", { name: "Insert a cross-reference" });
    await userEvent.click(within(picker).getByRole("button", { name: /Figure 2/u }));

    const inserted = await waitFor(() => {
      const span = document.querySelector("[data-crossref]");
      expect(span).not.toBeNull();
      return span as HTMLElement;
    });
    expect(inserted.textContent).toBe("Figure 2");
    // The link, not the words. The id was assigned to the figure at this moment, because
    // nothing had needed to name it before.
    expect(inserted.getAttribute("data-target")).not.toBe("");
  });

  it("works the number out from document order rather than from what was stored", async () => {
    // The document was saved when the referred-to figure was the first one. A figure has been
    // put above it since, and the stored label is now a lie.
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={withDocument(figure("Added later"), figure("Yield", "f-1"), {
          type: "paragraph",
          content: [
            { type: "crossReference", attrs: { target: "f-1", kind: "figure", label: "Figure 1" } },
          ],
        })}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-crossref]")?.textContent).toBe("Figure 2"),
    );
  });

  it("renumbers when something is inserted above what is pointed at", async () => {
    stubBridge();
    const table = {
      type: "table",
      attrs: { kiwiId: "t-1" },
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph" }] },
            { type: "tableCell", content: [{ type: "paragraph" }] },
          ],
        },
      ],
    };
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={withDocument({ type: "paragraph" }, table, {
          type: "paragraph",
          content: [
            { type: "crossReference", attrs: { target: "t-1", kind: "table", label: "Table 1" } },
          ],
        })}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-crossref]")?.textContent).toBe("Table 1"),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Insert table" }));

    await waitFor(() =>
      expect(document.querySelector("[data-crossref]")?.textContent).toBe("Table 2"),
    );
  });

  it("says so when what a reference pointed at is gone", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={withDocument({
          type: "paragraph",
          content: [
            {
              type: "crossReference",
              attrs: { target: "f-deleted", kind: "figure", label: "Figure 1" },
            },
          ],
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector("[data-crossref]")?.textContent).toBe("(?)"));
    expect(
      await screen.findByText(/1 cross-reference points at something that is no longer/u),
    ).toBeInTheDocument();
  });

  it("has nothing to offer in a document with nothing to point at", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Insert cross-reference" }));

    expect(await screen.findByText(/There is nothing to point at yet/u)).toBeInTheDocument();
  });
});

describe("opening a document in a window of its own", () => {
  it("asks for the object by id, and saves the buffer first", async () => {
    const { recorded } = stubBridge();
    const detachDocument = vi.fn(async () => null);
    window.kiwiDesktop = {
      ...window.kiwiDesktop,
      detachDocument,
    } as unknown as RendererBridge;

    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open in a new window" }));

    expect(detachDocument).toHaveBeenCalledWith({ objectId: "note-1", kind: "document" });
    // Opening the second window on yesterday's paragraph is a confusing way to start.
    expect(recorded.some((entry) => entry.command === "kiwi.object.set-document")).toBe(true);
  });

  it("does not open the second window until the buffer has landed", async () => {
    // Both windows read one canonical file, so a detach that races the save hands the new window
    // the paragraph before the one that was just typed. Two windows on two versions of a document
    // is the one thing detaching must not do.
    const { invokeCommand } = stubBridge();
    const order: string[] = [];
    const detachDocument = vi.fn(async () => {
      order.push("detached");
      return null;
    });
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async (envelope: unknown) => {
        const result = await invokeCommand(envelope);
        if ((envelope as Recorded).command === "kiwi.object.set-document") order.push("saved");
        return result;
      }),
      detachDocument,
    } as unknown as RendererBridge;

    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open in a new window" }));

    expect(order).toEqual(["saved", "detached"]);
  });

  it("offers no second window when there is nowhere new to put the document", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} detachable={false} />);

    await screen.findByText("Existing words");
    expect(screen.queryByRole("button", { name: "Open in a new window" })).not.toBeInTheDocument();
  });
});

describe("comments in the margin", () => {
  const PROSE = "The bound is tight. It holds for long documents.";

  /** A bridge that answers for the comments as well as for the manuscript. */
  function marginBridge(threads: () => unknown[] = () => []) {
    const recorded: Recorded[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Recorded;
      recorded.push(request);
      const base = { protocol_version: "1.0.0", request_id: crypto.randomUUID() };
      if (request.command === "kiwi.thread.list") {
        return { ...base, status: "no_change", data: { threads: threads() } };
      }
      return {
        ...base,
        status: "committed",
        data: {
          object: {
            id: "note-1",
            type: "output",
            title: "Reading",
            version: 2,
            content_hash: `sha256:${"e".repeat(64)}`,
          },
          words: 3,
        },
      };
    });
    window.kiwiDesktop = {
      invokeCommand,
      // Offline, because a paper commented on aboard a train is the case this is for.
      getAccountAuthState: async () => ({
        status: "authenticated",
        account: { id: "ada", email: "ada@example.org", email_verified: true },
        connection: "offline",
      }),
    } as unknown as RendererBridge;
    return { recorded };
  }

  /** One comment on a passage, stored with the positions it had when it was written. */
  function storedThread(anchor: { from: number; to: number; quote: string }, id = "thread-1") {
    return {
      id,
      version: 1,
      content_hash: `sha256:${"c".repeat(64)}`,
      title: "Is this the right bound?",
      created_at: "2026-08-20T10:00:00.000Z",
      updated_at: "2026-08-20T10:00:00.000Z",
      thread: {
        anchor: { object_id: "note-1", kind: "text_range", ...anchor },
        status: "open",
        resolved_by: null,
        resolved_at: null,
        messages: [
          {
            id: `message-${id}`,
            author_id: "account:ada",
            author_name: "Ada",
            body: `About ${anchor.quote}`,
            created_at: "2026-08-20T10:00:00.000Z",
            edited_at: null,
          },
        ],
        participants: ["account:ada"],
        mentions: [],
      },
    };
  }

  function latexRecord(): DocumentRecord {
    return record({ type: "output", document_mode: "latex", content: PROSE });
  }

  /** Selects a stretch of the source, the way dragging across it would. */
  function selectSource(from: number, to: number): void {
    const field = screen.getByLabelText("LaTeX source") as HTMLTextAreaElement;
    field.setSelectionRange(from, to);
    fireEvent.select(field);
  }

  async function openMargin(): Promise<void> {
    await userEvent.click(await screen.findByRole("button", { name: "Comments" }));
    await screen.findByRole("region", { name: "Comments" });
  }

  it("files a comment against the passage that is selected", async () => {
    const { recorded } = marginBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={latexRecord()} />);
    await openMargin();

    selectSource(4, 9);
    const compose = await screen.findByRole("textbox", { name: "Start a comment" });
    // The box says what is about to be commented on, so nobody files a remark against the paper
    // believing it was filed against the sentence.
    expect(compose).toHaveAttribute("placeholder", "Comment on the selection");
    await userEvent.type(compose, "Is this tight?");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(recorded.find((entry) => entry.command === "kiwi.thread.start")?.args).toEqual({
      anchor: { object_id: "note-1", kind: "text_range", from: 4, to: 9, quote: "bound" },
      body: "Is this tight?",
      author_name: "ada@example.org",
    });
  });

  it("comments on the manuscript itself when nothing is selected", async () => {
    const { recorded } = marginBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={latexRecord()} />);
    await openMargin();

    await userEvent.type(
      await screen.findByRole("textbox", { name: "Start a comment" }),
      "Does this need a conclusion?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(recorded.find((entry) => entry.command === "kiwi.thread.start")?.args).toEqual({
      anchor: { object_id: "note-1", kind: "object" },
      body: "Does this need a conclusion?",
      author_name: "ada@example.org",
    });
  });

  it("finds a comment's passage again after an edit moved it", async () => {
    // Stored well past the end of this manuscript: the positions are stale, the words are not.
    marginBridge(() => [storedThread({ from: 400, to: 405, quote: "bound" })]);
    render(<DocumentEditor workspaceId="workspace-1" record={latexRecord()} />);
    await openMargin();

    expect(await screen.findByText("About bound")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show the text of bound" }));

    const field = screen.getByLabelText("LaTeX source") as HTMLTextAreaElement;
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 9]);
  });

  it("keeps a comment whose text is gone, and points it at the selection", async () => {
    const { recorded } = marginBridge(() => [
      storedThread({ from: 0, to: 12, quote: "a claim nobody made" }),
    ]);
    render(<DocumentEditor workspaceId="workspace-1" record={latexRecord()} />);
    await openMargin();

    // Listed apart rather than dropped: an anchor that stopped resolving is not permission to
    // hide somebody's argument.
    expect(await screen.findByRole("region", { name: "Comments that lost their place" }));
    expect(screen.getByText(/lost the text it was about/u)).toBeInTheDocument();

    const point = screen.getByRole("button", { name: "Point at the selection" });
    expect(point).toBeDisabled();

    selectSource(4, 9);
    await userEvent.click(screen.getByRole("button", { name: "Point at the selection" }));

    expect(recorded.find((entry) => entry.command === "kiwi.thread.reanchor")?.args).toEqual({
      thread_id: "thread-1",
      from: 4,
      to: 9,
      quote: "bound",
    });
  });

  it("reads the same comments in a rich manuscript", async () => {
    marginBridge(() => [storedThread({ from: 0, to: 8, quote: "Existing" })]);
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);
    await openMargin();

    expect(await screen.findByText("About Existing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the text of Existing" })).toBeInTheDocument();
  });
});

describe("linking to another Paper or Note", () => {
  interface Row {
    id: string;
    type: string;
    title: string;
  }

  const ROWS: Row[] = [
    { id: "paper-1", type: "source", title: "Computing Machinery and Intelligence" },
    { id: "note-2", type: "note", title: "Reading group, week three" },
  ];

  function mentionBridge(titles: Record<string, string> = {}) {
    const sent: Recorded[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Recorded;
      sent.push(request);
      const identity = { protocol_version: "1.0.0", request_id: crypto.randomUUID() };
      if (request.command === "kiwi.projection.list") {
        return { ...identity, status: "committed", data: { objects: ROWS } };
      }
      if (request.command === "kiwi.object.read") {
        const objectId = String(request.args["object_id"]);
        const title = titles[objectId];
        if (title === undefined) {
          return {
            ...identity,
            status: "failed",
            error: { code: "KIWI_NOT_FOUND", message: "It is not there." },
          };
        }
        return { ...identity, status: "committed", data: { object: { id: objectId, title } } };
      }
      return {
        ...identity,
        status: "committed",
        data: {
          object: {
            id: "note-1",
            type: "note",
            title: "Reading",
            version: 2,
            content_hash: `sha256:${"e".repeat(64)}`,
          },
          words: 3,
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  /** A note that already points at a paper, under the name that paper had at the time. */
  function withMention(target = "paper-1", label = "The name it had then", missing = false) {
    return record({
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "As " },
              { type: "mention", attrs: { target, kind: "source", label, missing } },
              { type: "text", text: " shows." },
            ],
          },
        ],
      },
    });
  }

  it("writes both the link in the sentence and the relation beside it", async () => {
    // Two things, answering opposite questions. The node is what the sentence reads as; the
    // relation is what lets the paper answer "what points at me" without every document in the
    // workspace being opened and scanned.
    const { sent } = mentionBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Link to something" }));
    await userEvent.click(await screen.findByText("Computing Machinery and Intelligence"));

    await waitFor(() => {
      expect(sent.some((entry) => entry.command === "kiwi.relation.create")).toBe(true);
    });
    expect(sent.find((entry) => entry.command === "kiwi.relation.create")?.args).toEqual({
      type: "mentions",
      subject_id: "note-1",
      object_id: "paper-1",
    });
  });

  it("shows a paper by the name it has now, not the one it had", async () => {
    mentionBridge({ "paper-1": "Computing Machinery and Intelligence" });
    render(<DocumentEditor workspaceId="workspace-1" record={withMention()} />);

    expect(await screen.findByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.queryByText("The name it had then")).not.toBeInTheDocument();
  });

  it("does not treat a rename made elsewhere as an edit to this document", async () => {
    // Otherwise opening a note beside a rename would save the note back, bump its version, and
    // meet a co-author's next save as a conflict over nothing anyone typed.
    const { sent } = mentionBridge({ "paper-1": "Computing Machinery and Intelligence" });
    render(<DocumentEditor workspaceId="workspace-1" record={withMention()} />);

    await screen.findByText("Computing Machinery and Intelligence");
    expect(sent.some((entry) => entry.command === "kiwi.object.set-document")).toBe(false);
  });

  it("marks a link whose object has gone, and keeps the name it had", async () => {
    // The sentence still reads perfectly with the paper deleted, which is exactly why the break
    // has to be visible. Losing the name as well would cost the sentence its meaning.
    mentionBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={withMention()} />);

    // Re-read rather than held: the restamp replaces the node view, so the element found a
    // moment ago is no longer the one on the screen.
    await waitFor(() =>
      expect(screen.getByText("The name it had then")).toHaveClass("mention--missing"),
    );
    expect(await screen.findByText(/no longer in the workspace/u)).toBeInTheDocument();
  });

  it("follows a link to what it points at", async () => {
    mentionBridge({ "paper-1": "Computing Machinery and Intelligence" });
    const onOpenObject = vi.fn();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={withMention()}
        onOpenObject={onOpenObject}
      />,
    );

    fireEvent.mouseDown(await screen.findByText("Computing Machinery and Intelligence"));
    expect(onOpenObject).toHaveBeenCalledWith("paper-1", "source");
  });

  it("is a name rather than a link where there is nowhere to send anyone", async () => {
    // A detached window holds one document and no way to show another.
    mentionBridge({ "paper-1": "Computing Machinery and Intelligence" });
    render(<DocumentEditor workspaceId="workspace-1" record={withMention()} />);

    const mention = await screen.findByText("Computing Machinery and Intelligence");
    expect(mention).not.toHaveAttribute("role", "link");
    expect(mention).not.toHaveClass("mention--linked");
  });

  it("never names a path", async () => {
    const { sent } = mentionBridge({ "paper-1": "Computing Machinery and Intelligence" });
    render(<DocumentEditor workspaceId="workspace-1" record={withMention()} />);

    await screen.findByText("Computing Machinery and Intelligence");
    for (const entry of sent) expect(entry.args).not.toHaveProperty("root");
  });
});

describe("what a Note draws on", () => {
  /** The index's answer for this note: one paper, reached through a passage it quoted. */
  function linkBridge() {
    const sent: Recorded[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as Recorded;
      sent.push(request);
      const identity = { protocol_version: "1.0.0", request_id: crypto.randomUUID() };
      if (request.command === "kiwi.projection.links") {
        return {
          ...identity,
          status: "committed",
          data: {
            links: [
              {
                relation_id: "relation-1",
                relation_type: "quotes",
                direction: "outgoing",
                object_id: "paper-1",
                object_type: "source",
                title: "Computing Machinery and Intelligence",
                via: { object_id: "annotation-1", title: "the imitation game" },
              },
            ],
          },
        };
      }
      return {
        ...identity,
        status: "committed",
        data: {
          object: {
            id: "note-1",
            type: "note",
            title: "Reading",
            version: 2,
            content_hash: `sha256:${"e".repeat(64)}`,
          },
          words: 3,
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent };
  }

  it("lists the Papers it rests on, under the text", async () => {
    linkBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    expect(await screen.findByText("Computing Machinery and Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Paper · quoted")).toBeInTheDocument();
  });

  it("asks the index about this document and nothing else", async () => {
    const { sent } = linkBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={record()} />);

    await screen.findByText("Computing Machinery and Intelligence");
    const asked = sent.find((entry) => entry.command === "kiwi.projection.links");
    expect(asked?.args).toEqual({ object_id: "note-1" });
  });
});

describe("following a quotation back to its page", () => {
  /** A note holding one quotation, the way one arrives from the Reader. */
  function quoting() {
    return record({
      document: {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "machines can think" }] },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "quotation",
                attrs: {
                  annotation: "annotation-1",
                  target: "paper-1",
                  source: "Computing Machinery and Intelligence",
                  page_label: "434",
                },
              },
            ],
          },
        ],
      },
    });
  }

  it("says which paper and which page under the passage", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={quoting()} />);

    expect(
      await screen.findByText("— Computing Machinery and Intelligence, p. 434"),
    ).toBeInTheDocument();
  });

  it("opens the page it was read on", async () => {
    stubBridge();
    const onOpenAnnotation = vi.fn();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={quoting()}
        onOpenAnnotation={onOpenAnnotation}
      />,
    );

    const line = await screen.findByText("— Computing Machinery and Intelligence, p. 434");
    // The press rather than the click: the editor turns a press on an atom into a selection,
    // and the node view claims it there so the line does not flash before it opens.
    fireEvent.mouseDown(line);
    // The paper travels with the mark, so a mark that has since been deleted still leaves
    // somewhere for the click to go.
    expect(onOpenAnnotation).toHaveBeenCalledWith("annotation-1", "paper-1");
  });

  it("is a line rather than a link where there is no Reader to open", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={quoting()} />);

    const line = await screen.findByText("— Computing Machinery and Intelligence, p. 434");
    expect(line).not.toHaveAttribute("role", "link");
  });
});

describe("saying where the caret is", () => {
  const heard: Array<{ documentId: string; offset: number }> = [];

  function collect(event: Event): void {
    heard.push((event as CustomEvent<{ documentId: string; offset: number }>).detail);
  }

  beforeEach(() => {
    heard.length = 0;
    window.addEventListener(CARET_CHANNEL, collect);
  });

  afterEach(() => {
    window.removeEventListener(CARET_CHANNEL, collect);
    forgetCaret();
  });

  function latest(): { documentId: string; offset: number } | undefined {
    return heard.at(-1);
  }

  function source(content: string): DocumentRecord {
    return record({ type: "output", document_mode: "latex", content });
  }

  function field(): HTMLTextAreaElement {
    return screen.getByLabelText("LaTeX source") as HTMLTextAreaElement;
  }

  function caretAt(at: number): void {
    const box = field();
    box.setSelectionRange(at, at);
    fireEvent.select(box);
  }

  it("follows the caret through a LaTeX manuscript", async () => {
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source("\\section{M}\nBody.\n")} />);
    await screen.findByLabelText("LaTeX source");

    caretAt(12);

    expect(latest()).toEqual({ documentId: "note-1", offset: 12 });
  });

  it("follows it while somebody is typing, not only while they are selecting", async () => {
    // A caret moves when a key is pressed as surely as when a line is clicked, and a textarea does
    // not promise a select event for the first of those.
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source("ab\n")} />);
    await screen.findByLabelText("LaTeX source");

    fireEvent.change(field(), {
      target: { value: "abc\n", selectionStart: 3, selectionEnd: 3 },
    });

    expect(latest()?.offset).toBe(3);
  });

  it("says where the caret is in the source, not where it is in the field", async () => {
    // A folded run is cut out of what the field holds, so every position after one is short by
    // its length. Sending that number would draw somebody's caret a paragraph early.
    const SOURCE = "\\section{One}\nBody one.\n\\section{Two}\nBody two.\n";
    stubBridge();
    render(<DocumentEditor workspaceId="workspace-1" record={source(SOURCE)} />);
    await screen.findByLabelText("LaTeX source");
    await userEvent.click(screen.getByRole("button", { name: "Fold section" }));

    const inField = field().value.indexOf("Body two.");
    expect(inField).toBeLessThan(SOURCE.indexOf("Body two."));

    caretAt(inField);

    expect(latest()?.offset).toBe(SOURCE.indexOf("Body two."));
  });

  it("follows the caret through a rich manuscript, in the editor's own positions", async () => {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({
          document: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "the cat and the hat" }] },
            ],
          },
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Find and replace" }));
    await userEvent.type(screen.getByLabelText("Find"), "the");
    await screen.findByText("1 of 2");

    await userEvent.click(screen.getByRole("button", { name: "Next match" }));

    // A node tree counts from one, and the second "the" is twelve characters into the paragraph.
    await waitFor(() => expect(latest()?.offset).toBe(13));
  });
});

describe("showing where everybody else is", () => {
  afterEach(() => {
    forgetPresence();
  });

  function reader(userId: string, cursor: number): PresentPerson {
    return {
      userId,
      name: `${userId} Okoye`,
      initials: "SO",
      colour: "#159078",
      cursor,
      named: true,
    };
  }

  function say(people: readonly PresentPerson[]): void {
    act(() => {
      announcePresence({ documentId: "note-1", people });
    });
  }

  function marks(): (string | undefined)[] {
    return [...document.querySelectorAll<HTMLElement>(".remote-caret")].map(
      (mark) => mark.dataset["person"],
    );
  }

  async function openSource(): Promise<void> {
    stubBridge();
    render(
      <DocumentEditor
        workspaceId="workspace-1"
        record={record({ type: "output", document_mode: "latex", content: "Body one.\n" })}
      />,
    );
    await screen.findByLabelText("LaTeX source");
  }

  it("draws a caret for each person in a LaTeX manuscript, with their name on it", async () => {
    await openSource();

    say([reader("sam", 5), reader("wren", 2)]);

    expect(marks()).toEqual(["sam", "wren"]);
    expect(screen.getByText("sam Okoye")).toBeTruthy();
  });

  it("draws nobody whose caret is past the end of this copy of the document", async () => {
    // Their copy is further along than this one. Drawing them at the end would be inventing a
    // position rather than reporting one, and the next answer says where they really are.
    await openSource();

    say([reader("sam", 4_000)]);

    expect(marks()).toEqual([]);
  });

  it("takes them off the screen when the answer says nobody is there", async () => {
    await openSource();
    say([reader("sam", 5)]);

    say([]);

    expect(marks()).toEqual([]);
  });
});
