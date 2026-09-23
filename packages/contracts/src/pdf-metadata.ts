import { EMPTY_REFERENCE, REFERENCE_LIMITS, normalizeDoi, type Reference } from "./reference.js";

/**
 * What a PDF says about itself, and what its first page says instead.
 *
 * A PDF carries an info dictionary that is supposed to name the work, and about half the time
 * it names the LaTeX run that produced the file: `paper.dvi`, `untitled`, `Microsoft Word -
 * final_v3_FINAL.doc`. So the file's own account is taken where it is worth taking and the
 * first page is read where it is not, and neither is trusted enough to be committed unseen.
 *
 * Every field comes back with where it came from, because that is what lets the preview say
 * "this was read off the page" beside a title somebody is about to keep. Extraction that hides
 * how sure it is asks to be believed; extraction that says so asks to be checked, and checking
 * is the point. Nothing here writes anything, and nothing here decides anything: it returns a
 * filled-in form for somebody to correct.
 */

/**
 * The entries of the PDF info dictionary this reads, under Kiwi's spelling of their names.
 *
 * PDF.js hands these back from `getMetadata()` capitalised the way the format spells them.
 * Renaming them at the seam keeps the format's spelling out of everything downstream.
 */
export interface PdfInfo {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  /** A PDF date, `D:20230415120000+02'00'`. Only its year is read. */
  creationDate?: string | null;
}

/**
 * A positioned piece of text off the first page.
 *
 * This is the shape PDF.js already produces, so the Reader's text items can be passed straight
 * in. Height stands in for font size, which is the only reason position matters here: a title
 * is not known by what it says but by being the largest thing near the top.
 */
export interface PdfTextRun {
  text: string;
  /** Distance from the left of the page, in the page's own units. */
  left: number;
  /** Distance from the top of the page, in the page's own units. */
  top: number;
  /** Glyph height, which stands in for the size of the type. */
  height: number;
}

/** Whether a field came out of the file's own account of itself, off the page, or nowhere. */
export type MetadataSource = "embedded" | "page" | "none";

/** The fields a PDF can be read for. `kind` follows `url`: an arXiv stamp makes a preprint. */
export type PdfMetadataField = "title" | "authors" | "year" | "doi" | "url";

export interface PdfMetadata {
  /** Empty when neither the file nor its first page offered one. */
  title: string;
  reference: Reference;
  /** Where each field came from, so a guess can be shown as a guess. */
  sources: Record<PdfMetadataField, MetadataSource>;
}

/** A run of text at one height on one line, which is what the heuristics actually read. */
interface PdfLine {
  text: string;
  top: number;
  height: number;
}

function collapsed(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cleaned(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = collapsed(value);
  return text === "" ? null : text;
}

/** What a typesetter left in the Title field instead of the title. */
const PRODUCED_FILENAME = /\.(pdf|dvi|doc|docx|tex|ps|indd|qxd|rtf)$/iu;
const PLACEHOLDER_TITLE = /^(untitled|unknown|no title|document\s*\d*|microsoft word\b)/iu;

/**
 * Whether the embedded title is a title or the name of a file.
 *
 * A wrong title is worse than an absent one, because an absent one sends the reader to the
 * page and a wrong one looks like an answer.
 */
function usableTitle(value: string | null): string | null {
  if (value === null || value.length < 4) return null;
  if (PRODUCED_FILENAME.test(value) || PLACEHOLDER_TITLE.test(value)) return null;
  return value;
}

/**
 * Names out of the info dictionary, where the separator is anybody's guess.
 *
 * A single comma is the ambiguous case: `Lovelace, Ada` is one name written family first and
 * `Ada Lovelace, Charles Babbage` is two, and nothing in the string says which. It is kept
 * whole, because a name held together can be split by the person reading the row and a name
 * split wrongly has invented an author nobody will notice. Two commas or more is a list.
 */
function splitInfoAuthors(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(/\s*;\s*|\s+and\s+|\s*&\s*/iu)) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if ((trimmed.match(/,/gu) ?? []).length >= 2) names.push(...trimmed.split(","));
    else names.push(trimmed);
  }
  return names;
}

/** Superscripts tying a name to an affiliation, which are not part of the name. */
const AFFILIATION_MARKER = /[\d*†‡§¶¹²³⁰-⁹,\s]+$/u;

const AFFILIATION_WORD =
  /\b(universi\w*|institut\w*|departmen\w*|dept|laborator\w*|college|school|academy|society|association|foundation|hospital|museum|observatory|centre|center|inc|ltd|gmbh|corp)\b/iu;

