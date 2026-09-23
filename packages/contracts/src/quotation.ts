import type { DocumentNode } from "./document.js";

/**
 * Quotations: the line under a passage saying where it was read.
 *
 * A quotation arrives in a note or a draft with the passage, a comment if one was written, and a
 * line saying which paper and which page. That line is the fourth thing in this codebase to
 * follow the rule citations, cross-references and mentions follow: **store the link, render the
 * name.** What is stored is the mark the passage was taken from; the source and the page are
 * copies of what it said, kept so the line still reads after the mark is gone.
 *
 * Storing the mark is what makes the line worth clicking. A quotation is a claim about what a
 * paper says, and the only way to check one is to go and look at the page it is on -- with the
 * passage still highlighted, because a page of a paper is not a small thing to search by eye.
 *
 * The paper is stored beside the mark for the case where the mark has been deleted. The line is
 * then still a link, and it goes to the paper: less than was asked for, and much more than a
 * click that does nothing.
 */

/** The node an attribution line is stored as. */
export const QUOTATION_NODE = "quotation";

export interface QuotationAttributes {
  /** The mark this passage was taken from. This is the part that is the truth. */
  annotation: string;
  /** The paper the mark is on, for when the mark itself is gone. */
  target: string;
  /** The paper's title as it read when the passage was sent. */
  source: string;
  /** The page as the document prints it, which is not always the page as the file counts it. */
  page_label: string;
}

/** A quotation's attributes, read out of a stored node with everything unreadable defaulted. */
export function readQuotation(attrs: unknown): QuotationAttributes {
  const record = (attrs ?? {}) as Record<string, unknown>;
  return {
    annotation: String(record["annotation"] ?? ""),
    target: String(record["target"] ?? ""),
    source: String(record["source"] ?? ""),
    page_label: String(record["page_label"] ?? ""),
  };
}

/**
 * The attribution as it reads.
 *
 * What the editor shows, what an export writes, and what search reads. An em dash rather than a
 * hyphen, and no marker: the id is in the node, and a reader who wanted to see it would be the
 * first.
 */
export function quotationText(attributes: QuotationAttributes): string {
  const source = attributes.source.trim() === "" ? "Unknown source" : attributes.source.trim();
  return attributes.page_label.trim() === ""
    ? `— ${source}`
    : `— ${source}, p. ${attributes.page_label.trim()}`;
}

/** A quotation as a plain-text run, which is what every export reads. */
export function quotationNodeText(node: DocumentNode): string {
  return quotationText(readQuotation(node.attrs));
}

// Structural rather than `isDocumentNode`, which lives in the module this one is read by: the
// document is what carries quotations, so it is the document that knows about them.
function isNode(value: unknown): value is DocumentNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as DocumentNode).type === "string";
}

function walkQuotations(node: unknown, found: QuotationAttributes[], depth: number): void {
  if (!isNode(node) || depth > 32) return;
  if (node.type === QUOTATION_NODE) {
    const quotation = readQuotation(node.attrs);
    if (quotation.annotation !== "") found.push(quotation);
  }
  for (const child of node.content ?? []) walkQuotations(child, found, depth + 1);
}

/** Every quotation in a document, in document order, repeats kept. */
export function documentQuotations(node: unknown): QuotationAttributes[] {
  const found: QuotationAttributes[] = [];
  walkQuotations(node, found, 0);
  return found;
}

/**
 * The marks a document already quotes.
 *
 * What stops the same passage being written in twice. Reading is iterative -- people send one
 * paragraph, read on, and send the rest of the page later -- and a tool that silently doubles the
 * first one makes a mess that has to be cleaned by hand.
 */
export function quotedAnnotations(node: unknown): Set<string> {
  return new Set(documentQuotations(node).map((quotation) => quotation.annotation));
}

/**
 * The marker a plain-text quotation carries.
 *
 * Notes are plain text and LaTeX drafts are source, and neither can hold a node. They carry the
 * mark's id in the attribution line instead, which is the same fact written the only way those
 * two formats have of writing it.
 */
export function quotationMarker(annotationId: string): string {
  return `[[kiwi:annotation/${annotationId}]]`;
}

const MARKER = /\[\[kiwi:annotation\/([^\]\s]+)\]\]/gu;

export type AttributionPart =
  { kind: "text"; text: string } | { kind: "quotation"; annotation: string };

/**
 * A line of plain text split into what it says and the marks it points at.
 *
 * The marker is never shown. It is punctuation for a program, and a reader who sees it is reading
 * the plumbing rather than the sentence.
 */
export function splitAttribution(text: string): AttributionPart[] {
  const parts: AttributionPart[] = [];
  let last = 0;
  // A fresh regex per call: a global one carries its position between calls, and two lines split
  // in a row would give the second one a running start into the middle of itself.
  const pattern = new RegExp(MARKER.source, "gu");
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) parts.push({ kind: "quotation", annotation: match[1] });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Where a mark was made: which paper, which file, which page. */
export interface AnnotationLocation {
  annotation_id: string;
  object_id: string;
  object_title: string;
  asset_id: string;
  /** What the file is called, which is what the Reader's tab will say. */
  file_title: string;
  page: number;
  page_label: string;
}

/** A location, read off a command result, or null when the mark is no longer there to find. */
export function readAnnotationLocation(
  data: Record<string, unknown> | undefined,
): AnnotationLocation | null {
  const found = (data ?? {})["location"];
  if (found === null || typeof found !== "object") return null;
  const record = found as Record<string, unknown>;
  const page = record["page"];
  if (
    typeof record["annotation_id"] !== "string" ||
    typeof record["object_id"] !== "string" ||
    typeof record["asset_id"] !== "string" ||
    typeof page !== "number"
  ) {
    return null;
  }
  return {
    annotation_id: record["annotation_id"],
    object_id: record["object_id"],
    object_title: String(record["object_title"] ?? ""),
    asset_id: record["asset_id"],
    file_title: String(record["file_title"] ?? ""),
    page,
    page_label: String(record["page_label"] ?? ""),
  };
}
