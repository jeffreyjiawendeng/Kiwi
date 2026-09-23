import { describe, expect, it, vi } from "vitest";
import type { PdfInfo } from "@kiwi/contracts";
import type { PdfDocument, PdfPage, PdfTextItem } from "./pdf-document.js";
import { readPdfSelections, type PdfSelection } from "./pdf-candidates.js";

/** Enough of a year that validation has an opinion about one. */
const NOW = new Date("2026-08-27T00:00:00.000Z");

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

function stubPage(items: PdfTextItem[] = TITLE_PAGE): PdfPage {
  return {
    width: 612,
    height: 792,
    render: vi.fn(async () => undefined),
    textItems: vi.fn(async () => items),
  };
}

function stubDocument(info: PdfInfo = {}, items: PdfTextItem[] = TITLE_PAGE): PdfDocument {
  return {
    pageCount: 12,
    pageLabel: (pageNumber) => String(pageNumber),
    page: vi.fn(async () => stubPage(items)),
    outline: vi.fn(async () => []),
    metadata: vi.fn(async () => ({
      title: null,
      author: null,
      subject: null,
      keywords: null,
      creationDate: null,
      ...info,
    })),
    destroy: vi.fn(),
  };
}

/** A folder where every file reads the same, which is the case most of these are varying from. */
function folder(names: string[]): PdfSelection[] {
  return names.map((name, index) => ({ id: `selection-${String(index + 1)}`, name }));
}

/** A loader that answers for each address in turn, and refuses anything it was not given. */
function loaderFor(documents: Record<string, PdfDocument>) {
  return vi.fn(async (url: string) => {
    const document = documents[url];
    if (document === undefined) throw new Error("not a PDF");
    return document;
  });
}

