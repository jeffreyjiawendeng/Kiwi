import type { CitationStyle } from "./project.js";
import type { Reference } from "./reference.js";

/**
 * Turning a bibliographic record into a citation.
 *
 * A reference stores author names as they were written, because Kiwi refuses to guess at what
 * is a given name and what is a family name when it is only storing the record. Every citation
 * style, however, needs exactly that split. So it is made here, at the moment of formatting,
 * by rules that are written down and testable rather than buried:
 *
 * - A name containing a comma is taken at its word: "van der Berg, Anna" is unambiguous, and
 *   whoever typed the comma has already answered the question.
 * - A name with no comma has its last word treated as the family name, with any lowercase
 *   particles immediately before it, "de", "van der", "bin", attached to it.
 * - A name with no space at all, or one that reads as an organization, is used whole. "World
 *   Health Organization, W. H. O." is not a person and must not be initialised.
 *
 * The comma form is exact. The space form is a documented heuristic that is right for most
 * Western names and wrong for some; the fix is to type a comma, and the interface says so.
 */

export interface PersonName {
  family: string;
  given: string;
  /** Set when the name is not a person: an organization, or a single word. */
  literal: string | null;
}

/** Lowercase particles that belong with the family name rather than the given names. */
const PARTICLES = new Set([
  "de",
  "del",
  "della",
  "der",
  "di",
  "du",
  "la",
  "le",
  "van",
  "von",
  "den",
  "dos",
  "da",
  "bin",
  "ibn",
  "al",
  "ter",
  "ten",
]);

export function parseAuthorName(raw: string): PersonName {
  const value = raw.trim().replace(/\s+/gu, " ");
  if (value === "") return { family: "", given: "", literal: "" };

  const comma = value.indexOf(",");
  if (comma >= 0) {
    const family = value.slice(0, comma).trim();
    const given = value.slice(comma + 1).trim();
    return family === ""
      ? { family: "", given: "", literal: value }
      : { family, given, literal: null };
  }

  const words = value.split(" ");
  // One word is a surname, a handle, or an organization. Any of those is used whole.
  if (words.length < 2) return { family: value, given: "", literal: value };

  let start = words.length - 1;
  while (start > 1 && PARTICLES.has((words[start - 1] ?? "").toLocaleLowerCase())) start -= 1;
  return {
    family: words.slice(start).join(" "),
    given: words.slice(0, start).join(" "),
    literal: null,
  };
}

/** "John Quincy" becomes "J. Q.", what most styles print instead of full given names. */
export function initials(given: string, separator = " "): string {
  return given
    .split(/[\s.]+/u)
    .filter((part) => part !== "")
    .map((part) => `${[...part][0]?.toLocaleUpperCase() ?? ""}.`)
    .join(separator);
}

export interface CitationSegment {
  text: string;
  /** Titles of containers are italic in every style Kiwi supports. */
  italic?: boolean;
}

