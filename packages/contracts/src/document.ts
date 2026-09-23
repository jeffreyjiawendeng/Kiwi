/**
 * The stored form of a Note or a Manuscript.
 *
 * Rich text has structure, and an object's `content` is one string, so the structure is kept
 * beside it rather than encoded into it. Two things are stored:
 *
 *   `document`  the node tree, which is what the editor reads and writes
 *   `content`   the same words as plain text, which is what search reads
 *
 * Keeping both is deliberate. A search index holding serialized markup finds `<strong>` and
 * misses the sentence; a document holding only plain text loses the writing. Deriving one from
 * the other on every save costs nothing and keeps each honest.
 *
 * The tree is ProseMirror's shape, which the editor produces natively. It is a document model
 * rather than a blob of HTML because the collaboration milestone needs character-level
 * co-editing, and that is close to impossible to make correct over serialized markup.
 */

import { QUOTATION_NODE, quotationNodeText } from "./quotation.js";

export const DOCUMENT_MODES = ["rich", "latex"] as const;
export type DocumentMode = (typeof DOCUMENT_MODES)[number];

export interface DocumentMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface DocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
  marks?: DocumentMark[];
  text?: string;
}

export interface RichDocument extends DocumentNode {
  type: "doc";
  content: DocumentNode[];
}

export const DOCUMENT_LIMITS = {
  /** Depth of nesting. A list inside a quote inside a table is already unusual. */
  depth: 24,
  nodes: 20_000,
  text: 1_000_000,
} as const;

export function emptyDocument(): RichDocument {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function isDocumentNode(value: unknown): value is DocumentNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as DocumentNode).type === "string";
}

export function isRichDocument(value: unknown): value is RichDocument {
  return isDocumentNode(value) && value.type === "doc" && Array.isArray(value.content);
}

/**
 * The words, as a reader would say them.
 *
 * Block boundaries become newlines so that two paragraphs do not run together into a word
 * that was never written, which would then be found by a search for it.
 */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

export function documentText(node: unknown): string {
  if (!isDocumentNode(node)) return "";
  const parts: string[] = [];
  const walk = (current: DocumentNode, depth: number): void => {
    if (depth > DOCUMENT_LIMITS.depth) return;
    if (typeof current.text === "string") parts.push(current.text);
    // An equation's source is its text. Without this, searching for a symbol you know is in
    // the paper finds nothing, and every equation is invisible to search and to any list.
    if (current.type === "mathInline" || current.type === "mathBlock") {
      const latex = current.attrs?.["latex"];
      if (typeof latex === "string") parts.push(latex);
    }
    // An attribution is a node rather than words, and it is the only place a note says which
    // paper a passage came from. Without this, searching for the paper misses the note quoting it.
    if (current.type === QUOTATION_NODE) parts.push(quotationNodeText(current));
    if (current.type === "mathBlock" || current.type === "hardBreak") parts.push("\n");
    for (const child of current.content ?? []) walk(child, depth + 1);
    if (BLOCK_TYPES.has(current.type)) parts.push("\n");
  };
  walk(node, 0);
  return parts
    .join("")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function countNodes(node: unknown, depth = 0): number {
  if (!isDocumentNode(node) || depth > DOCUMENT_LIMITS.depth) return 0;
  let total = 1;
  for (const child of node.content ?? []) total += countNodes(child, depth + 1);
  return total;
}

export interface DocumentProblem {
  message: string;
}

export function validateDocument(value: unknown): DocumentProblem[] {
  if (!isRichDocument(value)) return [{ message: "A document must be a node tree." }];
  const nodes = countNodes(value);
  if (nodes > DOCUMENT_LIMITS.nodes) {
    return [{ message: `A document cannot hold more than ${DOCUMENT_LIMITS.nodes} nodes.` }];
  }
  if (documentText(value).length > DOCUMENT_LIMITS.text) {
    return [{ message: "This document is too long to store." }];
  }
  return [];
}

/** Reads whatever is stored, falling back to an empty document rather than failing to open. */
export function readDocument(value: unknown): RichDocument {
  return isRichDocument(value) ? value : emptyDocument();
}

export function isDocumentMode(value: unknown): value is DocumentMode {
  return typeof value === "string" && (DOCUMENT_MODES as readonly string[]).includes(value);
}

/** Words, the way a manuscript target is counted. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/u).length;
}
