/**
 * Folding a LaTeX buffer: which runs can be hidden, and how the field stays honest while they are.
 *
 * A textarea cannot hide part of its own value, so a folded run is not in the field at all, the
 * field holds the source with those runs cut out of it. Everything else in the editor still counts
 * positions in the source, so the two have to be converted between, and an edit made against the
 * shortened text has to be put back into the source it came out of.
 *
 * Nothing here holds a buffer or any state. The source and the list of hidden runs are the caller's,
 * and every function takes both.
 */

import { environmentPairs, type SourceRange } from "./latex-syntax.js";
import { buildOutline, latexBlocks } from "./outline.js";

export type FoldKind = "section" | "environment";

/** Something that can be folded, and the run folding it would hide. */
export interface FoldRegion {
  kind: FoldKind;
  /** The section's title, or the environment's name. */
  label: string;
  /** The first character of the `\section` or the `\begin` that opens it. */
  start: number;
  /** The run that folding hides, which never includes the line the region opens on. */
  from: number;
  to: number;
}

/** A stretch of a buffer replaced by another, as the one change between two versions of it. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Where the line the offset is on ends, or the end of the buffer for the last one. */
function lineEnd(source: string, at: number): number {
  const found = source.indexOf("\n", at);
  return found === -1 ? source.length : found;
}

/**
 * Every section and every environment that has a body worth hiding.
 *
 * A fold always leaves the line it opens on in place. That line is what says what was folded, and a
 * fold that took its own heading with it would hide the only thing left to click on. So a section
 * hides from the end of its heading's line to where the section ends, and an environment hides from
 * the end of `\begin{proof}` to the start of the `\end{proof}` that closes it, which reads, once
 * folded, as the two of them side by side.
 *
 * The newline in front of the next heading belongs to that heading rather than to this section:
 * hiding it would run two headings together on one line.
 */
export function foldableRegions(source: string): FoldRegion[] {
  const regions: FoldRegion[] = [];
  const blocks = latexBlocks(source);
  const titleEnds = new Map<number, number>();
  for (const block of blocks) {
    if (block.level !== null) titleEnds.set(block.from, block.to);
  }
  for (const heading of buildOutline(blocks)) {
    const from = lineEnd(source, titleEnds.get(heading.from) ?? heading.from);
    const to = source[heading.to - 1] === "\n" ? heading.to - 1 : heading.to;
    if (to > from) {
      regions.push({ kind: "section", label: heading.title, start: heading.from, from, to });
    }
  }
  for (const pair of environmentPairs(source)) {
    if (pair.end.from > pair.begin.to) {
      regions.push({
        kind: "environment",
        label: pair.name,
        start: pair.begin.from,
        from: pair.begin.to,
        to: pair.end.from,
      });
    }
  }
  return regions.sort((left, right) => left.from - right.from || left.to - right.to);
}

/**
 * The innermost region the caret is inside.
 *
 * Innermost, because a caret in a proof inside a section is in both, and the one a person means is
 * the smaller. The whole region counts, its opening line included: standing on `\section{Method}` is
 * how someone asks to fold the section under it.
 */
export function regionAt(regions: readonly FoldRegion[], caret: number): FoldRegion | null {
  let found: FoldRegion | null = null;
  for (const region of regions) {
    if (caret < region.start || caret > region.to) continue;
    if (found === null || region.to - region.start < found.to - found.start) found = region;
  }
  return found;
}

/** Adds a run to the hidden ones, dropping any it swallows. A run already hidden changes nothing. */
export function addFold(folds: readonly SourceRange[], run: SourceRange): SourceRange[] {
  if (folds.some((fold) => fold.from <= run.from && fold.to >= run.to)) return [...folds];
  const kept = folds.filter((fold) => fold.to <= run.from || fold.from >= run.to);
  return [...kept, run].sort((left, right) => left.from - right.from);
}

/**
 * Folds the run, or opens it if any part of it is already hidden.
 *
 * Overlap rather than an exact match, because the run is measured against the source as it is now
 * and the hidden one was measured before the last few keystrokes. Asking for a fold that is already
 * there and getting a second one would be worse than opening it.
 */
export function toggleFold(folds: readonly SourceRange[], run: SourceRange): SourceRange[] {
  const open = folds.filter((fold) => fold.from < run.to && fold.to > run.from);
  if (open.length > 0) return folds.filter((fold) => !open.includes(fold));
  return addFold(folds, run);
}

