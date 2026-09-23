import { isDocumentNode, type DocumentNode } from "./document.js";
import { isObjectType, type ObjectType } from "./object-types.js";

/**
 * Mentions: writing "as Attention Is All You Need shows" and having it stay true.
 *
 * The third time the rule that governs citations and cross-references applies, and it applies for
 * the same reason: **store the link, render the name.** A note that stored the title as text keeps
 * showing the old one after the paper is renamed, and nothing in the note knows it is now wrong.
 * What is stored is which object; the title is read from that object and written back into the
 * node whenever the document is opened, which is what a rename moves.
 *
 * The `@` is how a mention is made, not how it reads. A sentence says "as Attention Is All You
 * Need shows", not "as @Attention Is All You Need shows", so the sigil is a way of typing and
 * never appears in the document or in an export.
 *
 * Search does not read mentions, for the same reason the stored title is not the truth: the title
 * a document carries is only as fresh as the last time it was opened. Indexing it would find a
 * note under a name its paper no longer has, which is worse than not finding it. Citations and
 * cross-references are left out of the searched text for the same reason.
 */

/** The node type a mention is stored as. */
export const MENTION_NODE = "mention";

/** The relation written beside the document when a mention is inserted. */
export const MENTION_RELATION = "mentions";

/**
 * The types that can be mentioned.
 *
 * Papers, notes, manuscripts, and claims: the things a sentence in a piece of writing points at
 * by name. Projects and collections are places rather than things to refer to, and an annotation
 * is reached through the paper it is on.
 */
export const MENTIONABLE_TYPES = ["source", "note", "output", "claim"] as const;

export type MentionableType = (typeof MENTIONABLE_TYPES)[number];

export function isMentionableType(value: unknown): value is MentionableType {
  return typeof value === "string" && (MENTIONABLE_TYPES as readonly string[]).includes(value);
}

export interface MentionAttributes {
  /** The id of the object this points at. This is the only part that is the truth. */
  target: string;
  /** What kind of thing it is, for the word beside the name and for where following it leads. */
  kind: ObjectType;
  /**
   * The title as it was last read.
   *
   * Rewritten whenever the document is opened, which is what carries a rename into every sentence
   * that mentions the renamed thing. Kept when the object goes, so a note does not lose the name
   * of what it was talking about.
   */
  label: string;
  /** Whether the object was gone the last time anyone looked. */
  missing: boolean;
}

/** What a mention shows. */
export function mentionText(attributes: MentionAttributes): string {
  return attributes.label === "" ? "Untitled" : attributes.label;
}

/** A mention's attributes, read out of a stored node with everything unreadable defaulted. */
export function readMention(attrs: unknown): MentionAttributes {
  const record = (attrs ?? {}) as Record<string, unknown>;
  const kind = record["kind"];
  return {
    target: String(record["target"] ?? ""),
    kind: isObjectType(kind) ? kind : "note",
    label: String(record["label"] ?? ""),
    missing: record["missing"] === true,
  };
}

function walkMentions(node: unknown, found: MentionAttributes[], depth: number): void {
  if (!isDocumentNode(node) || depth > 32) return;
  if (node.type === MENTION_NODE) {
    const mention = readMention(node.attrs);
    if (mention.target !== "") found.push(mention);
  }
  for (const child of node.content ?? []) walkMentions(child, found, depth + 1);
}

/** Every mention in a document, in document order, repeats kept. */
export function documentMentions(node: unknown): MentionAttributes[] {
  const found: MentionAttributes[] = [];
  walkMentions(node, found, 0);
  return found;
}

/**
 * The objects a document mentions, each once.
 *
 * What the relations beside the document have to say after a save, and what has to have its title
 * read when the document is opened. Mentioning the same paper in four sentences is one link: a
 * backlinks panel that listed it four times would be counting sentences rather than answering the
 * question it was asked.
 */
export function mentionedObjects(node: unknown): string[] {
  const seen = new Set<string>();
  for (const mention of documentMentions(node)) seen.add(mention.target);
  return [...seen];
}

/**
 * Mentions of something that is no longer there.
 *
 * A note reads perfectly well after the paper it points at is deleted, which is exactly why the
 * break has to be shown. Nobody rereads a paragraph to check that its links still resolve.
 */
export function brokenMentions(node: unknown): MentionAttributes[] {
  return documentMentions(node).filter((mention) => mention.missing);
}

/** A mention as a plain-text run, which is what every export reads. */
export function mentionNodeText(node: DocumentNode): string {
  return mentionText(readMention(node.attrs));
}
