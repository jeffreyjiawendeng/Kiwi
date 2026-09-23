/**
 * Whether a mark still points at what it was made on.
 *
 * An annotation is stored beside the file, not inside it, so nothing stops the file underneath
 * from changing: a preprint is replaced by the published version, a scan is re-run at a better
 * resolution, a chapter is dropped. When that happens a mark can name a page the file no longer
 * has, or quote a passage that is no longer on the page it names. Such a mark is orphaned. It is
 * kept, listed, and told apart from the rest, never deleted, and never drawn somewhere it does
 * not belong, because a highlight over the wrong words is a misquotation Kiwi made on the
 * reader's behalf.
 *
 * Orphaned is worked out, not stored. Whether the passage is still there is a fact about the
 * file that is open now, and `orphaned: true` written into the record would be wrong the moment
 * somebody put the old file back.
 */

import type { Annotation, AnnotationRect } from "@kiwi/contracts";
import type { PdfDocument } from "./pdf-document.js";
import { joinPageText } from "./pdf-search.js";

/** As little of a mark as this file needs: which one it is, and where it says it points. */
export interface AnchoredMark {
  id: string;
  annotation: Annotation;
}

/** What the open file has to say about one page. */
export interface PageEvidence {
  /**
   * The page's text as one string, or null when the page is there but its text could not be
   * read. Null is not evidence of anything, and is answered by keeping the mark.
   */
  text: string | null;
}

export type AnchorState = "found" | "orphaned";

/**
 * A passage reduced to what two copies of it can be expected to agree on.
 *
 * The stored quotation came from a browser selection over the text layer; the page's text comes
 * from the runs PDF.js reports, joined with spaces. The two differ in whitespace wherever a line
 * broke, and in a hyphen wherever a word did. Dropping everything that is not a letter or a
 * number leaves the words themselves, which is the comparison that survives a file being
 * re-rendered by a different producer.
 */
function comparable(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether any part of a rectangle lands on the page it claims a fraction of. */
function onThePage(rect: AnnotationRect): boolean {
  const values = [rect.left, rect.top, rect.width, rect.height];
  if (!values.every((value) => Number.isFinite(value))) return false;
  return rect.left < 1 && rect.top < 1 && rect.left + rect.width > 0 && rect.top + rect.height > 0;
}

/**
 * Whether one mark still resolves, given what the file says about the page it names.
 *
 * `page` is undefined when the file has no such page at all. Everything else is decided in
 * favour of keeping the mark where it is: an unreadable page, a page with no text on it, a
 * quotation of nothing but punctuation, and a text box that was never given a region are all
 * left alone. A false orphan takes a good highlight off the page, which is worse than a broken
 * one nobody flagged.
 */
export function anchorState(annotation: Annotation, page: PageEvidence | undefined): AnchorState {
  if (page === undefined) return "orphaned";
  // A text box carries its own words and can stand on a page without a region. Any other kind
  // with nothing left to draw has lost its place on it.
  if (annotation.rects.length === 0) return annotation.kind === "text" ? "found" : "orphaned";
  if (!annotation.rects.some(onThePage)) return "orphaned";

  const quoted = comparable(annotation.quoted);
  if (quoted === "" || page.text === null) return "found";
  // A page with no text on it at all is a scan, or a page of figures. It is not evidence that
  // the passage has gone, and treating it as evidence would orphan every mark on the document.
  const found = comparable(page.text);
  if (found === "") return "found";
  return found.includes(quoted) ? "found" : "orphaned";
}

/**
 * The marks in this document that no longer point at anything in the file.
 *
 * Only the pages carrying marks are read, and each of them once however many marks it carries:
 * a four-hundred page thesis with six highlights in it must not extract four hundred pages of
 * text to draw six.
 */
export async function resolveAnchors(
  document: PdfDocument,
  marks: readonly AnchoredMark[],
): Promise<Set<string>> {
  const wanted = new Set(marks.map((mark) => mark.annotation.page));
  const evidence = new Map<number, PageEvidence>();
  for (const pageNumber of wanted) {
    if (pageNumber < 1 || pageNumber > document.pageCount) continue;
    const page = await document.page(pageNumber).catch(() => null);
    if (page === null) {
      // The file says it has this page. Failing to open it says nothing about the passage.
      evidence.set(pageNumber, { text: null });
      continue;
    }
    const items = await page.textItems().catch(() => null);
    evidence.set(pageNumber, { text: items === null ? null : joinPageText(items).text });
  }

  const orphans = new Set<string>();
  for (const mark of marks) {
    if (anchorState(mark.annotation, evidence.get(mark.annotation.page)) === "orphaned")
      orphans.add(mark.id);
  }
  return orphans;
}
