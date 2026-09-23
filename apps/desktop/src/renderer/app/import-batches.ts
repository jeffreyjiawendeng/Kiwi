/**
 * Cutting a reviewed import into requests that will fit.
 *
 * A command may carry 256 KB and no more. A file on the way in is under that ceiling by being a
 * path the command opens for itself, but the rows on the way back out have no such escape: a
 * person ticked them, corrected them, and they have to travel as arguments. Several hundred
 * entries of BibTeX is past the ceiling routinely, so the choice is between refusing a real
 * library and sending it in parts. It goes in parts.
 *
 * The parts are decided here rather than in the table, so that what the gateway measures and what
 * this counts are the same measurement rather than two guesses about each other. The gateway
 * compares `JSON.stringify(request).length` against its ceiling, which counts UTF-16 units and not
 * bytes, and so does this. Anything more clever would be a different number.
 *
 * Splitting is safe to do because the command was built to be split: a reviewed row is created on
 * the strength of having been reviewed, so a row in the second request behaves the same as it
 * would have in the first. What changes is that there are several receipts instead of one, and
 * adding those up is the table's work.
 */

/** A row as the preview handed it over and the person left it. */
export interface ReviewedRow {
  title: string;
  reference: unknown;
  file_hash: string | null;
  /**
   * What this side calls the row, sent so that the receipt can say it back.
   *
   * It costs a few bytes in a request that is being cut up over bytes, and it is worth them. A
   * row read out of a PDF has a file behind it that still has to be attached once the Paper
   * exists, and the receipt separates what it created from what it held back -- so without a
   * name travelling both ways there is no honest way to tell which Paper a given file belongs
   * to. Guessing by position would attach files to the wrong papers, quietly, in exactly the
   * imports where the most rows were held back.
   */
  key: string;
}

export interface ImportBatch {
  /** The rows this one request carries, in the order they were reviewed. */
  entries: ReviewedRow[];
  /** Where the first of them sat in the whole selection, counting from one. */
  first: number;
  /** Where the last of them sat, so a part that fails can say which rows it was carrying. */
  last: number;
}

export type ImportBatchPlan =
  | { status: "planned"; batches: ImportBatch[] }
  /**
   * One row is past the ceiling by itself, and no cutting will help.
   *
   * Said rather than worked around, because the only fixes are the person's: shorten the record,
   * or leave that row out and import the rest. Silently dropping it would produce a receipt that
   * counted wrong, and refusing the whole import would punish the other rows for it.
   */
  | { status: "row_too_large"; index: number; title: string };

/** What the gateway allows a whole request to be, counted the way the gateway counts it. */
const REQUEST_CEILING = 256 * 1024;

/**
 * The schema's own limit on how many rows one import may carry.
 *
 * Size runs out well before this does for any real library, so it almost never decides anything.
 * It is here so that the request this builds is one the command would accept on every count, not
 * only on the count that usually binds.
 */
const MAX_ROWS = 5_000;

/**
 * Room for the two fields the main process fills in after the renderer has stopped measuring.
 *
 * The workspace and the folder it lives in are put on the envelope on the way past, precisely
 * because the renderer is not the thing that may name them -- which leaves the renderer measuring
 * a request slightly smaller than the one that gets sent. So it budgets for them instead. A root
 * is at most 240 characters by the command's own schema and JSON doubles every backslash in a
 * Windows path, and an id is shorter than that again; a kilobyte is past the worst either can be.
 */
const SUBSTITUTION_RESERVE = 1024;

/** Everything in the request that is not a row: the envelope, the argument names, the brackets. */
const SKELETON = JSON.stringify({
  protocol_version: "1.0.0",
  request_id: "00000000-0000-4000-8000-000000000000",
  workspace_id: "",
  command: "kiwi.bibliography.import",
  args: { entries: [] },
}).length;

/** What is left over for rows once everything else has had its share. */
export const BATCH_BUDGET = REQUEST_CEILING - SKELETON - SUBSTITUTION_RESERVE;

/** What one row costs a request: itself, and the comma that separates it from the next. */
function costOf(row: ReviewedRow): number {
  return JSON.stringify(row).length + 1;
}

/**
 * Splits reviewed rows into whole requests, each one under the ceiling.
 *
 * Rows keep their order and no row is split, so every part is a request the command would have
 * accepted on its own. The parts come out as small in number as this measurement allows: a row
 * joins the part being filled until it would not fit, and only then does a new part start.
 */
export function planImportBatches(rows: readonly ReviewedRow[]): ImportBatchPlan {
  const batches: ImportBatch[] = [];
  let current: ReviewedRow[] = [];
  let used = 0;
  let first = 1;

  for (const [index, row] of rows.entries()) {
    const cost = costOf(row);
    // Nothing to be done about a row this size, and it is worth saying which row it is: a
    // library where one record carries a whole paper in its abstract is a real thing, and the
    // person can see that from the title in a way they cannot from a total.
    if (cost > BATCH_BUDGET) return { status: "row_too_large", index, title: row.title };
    if (current.length > 0 && (used + cost > BATCH_BUDGET || current.length >= MAX_ROWS)) {
      batches.push({ entries: current, first, last: index });
      current = [];
      used = 0;
      first = index + 1;
    }
    current.push(row);
    used += cost;
  }
  if (current.length > 0) batches.push({ entries: current, first, last: rows.length });

  return { status: "planned", batches };
}
