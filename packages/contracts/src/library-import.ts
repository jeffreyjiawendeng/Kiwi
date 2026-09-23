import { parseAuthorName } from "./citation.js";
import { normalizeDoi, type Reference } from "./reference.js";
import { type BibtexEntry } from "./bibtex.js";

/**
 * What an import would add, worked out before it adds anything.
 *
 * Every way a library gets into Kiwi ends in the same place: a folder of PDFs, a file dropped
 * on the window, a `.bib` picked off disk and a single paper typed in by hand all become a list
 * of rows, each one a work that could be created and each one already checked against the
 * library and against the rest of its own file. Four entrances that each decide for themselves
 * what a duplicate is would be four sets of duplicate bugs, so the deciding happens once, here,
 * and the entrances differ only in where their rows came from.
 *
 * Nothing in this file creates anything. A candidate is an offer, and the answer to it is a
 * person looking at a row and leaving its box ticked.
 */

/** An entry offered for import, with the file it was read out of when there was one. */
export interface ImportEntry extends BibtexEntry {
  /** A hash of the source file, so the same PDF imported twice is recognised as the same PDF. */
  fileHash?: string | null;
}

/** A Paper the library already holds, as much of it as deciding a duplicate needs. */
export interface HeldWork {
  id: string;
  title: string;
  reference: Reference;
  fileHash?: string | null;
}

/** What a candidate turned out to be a second copy of. */
export interface ImportMatch {
  /** Already in the library, or repeated further up the same file. */
  where: "library" | "file";
  /** What matched. */
  by: "doi" | "file" | "title";
  /**
   * Whether this is a fact or a resemblance.
   *
   * A shared DOI or an identical file is the same work by definition. A title that reads the
   * same is a strong guess and no more, and the preview has to say which of the two it is
   * rather than presenting both as settled.
   */
  certain: boolean;
  /** The Paper already held, when that is what matched. */
  objectId: string | null;
  /** The earlier row in this same import, when that is what matched. */
  row: number | null;
  /** What the thing it matched is called, so a row can say what it is a copy of. */
  title: string;
}

export interface ImportCandidate {
  /** Where in the file the entry was. A row keeps its number when the preview is sorted. */
  row: number;
  key: string;
  title: string;
  reference: Reference;
  fileHash: string | null;
  duplicate: ImportMatch | null;
  /**
   * Whether the row arrives ticked.
   *
   * Everything is ticked except what looks like a second copy of something. That way the
   * ordinary import is one click and the careful one is still possible: an untick can be
   * reversed by the person reading the row, and a paper created twice cannot.
   */
  selected: boolean;
}

/**
 * How alike two titles have to read before they are called the same work.
 *
 * High, because the cost of the two mistakes is not the same. A duplicate that slips through
 * is one extra Paper somebody deletes; a distinct paper wrongly called a duplicate arrives
 * unticked and is quietly never imported at all.
 */
const SAME_TITLE = 0.85;

const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

/**
 * A title reduced to what two spellings of it would still have in common.
 *
 * Case, accents, punctuation and spacing are each things one exporter keeps and another drops,
 * and none of them change which paper is meant. LaTeX's braces go for the same reason: `{DNA}
 * sequencing` and `DNA sequencing` are one title written by two programs.
 */
export function titleFingerprint(title: string): string[] {
  return title
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .split(NOT_A_WORD)
    .filter((word) => word !== "");
}

/**
 * How much of two titles is the same title, from 0 to 1.
 *
 * Shared words counted twice over the words both titles hold, which is Dice's coefficient. It
 * is used rather than an edit distance because the differences that matter here are whole
 * words, a subtitle kept or dropped, "and" written as an ampersand, and not letters.
 */
export function titleSimilarity(left: string, right: string): number {
  return fingerprintSimilarity(titleFingerprint(left), titleFingerprint(right));
}

function fingerprintSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rest = [...right];
  let shared = 0;
  for (const word of left) {
    const at = rest.indexOf(word);
    if (at === -1) continue;
    // Removed rather than counted again, so a title that says "study" twice does not score
    // against one that says it once.
    rest.splice(at, 1);
    shared += 1;
  }
  return (2 * shared) / (left.length + right.length);
}

