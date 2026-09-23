import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a folder of PDFs offers an import.
 *
 * Only the folder that was picked, and not the tree under it. A person choosing a folder can see
 * what is in it; they cannot see what is in everything below it, and the difference between those
 * two amounts of work is the difference between thirty papers and a Zotero storage directory of
 * several thousand. Walking down is a thing that can be added later against an asking; guessing it
 * now would make the picked folder mean something other than what it looked like.
 *
 * What is not a PDF is counted rather than listed. A folder of papers usually holds a few other
 * things -- a spreadsheet, a stray note -- and naming each one back would bury the papers. That
 * the count is shown at all is the point: a folder of thirty files that yields twenty rows should
 * say so, so nobody has to work out which ten went missing.
 */

/** Everything the import needs to know about a picked folder, before it holds any identifiers. */
export interface PdfFolderListing {
  /** The files to make selections from, in the order they should be shown. */
  paths: string[];
  /** What else was in the folder. Counted rather than listed. */
  skipped: number;
  /** True when the folder held more PDFs than one pass takes, and the rest were left behind. */
  truncated: boolean;
}

/**
 * How many files one pass takes.
 *
 * Every file becomes a row somebody is expected to actually read before it is committed, and a
 * pass nobody can review is not a review. It is also the number of single-use identifiers held at
 * once, each good for ten minutes. A larger folder is imported in more than one go.
 */
export const FOLDER_IMPORT_LIMIT = 500;

/**
 * A dotfile is skipped whatever it is called: on macOS a resource fork sits beside its file as
 * `._paper.pdf`, and it is not the paper.
 */
function isPdfName(name: string): boolean {
  return !name.startsWith(".") && name.toLowerCase().endsWith(".pdf");
}

/**
 * Named the way the person who made the folder named them, so `chapter9` comes before
 * `chapter10` rather than after it.
 */
const byName = new Intl.Collator("en", { numeric: true });

/**
 * Lists the PDFs directly inside a folder.
 *
 * A folder that cannot be read raises rather than coming back empty, because "there is nothing
 * here" and "I could not look" are different answers and only one of them is worth showing as a
 * result.
 */
export async function listPdfFolder(
  root: string,
  limit: number = FOLDER_IMPORT_LIMIT,
): Promise<PdfFolderListing> {
  const entries = await readdir(root, { withFileTypes: true });

  const names: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    // A subfolder is not counted as skipped: it was never a candidate, and counting it would
    // read as though a paper had been passed over. A symbolic link is not a file here either --
    // `readdir` reports the link itself -- and it stays out for the same reason the single-file
    // picker turns one away: what it points at is a path somebody else chose.
    if (!entry.isFile()) continue;
    if (isPdfName(entry.name)) names.push(entry.name);
    else skipped += 1;
  }
  names.sort(byName.compare);

  return {
    paths: names.slice(0, limit).map((name) => join(root, name)),
    skipped,
    truncated: names.length > limit,
  };
}
