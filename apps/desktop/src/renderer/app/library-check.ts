import type { ReferenceKind } from "@kiwi/contracts";
import { readImportPreview, type PreviewRow } from "./import-review.js";

/**
 * Asking the library whether it already holds any of the rows read in the window.
 *
 * A reference file is read by the workspace, which knows what the library holds and says on
 * every row it hands back whether the work is already there. A folder of PDFs is not: the files
 * are opened here, because a PDF renderer is what a window has and a workspace does not, and the
 * rows arrive knowing what each paper is and nothing about whether Kiwi already has it. Left
 * that way, importing the same folder twice would create every paper in it twice, and the second
 * copy would be nobody's mistake but Kiwi's.
 *
 * So the rows go back the other way and the same command answers the same question. Not a second
 * implementation of what a duplicate is: a shared DOI, an identical file and a title that merely
 * reads alike are three different pieces of news, and two entrances that each decided for
 * themselves which was which would be two sets of duplicate bugs.
 *
 * What is sent is what a duplicate is decided on and nothing else -- the title, the DOI, the
 * year, the authors, the hash of the file. Partly because the rest is not consulted, and partly
 * because five hundred whole records with their abstracts in them would not fit under the size a
 * single command may be, and a check that had to be cut into parts would be a check that could
 * not see a folder listing the same paper at both ends of itself.
 */

/** One row, reduced to the parts the answer turns on. */
export interface CheckEntry {
  title: string;
  reference: {
    kind: ReferenceKind;
    authors: string[];
    year: number | null;
    doi: string | null;
  };
  file_hash: string | null;
}

/** How the question is put. The component owns the bridge; this owns what is asked and read. */
export type AskLibrary = (entries: CheckEntry[]) => Promise<Record<string, unknown> | null>;

export interface CheckedRows {
  rows: PreviewRow[];
  /**
   * What went wrong, when something did.
   *
   * A failed check is not a failed read. The files opened, the rows are good, and the only thing
   * missing is one warning -- so the rows are shown as they are and the gap is stated, rather
   * than throwing away a folder somebody just waited three minutes for. It has to be stated
   * plainly, though: a person who is told nothing will assume the checking happened.
   */
  note: string | null;
}

export function checkEntries(rows: readonly PreviewRow[]): CheckEntry[] {
  return rows.map((row) => ({
    title: row.title,
    reference: {
      kind: row.reference.kind,
      authors: row.reference.authors,
      year: row.reference.year,
      doi: row.reference.doi,
    },
    file_hash: row.file_hash,
  }));
}

/**
 * Puts the library's verdict onto rows that were read here.
 *
 * By position, because position is the only thing the two lists are guaranteed to share: the
 * rows were sent in order and the answer comes back in order. An answer of a different length is
 * an answer about some other set of rows, and putting a verdict from one row onto another would
 * be worse than having none -- it would untick a paper nobody has ever seen a second copy of.
 */
export async function checkAgainstLibrary(
  ask: AskLibrary,
  rows: readonly PreviewRow[],
): Promise<CheckedRows> {
  const unchecked = {
    rows: [...rows],
    note: "Kiwi could not check these against the library. Anything it already holds will be added again.",
  };

  const answer = await ask(checkEntries(rows));
  if (answer === null) return unchecked;
  const preview = readImportPreview(answer);
  if (preview === null || preview.rows.length !== rows.length) return unchecked;

  const checked: PreviewRow[] = [];
  for (const [index, row] of rows.entries()) {
    const verdict = preview.rows[index];
    if (verdict === undefined) return unchecked;
    // Everything else stays as it was read. The answer is about duplicates, and the rows carry
    // things it was never told -- what the file stated and what was guessed off its first page.
    checked.push({ ...row, duplicate: verdict.duplicate, selected: verdict.selected });
  }
  return { rows: checked, note: null };
}
