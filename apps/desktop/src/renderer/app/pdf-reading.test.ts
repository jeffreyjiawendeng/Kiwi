import { describe, expect, it, vi } from "vitest";
import type { PdfDocument, PdfPage, PdfTextItem } from "./pdf-document.js";
import { readPdfFile } from "./pdf-reading.js";

/** A first page, written the way it reads: lines down the page, each with a type size. */
function page(lines: Array<[text: string, height: number]>): PdfTextItem[] {
  return lines.map(([text, height], index) => ({
    text,
    left: 100,
    top: index * 30,
    width: text.length * height * 0.5,
    height,
  }));
}

const TITLE_PAGE = page([
  ["Proceedings of the 41st Conference", 8],
  ["Notes on the Analytical Engine", 18],
  ["Ada Lovelace, Charles Babbage", 11],
  ["Abstract", 11],
]);

function stubPage(overrides: Partial<PdfPage> = {}): PdfPage {
  return {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async () => TITLE_PAGE),
    ...overrides,
  };
}

function stubDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    pageCount: 12,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => stubPage()),
    outline: vi.fn(async () => []),
    metadata: vi.fn(async () => ({})),
    destroy: vi.fn(),
    ...overrides,
  };
}

function loaderFor(document: PdfDocument) {
  return vi.fn(async () => document);
}

describe("readPdfFile", () => {
  it("takes the record from what the file says about itself", async () => {
    const document = stubDocument({
      metadata: vi.fn(async () => ({
        title: "Notes on the Analytical Engine",
        author: "Ada Lovelace; Charles Babbage",
      })),
    });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(read.title).toBe("Notes on the Analytical Engine");
    expect(read.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(read.sources.title).toBe("embedded");
  });

  it("reads the first page where the file names a LaTeX run instead of a work", async () => {
    // The point of opening the page at all: half of the PDFs in a library are titled by
    // whatever produced them.
    const document = stubDocument({ metadata: vi.fn(async () => ({ title: "paper.dvi" })) });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(read.title).toBe("Notes on the Analytical Engine");
    expect(read.sources.title).toBe("page");
  });

  it("reads the page when the file will not say anything about itself", async () => {
    const document = stubDocument({
      metadata: vi.fn(async () => {
        throw new Error("no info dictionary");
      }),
    });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(read.title).toBe("Notes on the Analytical Engine");
  });

  it("keeps what the file says when its first page has no text on it", async () => {
    // A scan. There is nothing to read off the page, which is not a reason to lose the rest.
    const document = stubDocument({
      metadata: vi.fn(async () => ({ title: "Notes on the Analytical Engine" })),
      page: vi.fn(async () =>
        stubPage({
          textItems: vi.fn(async () => {
            throw new Error("no text layer");
          }),
        }),
      ),
    });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(read.title).toBe("Notes on the Analytical Engine");
    expect(read.sources.title).toBe("embedded");
  });

  it("does not ask an empty document for a first page", async () => {
    const page = vi.fn(async () => stubPage());
    const document = stubDocument({ pageCount: 0, page });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(page).not.toHaveBeenCalled();
    expect(read.sources.title).toBe("none");
  });

  it("says it found nothing rather than inventing a record", async () => {
    const document = stubDocument({
      page: vi.fn(async () => stubPage({ textItems: vi.fn(async () => []) })),
    });

    const read = await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(read.title).toBe("");
    expect(read.reference.authors).toEqual([]);
    expect(read.sources).toEqual({
      title: "none",
      authors: "none",
      year: "none",
      doi: "none",
      url: "none",
    });
  });

  it("closes the document, so a folder of files does not leave a worker behind each", async () => {
    const document = stubDocument();

    await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("closes the document even when reading it goes wrong", async () => {
    const document = stubDocument({
      page: vi.fn(async () => {
        throw new Error("damaged");
      }),
    });

    await readPdfFile(loaderFor(document), "kiwi-asset://workspace-1/asset-1");

    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("lets a file that will not open at all be the caller's problem", async () => {
    // One unreadable file in a folder is a decision about the folder, which this cannot make.
    const loader = vi.fn(async () => {
      throw new Error("not a PDF");
    });

    await expect(readPdfFile(loader, "kiwi-asset://workspace-1/asset-1")).rejects.toThrow(
      "not a PDF",
    );
  });
});
