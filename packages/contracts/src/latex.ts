import {
  CROSS_REFERENCE_NODE,
  crossReferenceLabelName,
  isCrossReferenceKind,
  referencedTargets,
  type CrossReferenceKind,
} from "./crossref.js";
import { isDocumentNode, type DocumentNode } from "./document.js";
import { MENTION_NODE, mentionNodeText } from "./mention.js";
import { QUOTATION_NODE, quotationNodeText } from "./quotation.js";

/**
 * LaTeX: the engines, the log, and turning a rich document into source.
 *
 * Both writing modes reach a PDF through the same compiler. A LaTeX manuscript is already
 * source; a rich one is converted here. The conversion is deliberately one-way, it exists so
 * a paper written in the rich editor can be typeset, not so the two modes can be swapped.
 */

/**
 * `lualatex` is the default: Unicode input and system fonts work without ceremony, and it is
 * where TeX development actually happens now. `pdflatex` is kept because a decade of journal
 * templates assume it, and `xelatex` because some font work still needs it.
 */
export const LATEX_ENGINES = ["lualatex", "pdflatex", "xelatex"] as const;
export type LatexEngine = (typeof LATEX_ENGINES)[number];
export const DEFAULT_LATEX_ENGINE: LatexEngine = "lualatex";

export function isLatexEngine(value: unknown): value is LatexEngine {
  return typeof value === "string" && (LATEX_ENGINES as readonly string[]).includes(value);
}

export interface LatexProblem {
  severity: "error" | "warning";
  /** The source file the engine named, when it named one. */
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileRequest {
  /** The complete document source. */
  source: string;
  engine: LatexEngine;
  /** Files the source refers to, by the name it uses for them. */
  files: Array<{ name: string; asset_id: string }>;
}

export const COMPILE_LIMITS = {
  source: 4_000_000,
  files: 200,
  /** A compile that has not finished by now is looping on a broken document. */
  timeoutSeconds: 120,
} as const;

/** Characters that mean something to TeX and must be written differently to appear as text. */
const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Escapes text for LaTeX.
 *
 * This is the part that has to be right. An unescaped `%` comments out the rest of the line,
 * so a sentence containing "50% of samples" silently deletes everything after it, the paper
 * still compiles, and the missing half is only noticed by reading the PDF.
 */
export function escapeLatex(text: string): string {
  let out = "";
  for (const character of text) out += ESCAPES[character] ?? character;
  return out;
}

function marksOf(node: DocumentNode): string[] {
  return (node.marks ?? []).map((mark) => mark.type);
}

function wrapMarks(text: string, marks: string[]): string {
  let out = text;
  // Applied innermost first so nesting reads the way it was written.
  if (marks.includes("code")) out = `\\texttt{${out}}`;
  if (marks.includes("superscript")) out = `\\textsuperscript{${out}}`;
  if (marks.includes("subscript")) out = `\\textsubscript{${out}}`;
  if (marks.includes("underline")) out = `\\underline{${out}}`;
  if (marks.includes("strike")) out = `\\sout{${out}}`;
  if (marks.includes("italic") || marks.includes("em")) out = `\\textit{${out}}`;
  if (marks.includes("bold") || marks.includes("strong")) out = `\\textbf{${out}}`;
  return out;
}

const HEADINGS = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];

/** How a reference to each kind is worded, so the source reads as the editor did. */
const REFERENCE_WORDS: Record<CrossReferenceKind, string> = {
  figure: "Figure",
  table: "Table",
  section: "Section",
  equation: "Equation",
};

/**
 * The ids something in the document refers to.
 *
 * Carried through the conversion because whether a target needs a `\label` is not a local fact:
 * an equation is written `\[...\]` unless a sentence somewhere else in the paper points at it,
 * in which case it has to become a numbered `equation` to have a number to point at.
 */
type Labelled = ReadonlySet<string>;

/** The `\label` a target carries, or the empty string when nothing refers to it. */
function labelFor(node: DocumentNode, labelled: Labelled): string {
  const id = String(node.attrs?.["kiwiId"] ?? "");
  if (id === "" || !labelled.has(id)) return "";
  return `\\label{${crossReferenceLabelName(id)}}`;
}

function childrenToLatex(node: DocumentNode, depth: number, labelled: Labelled): string {
  return (node.content ?? []).map((child) => nodeToLatex(child, depth + 1, labelled)).join("");
}

