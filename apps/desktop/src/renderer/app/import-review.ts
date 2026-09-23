/**
 * What a reference import shows a person, and what it tells them afterwards.
 *
 * Two jobs that look unrelated and are the same job. Before the import, a row has to say what it
 * is a copy of and what is wrong with it, in a sentence somebody can act on: "duplicate" on its
 * own is a label, and a label is not a reason to untick a box. After the import, several requests
 * have come back separately -- because a reviewed library does not fit in one -- and the person
 * asked for one import, so they are owed one answer rather than a list of receipts.
 *
 * Both jobs are here rather than in the table so that they can be read and checked without a
 * screen. The wording of a duplicate verdict is the part of this feature most likely to be wrong
 * in a way nobody notices, and the arithmetic of "388 of 400" is the part most likely to be wrong
 * in a way somebody notices far too late.
 */

import { readReference, type Reference, type ReferenceProblem } from "@kiwi/contracts";

/** What a candidate row turned out to be a second copy of, as the preview spells it. */
export interface DuplicateVerdict {
  where: "library" | "file";
  by: "doi" | "file" | "title";
  /** Whether this is a fact or a resemblance. It changes the sentence, not only the wording. */
  certain: boolean;
  object_id: string | null;
  row: number | null;
  title: string;
}

/** One offered work, as the preview handed it over. */
export interface PreviewRow {
  /** Where in the file it was. Kept, so a row can be named by the same number twice. */
  row: number;
  key: string;
  title: string;
  reference: Reference;
  file_hash: string | null;
  /** Whether it arrives ticked. Everything does except what looks like a second copy. */
  selected: boolean;
  duplicate: DuplicateVerdict | null;
  problems: ReferenceProblem[];
  missing: string[];
  /**
   * How the row was arrived at, when it was arrived at rather than read.
   *
   * A reference file states what it states, so a row out of one leaves this null. A row read out
   * of a PDF may have had its title decided by which line of the first page was the largest, and
   * that is worth a sentence before somebody keeps it.
   */
  note: string | null;
}

