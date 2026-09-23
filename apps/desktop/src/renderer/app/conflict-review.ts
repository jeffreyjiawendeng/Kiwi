/**
 * Two saved versions of the same note, put side by side so somebody can choose between them.
 *
 * A conflict is not a failure to read: both versions are already safe on disk. What is missing is
 * the answer to "what is actually different?", and two blocks of prose printed next to each other
 * do not answer it. Somebody looking at a paragraph they wrote this morning against a paragraph
 * with one sentence changed has to find the sentence themselves, and the longer the note the less
 * likely they are to. So the difference is worked out here and said in words first, with the line
 * by line underneath for whoever wants to check it.
 *
 * The differ is the one in contracts that History already uses. There is no second one: a diff
 * that disagreed with the diff in the history panel would be worse than no diff at all.
 */

import { compareObjectVersions, type MarkdownLineChange } from "@kiwi/contracts";
import { describeAge } from "./members-roster.js";

/** One saved version of the object, as a conflict record carries it. */
export interface ConflictVariant {
  version: number;
  content_hash: string;
  title: string;
  content: string;
  updated_at?: string;
  updated_by?: string;
}

export interface ConflictSide {
  /** Which of the three this is, for the caller to key its buttons off. */
  side: "base" | "mine" | "theirs";
  /** What to call it in front of somebody. */
  heading: string;
  version: number;
  title: string;
  content: string;
  /** Who saved it and when, or as much of that as the record knows. */
  attribution: string;
}

export interface ConflictTitles {
  mine: string;
  theirs: string;
  differs: boolean;
}

export interface ConflictReading {
  /** What both versions were written from, when the record kept it. */
  base: ConflictSide | null;
  /** Null when this machine has no version of the object at all. */
  mine: ConflictSide | null;
  theirs: ConflictSide;
  /** The one field these objects have besides their text. Null when there is nothing to compare. */
  titles: ConflictTitles | null;
  /** Mine read as the before and theirs as the after. Empty when there is nothing to compare. */
  lines: readonly MarkdownLineChange[];
  /** Runs of changed lines, not changed lines: one edited sentence is one place, not two. */
  places: number;
  /** The whole difference in one sentence, which is all most people need. */
  summary: string;
  /** The line view fell back to a coarser one because the versions are large. */
  simplified: boolean;
}

const HEADINGS: Readonly<Record<ConflictSide["side"], string>> = {
  base: "What both started from",
  mine: "Your version",
  theirs: "Their version",
};

function count(value: number, singular: string, plural: string): string {
  return `${value === 1 ? "one" : String(value)} ${value === 1 ? singular : plural}`;
}

/**
 * Who saved this one and when.
 *
 * The first question somebody asks of a version they did not write is whose it is, and a record
 * that cannot say is more common than it looks: an older conflict file may have neither. Each half
 * is said only if it is known, rather than filling in "unknown" for the missing one.
 */
function attribute(variant: ConflictVariant, now: Date): string {
  const at = variant.updated_at === undefined ? Number.NaN : Date.parse(variant.updated_at);
  const when = Number.isFinite(at) ? describeAge(new Date(at), now) : null;
  const who =
    variant.updated_by === undefined || variant.updated_by === "" ? null : variant.updated_by;
  if (who !== null && when !== null) return `Saved by ${who} ${when}.`;
  if (who !== null) return `Saved by ${who}.`;
  if (when !== null) return `Saved ${when}.`;
  return "There is no record of who saved this one.";
}

function side(which: ConflictSide["side"], variant: ConflictVariant, now: Date): ConflictSide {
  return {
    side: which,
    heading: HEADINGS[which],
    version: variant.version,
    title: variant.title,
    content: variant.content,
    attribution: attribute(variant, now),
  };
}

/** Contiguous runs of changed lines. An edited sentence is one place; ten of them are ten. */
function placesChanged(lines: readonly MarkdownLineChange[]): number {
  let places = 0;
  let inside = false;
  for (const line of lines) {
    if (line.kind === "unchanged") {
      inside = false;
      continue;
    }
    if (!inside) places += 1;
    inside = true;
  }
  return places;
}

function summarize(titles: ConflictTitles, places: number): string {
  if (titles.differs && places > 0)
    return `The titles differ, and the text differs in ${count(places, "place", "places")}.`;
  if (titles.differs) return "The titles differ. The text is the same in both.";
  if (places > 0)
    return `The text differs in ${count(places, "place", "places")}. Both are called the same thing.`;
  // Two versions can conflict and still read the same: the hashes are of the stored file, and a
  // save that changed nothing a person can see still counts as a save.
  return "Both versions say the same thing. Whichever you keep, nothing you can read changes.";
}

/**
 * A conflict record turned into something readable.
 *
 * `mine` being null is not an error state: it is a note that was made somewhere else and has
 * reached this machine as the only version there is. Nothing is being chosen between, so nothing
 * is compared, and the summary says that instead of describing a difference against nothing.
 */
export function readConflict(
  conflict: {
    base_snapshot?: ConflictVariant | undefined;
    mine: ConflictVariant | null;
    theirs: ConflictVariant;
  },
  now: Date,
): ConflictReading {
  const base =
    conflict.base_snapshot === undefined ? null : side("base", conflict.base_snapshot, now);
  const theirs = side("theirs", conflict.theirs, now);
  if (conflict.mine === null) {
    return {
      base,
      mine: null,
      theirs,
      titles: null,
      lines: [],
      places: 0,
      summary:
        "There is no version of this here to compare with. It was written somewhere else and this is the only copy that arrived.",
      simplified: false,
    };
  }

  const mine = conflict.mine;
  // The differ puts the lower version number first, and a conflict is exactly the case where both
  // sides claim the same one. So the order is forced here -- yours read as the before, theirs as
  // the after -- and the real version numbers are carried beside the comparison, not through it.
  const comparison = compareObjectVersions(
    { version: 1, content_hash: mine.content_hash, title: mine.title, content: mine.content },
    {
      version: 2,
      content_hash: conflict.theirs.content_hash,
      title: conflict.theirs.title,
      content: conflict.theirs.content,
    },
  );
  const titles: ConflictTitles = {
    mine: mine.title,
    theirs: theirs.title,
    differs: mine.title !== theirs.title,
  };
  const places = placesChanged(comparison.markdown);
  return {
    base,
    mine: side("mine", mine, now),
    theirs,
    titles,
    lines: comparison.markdown,
    places,
    summary: summarize(titles, places),
    simplified: comparison.simplified,
  };
}
