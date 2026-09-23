import { listPhrase, type CreatedRow } from "./import-review.js";

/**
 * Putting the PDF a row was read out of onto the Paper that row became.
 *
 * A folder import is the only way into Kiwi where the record and the file arrive together. A
 * `.bib` file states what a paper is and has none of the papers; a folder is the papers. So a
 * folder import that stopped at creating records would leave somebody with four hundred Papers
 * and four hundred PDFs still in a folder, and the job of pairing them up by hand -- which is
 * the job they were trying to avoid.
 *
 * It happens after the import rather than inside it for a plain reason: the workspace cannot see
 * these files. It was sent rows, not files, because the files were opened in the window. Copying
 * one in is a command of its own that already exists and already works one file at a time, and
 * running it once per row is what the folder has been doing since the picker: the single-file
 * path run repeatedly rather than a second kind of import.
 *
 * Which Paper a file belongs on is answered by the name the row travelled under, never by
 * position. The receipt reports what was created and what was held back in two lists, so the
 * created list on its own is shorter than the rows that were sent whenever anything was a
 * duplicate -- and pairing by position would then file every paper after the first duplicate
 * against the wrong record. Wrongly attached is worse than unattached: an unattached file is
 * visibly missing, and a file on the wrong paper is a quotation from the wrong work.
 */

/** A picked file, as much of it as the renderer is ever told. */
export interface PickedFile {
  /** The single-use identifier the picker issued. It is how the file is addressed, not where. */
  id: string;
  /** What it is called, which is the only thing worth saying about it in a sentence. */
  name: string;
}

/**
 * Copies one picked file into the workspace and answers with what it became.
 *
 * `null` means this file did not make it and the rest still might -- an expired identifier, a
 * file that has been moved since it was picked. Throwing means the workspace itself has stopped
 * answering, and there is no point asking it four hundred more times.
 */
export type CopyIntoWorkspace = (selectionId: string) => Promise<string | null>;

/** Attaches a copied file to a Paper. False where the workspace declined; throwing as above. */
export type AttachToPaper = (paperId: string, assetId: string) => Promise<boolean>;

export interface AttachedFiles {
  /** How many Papers ended up holding the file they were read out of. */
  attached: number;
  /** The files that did not, by name, in the order they were tried. */
  missed: string[];
}

export interface AttachFilesOptions {
  /** Called after each file, so a folder of four hundred can say how far along it is. */
  onProgress?: (done: number) => void;
}

/**
 * Files each created Paper with the PDF it was read out of, and says what it could not file.
 *
 * Only Papers that were created, and only ones whose row names a file this side is still holding.
 * A row held back as a duplicate created nothing, so there is nothing for its file to go on; the
 * work it was a second copy of already exists and may already have its own file, and deciding
 * whether this one belongs there too is a person's decision rather than an import's.
 *
 * A file that will not copy costs its own row and nothing else, exactly as one that would not
 * open cost its own row during the reading. The Paper is already created either way -- the record
 * is the greater part of what was wanted, and throwing it away because its file could not follow
 * would be losing the reading to save the filing.
 */
export async function attachPickedFiles(
  copyIn: CopyIntoWorkspace,
  attach: AttachToPaper,
  created: readonly CreatedRow[],
  files: ReadonlyMap<string, PickedFile>,
  options: AttachFilesOptions = {},
): Promise<AttachedFiles> {
  const pending = created
    .map((row) => ({ paper: row.id, file: files.get(row.key) }))
    .filter((row): row is { paper: string; file: PickedFile } => row.file !== undefined);

  let attached = 0;
  const missed: string[] = [];
  for (const [index, row] of pending.entries()) {
    try {
      const assetId = await copyIn(row.file.id);
      if (assetId === null || !(await attach(row.paper, assetId))) missed.push(row.file.name);
      else attached += 1;
    } catch {
      // The workspace has stopped answering. Everything from here on is a file that did not make
      // it, and saying so now is more use than four hundred further requests to nobody.
      for (const remaining of pending.slice(index)) missed.push(remaining.file.name);
      break;
    }
    options.onProgress?.(index + 1);
  }
  return { attached, missed };
}

/**
 * What the filing came to, in a sentence, or nothing when there was no filing to do.
 *
 * The successes are worth stating and not only the failures. Copying four hundred PDFs into the
 * workspace is the part of this import that took the time and the disk, and an import that says
 * only "400 papers added" leaves somebody wondering whether the files came too.
 */
export function describeAttachments(result: AttachedFiles): string | null {
  const sentences: string[] = [];
  if (result.attached === 1) sentences.push("Its file was copied in and attached to it.");
  else if (result.attached > 1)
    sentences.push(
      `${result.attached.toLocaleString()} files were copied into the workspace and attached.`,
    );
  if (result.missed.length > 0) {
    // Three names and a count, the same way the folder reading names what it could not open. A
    // list nobody reads to the end is not a list anybody acts on.
    const shown = result.missed.slice(0, 3);
    const rest = result.missed.length - shown.length;
    const named = rest === 0 ? listPhrase(shown) : `${shown.join(", ")} and ${String(rest)} more`;
    sentences.push(
      `Kiwi could not attach ${named}. The papers were still added, and the ${result.missed.length === 1 ? "file can" : "files can"} be added from the paper.`,
    );
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}