export interface ImportPreview {
  found: number;
  rows: PreviewRow[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readVerdict(value: unknown): DuplicateVerdict | null {
  const entry = record(value);
  if (entry === null) return null;
  const where = entry["where"];
  const by = entry["by"];
  if (where !== "library" && where !== "file") return null;
  if (by !== "doi" && by !== "file" && by !== "title") return null;
  const row = entry["row"];
  const objectId = entry["object_id"];
  return {
    where,
    by,
    certain: entry["certain"] === true,
    object_id: typeof objectId === "string" ? objectId : null,
    row: typeof row === "number" ? row : null,
    title: typeof entry["title"] === "string" ? entry["title"] : "",
  };
}

function readProblems(value: unknown): ReferenceProblem[] {
  if (!Array.isArray(value)) return [];
  const problems: ReferenceProblem[] = [];
  for (const item of value) {
    const entry = record(item);
    const field = entry?.["field"];
    const message = entry?.["message"];
    if (typeof field !== "string" || typeof message !== "string") continue;
    problems.push({
      field: field as ReferenceProblem["field"],
      severity: entry?.["severity"] === "warning" ? "warning" : "error",
      message,
    });
  }
  return problems;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Reads what the preview command answered, or refuses the whole thing.
 *
 * Refusing rather than repairing, because a half-read preview is the one failure this feature
 * cannot afford: a row whose duplicate verdict was dropped on the way in arrives ticked and
 * looking ordinary, and gets imported over a warning nobody was shown.
 */
export function readImportPreview(
  value: Record<string, unknown> | undefined,
): ImportPreview | null {
  const rows = value?.["rows"];
  const found = value?.["found"];
  if (typeof found !== "number" || !Array.isArray(rows)) return null;
  const read: PreviewRow[] = [];
  for (const item of rows) {
    const entry = record(item);
    const row = entry?.["row"];
    const title = entry?.["title"];
    if (entry === null || typeof row !== "number" || typeof title !== "string") return null;
    const hash = entry["file_hash"];
    read.push({
      row,
      key: typeof entry["key"] === "string" ? entry["key"] : `row-${String(row)}`,
      title,
      reference: readReference(entry["reference"]),
      file_hash: typeof hash === "string" ? hash : null,
      // Ticked unless the preview said otherwise. The one direction worth being strict about is
      // the other one: a row the preview held back must not arrive ticked because a field was
      // spelled unexpectedly.
      selected: entry["selected"] !== false,
      duplicate: readVerdict(entry["duplicate"]),
      problems: readProblems(entry["problems"]),
      missing: readStrings(entry["missing"]),
      // A reference file is somebody's own record of the work, whatever else is wrong with it.
      note: null,
    });
  }
  return { found, rows: read };
}

/**
 * The duplicate verdict as a sentence.
 *
 * Certainty is what decides the sentence, not what matched. A shared DOI or an identical file is
 * the same work by definition and can be stated; a title that reads alike is a guess, and stating
 * a guess as a fact is how a distinct paper ends up unticked and never imported. What matched is
 * still said, because it is what somebody would check.
 */
export function describeDuplicate(verdict: DuplicateVerdict): string {
  const named = verdict.title === "" ? "a work already held" : `"${verdict.title}"`;
  if (verdict.where === "file") {
    const above = verdict.row === null ? "an earlier row" : `row ${String(verdict.row)}`;
    if (verdict.by === "doi") return `The same DOI appears at ${above} of this file.`;
    if (verdict.by === "file") return `The same file appears at ${above} of this file.`;
    return `Reads like ${above} of this file. Check the two before adding both.`;
  }
  if (verdict.by === "doi") return `Already in the library as ${named}, with the same DOI.`;
  if (verdict.by === "file") return `Already in the library as ${named}, from the same file.`;
  return verdict.certain
    ? `Already in the library as ${named}.`
    : `Reads like ${named}, already in the library. Check before adding it.`;
}

/** Fields no style can print an honest entry without, said in words rather than in field names. */
const FIELD_NAMES: Record<string, string> = {
  authors: "authors",
  year: "year",
  container: "venue",
  pages: "page numbers",
};

/** What the exporter left out, phrased so the gap is something to type in rather than a code. */
export function describeMissing(missing: readonly string[]): string | null {
  const named = missing.map((field) => FIELD_NAMES[field] ?? field);
  const last = named.at(-1);
  if (last === undefined) return null;
  const rest = named.slice(0, -1);
  return rest.length === 0 ? `No ${last}.` : `No ${rest.join(", ")} or ${last}.`;
}

/** Several names in one phrase, joined the way somebody reading them out would join them. */
export function listPhrase(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  const rest = names.slice(0, -1);
  return rest.length === 0 ? last : `${rest.join(", ")} and ${last}`;
}

/**
 * What a folder held that its rows do not account for.
 *
 * A folder of thirty files that yields twenty rows has to say where the other ten went, while the
 * table is still on screen rather than afterwards. Three things can keep a file out of the table
 * and they are not the same news. Something that was never a PDF is not worth naming: it was
 * never going to be a paper. More PDFs than one pass reads is worth an instruction rather than a
 * count, because the folder is still there and can be chosen again. A PDF that would not open is
 * worth its name, because it was meant to be a paper and somebody can go and look at it.
 */
export function describeFolderRead(read: {
  skipped: number;
  truncated: boolean;
  unreadable: readonly string[];
}): string[] {
  const notes: string[] = [];
  if (read.skipped > 0)
    notes.push(
      read.skipped === 1
        ? "One other file in the folder was not a PDF."
        : `${read.skipped.toLocaleString()} other files in the folder were not PDFs.`,
    );
  if (read.truncated)
    notes.push(
      "The folder holds more PDFs than Kiwi reads at once. Add these, then choose it again for the rest.",
    );
  if (read.unreadable.length > 0) {
    // Three names and a count rather than thirty names. The list is here to be acted on, and a
    // list nobody reads to the end is not a list anybody acts on.
    const shown = read.unreadable.slice(0, 3);
    const rest = read.unreadable.length - shown.length;
    const named = rest === 0 ? listPhrase(shown) : `${shown.join(", ")} and ${String(rest)} more`;
    notes.push(`Kiwi could not open ${named}.`);
  }
  return notes;
}

/** Why a row was not created, in the words the receipt uses. */
const SKIP_REASONS: Record<string, string> = {
  repeated_in_file: "the file lists it more than once",
  duplicate_doi: "the library already holds that DOI",
  duplicate_file: "the library already holds that file",
  duplicate_title: "the library already holds something by that title",
  rejected: "the workspace would not accept the record",
};

export function describeSkip(reason: string): string {
  return SKIP_REASONS[reason] ?? "the workspace gave no reason";
}

export interface CreatedRow {
  id: string;
  title: string;
  /**
   * Which reviewed row became this Paper, in the name this side gave the row.
   *
   * The empty string where the workspace named none, which is what an older receipt or a caller
   * that sent no names produces. It means the same thing an unrecognised name means -- there is
   * nothing further to do for this Paper -- so the two need not be told apart.
   */
  key: string;
}

export interface SkippedRow {
  title: string;
  reason: string;
}

/** What the import command answered for one part of a split import. */
export interface ImportReceipt {
  created: CreatedRow[];
  skipped: SkippedRow[];
}

export function readImportReceipt(
  value: Record<string, unknown> | undefined,
): ImportReceipt | null {
  const created = value?.["created"];
  const skipped = value?.["skipped"];
  if (!Array.isArray(created) || !Array.isArray(skipped)) return null;
  const rows: CreatedRow[] = [];
  for (const item of created) {
    const entry = record(item);
    const id = entry?.["id"];
    const title = entry?.["title"];
    if (typeof id !== "string" || typeof title !== "string") return null;
    const key = entry?.["key"];
    rows.push({ id, title, key: typeof key === "string" ? key : "" });
  }
  const held: SkippedRow[] = [];
  for (const item of skipped) {
    const entry = record(item);
    const title = entry?.["title"];
    if (typeof title !== "string") return null;
    held.push({
      title,
      reason: typeof entry?.["reason"] === "string" ? entry["reason"] : "rejected",
    });
  }
  return { created: rows, skipped: held };
}

/** How one part of a split import turned out. */
export type PartOutcome =
  { status: "committed"; receipt: ImportReceipt } | { status: "failed"; message: string };

/** One part, and where its rows sat in the selection so a failure can be said in rows. */
export interface ImportPart {
  first: number;
  last: number;
  outcome: PartOutcome;
}

/** A stretch of the selection that never reached the workspace, and what stopped it. */
export interface UnsentRows {
  first: number;
  last: number;
  message: string;
}

export interface ImportOutcome {
  created: CreatedRow[];
  skipped: SkippedRow[];
  unsent: UnsentRows[];
}

/**
 * Adds several receipts up into one.
 *
 * Failures are kept as stretches of the selection rather than as failed requests, because the
 * requests are an implementation detail of the ceiling and the rows are what the person ticked.
 * Neighbouring stretches that failed the same way are joined for the same reason: "rows 201 to
 * 600 were not sent" is one thing that went wrong, and reporting it as two is reporting the
 * cutting rather than the fault.
 */
export function collectImport(parts: readonly ImportPart[]): ImportOutcome {
  const created: CreatedRow[] = [];
  const skipped: SkippedRow[] = [];
  const unsent: UnsentRows[] = [];
  for (const part of parts) {
    if (part.outcome.status === "committed") {
      created.push(...part.outcome.receipt.created);
      skipped.push(...part.outcome.receipt.skipped);
      continue;
    }
    const previous = unsent.at(-1);
    if (
      previous !== undefined &&
      previous.last + 1 === part.first &&
      previous.message === part.outcome.message
    )
      previous.last = part.last;
    else unsent.push({ first: part.first, last: part.last, message: part.outcome.message });
  }
  return { created, skipped, unsent };
}

function rowsIn(range: UnsentRows): number {
  return range.last - range.first + 1;
}

function countOf(range: UnsentRows): string {
  return range.first === range.last
    ? `Row ${String(range.first)} was not sent.`
    : `Rows ${String(range.first)} to ${String(range.last)} were not sent.`;
}

export interface ImportSummary {
  /** The one line that says what happened. */
  headline: string;
  /** Everything else the person needs, one sentence each. */
  notes: string[];
}

/**
 * What to tell somebody who asked for one import and got several answers.
 *
 * The headline counts rows and not requests, and it says the total whenever the total and the
 * created count differ: "388 added" invites the reading that 388 was what there was. Skips are
 * grouped by reason because twelve identical sentences say less than one sentence and a number.
 */
export function describeImport(outcome: ImportOutcome): ImportSummary {
  const missed = outcome.unsent.reduce((total, range) => total + rowsIn(range), 0);
  const attempted = outcome.created.length + outcome.skipped.length + missed;
  const notes: string[] = [];

  const reasons = new Map<string, number>();
  for (const row of outcome.skipped) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  for (const [reason, count] of reasons)
    notes.push(
      count === 1
        ? `One row was not created, because ${describeSkip(reason)}.`
        : `${String(count)} rows were not created, because ${describeSkip(reason)}.`,
    );
  for (const range of outcome.unsent) notes.push(`${countOf(range)} ${range.message}`);

  if (attempted === 0) return { headline: "Nothing was imported.", notes };
  const count = outcome.created.length;
  const papers = count === 1 ? "paper" : "papers";
  if (missed === 0)
    return {
      headline:
        count === attempted
          ? `${String(count)} ${papers} added.`
          : `${String(count)} of ${String(attempted)} rows added.`,
      notes,
    };
  if (count === 0) return { headline: "Nothing was added.", notes };
  return {
    headline: `${String(count)} of ${String(attempted)} rows added, and the import stopped.`,
    notes,
  };
}
