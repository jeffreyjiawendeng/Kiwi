import { parseAuthorName } from "./citation.js";
import { parseBibtex, toBibtexFile, type BibtexEntry } from "./bibtex.js";
import { EMPTY_REFERENCE, type Reference, type ReferenceKind } from "./reference.js";

/**
 * The three files a library can leave in.
 *
 * BibTeX is what a journal asks for and what LaTeX reads. RIS is what EndNote, Mendeley and
 * every reference manager that is not Zotero will take. CSV is not a reference format at all:
 * it is for the person who has to put the library in front of a supervisor, a grant office, or
 * a systematic-review spreadsheet, and who needs columns rather than records.
 *
 * All three are written from the same entries, so the choice of format never changes which
 * papers leave, only how they are spelled.
 *
 * RIS is also read here, next to where it is written. It is the format a library arrives in when
 * it did not come from Zotero, and a reader kept beside its writer is a reader that stays honest
 * about the tags: a field added to one is a field the other is missing on the same screen.
 */

export const LIBRARY_EXPORT_FORMATS = ["bibtex", "ris", "csv"] as const;

export type LibraryExportFormat = (typeof LIBRARY_EXPORT_FORMATS)[number];

export function isLibraryExportFormat(value: unknown): value is LibraryExportFormat {
  return typeof value === "string" && LIBRARY_EXPORT_FORMATS.includes(value as LibraryExportFormat);
}

/** RIS's reference types, which are four uppercase letters and not negotiable. */
const KIND_TO_RIS: Record<ReferenceKind, string> = {
  article: "JOUR",
  preprint: "UNPB",
  book: "BOOK",
  chapter: "CHAP",
  conference: "CPAPER",
  thesis: "THES",
  report: "RPRT",
  dataset: "DATA",
  software: "COMP",
  webpage: "ELEC",
  other: "GEN",
};

/**
 * RIS is line-oriented and fussy about it: a tag, two spaces, a hyphen, a space, the value.
 * A reader that splits on a fixed column will take nothing else.
 */
function risLine(tag: string, value: string | null): string[] {
  if (value === null) return [];
  const text = value.replace(/[\r\n]+/gu, " ").trim();
  return text === "" ? [] : [`${tag}  - ${text}`];
}

/** RIS wants "Family, Given", which is the one place Kiwi has to take a name apart. */
function risAuthor(raw: string): string {
  const name = parseAuthorName(raw);
  if (name.literal !== null && name.literal !== "") return name.literal;
  return name.given === "" ? name.family : `${name.family}, ${name.given}`;
}

export function toRis(entry: BibtexEntry): string {
  const { reference } = entry;
  const lines = [
    ...risLine("TY", KIND_TO_RIS[reference.kind]),
    ...risLine("ID", entry.key),
    ...risLine("TI", entry.title),
    ...reference.authors.flatMap((author) => risLine("AU", risAuthor(author))),
    ...risLine("T2", reference.container),
    ...risLine("PY", reference.year === null ? null : String(reference.year)),
    ...risLine("VL", reference.volume),
    ...risLine("IS", reference.issue),
  ];

  // A page range is two fields in RIS. A single page is a start page with no end.
  const pages = reference.pages?.trim() ?? "";
  const range = /^([^\s-]+)\s*-{1,2}\s*([^\s-]+)$/u.exec(pages);
  if (range === null) lines.push(...risLine("SP", pages));
  else lines.push(...risLine("SP", range[1] ?? null), ...risLine("EP", range[2] ?? null));

  lines.push(
    ...risLine("PB", reference.publisher),
    ...risLine("DO", reference.doi),
    ...risLine("UR", reference.url),
    ...risLine("AB", reference.abstract),
    // Every record ends with an empty ER tag. A reader that does not see one drops the record.
    "ER  - ",
  );
  return lines.join("\r\n");
}

export function toRisFile(entries: BibtexEntry[]): string {
  return entries.map((entry) => `${toRis(entry)}\r\n\r\n`).join("");
}

/**
 * What RIS calls a kind of work, and what Kiwi calls it back.
 *
 * Wider than the table that writes RIS, because reading has to take what other programs emit and
 * writing only has to produce one spelling of each. A type this does not know becomes `other`
 * rather than costing the record: the type is the least of what a reference carries.
 */
