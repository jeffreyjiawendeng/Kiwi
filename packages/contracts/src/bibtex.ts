import { parseAuthorName } from "./citation.js";
import { EMPTY_REFERENCE, type Reference, type ReferenceKind } from "./reference.js";

/**
 * BibTeX, in and out.
 *
 * This is how an existing library moves. Somebody with ten years of Zotero behind them will
 * not retype it, and somebody submitting to a journal will be asked for a `.bib` file. Both
 * directions matter, and neither is allowed to lose a field the other could have carried.
 *
 * The parser is deliberately forgiving. A `.bib` file in the wild is whatever the tool that
 * wrote it produced: unquoted numbers, nested braces, comments, `@string` definitions, fields
 * in any order. Refusing the whole file over one unrecognised entry would make the feature
 * useless for exactly the libraries it exists to import.
 */

/** BibTeX's entry types, and what Kiwi calls each of them. */
const TYPE_TO_KIND: Record<string, ReferenceKind> = {
  article: "article",
  inproceedings: "conference",
  conference: "conference",
  proceedings: "conference",
  book: "book",
  inbook: "chapter",
  incollection: "chapter",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  techreport: "report",
  misc: "other",
  unpublished: "preprint",
  online: "webpage",
  electronic: "webpage",
  dataset: "dataset",
  software: "software",
};

const KIND_TO_TYPE: Record<ReferenceKind, string> = {
  article: "article",
  preprint: "unpublished",
  book: "book",
  chapter: "incollection",
  conference: "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  dataset: "dataset",
  software: "software",
  webpage: "online",
  other: "misc",
};

export interface BibtexEntry {
  key: string;
  title: string;
  reference: Reference;
}

/**
 * A citation key, built from the first author and the year.
 *
 * Kept stable and readable because it is what appears in a LaTeX source, where a key of
 * `ref17` tells the author nothing about what they just cited.
 */
export function bibtexKey(
  entry: { title: string; reference: Reference },
  taken: Set<string>,
): string {
  const first = entry.reference.authors[0];
  const name = first === undefined ? "" : parseAuthorName(first);
  const family = name === "" ? "" : (name.literal ?? name.family);
  const word =
    family.replace(/[^A-Za-z]/gu, "") ||
    entry.title.split(/\s+/u)[0]?.replace(/[^A-Za-z]/gu, "") ||
    "ref";
  const base = `${word.toLocaleLowerCase()}${entry.reference.year ?? ""}`;
  if (!taken.has(base)) return base;
  // Two papers by the same author in the same year get a, b, c, the convention every
  // bibliography already uses for exactly this.
  for (const suffix of "abcdefghijklmnopqrstuvwxyz") {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${String(taken.size)}`;
}

/** Braces protect capitals that a style would otherwise lower-case. */
function protect(value: string): string {
  return value.replace(/[{}]/gu, "");
}

export function toBibtex(entry: BibtexEntry): string {
  const { reference } = entry;
  const fields: Array<[string, string]> = [];
  const add = (name: string, value: string | null): void => {
    if (value !== null && value.trim() !== "") fields.push([name, protect(value.trim())]);
  };

  add("title", entry.title);
  if (reference.authors.length > 0) add("author", reference.authors.join(" and "));
  // A journal and a book series are the same field in Kiwi and different ones in BibTeX.
  const containerField =
    reference.kind === "article" || reference.kind === "preprint"
      ? "journal"
      : reference.kind === "conference"
        ? "booktitle"
        : reference.kind === "chapter"
          ? "booktitle"
          : "howpublished";
  add(containerField, reference.container);
  add("year", reference.year === null ? null : String(reference.year));
  add("volume", reference.volume);
  add("number", reference.issue);
  add("pages", reference.pages);
  add("publisher", reference.publisher);
  add("doi", reference.doi);
  add("url", reference.url);
  add("abstract", reference.abstract);

  const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(",\n");
  return `@${KIND_TO_TYPE[reference.kind]}{${entry.key},\n${body}\n}`;
}

export function toBibtexFile(entries: BibtexEntry[]): string {
  return entries.map(toBibtex).join("\n\n") + "\n";
}

/** Reads a braced or quoted value, counting nesting so `{The {DNA} Helix}` survives. */
function readValue(source: string, start: number): { value: string; next: number } {
  let index = start;
  while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
  const opener = source[index];

  if (opener === "{" || opener === '"') {
    const closer = opener === "{" ? "}" : '"';
    let depth = 0;
    let value = "";
    for (index += 1; index < source.length; index += 1) {
      const character = source[index] ?? "";
      if (opener === "{" && character === "{") depth += 1;
      else if (character === closer) {
        if (depth === 0) return { value, next: index + 1 };
        depth -= 1;
      }
      value += character;
    }
    return { value, next: index };
  }

  // An unbraced value: a number, or a @string name this parser does not resolve.
  let value = "";
  while (index < source.length && !/[,}]/u.test(source[index] ?? "")) {
    value += source[index] ?? "";
    index += 1;
  }
  return { value: value.trim(), next: index };
}

function unwrap(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[{}]/gu, "").trim();
}

/**
 * Reads every entry a `.bib` file holds, skipping what it cannot understand.
 *
 * One malformed entry costs that entry, not the file. A library of four hundred references
 * with one broken record should import three hundred and ninety-nine.
 */
export function parseBibtex(source: string): BibtexEntry[] {
  const entries: BibtexEntry[] = [];
  const pattern = /@(\w+)\s*\{\s*([^,\s}]*)\s*,/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const type = (match[1] ?? "").toLocaleLowerCase();
    // @string, @preamble and @comment are not references.
    if (type === "string" || type === "preamble" || type === "comment") continue;

    const key = match[2] ?? "";
    const fields = new Map<string, string>();
    let index = pattern.lastIndex;
    let depth = 0;

    while (index < source.length) {
      const character = source[index] ?? "";
      if (character === "}" && depth === 0) break;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      const name = /^\s*([A-Za-z][\w-]*)\s*=/u.exec(source.slice(index));
      if (name === null) {
        index += 1;
        continue;
      }
      const read = readValue(source, index + name[0].length);
      fields.set((name[1] ?? "").toLocaleLowerCase(), unwrap(read.value));
      index = read.next;
    }
    pattern.lastIndex = index;

    const title = fields.get("title") ?? "";
    if (title === "" && fields.size === 0) continue;
    const year = Number.parseInt(fields.get("year") ?? "", 10);
    const authors = (fields.get("author") ?? "")
      .split(/\s+and\s+/iu)
      .map((name) => name.trim())
      .filter((name) => name !== "");

    entries.push({
      key,
      title: title === "" ? "Untitled" : title,
      reference: {
        ...EMPTY_REFERENCE,
        kind: TYPE_TO_KIND[type] ?? "other",
        authors,
        container:
          fields.get("journal") ?? fields.get("booktitle") ?? fields.get("howpublished") ?? null,
        year: Number.isSafeInteger(year) ? year : null,
        volume: fields.get("volume") ?? null,
        issue: fields.get("number") ?? null,
        pages: fields.get("pages")?.replace(/--/gu, "-") ?? null,
        publisher: fields.get("publisher") ?? fields.get("school") ?? null,
        doi: fields.get("doi") ?? null,
        url: fields.get("url") ?? null,
        abstract: fields.get("abstract") ?? null,
      },
    });
  }
  return entries;
}