function plausibleName(value: string): boolean {
  const name = collapsed(value.replace(AFFILIATION_MARKER, ""));
  if (name.length < 2 || name.length > REFERENCE_LIMITS.authorLength) return false;
  if (name.includes("@") || AFFILIATION_WORD.test(name)) return false;
  return /\p{L}/u.test(name);
}

function tidyName(value: string): string {
  return collapsed(value.replace(AFFILIATION_MARKER, ""));
}

/** On a title page a comma separates one author from the next, so it is read that way. */
function splitPageAuthors(line: string): string[] {
  return line.split(/\s*(?:,|;|·|\band\b|&)\s*/iu);
}

/**
 * Lines, built back out of the pieces PDF.js breaks a line into.
 *
 * Runs sitting within half a line's height of each other are the same line. They are joined
 * with a space and the spacing collapsed, which is right for the pieces PDF.js usually
 * produces and wrong for a file that breaks a word across two runs; a title reading `Atten
 * tion` is visibly wrong, which is the failure to prefer when there has to be one.
 */
function toLines(runs: readonly PdfTextRun[]): PdfLine[] {
  const sorted = runs
    .filter((run) => run.text.trim() !== "")
    .slice()
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const lines: PdfLine[] = [];
  let current: PdfTextRun[] = [];
  const close = () => {
    if (current.length === 0) return;
    const ordered = current.slice().sort((a, b) => a.left - b.left);
    lines.push({
      text: collapsed(ordered.map((run) => run.text).join(" ")),
      top: Math.min(...current.map((run) => run.top)),
      height: Math.max(...current.map((run) => run.height)),
    });
    current = [];
  };

  for (const run of sorted) {
    const first = current[0];
    if (
      first !== undefined &&
      Math.abs(run.top - first.top) > Math.max(first.height, run.height) / 2
    )
      close();
    current.push(run);
  }
  close();
  return lines.filter((line) => line.text !== "");
}

/** A stamp, a running head, an email: things set near a title that are not the title. */
const NOT_A_TITLE =
  /^(arxiv[:.]|preprint\b|draft\b|submitted\b|accepted\b|proceedings\b|downloaded\b|https?:|www\.|doi:|10\.\d{4}|copyright\b|©|vol\.|volume \d|chapter \d|page \d)/iu;

function noise(text: string): boolean {
  if (text.length < 4) return true;
  if (NOT_A_TITLE.test(text) || text.includes("@")) return true;
  // Mostly digits and punctuation is a citation line, a date, or a page footer.
  return text.replace(/[^\p{L}]/gu, "").length * 2 < text.length;
}

/** How far down the page a title can be before it is a section heading instead. */
const TITLE_SEARCH_LINES = 12;

interface PageTitle {
  text: string;
  /** The line after the title block, which is where the authors are if they are anywhere. */
  next: number;
}

/**
 * The title as the page shows it: the largest type near the top, plus whatever it wrapped onto.
 *
 * Size rather than position, because a running head sits above the title and a journal stamp
 * above that. Ties go to whichever came first, which is the one nearer the top of the page.
 */
function pageTitle(lines: readonly PdfLine[]): PageTitle | null {
  let best = -1;
  for (let index = 0; index < Math.min(lines.length, TITLE_SEARCH_LINES); index += 1) {
    const line = lines[index];
    if (line === undefined || noise(line.text)) continue;
    const chosen = best === -1 ? undefined : lines[best];
    if (chosen === undefined || line.height > chosen.height + 0.01) best = index;
  }
  const first = best === -1 ? undefined : lines[best];
  if (first === undefined) return null;

  const parts = [first.text];
  let next = best + 1;
  while (next < lines.length) {
    const line = lines[next];
    // Set in the same type and immediately under it, so it is the rest of the same sentence.
    if (line === undefined || Math.abs(line.height - first.height) > 0.51 || noise(line.text))
      break;
    parts.push(line.text);
    next += 1;
  }
  return { text: parts.join(" "), next };
}

/** How many lines below the title the authors can be before they are the abstract. */
const AUTHOR_SEARCH_LINES = 3;

function pageAuthors(lines: readonly PdfLine[], from: number): string[] {
  for (let index = from; index < Math.min(lines.length, from + AUTHOR_SEARCH_LINES); index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (/^(abstract|introduction|keywords)\b/iu.test(line.text)) break;
    const parts = splitPageAuthors(line.text);
    // A line naming an institution is the affiliation line, even where a name sits on it too.
    // Skipping it can lose an author, and reading it lists a university as a person; a field
    // left empty is one somebody fills in, and a field filled in wrongly is one they keep.
    if (parts.some((part) => AFFILIATION_WORD.test(part) || part.includes("@"))) continue;
    const names = parts.filter(plausibleName).map(tidyName);
    if (names.length > 0) return names;
  }
  return [];
}

