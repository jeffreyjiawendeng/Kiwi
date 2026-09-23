/**
 * The sections of a manuscript nobody has open, and where a passage sent to one of them lands.
 *
 * A section is a heading and everything under it up to the next heading of the same or higher
 * level. The outline beside the editor says the same thing, but it says it in the editor's own
 * positions, and a passage sent from the Reader has to find its section in the manuscript as it
 * is stored: a node tree in the rich mode, a buffer of source in LaTeX. This is the stored-form
 * answer, and both halves of a send use it, the chooser that lists the sections and the command
 * that writes into one, so the section somebody picked is the section that gets written to.
 *
 * A section is named rather than numbered. A position moves the moment somebody adds a paragraph
 * above it, and a send that arrived a second later would land somewhere else; the name is what
 * the person choosing it read.
 */

import {
  documentText,
  isRichDocument,
  type DocumentMode,
  type DocumentNode,
  type RichDocument,
} from "./document.js";

/** One section of a manuscript, and the end of what it covers. */
export interface ManuscriptSection {
  title: string;
  level: number;
  /**
   * Where a passage sent here is written: the index of the block it becomes in a rich
   * manuscript, and an offset into the source in a LaTeX one. The end and not the start,
   * because a section is written down the page and new material joins the bottom of it.
   */
  end: number;
}

/** A heading level a manuscript can actually have, with anything else read as the top one. */
function headingLevel(node: DocumentNode): number {
  const level = node.attrs?.["level"];
  return typeof level === "number" && level >= 1 && level <= 6 ? level : 1;
}

/** The sections of a rich manuscript, counted in top-level blocks. */
export function richSections(document: unknown): ManuscriptSection[] {
  if (!isRichDocument(document)) return [];
  const blocks = document.content;
  const sections: ManuscriptSection[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "heading") continue;
    const level = headingLevel(block);
    const next = blocks.findIndex(
      (later, at) => at > index && later.type === "heading" && headingLevel(later) <= level,
    );
    sections.push({
      title: documentText(block).trim(),
      level,
      end: next === -1 ? blocks.length : next,
    });
  }
  return sections;
}

/** Which sectioning commands count, and what they are worth. */
const LATEX_LEVELS: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3 };

/** A sectioning command, up to and including the brace its title opens with. */
const LATEX_HEADING = /\\(subsubsection|subsection|section)\*?\s*(?:\[[^\]]*\])?\s*\{/gu;

/**
 * Whether the position sits after a comment marker on its own line.
 *
 * A commented-out `\section` is a line a writer has already decided is not part of the paper, and
 * an outline that lists it sends them to a line that is not there.
 */
function isCommentedOut(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf("\n", at) + 1;
  for (let index = lineStart; index < at; index += 1) {
    // An escaped percent sign is a percent sign in the text, not the start of a comment.
    if (source[index] === "\\") index += 1;
    else if (source[index] === "%") return true;
  }
  return false;
}

/** Where the brace opened at this position closes, or null when it never does. */
function matchBrace(source: string, open: number): number | null {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") index += 1;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

/** A title as a person reads it, with the commands that dressed it up taken off. */
function plainTitle(latex: string): string {
  return latex
    .replaceAll(/\\[a-zA-Z]+\s*/gu, "")
    .replaceAll(/[{}]/gu, "")
    .trim();
}

/** One sectioning command in a LaTeX source. */
export interface LatexHeading {
  level: number;
  title: string;
  /** Where the sectioning command begins. */
  from: number;
  /** Just past the brace its title closes with. */
  to: number;
}

/**
 * Every sectioning command in a LaTeX source, in the order they are written.
 *
 * One scanner, because a manuscript that is outlined one way and written into another way would
 * put a passage under a heading the writer did not choose.
 */
export function latexHeadings(source: string): LatexHeading[] {
  const headings: LatexHeading[] = [];
  const pattern = new RegExp(LATEX_HEADING.source, "gu");
  for (let found = pattern.exec(source); found !== null; found = pattern.exec(source)) {
    const start = found.index;
    if (isCommentedOut(source, start)) continue;
    const open = start + found[0].length - 1;
    const close = matchBrace(source, open);
    // A title whose brace never closes is source that is still being typed.
    if (close === null) continue;
    headings.push({
      level: LATEX_LEVELS[found[1] ?? "section"] ?? 1,
      title: plainTitle(source.slice(open + 1, close)),
      from: start,
      to: close + 1,
    });
    pattern.lastIndex = close + 1;
  }
  return headings;
}

/** The sections of a LaTeX manuscript, counted in characters of source. */
export function latexSections(source: string): ManuscriptSection[] {
  const headings = latexHeadings(source);
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((later) => later.level <= heading.level);
    return { title: heading.title, level: heading.level, end: next?.from ?? source.length };
  });
}

/** The sections of a manuscript, whichever way it is written. */
export function manuscriptSections(
  mode: DocumentMode,
  document: unknown,
  source: string,
): ManuscriptSection[] {
  return mode === "latex" ? latexSections(source) : richSections(document);
}

/** The end of the whole manuscript, for a passage sent to no section in particular. */
export function endOfManuscript(mode: DocumentMode, document: unknown, source: string): number {
  if (mode === "latex") return source.length;
  return isRichDocument(document) ? document.content.length : 0;
}

/**
 * The section with this heading, or null when the manuscript no longer has one.
 *
 * Two sections with the same heading are answered with the first, which is the one a reader
 * counting down the list would have meant. It is a rare enough shape that guessing harder would
 * be guessing.
 */
export function sectionNamed(
  sections: readonly ManuscriptSection[],
  title: string,
): ManuscriptSection | null {
  const wanted = title.trim().normalize("NFC");
  return sections.find((section) => section.title.normalize("NFC") === wanted) ?? null;
}

/** A rich manuscript with blocks put in at a block index. */
export function insertInDocument(
  document: RichDocument,
  at: number,
  blocks: readonly DocumentNode[],
): RichDocument {
  const content = [...document.content];
  content.splice(Math.max(0, Math.min(at, content.length)), 0, ...blocks);
  return { ...document, content };
}

/**
 * A LaTeX source with text put in at an offset.
 *
 * The offset is walked back over whitespace first: the end of a section is the start of the next
 * heading, and text written exactly there would sit against `\section` with no blank line, which
 * is a paragraph break TeX would then not make.
 */
export function insertInSource(source: string, at: number, text: string): string {
  let cut = Math.max(0, Math.min(at, source.length));
  while (cut > 0 && /\s/u.test(source[cut - 1] ?? "")) cut -= 1;
  const before = source.slice(0, cut);
  const after = source.slice(cut);
  const opening = before === "" ? "" : "\n\n";
  // What follows is whatever was between the section and the next heading, which is already the
  // blank line that separated them. Only a heading written against the prose with nothing
  // between needs one supplying.
  const closing = after === "" ? "\n" : after.startsWith("\n") ? after : `\n\n${after}`;
  return `${before}${opening}${text}${closing}`;
}