export function citationText(segments: CitationSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/** IEEE and Nature number their references; the rest name them. */
export function isNumericStyle(style: CitationStyle): boolean {
  return style === "ieee" || style === "nature";
}

function plain(text: string): CitationSegment {
  return { text };
}

function italic(text: string): CitationSegment {
  return { text, italic: true };
}

/** A page range with an en dash, which every style here wants except MLA. */
function pageRange(pages: string | null, dash = "–"): string | null {
  if (pages === null || pages.trim() === "") return null;
  return pages.trim().replace(/\s*[-‒–—]\s*/gu, dash);
}

function doiUrl(reference: Reference): string | null {
  if (reference.doi !== null && reference.doi.trim() !== "")
    return `https://doi.org/${reference.doi.trim()}`;
  return reference.url !== null && reference.url.trim() !== "" ? reference.url.trim() : null;
}

function endsWithTerminator(text: string): boolean {
  return /[.!?]["”]?$/u.test(text.trim());
}

/** Adds a full stop unless the text already ends in one, so titles do not get "..". */
function sentence(text: string): string {
  return endsWithTerminator(text) ? text : `${text}.`;
}

/**
 * Joins names with the conjunction and punctuation a style asks for.
 *
 * Two authors are where the styles disagree: APA, MLA and Chicago put a comma before the
 * conjunction in the reference list ("Vaswani, A., & Shazeer, N."), IEEE and Nature do not.
 * With three or more, everybody uses the serial comma, which falls out of the join.
 */
function joinNames(names: string[], conjunction: string, commaForTwo: boolean): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2)
    return `${names[0] ?? ""}${commaForTwo ? "," : ""} ${conjunction} ${names[1] ?? ""}`;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1] ?? ""}`;
}

const CONJUNCTIONS: Record<CitationStyle, string> = {
  apa: "&",
  nature: "&",
  mla: "and",
  chicago: "and",
  ieee: "and",
};

/** Whether the reference list puts a comma before the conjunction when there are two authors. */
const COMMA_FOR_TWO: Record<CitationStyle, boolean> = {
  apa: true,
  mla: true,
  chicago: true,
  ieee: false,
  nature: false,
};

/**
 * Author names formatted for the reference list.
 *
 * Long author lists are truncated, because a reference list is not a credits roll and every
 * style caps it. The cap differs by style and so does the marker.
 */
function authorList(reference: Reference, style: CitationStyle): string {
  const parsed = reference.authors
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map(parseAuthorName);
  if (parsed.length === 0) return "";

  const format = (name: PersonName, first: boolean): string => {
    if (name.literal !== null) return name.literal;
    switch (style) {
      case "apa":
        return `${name.family}, ${initials(name.given)}`.trim();
      case "nature":
        return `${name.family}, ${initials(name.given, "")}`.trim();
      case "ieee":
        return `${initials(name.given)} ${name.family}`.trim();
      case "mla":
      case "chicago":
        // Only the first author is inverted; the rest read naturally.
        return first
          ? `${name.family}, ${name.given}`.trim().replace(/,$/u, "")
          : `${name.given} ${name.family}`.trim();
    }
  };

  const caps: Record<CitationStyle, number> = {
    apa: 20,
    mla: 2,
    chicago: 10,
    ieee: 6,
    nature: 5,
  };
  const cap = caps[style];
  if (parsed.length > cap) {
    const kept = parsed
      .slice(0, style === "mla" ? 1 : cap)
      .map((name, index) => format(name, index === 0));
    // "et al." rather than a truncated list with no sign that it was truncated.
    return `${kept.join(", ")}, et al.`;
  }
  return joinNames(
    parsed.map((name, index) => format(name, index === 0)),
    CONJUNCTIONS[style],
    COMMA_FOR_TWO[style],
  );
}

export interface CitationInput {
  reference: Reference;
  /** The Paper's title. The reference record deliberately does not duplicate it. */
  title: string;
}

/**
 * One entry in a reference list.
 *
 * Missing fields are skipped rather than printed as blanks: a reference with no volume reads
 * as a reference with no volume, not as one with an empty pair of brackets.
 */
export function formatReferenceEntry(
  input: CitationInput,
  style: CitationStyle,
): CitationSegment[] {
  const { reference, title } = input;
  const authors = authorList(reference, style);
  const year = reference.year === null ? null : String(reference.year);
  const container = reference.container?.trim() ?? "";
  const link = doiUrl(reference);
  const segments: CitationSegment[] = [];

  const push = (text: string): void => {
    if (text !== "") segments.push(plain(text));
  };

  switch (style) {
    case "apa": {
      push(authors === "" ? "" : `${sentence(authors)} `);
      push(year === null ? "(n.d.). " : `(${year}). `);
      push(`${sentence(title)} `);
      if (container !== "") {
        segments.push(italic(container));
        const volume = reference.volume?.trim() ?? "";
        if (volume !== "") {
          segments.push(italic(`, ${volume}`));
          const issue = reference.issue?.trim() ?? "";
          if (issue !== "") push(`(${issue})`);
        }
        const pages = pageRange(reference.pages);
        push(pages === null ? "." : `, ${pages}.`);
        push(" ");
      } else if (reference.publisher !== null && reference.publisher.trim() !== "") {
        push(`${sentence(reference.publisher.trim())} `);
      }
      if (link !== null) push(link);
      break;
    }
    case "mla": {
      push(authors === "" ? "" : `${sentence(authors)} `);
      push(`"${sentence(title)}" `);
      if (container !== "") {
        segments.push(italic(container));
        push(",");
        const volume = reference.volume?.trim() ?? "";
        if (volume !== "") push(` vol. ${volume},`);
        const issue = reference.issue?.trim() ?? "";
        if (issue !== "") push(` no. ${issue},`);
      }
      if (year !== null) push(` ${year},`);
      const pages = pageRange(reference.pages, "-");
      if (pages !== null) push(` pp. ${pages},`);
      // Trim the trailing comma the optional parts leave behind.
      const last = segments[segments.length - 1];
      if (last !== undefined && last.text.endsWith(",")) last.text = `${last.text.slice(0, -1)}.`;
      if (link !== null) push(` ${link}.`);
      break;
    }
    case "chicago": {
      push(authors === "" ? "" : `${sentence(authors)} `);
      push(year === null ? "n.d. " : `${year}. `);
      push(`"${sentence(title)}" `);
      if (container !== "") {
        segments.push(italic(container));
        const volume = reference.volume?.trim() ?? "";
        if (volume !== "") push(` ${volume}`);
        const issue = reference.issue?.trim() ?? "";
        if (issue !== "") push(` (${issue})`);
        const pages = pageRange(reference.pages);
        push(pages === null ? "." : `: ${pages}.`);
      } else if (reference.publisher !== null && reference.publisher.trim() !== "") {
        push(`${sentence(reference.publisher.trim())}`);
      }
      if (link !== null) push(` ${link}.`);
      break;
    }
    case "ieee": {
      push(authors === "" ? "" : `${authors}, `);
      push(`"${title.replace(/\.$/u, "")}," `);
      if (container !== "") {
        segments.push(italic(container));
        push(", ");
      }
      const volume = reference.volume?.trim() ?? "";
      if (volume !== "") push(`vol. ${volume}, `);
      const issue = reference.issue?.trim() ?? "";
      if (issue !== "") push(`no. ${issue}, `);
      const pages = pageRange(reference.pages);
      if (pages !== null) push(`pp. ${pages}, `);
      push(year === null ? "n.d." : year);
      push(".");
      if (link !== null) push(` ${link}`);
      break;
    }
    case "nature": {
      push(authors === "" ? "" : `${authors} `);
      push(`${sentence(title)} `);
      if (container !== "") {
        segments.push(italic(container));
        const volume = reference.volume?.trim() ?? "";
        if (volume !== "") segments.push(italic(` ${volume}`));
        const pages = pageRange(reference.pages);
        push(pages === null ? "" : `, ${pages}`);
        push(" ");
      }
      if (year !== null) push(`(${year}).`);
      if (link !== null) push(` ${link}`);
      break;
    }
  }

  // A trailing space is invisible in a browser and visible in a LaTeX bibliography.
  const trimmed = segments.filter((segment) => segment.text !== "");
  const final = trimmed[trimmed.length - 1];
  if (final !== undefined) final.text = final.text.replace(/\s+$/u, "");
  return trimmed;
}

export interface InTextOptions {
  /** Where in the work, when the reader gave one: "p. 45", "ch. 2". */
  locator?: string | undefined;
  /** One-based position in the reference list. Required by the numeric styles. */
  number?: number | undefined;
}

/** The short form that appears in the running text. */
export function formatInTextCitation(
  input: CitationInput,
  style: CitationStyle,
  options: InTextOptions = {},
): string {
  if (isNumericStyle(style)) {
    const number = options.number ?? 1;
    return style === "ieee" ? `[${String(number)}]` : `[${String(number)}]`;
  }

  const parsed = input.reference.authors
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map(parseAuthorName);
  const families = parsed.map((name) => name.literal ?? name.family);
  const names =
    families.length === 0
      ? input.title
      : families.length > 3
        ? `${families[0] ?? ""} et al.`
        : joinNames(families, CONJUNCTIONS[style], false);
  const year = input.reference.year === null ? "n.d." : String(input.reference.year);
  const locator = options.locator?.trim();

  if (style === "mla") {
    // MLA cites a place in the work, not a year.
    return locator === undefined || locator === ""
      ? `(${names})`
      : `(${names} ${locator.replace(/^p+\.\s*/iu, "")})`;
  }
  const tail = locator === undefined || locator === "" ? "" : `, ${locator}`;
  return `(${names}, ${year}${tail})`;
}

/**
 * The order a reference list is printed in.
 *
 * Numeric styles list works in the order they were first cited, because that is what the
 * numbers mean. The rest sort by author and year.
 */
export function orderBibliography(
  works: Array<CitationInput & { id: string }>,
  style: CitationStyle,
  citedOrder: string[],
): Array<CitationInput & { id: string; number: number }> {
  const ordered = isNumericStyle(style)
    ? [...works].sort((left, right) => {
        const leftAt = citedOrder.indexOf(left.id);
        const rightAt = citedOrder.indexOf(right.id);
        // Anything never cited sinks below everything that was.
        return (
          (leftAt < 0 ? Number.MAX_SAFE_INTEGER : leftAt) -
          (rightAt < 0 ? Number.MAX_SAFE_INTEGER : rightAt)
        );
      })
    : [...works].sort((left, right) => {
        const key = (work: CitationInput): string => {
          const first = work.reference.authors[0];
          const name = first === undefined ? work.title : parseAuthorName(first);
          const family = typeof name === "string" ? name : (name.literal ?? name.family);
          return `${family.toLocaleLowerCase()} ${String(work.reference.year ?? 9999)}`;
        };
        return key(left).localeCompare(key(right));
      });
  return ordered.map((work, index) => ({ ...work, number: index + 1 }));
}
