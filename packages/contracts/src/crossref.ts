import { isDocumentNode, type DocumentNode } from "./document.js";

/**
 * Cross-references: "see Figure 3", written so it stays true.
 *
 * The same rule citations follow, for the same reason: **store the link, render the number.** A
 * document that stores the words "Figure 3" is wrong the moment a figure is inserted above it,
 * and nothing in the document knows it has gone wrong. What is stored is which figure; the
 * number is worked out from document order every time, and the author never renumbers anything.
 *
 * Numbering lives here rather than in the editor because two things have to agree about it: the
 * number shown while writing, and the number the PDF prints. If those are computed in different
 * places by different rules they will eventually differ, and the person who finds out is a
 * reviewer reading "see Figure 4" under a caption that says Figure 5.
 */

export const CROSS_REFERENCE_KINDS = ["figure", "table", "section", "equation"] as const;
export type CrossReferenceKind = (typeof CROSS_REFERENCE_KINDS)[number];

/** The node type a cross-reference is stored as. */
export const CROSS_REFERENCE_NODE = "crossReference";

/** The node type each kind of target is stored as. */
const TARGET_TYPES: Record<string, CrossReferenceKind> = {
  image: "figure",
  table: "table",
  heading: "section",
  mathBlock: "equation",
};

/** What a reference to each kind is called in running text. */
const KIND_WORDS: Record<CrossReferenceKind, string> = {
  figure: "Figure",
  table: "Table",
  section: "Section",
  equation: "Equation",
};

export interface CrossReferenceTarget {
  /**
   * The id carried by the target node, or the empty string when it has none.
   *
   * Ids are assigned when something first refers to a target, not when the target is created.
   * Most figures in most papers are never referred to, and giving every one of them an id would
   * put a UUID on every heading in the document to no purpose.
   */
  id: string;
  kind: CrossReferenceKind;
  /** "3", or "2.1" for a subsection: the number as it will be printed. */
  number: string;
  /** The caption, heading, or equation the number belongs to, for choosing between them. */
  text: string;
}

export function isCrossReferenceKind(value: unknown): value is CrossReferenceKind {
  return typeof value === "string" && (CROSS_REFERENCE_KINDS as readonly string[]).includes(value);
}

/** The kind of target a node is, or null when it is not one. */
export function crossReferenceTargetKind(type: string): CrossReferenceKind | null {
  return TARGET_TYPES[type] ?? null;
}

/** What a reference reads as: "Figure 3". */
export function crossReferenceLabel(kind: CrossReferenceKind, number: string): string {
  return `${KIND_WORDS[kind]} ${number}`;
}

/** The LaTeX label a target is given, and the name a `\ref` to it uses. */
export function crossReferenceLabelName(id: string): string {
  return `kiwi:${id.replace(/[^A-Za-z0-9-]/gu, "")}`;
}

export interface CrossReferenceCounter {
  /** The number the next target of this kind takes. `level` is read for sections only. */
  next(kind: CrossReferenceKind, level?: number): string;
}

/**
 * The numbering rule, kept in one object so every walk over a document shares it.
 *
 * Figures, tables, and equations count straight up from one, and sections count by level, which
 * is what `article` does. Matching the document class matters more than any tidier scheme would:
 * the number in the editor is a promise about the number in the PDF, and only the PDF is read.
 */
export function createCrossReferenceCounter(): CrossReferenceCounter {
  const flat: Record<string, number> = { figure: 0, table: 0, equation: 0 };
  const sections: number[] = [];
  return {
    next(kind, level = 1): string {
      if (kind !== "section") {
        const value = (flat[kind] ?? 0) + 1;
        flat[kind] = value;
        return String(value);
      }
      const depth = Math.min(Math.max(Math.trunc(level), 1), 6);
      sections.length = Math.min(sections.length, depth);
      while (sections.length < depth) sections.push(0);
      sections[depth - 1] = (sections[depth - 1] ?? 0) + 1;
      return sections.join(".");
    },
  };
}

/** What a target is called, for a list someone has to choose from. */
function targetText(node: DocumentNode): string {
  switch (node.type) {
    case "image":
      return String(node.attrs?.["alt"] ?? "");
    case "mathBlock":
      return String(node.attrs?.["latex"] ?? "");
    default:
      return documentNodeText(node);
  }
}

function documentNodeText(node: DocumentNode, depth = 0): string {
  if (depth > 32) return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map((child) => documentNodeText(child, depth + 1)).join("");
}

function walkTargets(
  node: unknown,
  counter: CrossReferenceCounter,
  found: CrossReferenceTarget[],
  depth: number,
): void {
  if (!isDocumentNode(node) || depth > 32) return;
  const kind = crossReferenceTargetKind(node.type);
  if (kind !== null) {
    const level = Number(node.attrs?.["level"] ?? 1);
    found.push({
      id: String(node.attrs?.["kiwiId"] ?? ""),
      kind,
      number: counter.next(kind, Number.isNaN(level) ? 1 : level),
      text: targetText(node),
    });
  }
  // A table's own rows hold no targets worth numbering, and walking into one would number a
  // heading typed inside a cell as a section of the paper.
  if (node.type === "table") return;
  for (const child of node.content ?? []) walkTargets(child, counter, found, depth + 1);
}

/** Everything a cross-reference could point at, numbered, in document order. */
export function documentTargets(node: unknown): CrossReferenceTarget[] {
  const found: CrossReferenceTarget[] = [];
  walkTargets(node, createCrossReferenceCounter(), found, 0);
  return found;
}

/** What each addressable target is called right now, by id. */
export function crossReferenceLabels(node: unknown): Record<string, string> {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const target of documentTargets(node)) {
    if (target.id !== "") labels[target.id] = crossReferenceLabel(target.kind, target.number);
  }
  return labels;
}

function walkReferences(
  node: unknown,
  found: Array<{ target: string; kind: string; label: string }>,
  depth: number,
): void {
  if (!isDocumentNode(node) || depth > 32) return;
  if (node.type === CROSS_REFERENCE_NODE) {
    const target = String(node.attrs?.["target"] ?? "");
    if (target !== "") {
      found.push({
        target,
        kind: String(node.attrs?.["kind"] ?? ""),
        label: String(node.attrs?.["label"] ?? ""),
      });
    }
  }
  for (const child of node.content ?? []) walkReferences(child, found, depth + 1);
}

/** Every cross-reference in a document, in document order, repeats kept. */
export function documentCrossReferences(
  node: unknown,
): Array<{ target: string; kind: string; label: string }> {
  const found: Array<{ target: string; kind: string; label: string }> = [];
  walkReferences(node, found, 0);
  return found;
}

/**
 * The targets something actually points at.
 *
 * Used by the LaTeX conversion to decide what gets a `\label`, and with it what gets a number at
 * all: an equation nothing refers to is set unnumbered, as it would be written by hand.
 */
export function referencedTargets(node: unknown): Set<string> {
  return new Set(documentCrossReferences(node).map((reference) => reference.target));
}

/**
 * References whose target is gone, in document order.
 *
 * A figure can be deleted long after the sentence that mentions it was written, and the sentence
 * still reads perfectly well. This is what lets the editor say so before the paper is sent.
 */
export function brokenCrossReferences(
  node: unknown,
): Array<{ target: string; kind: string; label: string }> {
  const labels = crossReferenceLabels(node);
  return documentCrossReferences(node).filter(
    (reference) => labels[reference.target] === undefined,
  );
}