const RIS_TO_KIND: Record<string, ReferenceKind> = {
  JOUR: "article",
  EJOUR: "article",
  ABST: "article",
  MGZN: "article",
  NEWS: "article",
  UNPB: "preprint",
  INPR: "preprint",
  BOOK: "book",
  EBOOK: "book",
  EDBOOK: "book",
  CHAP: "chapter",
  ECHAP: "chapter",
  CONF: "conference",
  CPAPER: "conference",
  THES: "thesis",
  RPRT: "report",
  DATA: "dataset",
  COMP: "software",
  ELEC: "webpage",
  ICOMM: "webpage",
  GEN: "other",
};

/**
 * Written strictly, read loosely.
 *
 * The specification says a tag, two spaces, a hyphen, a space, and `toRis` writes exactly that.
 * Real files hand over `TY - JOUR` and `TY  -JOUR` as well, and refusing those would mean
 * refusing files that every other reference manager opens.
 */
const RIS_TAG = /^([A-Z][A-Z0-9])\s{0,3}-\s?(.*)$/u;

/** Reads one record's tags into an entry, or nothing when the record carried nothing. */
function risEntry(tags: Map<string, string[]>): BibtexEntry | null {
  const first = (...names: string[]): string | null => {
    for (const name of names) {
      const value = tags.get(name)?.find((text) => text !== "");
      if (value !== undefined) return value;
    }
    return null;
  };

  // A record with nothing but its type names no work. It is skipped the way a malformed BibTeX
  // entry is: one unreadable record costs that record, never the file it arrived in.
  if ([...tags.keys()].every((tag) => tag === "TY")) return null;

  // `BT` is the title of a book and the container of a chapter in it, and which one it is here
  // depends on whether a title was given separately.
  const named = first("TI", "T1", "CT");
  const title = named ?? first("BT") ?? "";
  const container = first("T2", "JO", "JF", "JA", "J2") ?? (named === null ? null : first("BT"));

  // `A1` is the primary author under an older spelling. `A2` and `A3` are editors and translators,
  // which are not authors, and taking them would put a book's editor in front of its writer.
  const authors = ["AU", "A1"].flatMap((tag) => tags.get(tag) ?? []).filter((name) => name !== "");

  // A date tag may be a bare year, or `2017/06/12/` with the parts nobody filled in left empty.
  const year = /\d{4}/u.exec(first("PY", "Y1", "DA") ?? "")?.[0];

  const start = first("SP");
  const end = first("EP");

  return {
    // No `ID` is not a broken record: the key is Kiwi's to assign, and `bibtexKey` assigns it.
    key: first("ID") ?? "",
    title: title === "" ? "Untitled" : title,
    reference: {
      ...EMPTY_REFERENCE,
      kind: RIS_TO_KIND[first("TY") ?? ""] ?? "other",
      authors,
      container,
      year: year === undefined ? null : Number.parseInt(year, 10),
      volume: first("VL"),
      issue: first("IS", "CP"),
      pages: start === null ? null : end === null ? start : `${start}-${end}`,
      publisher: first("PB"),
      doi: first("DO", "DOI"),
      url: first("UR"),
      abstract: first("AB", "N2"),
    },
  };
}

/**
 * Reads every record a `.ris` file holds, skipping what it cannot understand.
 *
 * The same forgiving stance the BibTeX parser takes, for the same reason: a library of four
 * hundred references with one broken record should import three hundred and ninety-nine. So a
 * record without its `ER` terminator is still a record, an unknown tag is ignored rather than
 * fatal, and a line that is not a tag at all continues the one above it, which is how a long
 * abstract survives having been wrapped.
 */