describe("readPdfSelections", () => {
  it("gives one row per file, in the order the folder was listed", async () => {
    const files = folder(["a.pdf", "b.pdf", "c.pdf"]);
    const load = vi.fn(async () => stubDocument({ title: "Notes on the Analytical Engine" }));

    const read = await readPdfSelections(load, files, { now: NOW });

    expect(read.rows.map((row) => row.key)).toEqual(["selection-1", "selection-2", "selection-3"]);
    expect(read.rows.map((row) => row.row)).toEqual([1, 2, 3]);
    expect(read.unreadable).toEqual([]);
  });

  it("asks for each file by its identifier and by nothing else", async () => {
    // The whole reason there is a scheme for this. A row is read out of a file the renderer
    // cannot name and could not open on its own.
    const load = vi.fn(async () => stubDocument({ title: "Notes on the Analytical Engine" }));

    await readPdfSelections(load, folder(["paper.pdf"]), { now: NOW });

    expect(load).toHaveBeenCalledWith("kiwi-selection://pending/selection-1");
  });

  it("takes the record the file states, and says nothing further about it", async () => {
    const load = vi.fn(async () =>
      stubDocument({
        title: "Notes on the Analytical Engine",
        author: "Ada Lovelace; Charles Babbage",
        creationDate: "D:20230415120000+02'00'",
      }),
    );

    const read = await readPdfSelections(load, folder(["paper.pdf"]), { now: NOW });

    expect(read.rows[0]?.title).toBe("Notes on the Analytical Engine");
    expect(read.rows[0]?.reference.authors).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(read.rows[0]?.note).toBeNull();
  });

  it("says which fields it read off the first page rather than took from the file", async () => {
    // A title decided by being the largest line near the top is a guess, and a guess presented
    // as a record is the one thing this review exists to prevent.
    const load = vi.fn(async () => stubDocument({ title: "paper.dvi" }));

    const read = await readPdfSelections(load, folder(["paper.pdf"]), { now: NOW });

    expect(read.rows[0]?.title).toBe("Notes on the Analytical Engine");
    expect(read.rows[0]?.note).toBe(
      "The title and authors were read off the first page, not stated by the file.",
    );
  });

  it("names a row after its file when nothing in the file offered a title", async () => {
    // A scan: no info dictionary worth the name, and no text layer to read instead. The file
    // name is what the person sees in the folder, so it is what they are shown here.
    const load = vi.fn(async () => stubDocument({}, []));

    const read = await readPdfSelections(load, folder(["Lovelace 1843 notes.pdf"]), { now: NOW });

    expect(read.rows[0]?.title).toBe("Lovelace 1843 notes");
    expect(read.rows[0]?.note).toBe(
      "Nothing in this file stated a title, so the row is named after it.",
    );
  });

  it("says what is thin about a record while the row can still be corrected", async () => {
    const load = vi.fn(async () => stubDocument({}, []));

    const read = await readPdfSelections(load, folder(["scan.pdf"]), { now: NOW });

    expect(read.rows[0]?.missing).toEqual(["authors", "year", "container"]);
  });

  it("arrives ticked, and claims no duplicate the library has not been asked about", async () => {
    const load = vi.fn(async () => stubDocument({ title: "Notes on the Analytical Engine" }));

    const read = await readPdfSelections(load, folder(["paper.pdf"]), { now: NOW });

    expect(read.rows[0]?.selected).toBe(true);
    expect(read.rows[0]?.duplicate).toBeNull();
    expect(read.rows[0]?.file_hash).toBeNull();
  });

  it("sets a file that will not open aside and reads the rest of the folder", async () => {
    // One bad file among thirty is one missing row, and one missing row should not cost the
    // other twenty-nine.
    const load = loaderFor({
      "kiwi-selection://pending/selection-1": stubDocument({ title: "First paper" }),
      "kiwi-selection://pending/selection-3": stubDocument({ title: "Third paper" }),
    });

    const read = await readPdfSelections(load, folder(["a.pdf", "damaged.pdf", "c.pdf"]), {
      now: NOW,
    });

    expect(read.rows.map((row) => row.title)).toEqual(["First paper", "Third paper"]);
    expect(read.unreadable).toEqual(["damaged.pdf"]);
  });

  it("leaves the number of a file that would not open unused", async () => {
    const load = loaderFor({
      "kiwi-selection://pending/selection-1": stubDocument({ title: "First paper" }),
      "kiwi-selection://pending/selection-3": stubDocument({ title: "Third paper" }),
    });

    const read = await readPdfSelections(load, folder(["a.pdf", "damaged.pdf", "c.pdf"]), {
      now: NOW,
    });

    expect(read.rows.map((row) => row.row)).toEqual([1, 3]);
  });

  it("opens one file at a time", async () => {
    // Every open document holds a worker. Thirty at once is thirty workers over one folder, for
    // a list the person is going to read in order anyway.
    let open = 0;
    let peak = 0;
    const load = vi.fn(async () => {
      open += 1;
      peak = Math.max(peak, open);
      await Promise.resolve();
      const document = stubDocument({ title: "Notes on the Analytical Engine" });
      return { ...document, destroy: () => (open -= 1) };
    });

    await readPdfSelections(load, folder(["a.pdf", "b.pdf", "c.pdf"]), { now: NOW });

    expect(peak).toBe(1);
  });

  it("says how far along it is after every file, readable or not", async () => {
    const onProgress = vi.fn();
    const load = loaderFor({
      "kiwi-selection://pending/selection-1": stubDocument({ title: "First paper" }),
    });

    await readPdfSelections(load, folder(["a.pdf", "damaged.pdf"]), { now: NOW, onProgress });

    expect(onProgress.mock.calls).toEqual([[1], [2]]);
  });

  it("reads a folder where nothing opens as a folder that yielded nothing", async () => {
    const load = loaderFor({});

    const read = await readPdfSelections(load, folder(["a.pdf", "b.pdf"]), { now: NOW });

    expect(read.rows).toEqual([]);
    expect(read.unreadable).toEqual(["a.pdf", "b.pdf"]);
  });
});
