import { readPdfMetadata, type PdfMetadata, type PdfTextRun } from "@kiwi/contracts";
import type { PdfDocument, PdfLoader } from "./pdf-document.js";

/**
 * Reading a PDF for the record it would be imported as.
 *
 * The judgement lives in contracts, where it is tested against title pages written out by hand.
 * This is the part that has to touch a real file: open it, ask what it says about itself, take
 * the text off its first page, and hand both to `readPdfMetadata`.
 *
 * The two inputs fail differently, and neither failure is unusual. A file with no info
 * dictionary is ordinary, and so is a scan whose first page carries no text layer, so each is
 * taken as far as it goes and whatever the other offers still gets through. A file that will not
 * open at all is a different matter and is left to the caller, which is the only one that knows
 * whether a bad file should stop the rest of a folder.
 */
export async function readPdfFile(load: PdfLoader, url: string): Promise<PdfMetadata> {
  const document = await load(url);
  try {
    const info = await document.metadata().catch(() => ({}));
    const firstPage = document.pageCount < 1 ? [] : await firstPageRuns(document);
    return readPdfMetadata(info, firstPage);
  } finally {
    // Every open document holds a worker, and an import walks a folder one file at a time.
    document.destroy();
  }
}

/** The text of the first page, or nothing, which a scan is entitled to give. */
async function firstPageRuns(document: PdfDocument): Promise<PdfTextRun[]> {
  try {
    const page = await document.page(1);
    return await page.textItems();
  } catch {
    return [];
  }
}
