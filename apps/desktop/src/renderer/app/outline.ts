/**
 * The outline of a manuscript, in both writing modes.
 *
 * A rich manuscript is a node tree and a LaTeX one is a buffer of source, so neither the headings
 * nor the positions are found the same way. What follows them is the same in both, though: a
 * section runs from its heading to the next heading of the same or higher level, and reordering
 * one means moving that whole run. So each mode brings its blocks, the heading level, the text,
 * and where the block begins and ends in whatever the mode counts positions in, and everything
 * after that is shared.
 *
 * Positions are the caller's own. The rich editor passes ProseMirror positions and the LaTeX
 * editor passes character offsets; nothing here does arithmetic that would tell the difference.
 */

import { countWords, latexHeadings } from "@kiwi/contracts";

/** One block of a manuscript: a heading with its level, or ordinary content. */
export interface OutlineBlock {
  /** The heading level, or null when the block is not a heading. */
  level: number | null;
  text: string;
  from: number;
  to: number;
}

/** One heading, and the section it opens. */
export interface OutlineHeading {
  level: number;
  title: string;
  /** Where the heading itself begins. */
  from: number;
  /** Where the section ends: the next heading of the same or higher level, or the end. */
  to: number;
  /** The words of the section's prose, its subsections included, its headings not. */
  words: number;
}

/** A section on its way somewhere else: the run to lift out, and where to put it back. */
export interface SectionMove {
  from: number;
  to: number;
  /** In the positions as they were before the run was lifted out. */
  at: number;
}

/**
 * The headings, each carrying the extent of what it covers.
 *
 * The extent is what makes the outline more than a list of links: dragging a heading has to take
 * its subsections and its prose with it, and a section that ended at the next heading of any level
 * would leave its own subsections behind.
 */
export function buildOutline(blocks: readonly OutlineBlock[]): OutlineHeading[] {
  const end = blocks.at(-1)?.to ?? 0;
  const headings: OutlineHeading[] = [];
  for (const [index, block] of blocks.entries()) {
    const level = block.level;
    if (level === null) continue;
    const rest = blocks.slice(index + 1);
    const next = rest.find((after) => after.level !== null && after.level <= level);
    const stop = next?.from ?? end;
    headings.push({
      level,
      title: block.text.trim(),
      from: block.from,
      to: stop,
      words: rest
        .filter((body) => body.level === null && body.from < stop)
        .reduce((total, body) => total + countWords(body.text), 0),
    });
  }
  return headings;
}

/**
 * A LaTeX source split into headings and the source between them.
 *
 * The runs between headings are kept as blocks rather than thrown away, because the word count of
 * a section is the count of what lies inside it. Counting words in source counts `\emph` as a
 * word, which is what the word count above the editor already does in this mode, one wrong number
 * is better than two that disagree.
 *
 * The headings themselves are found by {@link latexHeadings}, which is also what a passage sent to
 * a section is placed by. Two scanners would eventually disagree, and the outline would name a
 * section the send could not find.
 */
export function latexBlocks(source: string): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  let plain = 0;
  for (const heading of latexHeadings(source)) {
    if (heading.from > plain) {
      blocks.push({
        level: null,
        text: source.slice(plain, heading.from),
        from: plain,
        to: heading.from,
      });
    }
    blocks.push({
      level: heading.level,
      text: heading.title,
      from: heading.from,
      to: heading.to,
    });
    plain = heading.to;
  }
  if (plain < source.length) {
    blocks.push({ level: null, text: source.slice(plain), from: plain, to: source.length });
  }
  return blocks;
}

/**
 * Where a section goes when it is dropped on another one.
 *
 * Dropped on something below it, it lands after the whole of that section rather than after its
 * heading, dropping "Results" on "Methods" puts it after everything Methods contains, which is
 * where the person doing the dragging is looking. Dropped on something above, it lands in front of
 * it. Null when there is nothing to do, which includes dropping a section onto its own subsection:
 * there is no position inside itself for it to move to.
 */
export function planMove(
  headings: readonly OutlineHeading[],
  dragIndex: number,
  overIndex: number,
): SectionMove | null {
  const moved = headings[dragIndex];
  const target = headings[overIndex];
  if (moved === undefined || target === undefined) return null;
  const at = dragIndex < overIndex ? target.to : target.from;
  if (at >= moved.from && at <= moved.to) return null;
  return { from: moved.from, to: moved.to, at };
}

/**
 * The same move from the keyboard.
 *
 * Down steps over everything the section contains rather than over the next heading, which would
 * otherwise be its own first subsection, a move that changes nothing and looks broken.
 */
export function planStep(
  headings: readonly OutlineHeading[],
  index: number,
  direction: 1 | -1,
): SectionMove | null {
  if (direction === -1) return planMove(headings, index, index - 1);
  const moved = headings[index];
  if (moved === undefined) return null;
  const next = headings.findIndex((heading, at) => at > index && heading.from >= moved.to);
  return next === -1 ? null : planMove(headings, index, next);
}

/** The source with a section lifted out and put back where the move says. */
export function moveInText(text: string, plan: SectionMove): string {
  const moved = text.slice(plan.from, plan.to);
  const rest = text.slice(0, plan.from) + text.slice(plan.to);
  // Taking the run out moves everything after it, so a destination below the run comes back by
  // the length of the run.
  const at = plan.at > plan.from ? plan.at - moved.length : plan.at;
  return rest.slice(0, at) + moved + rest.slice(at);
}
