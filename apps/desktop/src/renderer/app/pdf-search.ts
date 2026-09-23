import type { AnnotationRect } from "@kiwi/contracts";
import type { PdfDocument, PdfTextItem } from "./pdf-document.js";

/**
 * Finding words inside a document.
 *
 * PDF text arrives as runs, not lines, and a phrase routinely straddles several of them. The
 * runs on a page are therefore joined into one string and searched as one, then each match is
 * mapped back to the runs it covers so it can be drawn on the page.
 *
 * Rectangles are fractions of the page, like every other mark in the Reader, so a match lands
 * correctly at any zoom.
 */

export interface SearchMatch {
  page: number;
  /** Where the match starts in the page's joined text, for ordering and for keys. */
  offset: number;
  rects: AnnotationRect[];
}

export interface PageText {
  items: PdfTextItem[];
  /** Every run joined, with a space between runs so words do not fuse across them. */
  text: string;
  /** Where each run begins in `text`. */
  starts: number[];
}

export function joinPageText(items: PdfTextItem[]): PageText {
  const starts: number[] = [];
  let text = "";
  for (const item of items) {
    starts.push(text.length);
    text += item.text;
    // A separator keeps "the" and "orem" from matching "theorem", which is the kind of false
    // hit that makes a search box useless.
    text += " ";
  }
  return { items, text, starts };
}

/**
 * Which runs a span of the joined text touches.
 *
 * Returned as indices rather than rectangles so the caller decides how to draw them; a match
 * inside one run still needs the whole run's box, because a text run carries no per-character
 * geometry.
 */
export function runsCovering(page: PageText, start: number, end: number): number[] {
  const covered: number[] = [];
  for (let index = 0; index < page.items.length; index += 1) {
    const runStart = page.starts[index] ?? 0;
    const runEnd = runStart + (page.items[index]?.text.length ?? 0);
    if (runEnd > start && runStart < end) covered.push(index);
  }
  return covered;
}

function rectsFor(
  page: PageText,
  indices: number[],
  width: number,
  height: number,
): AnnotationRect[] {
  if (width <= 0 || height <= 0) return [];
  return indices.flatMap((index) => {
    const item = page.items[index];
    if (item === undefined || item.width <= 0 || item.height <= 0) return [];
    return [
      {
        left: item.left / width,
        top: item.top / height,
        width: item.width / width,
        height: item.height / height,
      },
    ];
  });
}

/** Every occurrence of `query` on one page, case-insensitively. */
export function matchesOnPage(
  page: PageText,
  query: string,
  pageNumber: number,
  width: number,
  height: number,
): SearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const haystack = page.text.toLocaleLowerCase();
  const found: SearchMatch[] = [];
  let from = 0;
  while (found.length < 500) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push({
      page: pageNumber,
      offset: at,
      rects: rectsFor(page, runsCovering(page, at, at + needle.length), width, height),
    });
    from = at + needle.length;
  }
  return found;
}

export interface SearchProgress {
  /** Called as each page is searched, so a long document reports rather than freezing. */
  onPage?: (pageNumber: number, total: number) => void;
  /** Checked between pages so a new query abandons the one in flight. */
  cancelled?: () => boolean;
}

/**
 * Searches a whole document, one page at a time.
 *
 * Sequential rather than parallel: a four-hundred page thesis asked to extract every page's
 * text at once will exhaust memory, and the reader wants the first match long before the last.
 */
export async function searchDocument(
  document: PdfDocument,
  query: string,
  progress: SearchProgress = {},
): Promise<SearchMatch[]> {
  if (query.trim() === "") return [];
  const matches: SearchMatch[] = [];
  for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
    if (progress.cancelled?.() === true) return matches;
    const page = await document.page(pageNumber).catch(() => null);
    if (page === null) continue;
    const items = await page.textItems().catch(() => []);
    matches.push(...matchesOnPage(joinPageText(items), query, pageNumber, page.width, page.height));
    progress.onPage?.(pageNumber, document.pageCount);
  }
  return matches;
}