/** The hidden runs with any that would cover the range opened, so the range can be shown. */
export function revealRange(
  folds: readonly SourceRange[],
  from: number,
  to: number,
): SourceRange[] {
  return folds.filter((fold) => fold.to <= from || fold.from >= to);
}

/** The stretches of the source the field actually holds, in order. */
export function visibleSegments(length: number, folds: readonly SourceRange[]): SourceRange[] {
  const segments: SourceRange[] = [];
  let at = 0;
  for (const fold of [...folds].sort((left, right) => left.from - right.from)) {
    const from = Math.max(at, Math.min(fold.from, length));
    const to = Math.max(from, Math.min(fold.to, length));
    if (from > at) segments.push({ from: at, to: from });
    at = Math.max(at, to);
  }
  if (at < length) segments.push({ from: at, to: length });
  return segments;
}

/** The text of those stretches joined up, which is what the field is given. */
export function foldedText(source: string, segments: readonly SourceRange[]): string {
  return segments.map((segment) => source.slice(segment.from, segment.to)).join("");
}

/** Where in the field each hidden run sits, so a marker can be drawn there. */
export function foldMarks(segments: readonly SourceRange[]): number[] {
  const marks: number[] = [];
  let at = 0;
  for (const [index, segment] of segments.entries()) {
    at += segment.to - segment.from;
    if (index < segments.length - 1) marks.push(at);
  }
  return marks;
}

/**
 * A position in the field, as a position in the source.
 *
 * Where a run is hidden, one position in the field stands for two in the source, the character
 * before the run and the character after it, and which of them is meant depends on what is being
 * done there. `after` picks the far side.
 */
export function toSource(segments: readonly SourceRange[], at: number, after: boolean): number {
  let seen = 0;
  for (const segment of segments) {
    const length = segment.to - segment.from;
    if (at < seen + length) return segment.from + (at - seen);
    if (at === seen + length && !after) return segment.to;
    seen += length;
  }
  return segments.at(-1)?.to ?? 0;
}

/** A position in the source, as a position in the field. One inside a hidden run gives its edge. */
export function toField(segments: readonly SourceRange[], at: number): number {
  let seen = 0;
  for (const segment of segments) {
    if (at < segment.from) return seen;
    if (at <= segment.to) return seen + (at - segment.from);
    seen += segment.to - segment.from;
  }
  return seen;
}

/**
 * The one stretch that differs between two versions of a buffer.
 *
 * The browser hands over a whole new value rather than saying what was typed, so the change is
 * found by taking the matching text off both ends. What is left is not always the keystroke, a
 * space typed in front of a space could be read as either one, but it always describes an edit
 * that turns the first buffer into the second, which is all that is asked of it.
 */
export function readEdit(before: string, after: string): TextEdit {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < limit - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) };
}

/**
 * The hidden runs after an edit to the source they were measured against.
 *
 * A run the edit reached inside of is opened rather than moved. Its ends could be mapped, but what
 * it hid is no longer what it hid, and text nobody can see being quietly rewritten is worse than a
 * fold that opens.
 */
export function remapFolds(folds: readonly SourceRange[], edit: TextEdit): SourceRange[] {
  const delta = edit.insert.length - (edit.to - edit.from);
  const next: SourceRange[] = [];
  for (const fold of folds) {
    if (fold.to <= edit.from) next.push(fold);
    else if (fold.from >= edit.to) next.push({ from: fold.from + delta, to: fold.to + delta });
  }
  return next;
}

/** The source and the hidden runs after the field's own text changed. */
export interface FoldedEdit {
  source: string;
  folds: SourceRange[];
}

/**
 * An edit made against the shortened text, put back into the source.
 *
 * The two sides of a hidden run are one position in the field, and the two things done at that
 * position want opposite answers. Typing there is typing at the end of the visible line, so it goes
 * in front of the run. Pressing Delete there is asking for the character that can be seen, so it
 * takes the one after the run instead of the run itself. A selection dragged across the marker
 * still covers the run, and deleting it still deletes what it hid, that one was asked for.
 */
export function applyFieldEdit(
  source: string,
  folds: readonly SourceRange[],
  next: string,
): FoldedEdit {
  const segments = visibleSegments(source.length, folds);
  const change = readEdit(foldedText(source, segments), next);
  const from = toSource(segments, change.from, change.to > change.from);
  const edit: TextEdit = {
    from,
    to: Math.max(from, toSource(segments, change.to, false)),
    insert: change.insert,
  };
  return {
    source: source.slice(0, edit.from) + edit.insert + source.slice(edit.to),
    folds: remapFolds(folds, edit),
  };
}