/** A DOI as it appears in running text, where it is followed by whatever punctuation follows. */
const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"<>]+/u;

function findDoi(text: string): string | null {
  const found = DOI_IN_TEXT.exec(text)?.[0];
  if (found === undefined) return null;
  // A DOI at the end of a sentence takes the full stop with it, and a bracketed one the bracket.
  return normalizeDoi(found.replace(/[.,;)\]]+$/u, ""));
}

const ARXIV_STAMP = /\barxiv:\s*([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/iu;

const YEAR_IN_TEXT = /\b(1\d{3}|2\d{3})\b/gu;
const PDF_DATE_YEAR = /^D?:?\s*(\d{4})/u;

function plausibleYear(year: number, now: Date): boolean {
  return (
    year >= REFERENCE_LIMITS.earliestYear && year <= now.getFullYear() + REFERENCE_LIMITS.yearsAhead
  );
}

/**
 * The latest plausible year printed on the first page.
 *
 * A title page states the year of publication and sometimes another year beside it, when a
 * conference series began, when a dataset was collected. The later of them is the one nearer
 * to the work, and it is a starting guess in a field somebody can retype.
 */
function pageYear(text: string, now: Date): number | null {
  let latest: number | null = null;
  for (const match of text.matchAll(YEAR_IN_TEXT)) {
    const year = Number(match[1]);
    if (plausibleYear(year, now) && (latest === null || year > latest)) latest = year;
  }
  return latest;
}

/**
 * Reads a PDF for the record it would be imported as.
 *
 * The file's own account is preferred where it is usable, and the page is read where it is
 * not, except for the year, where the page wins outright. A creation date says when the file
 * was made, which for a paper scanned last week is last week, and a year printed on the title
 * page is at least a year somebody meant.
 *
 * The journal is not guessed at. It appears on a title page in a different place in every
 * journal there is, and a container filled in wrongly is a citation that will be printed
 * wrongly; left empty it is a field the preview can say is missing.
 */
export function readPdfMetadata(
  info: PdfInfo,
  firstPage: readonly PdfTextRun[] = [],
  now = new Date(),
): PdfMetadata {
  const lines = toLines(firstPage);
  const pageText = lines.map((line) => line.text).join("\n");
  const sources: Record<PdfMetadataField, MetadataSource> = {
    title: "none",
    authors: "none",
    year: "none",
    doi: "none",
    url: "none",
  };
  const reference: Reference = { ...EMPTY_REFERENCE };

  const fromPage = pageTitle(lines);
  const embeddedTitle = usableTitle(cleaned(info.title));
  let title = "";
  if (embeddedTitle !== null) {
    title = embeddedTitle;
    sources.title = "embedded";
  } else if (fromPage !== null) {
    title = fromPage.text;
    sources.title = "page";
  }

  const embeddedAuthors = cleaned(info.author);
  const listed = embeddedAuthors === null ? [] : splitInfoAuthors(embeddedAuthors);
  const named = listed.filter(plausibleName).map(tidyName);
  if (named.length > 0) {
    reference.authors = named.slice(0, REFERENCE_LIMITS.authors);
    sources.authors = "embedded";
  } else if (fromPage !== null) {
    const read = pageAuthors(lines, fromPage.next);
    if (read.length > 0) {
      reference.authors = read.slice(0, REFERENCE_LIMITS.authors);
      sources.authors = "page";
    }
  }

  const printed = pageYear(pageText, now);
  if (printed !== null) {
    reference.year = printed;
    sources.year = "page";
  } else {
    const stated = Number(PDF_DATE_YEAR.exec(cleaned(info.creationDate) ?? "")?.[1]);
    if (Number.isFinite(stated) && plausibleYear(stated, now)) {
      reference.year = stated;
      sources.year = "embedded";
    }
  }

  // Some publishers put the DOI in Subject or Keywords, and most print it on the page.
  const embeddedDoi = findDoi(`${cleaned(info.subject) ?? ""} ${cleaned(info.keywords) ?? ""}`);
  const printedDoi = findDoi(pageText);
  if (embeddedDoi !== null) {
    reference.doi = embeddedDoi;
    sources.doi = "embedded";
  } else if (printedDoi !== null) {
    reference.doi = printedDoi;
    sources.doi = "page";
  }

  const arxiv = ARXIV_STAMP.exec(pageText)?.[1];
  if (arxiv !== undefined) {
    // The stamp is put there by arXiv itself, so this is the one thing on the page that is not
    // a guess: the file is a preprint and that is where it lives.
    reference.kind = "preprint";
    reference.url = `https://arxiv.org/abs/${arxiv}`;
    sources.url = "page";
  }

  return { title, reference, sources };
}