function nodeToLatex(node: DocumentNode, depth: number, labelled: Labelled): string {
  if (!isDocumentNode(node) || depth > 32) return "";
  switch (node.type) {
    case "text":
      return wrapMarks(escapeLatex(node.text ?? ""), marksOf(node));
    case "hardBreak":
      return "\\\\\n";
    case "paragraph": {
      const body = childrenToLatex(node, depth, labelled);
      return body.trim() === "" ? "" : `${body}\n\n`;
    }
    case "heading": {
      const level = Number((node.attrs?.["level"] as number | undefined) ?? 1);
      const command = HEADINGS[Math.min(Math.max(level, 1), HEADINGS.length) - 1] ?? "section";
      // The label goes after the heading rather than inside it: `\label` inside `\section{}`
      // ends up in the table of contents and in the running head.
      return `\\${command}{${childrenToLatex(node, depth, labelled)}}${labelFor(node, labelled)}\n\n`;
    }
    case "bulletList":
      return `\\begin{itemize}\n${childrenToLatex(node, depth, labelled)}\\end{itemize}\n\n`;
    case "orderedList":
      return `\\begin{enumerate}\n${childrenToLatex(node, depth, labelled)}\\end{enumerate}\n\n`;
    case "listItem":
      return `  \\item ${childrenToLatex(node, depth, labelled).trim()}\n`;
    case "blockquote":
      return `\\begin{quote}\n${childrenToLatex(node, depth, labelled)}\\end{quote}\n\n`;
    case "codeBlock":
      return `\\begin{verbatim}\n${(node.content ?? []).map((child) => child.text ?? "").join("")}\n\\end{verbatim}\n\n`;
    case "horizontalRule":
      return "\\par\\noindent\\hrulefill\\par\n\n";
    case "citation": {
      // The key rather than the formatted text: LaTeX formats citations itself, from the
      // bibliography, and a pre-formatted one would be frozen at whatever style was current
      // when it was typed.
      const key = String(node.attrs?.["key"] ?? "");
      if (key === "") return "";
      const locator = String(node.attrs?.["locator"] ?? "").trim();
      return locator === "" ? `\\cite{${key}}` : `\\cite[${escapeLatex(locator)}]{${key}}`;
    }
    case CROSS_REFERENCE_NODE: {
      // `\ref` prints the number and nothing else, so the word in front of it is written here.
      // It is the word the editor showed, which is the point: what was read while writing and
      // what is read in the PDF have to be the same sentence. The tie rather than a space, so a
      // line never breaks between "Figure" and its number.
      const target = String(node.attrs?.["target"] ?? "");
      if (target === "") return "";
      const kind = String(node.attrs?.["kind"] ?? "");
      const reference = `\\ref{${crossReferenceLabelName(target)}}`;
      return isCrossReferenceKind(kind) ? `${REFERENCE_WORDS[kind]}~${reference}` : reference;
    }
    case MENTION_NODE:
      // The name, as prose. A mention is a way of getting somewhere inside Kiwi, and there is
      // nowhere to get to in a PDF, so what survives the conversion is the sentence the mention
      // was read as while it was written.
      return escapeLatex(mentionNodeText(node));
    case QUOTATION_NODE:
      // The line as it reads, for the same reason. The draft still has to say where a passage
      // came from; turning it into a citation is a decision the writer makes with the
      // bibliography in front of them, and not one this conversion should make for them.
      return escapeLatex(quotationNodeText(node));
    case "mathInline":
      return `$${String(node.attrs?.["latex"] ?? "")}$`;
    case "mathBlock": {
      const latex = String(node.attrs?.["latex"] ?? "");
      const label = labelFor(node, labelled);
      // Unnumbered until something refers to it. `\[...\]` is how displayed maths is written
      // when it is not pointed at, and numbering every one of them would put a number down the
      // margin beside every line of algebra in the paper.
      if (label === "") return `\\[\n${latex}\n\\]\n\n`;
      return `\\begin{equation}\n${latex}\n${label}\n\\end{equation}\n\n`;
    }
    case "image": {
      const source = String(node.attrs?.["src"] ?? "");
      const caption = String(node.attrs?.["alt"] ?? "");
      const name = latexFileName(source);
      if (name === null) return "";
      const body = `  \\centering\n  \\includegraphics[width=\\linewidth]{${name}}\n`;
      // After the caption, because `\label` takes its number from the last counter stepped and
      // it is `\caption` that steps the figure counter. A referenced figure with no caption is
      // given an empty one for the same reason: without it there is no number to refer to.
      const label = labelFor(node, labelled);
      const captioned = caption !== "" || label !== "";
      const captionLine = captioned ? `  \\caption{${escapeLatex(caption)}}\n` : "";
      const labelLine = label === "" ? "" : `  ${label}\n`;
      return `\\begin{figure}[htbp]\n${body}${captionLine}${labelLine}\\end{figure}\n\n`;
    }
    case "table": {
      const rows = node.content ?? [];
      const columns = rows[0]?.content?.length ?? 1;
      const spec = Array.from({ length: columns }, () => "l").join(" ");
      const body = rows
        .map((row) =>
          (row.content ?? [])
            .map((cell) =>
              childrenToLatex(cell, depth + 1, labelled)
                .replace(/\n+/gu, " ")
                .trim(),
            )
            .join(" & "),
        )
        .join(" \\\\\n");
      const tabular = `\\begin{tabular}{${spec}}\n${body} \\\\\n\\end{tabular}\n`;
      const label = labelFor(node, labelled);
      // A table nothing points at stays where it was typed. One that is pointed at becomes a
      // float, because that is what carries the table counter the reference reads. The empty
      // caption is not decoration: `\caption` is what steps the counter, and a `\label` without
      // one takes its number from whatever counter moved last, which is the section.
      if (label === "") return `${tabular}\n`;
      return `\\begin{table}[htbp]\n  \\centering\n${tabular}  \\caption{}\n  ${label}\n\\end{table}\n\n`;
    }
    default:
      return childrenToLatex(node, depth, labelled);
  }
}

