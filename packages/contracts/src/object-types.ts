/**
 * The kinds of thing a workspace holds, and the words the interface uses for them.
 *
 * The stored type is not the displayed word. Storage says `source` because that is what the
 * folder has always been called; a researcher says "paper". Keeping the two apart lets the
 * interface speak plainly without rewriting every workspace on disk.
 */

/** Every type that may legitimately appear in a canonical object file. */
export const OBJECT_TYPES = [
  "inbox_item",
  "source",
  "note",
  "output",
  "project",
  "collection",
  "asset",
  "annotation",
  "claim",
  "protocol",
  "run",
  "dataset",
  "thread",
  "task",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * The types a person can create or promote into.
 *
 * `inbox_item` is absent because capture creates it and nothing else should. `collection` and
 * `asset` are absent because collecting and importing create them as a side effect. The
 * wet-lab types are absent because nothing surfaces them yet; the folders stay on disk so an
 * existing workspace still opens. `thread` is absent because a comment thread is created by
 * commenting on something, and a thread made from a New menu would be a comment about nothing.
 * `task` is present for the opposite reason: writing down work that has to be done is a thing
 * somebody sits and does, and it must not require first finding something to attach it to.
 */
export const CREATABLE_OBJECT_TYPES = ["source", "note", "output", "project", "task"] as const;

export type CreatableObjectType = (typeof CREATABLE_OBJECT_TYPES)[number];

/** What the interface calls each type, singular and plural. */
export const OBJECT_TYPE_LABELS: Record<ObjectType, { one: string; many: string }> = {
  inbox_item: { one: "Inbox item", many: "Inbox" },
  source: { one: "Paper", many: "Papers" },
  note: { one: "Note", many: "Notes" },
  output: { one: "Manuscript", many: "Manuscripts" },
  project: { one: "Project", many: "Projects" },
  collection: { one: "Collection", many: "Collections" },
  asset: { one: "File", many: "Files" },
  annotation: { one: "Annotation", many: "Annotations" },
  claim: { one: "Claim", many: "Claims" },
  protocol: { one: "Protocol", many: "Protocols" },
  run: { one: "Run", many: "Runs" },
  dataset: { one: "Dataset", many: "Datasets" },
  thread: { one: "Comment thread", many: "Comments" },
  task: { one: "Task", many: "Tasks" },
};

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && (OBJECT_TYPES as readonly string[]).includes(value);
}

export function isCreatableObjectType(value: unknown): value is CreatableObjectType {
  return typeof value === "string" && (CREATABLE_OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * An unknown type still has to render as something. A workspace written by a later version of
 * Kiwi may hold types this build has never heard of, and showing the raw identifier is better
 * than showing nothing.
 */
export function objectTypeLabel(type: string, plural = false): string {
  const known = OBJECT_TYPE_LABELS[type as ObjectType];
  if (known !== undefined) return plural ? known.many : known.one;
  return type.replaceAll("_", " ");
}

/**
 * How a tag reads on screen.
 *
 * A tag is stored as a path so that two teams can both have a `review` tag without meaning the
 * same thing, and the last segment is the part a person named. Anything without a path is shown
 * as it was written.
 */
export function tagLabel(tag: string): string {
  return tag.split("/").at(-1)?.replaceAll("-", " ") ?? tag;
}

/**
 * The stored id of a tag somebody typed.
 *
 * The inverse of `tagLabel`, and beside it so the two cannot drift apart: a tag added from the
 * Library has to be the same tag as the one added in the Reader, or filtering by it finds half
 * of what carries it. `user/` says a person named this one rather than Kiwi. An empty string
 * means there was no name in what was typed, which the caller has to answer for.
 */
export function userTagId(label: string): string {
  const slug = label
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "" : `tag:user/${slug}`;
}

/** The `$schema` a canonical object of this type carries. */
export function objectSchemaUri(type: string): string {
  return `https://kiwi-research.org/schemas/object/${type.replaceAll("_", "-")}/1-0-0.json`;
}

/**
 * Event types this build no longer writes, and the one it writes instead.
 *
 * The event log is append-only, so a workspace written before an event was renamed still holds
 * the old name and always will. Reading maps it; nothing rewrites the files.
 */
const RETIRED_EVENT_TYPES: Record<string, string> = {
  // Saving an edit was called publishing until the word was needed for publishing a paper.
  "object.published": "object.saved",
};

/**
 * What history calls an event.
 *
 * An unrecognised event type still renders, for the same reason an unrecognised object type
 * does: a workspace written by a later build may hold events this one has never heard of, and
 * the raw identifier reads better than a blank line.
 */
export function objectEventLabel(eventType: string): string {
  const current = RETIRED_EVENT_TYPES[eventType] ?? eventType;
  return current.replaceAll(".", " ").replaceAll("_", " ");
}
