/**
 * The bibliographic record attached to a Paper.
 *
 * This is what a citation is built from, so the fields are the ones a citation style asks
 * for and nothing more. It is stored on the canonical object under `reference`, which keeps
 * the file readable: someone opening the JSON sees a recognisable citation rather than a bag
 * of loose properties.
 */

export const REFERENCE_KINDS = [
  "article",
  "preprint",
  "book",
  "chapter",
  "conference",
  "thesis",
  "report",
  "dataset",
  "software",
  "webpage",
  "other",
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface Reference {
  kind: ReferenceKind;
  /** Whole names as written, one per author. Kiwi does not guess at given and family parts. */
  authors: string[];
  /** Journal, book, conference, or site. One field, because a work has one container. */
  container: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  abstract: string | null;
}

export const EMPTY_REFERENCE: Reference = {
  kind: "article",
  authors: [],
  container: null,
  year: null,
  doi: null,
  url: null,
  volume: null,
  issue: null,
  pages: null,
  publisher: null,
  abstract: null,
};

export const REFERENCE_LIMITS = {
  authors: 200,
  authorLength: 300,
  container: 300,
  volume: 40,
  issue: 40,
  pages: 40,
  publisher: 300,
  abstract: 20_000,
  url: 2_048,
  doi: 255,
  earliestYear: 1000,
  /** A paper can be dated slightly ahead of today, but not by a decade. */
  yearsAhead: 5,
} as const;

export type ReferenceField = keyof Reference;

export interface ReferenceProblem {
  field: ReferenceField;
  severity: "error" | "warning";
  message: string;
}

/**
 * A DOI is `10.` a registrant code, a slash, then anything. Kiwi accepts a bare DOI and the
 * two URL forms people paste, because rejecting a pasted doi.org link would be pedantry.
 */
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/u;
const DOI_URL_PATTERN = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/iu;

export function normalizeDoi(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const fromUrl = DOI_URL_PATTERN.exec(trimmed);
  const candidate = fromUrl?.[1] ?? trimmed.replace(/^doi:\s*/iu, "");
  return DOI_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * Contracts is deliberately free of any environment, so this cannot use `URL`. The check is a
 * pattern rather than a parse, and it is a safety boundary as much as a validation: the
 * interface opens this link later, so `javascript:` and `file:` must never reach it.
 */
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+\S*$/iu;

function isSafeUrl(value: string): boolean {
  return HTTP_URL_PATTERN.test(value);
}

/**
 * Fields no style can print an honest entry without, whichever style is chosen later.
 *
 * Not the same question as `validateReference`, which asks whether a record is wrong. This asks
 * whether it is thin, and it is asked while the person is still looking at the row and in a
 * position to type the missing part in, rather than months later in a bibliography that will not
 * format. Both halves of an import ask it -- a reference file read by the workspace, and a PDF
 * read in the renderer -- so it is answered in one place and spelled one way.
 */
export function bareFields(reference: Reference): string[] {
  const missing: string[] = [];
  if (reference.authors.filter((name) => name.trim() !== "").length === 0) missing.push("authors");
  if (reference.year === null) missing.push("year");
  // A journal article with no journal is not something any style can format honestly.
  if (
    (reference.kind === "article" || reference.kind === "conference") &&
    (reference.container === null || reference.container.trim() === "")
  )
    missing.push("container");
  return missing;
}

export function validateReference(reference: Reference, now = new Date()): ReferenceProblem[] {
  const problems: ReferenceProblem[] = [];
  const add = (field: ReferenceField, message: string, severity: "error" | "warning" = "error") => {
    problems.push({ field, severity, message });
  };

  if (!(REFERENCE_KINDS as readonly string[]).includes(reference.kind)) {
    add("kind", "Choose a reference type.");
  }

  if (reference.authors.length > REFERENCE_LIMITS.authors) {
    add("authors", `A reference can list at most ${REFERENCE_LIMITS.authors} authors.`);
  }
  for (const author of reference.authors) {
    if (author.trim() === "") {
      add("authors", "An author name cannot be blank.");
      break;
    }
    if (author.length > REFERENCE_LIMITS.authorLength) {
      add("authors", `An author name cannot exceed ${REFERENCE_LIMITS.authorLength} characters.`);
      break;
    }
  }

  const lengths: Array<[ReferenceField, string | null, number]> = [
    ["container", reference.container, REFERENCE_LIMITS.container],
    ["volume", reference.volume, REFERENCE_LIMITS.volume],
    ["issue", reference.issue, REFERENCE_LIMITS.issue],
    ["pages", reference.pages, REFERENCE_LIMITS.pages],
    ["publisher", reference.publisher, REFERENCE_LIMITS.publisher],
    ["abstract", reference.abstract, REFERENCE_LIMITS.abstract],
  ];
  for (const [field, value, limit] of lengths) {
    if (value !== null && value.length > limit) {
      add(field, `This field cannot exceed ${limit} characters.`);
    }
  }

  if (reference.year !== null) {
    const latest = now.getUTCFullYear() + REFERENCE_LIMITS.yearsAhead;
    if (!Number.isInteger(reference.year)) {
      add("year", "Enter a whole year.");
    } else if (reference.year < REFERENCE_LIMITS.earliestYear || reference.year > latest) {
      add("year", `Enter a year between ${REFERENCE_LIMITS.earliestYear} and ${latest}.`);
    }
  }

  if (reference.doi !== null && normalizeDoi(reference.doi) === null) {
    add("doi", "A DOI looks like 10.1000/xyz123.");
  }

  if (reference.url !== null) {
    if (reference.url.length > REFERENCE_LIMITS.url) {
      add("url", `A link cannot exceed ${REFERENCE_LIMITS.url} characters.`);
    } else if (!isSafeUrl(reference.url)) {
      add("url", "Enter a complete http or https link.");
    }
  }

  return problems;
}

/** Trims, drops blanks, and normalizes a DOI so what is stored is what will be cited. */
export function normalizeReference(reference: Reference): Reference {
  const text = (value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim().normalize("NFC");
    return trimmed === "" ? null : trimmed;
  };
  return {
    kind: reference.kind,
    authors: reference.authors
      .map((author) => author.trim().normalize("NFC"))
      .filter((author) => author !== ""),
    container: text(reference.container),
    year: reference.year,
    doi: reference.doi === null ? null : (normalizeDoi(reference.doi) ?? reference.doi.trim()),
    url: text(reference.url),
    volume: text(reference.volume),
    issue: text(reference.issue),
    pages: text(reference.pages),
    publisher: text(reference.publisher),
    abstract: text(reference.abstract),
  };
}

export function isReference(value: unknown): value is Reference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Reference>;
  return (
    typeof candidate.kind === "string" &&
    Array.isArray(candidate.authors) &&
    candidate.authors.every((author) => typeof author === "string")
  );
}

/** Reads whatever is stored on an object, filling in anything a older file did not carry. */
export function readReference(value: unknown): Reference {
  if (!isReference(value)) return { ...EMPTY_REFERENCE };
  const stored = value as Partial<Reference> & Pick<Reference, "kind" | "authors">;
  return {
    ...EMPTY_REFERENCE,
    ...stored,
    kind: (REFERENCE_KINDS as readonly string[]).includes(stored.kind)
      ? stored.kind
      : EMPTY_REFERENCE.kind,
  };
}

/** "Vaswani et al. (2017)", what a list row shows under the title. */
export function referenceSummary(reference: Reference): string {
  const [first] = reference.authors;
  const family = first === undefined ? null : (first.split(",")[0] ?? first).trim();
  const who = family === null ? null : reference.authors.length > 1 ? `${family} et al.` : family;
  const when = reference.year === null ? null : String(reference.year);
  const where = reference.container;
  return [who, when === null ? null : `(${when})`, where].filter(Boolean).join(" ");
}

/**
 * How long a one-line summary is allowed to be.
 *
 * One line means one sentence. A field that accepts a paragraph becomes the place people put
 * paragraphs, and then the table cell showing it is a paragraph and the column is unreadable.
 * Anything longer than this belongs in a Note attached to the Paper.
 */
export const PAPER_SUMMARY_LIMIT = 280;

/**
 * Folds a written summary onto the one line it claims to be.
 *
 * Text pasted out of a PDF arrives with the line breaks the PDF had in it. Keeping them would
 * store a summary that reads as one line in the field it was typed in and as four in the table,
 * so the breaks are collapsed here, once, before anything is stored.
 */
export function normalizePaperSummary(value: string): string {
  return value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
}

/**
 * Reads the summary stored on an object, which most objects do not carry.
 *
 * This is the reader's own sentence about a work, not `referenceSummary`, which is built from
 * the citation, and not the abstract, which is the publisher's words. Nothing written before
 * this build has one, and an empty string is the honest answer for all of them.
 */
export function readPaperSummary(value: unknown): string {
  return typeof value === "string" ? normalizePaperSummary(value) : "";
}

/**
 * Whether the work has been marked read.
 *
 * Only `true` counts. Nothing written before this build carries the field, and unread is the
 * honest answer for all of it: a library that opened claiming every paper already on the shelf
 * had been read would be worse than one that asks to be told.
 *
 * When it was read is not kept here. The version that set the mark carries the moment it was
 * published, and the object's own history is where a question about when is answered.
 *
 * This is the workspace's mark rather than one member's, the shelf says a book is out or in.
 * A mark each member keeps to themselves is a different field, and it belongs to the build that
 * gives a workspace more than one person in it.
 */
export function readPaperReadState(value: unknown): boolean {
  return value === true;
}

/**
 * Which of an object's files is the one to open, given what it names and what is attached.
 *
 * A Paper can hold the preprint, the published version and the supplement at once, and only one
 * of them is the one somebody means when they say read this paper. The object names it under
 * `primary_asset_id`; everything written before this build names nothing, and the first file
 * attached is the honest answer for all of it, because it was the only file when it was the only
 * file.
 *
 * The name is obeyed only while that file is still attached. This is what keeps detaching a file
 * from having to write the Paper as well: a name pointing at a file that is gone reads exactly as
 * no name at all, and the same fallback answers both.
 *
 * The empty string means there is nothing to open, which is a Paper with no files.
 */
export function primaryFileId(attachedIds: readonly string[], named: unknown): string {
  if (typeof named === "string" && attachedIds.includes(named)) return named;
  return attachedIds[0] ?? "";
}