/**
 * The name a figure has inside the compile bundle.
 *
 * An image in a rich document points at `kiwi-asset://workspace/asset-id`. The compiler sees a
 * flat directory, so the asset id becomes the filename and the bundle carries it under that
 * name.
 */
export function latexFileName(source: string): string | null {
  const match = /^kiwi-asset:\/\/[^/]+\/([^/?#]+)/u.exec(source);
  const id = match?.[1];
  if (id === undefined) return null;
  return `figure-${decodeURIComponent(id).replace(/[^A-Za-z0-9-]/gu, "")}`;
}

/** Every asset a rich document refers to, so the bundle can carry them. */
export function documentFigures(
  node: unknown,
  depth = 0,
): Array<{ name: string; assetId: string }> {
  if (!isDocumentNode(node) || depth > 32) return [];
  const found: Array<{ name: string; assetId: string }> = [];
  if (node.type === "image") {
    const source = String(node.attrs?.["src"] ?? "");
    const match = /^kiwi-asset:\/\/[^/]+\/([^/?#]+)/u.exec(source);
    const name = latexFileName(source);
    if (match?.[1] !== undefined && name !== null) {
      found.push({ name, assetId: decodeURIComponent(match[1]) });
    }
  }
  for (const child of node.content ?? []) found.push(...documentFigures(child, depth + 1));
  return found;
}

/** Every citation in a rich document, in document order, with repeats kept. */
function collectCitations(node: unknown, depth = 0): string[] {
  if (!isDocumentNode(node) || depth > 32) return [];
  const found: string[] = [];
  if (node.type === "citation") {
    const objectId = String(node.attrs?.["objectId"] ?? "");
    if (objectId !== "") found.push(objectId);
  }
  for (const child of node.content ?? []) found.push(...collectCitations(child, depth + 1));
  return found;
}

/** Every work a rich document cites, in the order it first cites them. */
export function documentCitations(node: unknown): string[] {
  // First appearance decides a numeric style's numbering, so duplicates collapse to the
  // earliest one rather than the latest.
  return [...new Set(collectCitations(node))];
}

/**
 * How many times a rich document cites each work.
 *
 * The reference list cannot show this on its own: once duplicates have collapsed, a source
 * carrying half the argument and one cited in passing look identical. The count is what tells
 * an author which is which.
 */
export function documentCitationCounts(node: unknown): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const id of collectCitations(node)) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

export interface PreambleOptions {
  title?: string;
  authors?: string[];
  engine?: LatexEngine;
  /** The bibliography file the bundle carries, without its extension. */
  bibliography?: string | undefined;
}

/**
 * The preamble a converted rich document is wrapped in.
 *
 * It is deliberately plain. Someone who wants a journal class writes in LaTeX mode; this exists
 * so a paper written in the rich editor typesets sensibly without asking its author to know
 * what a document class is.
 */
export function defaultPreamble(options: PreambleOptions = {}): string {
  const engine = options.engine ?? DEFAULT_LATEX_ENGINE;
  const unicode =
    engine === "pdflatex"
      ? "\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}"
      : "\\usepackage{fontspec}";
  const lines = [
    "\\documentclass[11pt]{article}",
    unicode,
    "\\usepackage{amsmath}",
    "\\usepackage{amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage{ulem}",
    "\\usepackage[hidelinks]{hyperref}",
    "\\usepackage[margin=1in]{geometry}",
    "\\normalem",
  ];
  if (options.title !== undefined && options.title !== "") {
    lines.push(`\\title{${escapeLatex(options.title)}}`);
  }
  if (options.authors !== undefined && options.authors.length > 0) {
    lines.push(`\\author{${options.authors.map(escapeLatex).join(" \\and ")}}`);
  }
  return lines.join("\n");
}

/** Turns a rich document into a complete, compilable LaTeX file. */
export function documentToLatex(document: unknown, options: PreambleOptions = {}): string {
  const body = isDocumentNode(document)
    ? childrenToLatex(document, 0, referencedTargets(document))
    : "";
  const hasTitle = options.title !== undefined && options.title !== "";
  // The bibliography is named rather than inlined: latexmk runs BibTeX over the .bib file the
  // bundle carries, which is what makes \cite resolve to a number and a reference list.
  const bibliography =
    options.bibliography === undefined || options.bibliography === ""
      ? ""
      : `\n\\bibliographystyle{plain}\n\\bibliography{${options.bibliography}}`;
  return [
    defaultPreamble(options),
    "\\begin{document}",
    hasTitle ? "\\maketitle\n" : "",
    body.trimEnd(),
    bibliography,
    "\\end{document}",
    "",
  ]
    .filter((part, index) => part !== "" || index === 0)
    .join("\n");
}

/**
 * Reads a TeX log into problems a person can act on.
 *
 * TeX reports errors in a format from 1978 and buries them in thousands of lines of package
 * chatter. Without this the interface can only say "it did not compile", which is exactly the
 * thing that makes people give up on LaTeX.
 */
export function parseLatexLog(log: string): LatexProblem[] {
  const problems: LatexProblem[] = [];
  const lines = log.split(/\r?\n/u);
  let file: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const opened = /^\((?:\.\/)?([^()\s]+\.tex)/u.exec(line);
    if (opened?.[1] !== undefined) file = opened[1];

    // `! LaTeX Error: ...` and bare `! ...`, with the line number on a later `l.NN` line.
    const failure = /^! (?:LaTeX|Package|Class)?\s*(.*)$/u.exec(line);
    if (failure !== null && line.startsWith("!")) {
      let lineNumber: number | null = null;
      for (let ahead = index + 1; ahead < Math.min(index + 12, lines.length); ahead += 1) {
        const at = /^l\.(\d+)/u.exec(lines[ahead] ?? "");
        if (at?.[1] !== undefined) {
          lineNumber = Number.parseInt(at[1], 10);
          break;
        }
      }
      problems.push({
        severity: "error",
        file,
        line: lineNumber,
        message: (failure[1] ?? line.slice(1)).trim().replace(/^Error:\s*/u, ""),
      });
      continue;
    }

    const undefinedControl = /^! Undefined control sequence/u.exec(line);
    if (undefinedControl !== null) continue;

    const warning = /^(?:LaTeX|Package \w+) Warning: (.*)$/u.exec(line);
    if (warning?.[1] !== undefined) {
      const onLine = /on input line (\d+)/u.exec(warning[1]);
      problems.push({
        severity: "warning",
        file,
        line: onLine?.[1] === undefined ? null : Number.parseInt(onLine[1], 10),
        message: warning[1].replace(/\s*on input line \d+\.?$/u, "").trim(),
      });
    }
  }
  return problems;
}

/** True when the log shows a run that produced no usable document. */
export function compileFailed(problems: LatexProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}