export function parseRis(source: string): BibtexEntry[] {
  const entries: BibtexEntry[] = [];
  let tags = new Map<string, string[]>();
  let open = false;
  let previous: { tag: string; index: number } | null = null;

  const finish = (): void => {
    const entry = risEntry(tags);
    if (entry !== null) entries.push(entry);
    tags = new Map<string, string[]>();
    open = false;
    previous = null;
  };

  for (const line of source.split(/\r\n|\r|\n/u)) {
    const match = RIS_TAG.exec(line);

    if (match === null) {
      const text = line.trim();
      if (!open || previous === null || text === "") continue;
      const values = tags.get(previous.tag);
      const held = values?.[previous.index];
      if (values !== undefined && held !== undefined) values[previous.index] = `${held} ${text}`;
      continue;
    }

    const tag = match[1] ?? "";
    const value = (match[2] ?? "").trim();

    if (tag === "TY") {
      // A second `TY` before an `ER` is a writer that forgot the terminator, not a field of the
      // record above. What was read so far is kept and the next record begins here.
      if (open) finish();
      open = true;
    }
    // Anything before the first `TY` is a header, a note, or somebody's covering line.
    if (!open) continue;
    if (tag === "ER") {
      finish();
      continue;
    }

    const values = tags.get(tag) ?? [];
    values.push(value);
    tags.set(tag, values);
    previous = { tag, index: values.length - 1 };
  }

  // A file whose last record ran out before its terminator still ends with a record in hand.
  if (open) finish();
  return entries;
}

/**
 * Reads a reference file without being told which kind it is.
 *
 * A RIS record opens with a type tag and a BibTeX entry opens with an `@`, so whichever comes
 * first is what the file is. That is steadier than trusting the name it was saved under: an
 * export off an older EndNote arrives as `.txt` and is RIS inside, and a file dragged onto the
 * window has whatever extension the person who sent it happened to use.
 */
export function parseReferenceFile(source: string): BibtexEntry[] {
  const ris = /^[ \t]*TY\s{0,3}-/mu.exec(source)?.index ?? -1;
  const bibtex = /@\w+\s*\{/u.exec(source)?.index ?? -1;
  if (ris === -1) return parseBibtex(source);
  if (bibtex === -1) return parseRis(source);
  return ris < bibtex ? parseRis(source) : parseBibtex(source);
}

const CSV_COLUMNS = [
  "key",
  "title",
  "authors",
  "kind",
  "container",
  "year",
  "volume",
  "issue",
  "pages",
  "publisher",
  "doi",
  "url",
  "abstract",
] as const;

/**
 * One cell.
 *
 * Quoted whenever a comma, a quote, or a line break would otherwise end the field early, and
 * quotes inside are doubled, which is the whole of RFC 4180's escaping.
 *
 * A cell that opens with `=`, `+` or `@` is prefixed with an apostrophe. A title beginning with
 * one of those is a formula to a spreadsheet, and a library export should not hand somebody a
 * file that computes something when they open it.
 */
function csvCell(value: string): string {
  const guarded = /^[=+@]/u.test(value) ? `'${value}` : value;
  return /["\n\r,]/u.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

function csvValue(reference: Reference, column: (typeof CSV_COLUMNS)[number]): string | null {
  switch (column) {
    case "authors":
      return reference.authors.join("; ");
    case "kind":
      return reference.kind;
    case "year":
      return reference.year === null ? null : String(reference.year);
    case "key":
    case "title":
      return null;
    default:
      return reference[column];
  }
}

/**
 * Built from its code point rather than typed, because the character is invisible and an
 * invisible character in a source file is one somebody deletes by accident.
 */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/**
 * The library as a spreadsheet.
 *
 * Written with a byte order mark and CRLF line endings because the program that opens this is
 * Excel, and Excel without the mark reads UTF-8 as the local codepage and turns every accented
 * author name into mojibake.
 */
export function toReferenceCsv(entries: BibtexEntry[]): string {
  const rows = [csvRow(CSV_COLUMNS)];
  for (const entry of entries) {
    rows.push(
      csvRow(
        CSV_COLUMNS.map((column) => {
          if (column === "key") return entry.key;
          if (column === "title") return entry.title;
          return csvValue(entry.reference, column) ?? "";
        }),
      ),
    );
  }
  return `${BYTE_ORDER_MARK}${rows.join("\r\n")}\r\n`;
}

export interface LibraryExportFile {
  text: string;
  /** Without the dot, so it can be handed straight to a save dialog's filter. */
  extension: string;
  mediaType: string;
}

export function libraryExportFile(
  format: LibraryExportFormat,
  entries: BibtexEntry[],
): LibraryExportFile {
  if (format === "ris")
    return {
      text: toRisFile(entries),
      extension: "ris",
      mediaType: "application/x-research-info-systems",
    };
  if (format === "csv")
    return { text: toReferenceCsv(entries), extension: "csv", mediaType: "text/csv" };
  return { text: toBibtexFile(entries), extension: "bib", mediaType: "application/x-bibtex" };
}
