/**
 * Finding and replacing text, in a manuscript written either way.
 *
 * A rich manuscript is a node tree and a LaTeX one is a buffer of source, but the search itself
 * is the same question asked of a string. So the matching lives here, over plain text, and each
 * mode brings its own text: the LaTeX editor passes its buffer, the rich editor passes its text
 * nodes with the position each one starts at.
 */

export interface FindOptions {
  caseSensitive: boolean;
  /** A match only counts when a word ends on both sides of it. */
  wholeWord: boolean;
}

/** Where a match sits in a string, as a half-open range. */
export interface TextMatch {
  start: number;
  end: number;
}

/** Where a match sits in a rich document, in the editor's own positions. */
export interface DocumentMatch {
  from: number;
  to: number;
}

/** One text node of a rich document, and the position it begins at. */
export interface TextRun {
  text: string;
  pos: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

/**
 * The query as a pattern that matches it literally.
 *
 * Case folding is left to the regular expression rather than done with `toLowerCase`, because
 * lowercasing can change a string's length — and a search that reports the wrong offset replaces
 * the wrong characters.
 */
function pattern(query: string, options: FindOptions): RegExp {
  const literal = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(literal, options.caseSensitive ? "gu" : "giu");
}

/** Every match in a string, in order, never overlapping. */
export function findMatches(text: string, query: string, options: FindOptions): TextMatch[] {
  if (query === "") return [];
  const search = pattern(query, options);
  const matches: TextMatch[] = [];
  for (let found = search.exec(text); found !== null; found = search.exec(text)) {
    const start = found.index;
    const end = start + found[0].length;
    if (options.wholeWord && (isWordCharacter(text[start - 1]) || isWordCharacter(text[end]))) {
      // Rejected, so the next attempt starts one character along rather than past this run.
      // "the" inside "there" must not hide a real "the" that begins two characters later.
      search.lastIndex = start + 1;
      continue;
    }
    matches.push({ start, end });
  }
  return matches;
}

/**
 * Every match across a rich document's text nodes.
 *
 * A match has to live inside one text node. Text splits at every change of formatting, so a
 * search for "the result" will not find it when "result" alone is bold, and replacing it would
 * have to decide which of the two formattings the replacement keeps. Missing that match is the
 * smaller wrong answer.
 */
export function collectMatches(
  runs: readonly TextRun[],
  query: string,
  options: FindOptions,
): DocumentMatch[] {
  const matches: DocumentMatch[] = [];
  for (const run of runs) {
    for (const match of findMatches(run.text, query, options)) {
      matches.push({ from: run.pos + match.start, to: run.pos + match.end });
    }
  }
  return matches;
}

/** The string with one match swapped for the replacement. */
export function replaceMatch(text: string, match: TextMatch, replacement: string): string {
  return text.slice(0, match.start) + replacement + text.slice(match.end);
}

/**
 * The string with every match swapped at once.
 *
 * One pass, built back to front so an earlier replacement cannot move a later match. A
 * replace-all that takes forty undos to reverse is a trap, and the same reasoning applies to the
 * rich editor, where every replacement goes into a single transaction.
 */
export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions,
): { text: string; replaced: number } {
  const matches = findMatches(text, query, options);
  let next = text;
  for (const match of [...matches].reverse()) next = replaceMatch(next, match, replacement);
  return { text: next, replaced: matches.length };
}

/** How the match count reads beside the search box. */
export function matchSummary(count: number, current: number): string {
  if (count === 0) return "No matches";
  return `${String(current + 1)} of ${String(count)}`;
}
