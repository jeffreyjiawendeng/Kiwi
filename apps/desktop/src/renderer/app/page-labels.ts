/**
 * Turning what somebody types into the pager into a page of the file.
 *
 * A PDF numbers its own pages, and the numbering it prints is usually not the order the pages sit
 * in the file: front matter runs i, ii, iii and then the body starts again at 1. The number a
 * reader has in their hand comes off a citation, a printed page or a colleague's email, so it is
 * the printed one, and that is what the pager takes first.
 *
 * The position in the file is still worth accepting, because it is the only number somebody has
 * when the page they want prints no number at all, a plate, a blank verso, a scanned insert.
 * So both are read, printed first, and the caller is told which page of the file was meant.
 */

/**
 * The page of the file somebody meant, counting from one, or null if nothing was meant.
 *
 * A printed label wins over a position, which matters for exactly the document this exists for:
 * where the body starts again at 1, typing `1` goes to the page printed 1 rather than to the
 * cover. Case is ignored, so `IV` and `iv` are the same request; a document that prints the same
 * label twice sends both to the first, because the first is the one a reader counting forwards
 * from the front will find.
 */
export function findPageByLabel(labels: readonly string[], typed: string): number | null {
  const wanted = typed.trim();
  if (wanted === "") return null;
  const folded = wanted.toLowerCase();
  const printed = labels.findIndex((label) => label.trim().toLowerCase() === folded);
  if (printed >= 0) return printed + 1;
  // Only a plain count, and only inside the file. "12a" is a label this document does not have,
  // not a request for page twelve, and page 900 of a 40-page paper is a typing mistake rather
  // than an instruction to go to the end.
  if (!/^[0-9]+$/u.test(wanted)) return null;
  const position = Number(wanted);
  return position >= 1 && position <= labels.length ? position : null;
}

/**
 * Whether this document prints anything other than the order its pages are in.
 *
 * Decides whether the Reader is any use to the reader by saying where in the file they are. For
 * a paper that prints 1, 2, 3 in the order 1, 2, 3, saying so twice is noise; for a thesis open
 * at `iv` it is the only way to tell how far in that is.
 */
export function labelsDifferFromPositions(labels: readonly string[]): boolean {
  return labels.some((label, index) => label !== String(index + 1));
}