/** A record on either side of the comparison, reduced to the parts a duplicate is decided on. */
interface Known {
  where: "library" | "file";
  objectId: string | null;
  row: number | null;
  title: string;
  words: string[];
  doi: string | null;
  fileHash: string | null;
  year: number | null;
  family: string | null;
}

function firstFamily(reference: Reference): string | null {
  const first = reference.authors.find((name) => name.trim() !== "");
  if (first === undefined) return null;
  const family = parseAuthorName(first).family.trim().toLocaleLowerCase();
  return family === "" ? null : family;
}

function knownOf(
  where: "library" | "file",
  objectId: string | null,
  row: number | null,
  title: string,
  reference: Reference,
  fileHash: string | null,
): Known {
  return {
    where,
    objectId,
    row,
    title,
    words: titleFingerprint(title),
    // Normalised, because one exporter writes the bare DOI and another the doi.org link, and
    // they are the same identifier.
    doi: reference.doi === null ? null : normalizeDoi(reference.doi),
    fileHash: fileHash === null || fileHash === "" ? null : fileHash,
    year: reference.year,
    family: firstFamily(reference),
  };
}

/**
 * Whether two records contradict each other on something they both state.
 *
 * This only ever holds a title match back. Two papers can read alike and be different work:
 * an annual report, a conference paper and its extended journal version, a translation. Where
 * both records name a year, a first author or a DOI and the two disagree, the resemblance is
 * not enough. Where only one of them names it, silence is not disagreement.
 */
function disagree(left: Known, right: Known): boolean {
  if (left.doi !== null && right.doi !== null && left.doi !== right.doi) return true;
  if (left.year !== null && right.year !== null && left.year !== right.year) return true;
  return left.family !== null && right.family !== null && left.family !== right.family;
}

function matchOf(other: Known, by: ImportMatch["by"], certain: boolean): ImportMatch {
  return {
    where: other.where,
    by,
    certain,
    objectId: other.objectId,
    row: other.row,
    title: other.title,
  };
}

function findMatch(candidate: Known, known: Known[]): ImportMatch | null {
  let resembles: Known | null = null;
  let best = 0;

  for (const other of known) {
    if (candidate.doi !== null && candidate.doi === other.doi) return matchOf(other, "doi", true);
    if (candidate.fileHash !== null && candidate.fileHash === other.fileHash)
      return matchOf(other, "file", true);

    // Two titles cannot read as one when one of them is much the longer, and knowing that
    // costs a subtraction rather than a word-by-word comparison. Most of a large library is
    // ruled out on this line.
    const span = candidate.words.length + other.words.length;
    const shortest = Math.min(candidate.words.length, other.words.length);
    if (span === 0 || (2 * shortest) / span < SAME_TITLE) continue;

    const score = fingerprintSimilarity(candidate.words, other.words);
    if (score < SAME_TITLE || score <= best) continue;
    if (disagree(candidate, other)) continue;
    best = score;
    resembles = other;
  }

  // A certain match wins from wherever in the list it comes, so a resemblance is only reported
  // once the whole list has been read without one.
  return resembles === null ? null : matchOf(resembles, "title", false);
}

/**
 * Turns parsed entries into the rows a preview shows, each one knowing what it duplicates.
 *
 * The library is checked first and then the file against itself, which is why a candidate
 * joins the known records as it is decided: a file that lists the same paper three times
 * offers it once and reports the other two as repeats of the first, rather than creating
 * three Papers and leaving somebody to find them.
 */
export function importCandidates(entries: ImportEntry[], held: HeldWork[]): ImportCandidate[] {
  const known: Known[] = held.map((work) =>
    knownOf("library", work.id, null, work.title, work.reference, work.fileHash ?? null),
  );

  return entries.map((entry, row) => {
    const candidate = knownOf(
      "file",
      null,
      row,
      entry.title,
      entry.reference,
      entry.fileHash ?? null,
    );
    const duplicate = findMatch(candidate, known);
    known.push(candidate);
    return {
      row,
      key: entry.key,
      title: entry.title,
      reference: entry.reference,
      fileHash: candidate.fileHash,
      duplicate,
      selected: duplicate === null,
    };
  });
}
