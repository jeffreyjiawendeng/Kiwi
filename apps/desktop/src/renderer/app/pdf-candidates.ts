import { bareFields, validateReference, type PdfMetadata } from "@kiwi/contracts";
import { selectionUrl, type PdfLoader } from "./pdf-document.js";
import { readPdfFile } from "./pdf-reading.js";
import { listPhrase, type PreviewRow } from "./import-review.js";

/**
 * Turning a folder of picked PDFs into rows somebody can review.
 *
 * The other way into this feature is a reference file, which arrives already written down: a
 * `.bib` entry states its title and its authors, and the workspace reads it and hands back rows.
 * A folder of PDFs states nothing. Each file has to be opened and read for what it is about,
 * which is guesswork, and the whole point of the review table is that guesswork gets looked at
 * before it is kept. So the two ways in end at the same place -- a list of `PreviewRow` -- and
 * the table below cannot tell which happened, exactly as a dropped file and a picked one already
 * cannot be told apart.
 *
 * What is different is that these rows say where they came from. `readPdfMetadata` reports a
 * source per field, because a title lifted off a first page is a guess and a title the file
 * stated is not, and losing that distinction here would present the guess as the record. It
 * becomes one sentence on the row, in the same place a duplicate verdict goes.
 *
 * Not here: whether any of these files is something the library already holds. That question is
 * asked of the workspace, and the workspace has not been given these files yet.
 */

/** A picked file, as much of it as the renderer is ever told. */
export interface PdfSelection {
  /** The single-use identifier the picker issued. It is how the file is addressed, not where. */
  id: string;
  /** What it is called. The only human-readable thing about it that crosses the bridge. */
  name: string;
}

export interface PdfCandidates {
  rows: PreviewRow[];
  /**
   * The files that would not open, by name.
   *
   * Named rather than counted, unlike the things in the folder that were never PDFs. A file that
   * was passed over was never going to be a paper; a PDF that would not open was meant to be one,
   * and the person can go and look at the two that failed if they know which two.
   */
  unreadable: string[];
}

export interface ReadPdfSelectionsOptions {
  /** Called after each file, so a folder of thirty can say how far along it is. */
  onProgress?: (read: number) => void;
  /** Fixed in tests, since validation asks what year it is before calling one implausible. */
  now?: Date;
}

/** What a file is called, without the part that says it is a PDF. */
function titleFromName(name: string): string {
  const stripped = name.replace(/\.pdf$/iu, "").trim();
  return stripped === "" ? name : stripped;
}

/** The fields a reading reports on, spelled for a sentence rather than for a schema. */
const FIELD_NAMES = {
  title: "title",
  authors: "authors",
  year: "year",
  doi: "DOI",
  url: "link",
} as const;

/**
 * How the row was arrived at, in a sentence, or nothing when there is nothing to admit.
 *
 * Only the guesses are worth a sentence. A field the file stated is the file's own account of
 * itself and needs no defending; a field read off the first page was decided by where it sat and
 * how large it was, and that is the kind of thing somebody should be told before they keep it.
 */
function describeReading(metadata: PdfMetadata, named: boolean): string | null {
  const sentences: string[] = [];
  if (named) sentences.push("Nothing in this file stated a title, so the row is named after it.");
  const guessed = (Object.keys(FIELD_NAMES) as Array<keyof typeof FIELD_NAMES>).filter(
    (field) => metadata.sources[field] === "page",
  );
  if (guessed.length > 0) {
    const was = guessed.length === 1 ? "was" : "were";
    sentences.push(
      `The ${listPhrase(guessed.map((field) => FIELD_NAMES[field]))} ${was} read off the first page, not stated by the file.`,
    );
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}

/** One file, read for the record it would be imported as. */
function rowFor(
  selection: PdfSelection,
  row: number,
  metadata: PdfMetadata,
  checked: Date,
): PreviewRow {
  const named = metadata.title === "";
  return {
    row,
    // The selection identifier, which is unique per file and stays the same across a re-render.
    key: selection.id,
    title: named ? titleFromName(selection.name) : metadata.title,
    reference: metadata.reference,
    // Nothing has read these bytes as bytes. A hash is what the workspace matches a file against
    // a file by, and it belongs to whichever step hands the file over, not to reading it.
    file_hash: null,
    selected: true,
    duplicate: null,
    problems: validateReference(metadata.reference, checked),
    missing: bareFields(metadata.reference),
    note: describeReading(metadata, named),
  };
}

/**
 * Reads every picked file, in order, and says which ones it could not.
 *
 * One at a time rather than all at once. Every open document holds a PDF.js worker and a file's
 * worth of bytes, and thirty of those at once is thirty workers competing over one folder for no
 * gain: the person is going to read the rows in order anyway. It also makes the count this
 * reports mean something, which a scatter of parallel reads would not.
 *
 * A file that will not open is set aside and the rest go on. This is the decision `readPdfFile`
 * left to its caller, and it is the same one the folder listing already made: one bad file among
 * thirty is one missing row, and one missing row should not cost the other twenty-nine.
 */
export async function readPdfSelections(
  load: PdfLoader,
  selections: readonly PdfSelection[],
  options: ReadPdfSelectionsOptions = {},
): Promise<PdfCandidates> {
  const checked = options.now ?? new Date();
  const rows: PreviewRow[] = [];
  const unreadable: string[] = [];

  for (const [index, selection] of selections.entries()) {
    try {
      const metadata = await readPdfFile(load, selectionUrl(selection.id));
      // Numbered by where the file sat in the folder, which is what the number means on the
      // other way in too. A file that would not open leaves its number unused rather than
      // shuffling every row after it up one.
      rows.push(rowFor(selection, index + 1, metadata, checked));
    } catch {
      // Why it would not open is not worth reporting. "Damaged", "encrypted" and "not a PDF at
      // all" are the same instruction to the person holding the folder: go and look at that one.
      unreadable.push(selection.name);
    }
    options.onProgress?.(index + 1);
  }

  return { rows, unreadable };
}
