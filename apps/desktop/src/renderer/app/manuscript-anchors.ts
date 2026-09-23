/**
 * A manuscript as one string, and the way back to where its words sit on the screen.
 *
 * A margin comment points at a pair of offsets into the manuscript's text, because offsets into
 * text are the only coordinate both kinds of manuscript can name. A LaTeX manuscript has nothing
 * else, the source is the text. A rich one keeps its words in nodes at editor positions, so this
 * is where those positions are flattened into a string and where they are recovered from one.
 */

import type { TextRun } from "./find-replace.js";

/** One text node, placed both in the manuscript's text and in the editor's own positions. */
export interface AnchorSpan {
  offset: number;
  pos: number;
  length: number;
}

export interface ManuscriptText {
  /** The manuscript as one string. A comment's `from` and `to` are offsets into this. */
  text: string;
  spans: readonly AnchorSpan[];
}

/** Where a comment points, in the manuscript's own coordinates. */
export interface ManuscriptPassage {
  from: number;
  to: number;
  quote: string;
}

/**
 * The manuscript a LaTeX buffer spells out, which is the buffer.
 *
 * Written as the identity mapping rather than as a special case, so everything downstream has one
 * shape to handle instead of one shape and an exception.
 */
export function sourceManuscript(source: string): ManuscriptText {
  return { text: source, spans: [{ offset: 0, pos: 0, length: source.length }] };
}

/**
 * The manuscript a rich document's text nodes spell out.
 *
 * A gap in the editor's positions is a node boundary, and it becomes a line break here. Without
 * one, the last word of a paragraph and the first word of the next would read as a single word,
 * and a quotation could be found straddling a boundary no reader can see.
 */
export function richManuscript(runs: readonly TextRun[]): ManuscriptText {
  const parts: string[] = [];
  const spans: AnchorSpan[] = [];
  let offset = 0;
  let previousEnd: number | null = null;
  for (const run of runs) {
    if (previousEnd !== null && run.pos > previousEnd) {
      parts.push("\n");
      offset += 1;
    }
    parts.push(run.text);
    spans.push({ offset, pos: run.pos, length: run.text.length });
    offset += run.text.length;
    previousEnd = run.pos + run.text.length;
  }
  return { text: parts.join(""), spans };
}

/**
 * Where an offset into the manuscript's text lands in the editor.
 *
 * An offset inside a break between two nodes belongs to neither, and is answered with the end of
 * the node before it: a comment ending on a paragraph's last word must not reach into the first
 * word of the next one.
 */
export function editorPosition(manuscript: ManuscriptText, offset: number): number {
  let last: AnchorSpan | null = null;
  for (const span of manuscript.spans) {
    if (offset < span.offset) break;
    if (offset <= span.offset + span.length) return span.pos + (offset - span.offset);
    last = span;
  }
  if (last === null) {
    const first = manuscript.spans[0];
    return first === undefined ? 0 : first.pos;
  }
  return last.pos + last.length;
}

/** Where an editor position lands in the manuscript's text. */
export function textOffset(manuscript: ManuscriptText, pos: number): number {
  let last: AnchorSpan | null = null;
  for (const span of manuscript.spans) {
    if (pos < span.pos) break;
    if (pos <= span.pos + span.length) return span.offset + (pos - span.pos);
    last = span;
  }
  return last === null ? 0 : last.offset + last.length;
}

/**
 * How much of a selection a comment can carry as its quotation.
 *
 * The store will not hold more, and a comment on more than this much text is a comment on a
 * section rather than on a passage. Taking the first two thousand characters keeps the anchor
 * exact for the words it does cover, which is what finding the passage again depends on.
 */
const QUOTE_LIMIT = 2_000;

/**
 * What a comment on the current selection would point at, or null when nothing is selected.
 *
 * The selection is given in the editor's positions, which for a LaTeX buffer are offsets already.
 * The whitespace at either end is dropped from the range and not only from the quotation: a
 * quotation trimmed away from its own offsets no longer matches the text at them, and the comment
 * would read as moved the first time anybody opened the manuscript.
 */
export function selectedPassage(
  manuscript: ManuscriptText,
  selectionFrom: number,
  selectionTo: number,
): ManuscriptPassage | null {
  const start = textOffset(manuscript, Math.min(selectionFrom, selectionTo));
  const end = textOffset(manuscript, Math.max(selectionFrom, selectionTo));
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(manuscript.text[from] ?? "")) from += 1;
  while (to > from && /\s/u.test(manuscript.text[to - 1] ?? "")) to -= 1;
  if (to <= from) return null;
  if (to - from > QUOTE_LIMIT) to = from + QUOTE_LIMIT;
  return { from, to, quote: manuscript.text.slice(from, to) };
}
