/**
 * A conversation about a particular thing: a passage, an annotation, a whole object.
 *
 * A thread is its own object rather than a field on what it comments on. A manuscript carrying
 * two hundred margin comments would otherwise be rewritten two hundred times, every reply would
 * take the manuscript's lock, and a comment left while someone else was editing would be a
 * version conflict on a document nobody meant to change.
 *
 * Three fields are stored twice on purpose. `author_name` is copied onto each message because a
 * thread has to read correctly in a workspace whose owner cannot reach the service, and after
 * the person who wrote it has left. `participants` and `mentions` are copied onto the thread
 * because "which threads am I in" must be answerable without opening every message of every
 * thread in the project. Nothing else recomputes them: `withThreadMessages` is the only way the
 * message list changes, and it derives both.
 */

export const THREAD_ANCHOR_KINDS = ["object", "annotation", "text_range", "section"] as const;
export type ThreadAnchorKind = (typeof THREAD_ANCHOR_KINDS)[number];

export const THREAD_STATUSES = ["open", "resolved"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** What a thread is attached to. */
export interface ThreadAnchor {
  /** The object commented on: the manuscript, the paper, the annotation's own object. */
  object_id: string;
  kind: ThreadAnchorKind;
  /** Document positions, for `text_range`. They move under every edit above them. */
  from?: number;
  to?: number;
  /** The heading's id, for `section`. */
  section_id?: string;
  /**
   * The anchored text as it read when the thread started.
   *
   * This is what lets a comment survive an edit. Positions shift; the words usually do not, so
   * the quotation is what the document is searched for when the stored positions stop landing
   * on it. Without it, an edit above a comment silently moves the comment onto other text.
   */
  quote?: string;
}

export interface ThreadMessage {
  id: string;
  author_id: string;
  /** Denormalised. A thread must still name its authors offline, and after they leave. */
  author_name: string;
  /** Plain text. A mention is written as `@[name](user:id)`. */
  body: string;
  created_at: string;
  /** Null until edited. An edit keeps the original in the object's version history. */
  edited_at: string | null;
}

export interface ThreadBody {
  anchor: ThreadAnchor;
  status: ThreadStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  /** Oldest first. Ordered by `created_at`, then by id so two replies in one second are stable. */
  messages: ThreadMessage[];
  /** Every author, derived. */
  participants: string[];
  /** Every account mentioned in any message, derived. */
  mentions: string[];
}

export const THREAD_LIMITS = {
  body: 20_000,
  quote: 2_000,
  name: 200,
  messages: 1_000,
} as const;

export function isThreadAnchorKind(value: unknown): value is ThreadAnchorKind {
  return typeof value === "string" && (THREAD_ANCHOR_KINDS as readonly string[]).includes(value);
}

export function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === "string" && (THREAD_STATUSES as readonly string[]).includes(value);
}

/**
 * `@[Ada Lovelace](user:0f1e...)`.
 *
 * The name is stored beside the id for the same reason `author_name` is: the text has to render
 * without asking the service who that id belongs to. The id is what a notification is sent to,
 * so a renamed account still reaches the right person.
 */
const MENTION = /@\[([^\]]*)\]\(user:([^)\s]+)\)/gu;

/** The accounts a message mentions, in the order they are mentioned, without repeats. */
export function parseMentions(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(MENTION)) {
    const id = match[2] ?? "";
    if (id !== "" && !found.includes(id)) found.push(id);
  }
  return found;
}

/** A message as it reads to a person: `@[Ada](user:...)` becomes `@Ada`. */
export function mentionPlainText(body: string): string {
  return body.replaceAll(MENTION, (_match, name: string) => `@${name}`);
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (value !== "" && !seen.includes(value)) seen.push(value);
  }
  return seen;
}

export function threadParticipants(messages: readonly ThreadMessage[]): string[] {
  return uniqueInOrder(messages.map((message) => message.author_id));
}

export function threadMentions(messages: readonly ThreadMessage[]): string[] {
  return uniqueInOrder(messages.flatMap((message) => parseMentions(message.body)));
}

/** Oldest first. The id breaks the tie so two machines agree on the order of a shared second. */
export function compareThreadMessages(left: ThreadMessage, right: ThreadMessage): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * The one way the message list changes.
 *
 * Sorting and the two derived arrays happen here so that no caller can write a thread whose
 * `participants` disagree with its `messages`. The inbox trusts those arrays.
 */
export function withThreadMessages(
  thread: ThreadBody,
  messages: readonly ThreadMessage[],
): ThreadBody {
  const ordered = [...messages].sort(compareThreadMessages);
  return {
    ...thread,
    messages: ordered,
    participants: threadParticipants(ordered),
    mentions: threadMentions(ordered),
  };
}

export function startThread(anchor: ThreadAnchor, first: ThreadMessage): ThreadBody {
  return withThreadMessages(
    {
      anchor,
      status: "open",
      resolved_by: null,
      resolved_at: null,
      messages: [],
      participants: [],
      mentions: [],
    },
    [first],
  );
}

/**
 * Appends a reply.
 *
 * A reply carries no expected version. Appending is commutative: two people replying in the
 * same second both belong in the result, and an append overwrites nothing, which is the only
 * thing optimistic concurrency exists to prevent.
 */
export function replyToThread(thread: ThreadBody, message: ThreadMessage): ThreadBody {
  return withThreadMessages(thread, [...thread.messages, message]);
}

/**
 * Two copies of one thread, reconciled.
 *
 * Last-writer-wins is right for a title and wrong for a conversation: whichever machine synced
 * second would erase the other's reply. Messages are unioned by id instead. Where both sides
 * hold the same id, the later edit wins, because that is an edit of one message rather than two
 * different messages.
 */
export function mergeThreadMessages(
  left: readonly ThreadMessage[],
  right: readonly ThreadMessage[],
): ThreadMessage[] {
  const merged = new Map<string, ThreadMessage>();
  for (const message of left) merged.set(message.id, message);
  for (const message of right) {
    const existing = merged.get(message.id);
    if (existing === undefined) {
      merged.set(message.id, message);
      continue;
    }
    const mine = existing.edited_at ?? "";
    const theirs = message.edited_at ?? "";
    if (theirs > mine) merged.set(message.id, message);
  }
  return [...merged.values()].sort(compareThreadMessages);
}

/**
 * How far from the stored position a passage is looked for before the thread is called orphaned.
 *
 * Wide enough to survive a paragraph rewritten above the comment; narrow enough that a common
 * phrase does not drag a comment to the far end of a chapter. Beyond the window a match is only
 * taken when it is the only one in the document.
 */
export const THREAD_REANCHOR_WINDOW = 2_000;

/** The document a thread's anchor is resolved against. */
export interface AnchorDocument {
  /** Its text, in the coordinates the anchor's positions were stored in. */
  text: string;
  /** The heading ids it currently has, for a `section` anchor. */
  sections?: readonly string[];
}

export interface ThreadAnchorResolution {
  /**
   * `found`, the stored anchor still holds, or it is not a passage and has nowhere to slip to.
   * `moved`, the quotation is elsewhere; write `from` and `to` back.
   * `orphaned`, the quotation is gone. Keep the thread and show it. An anchor that stopped
   * resolving is not permission to delete somebody's argument.
   */
  state: "found" | "moved" | "orphaned";
  /** Where the passage is now. Null for an orphan, and for an anchor that is not a passage. */
  from: number | null;
  to: number | null;
}

function orphaned(): ThreadAnchorResolution {
  return { state: "orphaned", from: null, to: null };
}

function unpositioned(): ThreadAnchorResolution {
  return { state: "found", from: null, to: null };
}

interface Collapsed {
  text: string;
  /** For each character of `text`, where it came from in the original. */
  source: number[];
}

/**
 * The text with every run of whitespace collapsed to one space, and the way back to the original.
 *
 * A re-wrapped paragraph is the ordinary case. The words are untouched and only the line breaks
 * moved, so comparing raw characters would orphan a comment that nobody's edit went near.
 */
function collapse(text: string): Collapsed {
  const characters: string[] = [];
  const source: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && characters.length > 0) {
      characters.push(" ");
      source.push(index);
    }
    pendingSpace = false;
    characters.push(character);
    source.push(index);
  }
  return { text: characters.join(""), source };
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

interface Span {
  from: number;
  to: number;
}

function locate(text: string, quote: string, near: number, window: number): Span | null {
  const document = collapse(text);
  const wanted = collapse(quote).text.trim();
  if (wanted === "") return null;

  const hits = occurrences(document.text, wanted).map((start) => ({
    from: document.source[start] ?? 0,
    to: (document.source[start + wanted.length - 1] ?? 0) + 1,
  }));
  if (hits.length === 0) return null;

  const nearEnough = hits.filter((hit) => Math.abs(hit.from - near) <= window);
  if (nearEnough.length > 0) {
    return nearEnough.reduce((best, hit) =>
      Math.abs(hit.from - near) < Math.abs(best.from - near) ? hit : best,
    );
  }
  // Far from where the comment was left, a match is only worth trusting when it is the only one:
  // a section moved to the end of the document takes its comments with it, but a phrase that
  // occurs four times must not pull a comment into a paragraph nobody was talking about.
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Where a thread's anchor lands in the document as it now reads.
 *
 * Orphaned is decided here rather than stored on the thread. Whether the quotation is still in
 * the document is a fact about the document, and it changes when the document changes without
 * anyone rewriting the thread, a stored flag would be wrong the moment the edit that broke the
 * anchor was undone.
 */
export function resolveThreadAnchor(
  anchor: ThreadAnchor,
  document: AnchorDocument,
  window: number = THREAD_REANCHOR_WINDOW,
): ThreadAnchorResolution {
  if (anchor.kind === "section") {
    if (document.sections === undefined) return unpositioned();
    return document.sections.includes(anchor.section_id ?? "") ? unpositioned() : orphaned();
  }
  // A thread on the object itself, or on an annotation, is attached to something with an id.
  // Editing the text cannot move it, and deleting what it is attached to deletes it.
  if (anchor.kind !== "text_range") return unpositioned();

  const from = anchor.from ?? 0;
  const to = anchor.to ?? from;
  const quote = anchor.quote ?? "";
  if (quote === "") {
    // There is nothing to search for, so the positions are all the thread has. They are kept for
    // as long as they are inside the document at all.
    return to <= document.text.length ? { state: "found", from, to } : orphaned();
  }
  if (document.text.slice(from, to) === quote) return { state: "found", from, to };

  const located = locate(document.text, quote, from, window);
  if (located === null) return orphaned();
  if (located.from === from && located.to === to) return { state: "found", from, to };
  return { state: "moved", from: located.from, to: located.to };
}

/**
 * The thread with the positions written back, when they moved.
 *
 * Unchanged for `found` and for `orphaned`, so a document load can pass every thread through
 * this and save the ones it returns changed. An orphan keeps its old positions and its quotation:
 * they are what someone re-anchoring it has to go on.
 */
export function withResolvedAnchor(
  thread: ThreadBody,
  resolution: ThreadAnchorResolution,
): ThreadBody {
  if (resolution.state !== "moved" || resolution.from === null || resolution.to === null) {
    return thread;
  }
  return { ...thread, anchor: { ...thread.anchor, from: resolution.from, to: resolution.to } };
}

/**
 * A person pointing an orphaned thread at the text it belongs to.
 *
 * The quotation is replaced along with the positions. The words they selected are what the thread
 * is about now, and keeping the old quotation would orphan it again on the next load.
 */
export function reanchorThread(
  thread: ThreadBody,
  from: number,
  to: number,
  quote: string,
): ThreadBody {
  return {
    ...thread,
    anchor: { ...thread.anchor, kind: "text_range", from, to, quote },
  };
}

function firstLine(text: string, limit = 80): string {
  const words = text.trim().replace(/\s+/gu, " ");
  if (words === "") return "";
  return words.length > limit ? `${words.slice(0, limit - 1)}…` : words;
}

/** The title the thread's object carries, so a list of threads reads without opening each. */
export function threadTitle(thread: ThreadBody): string {
  const opening = firstLine(mentionPlainText(thread.messages[0]?.body ?? ""));
  if (opening !== "") return opening;
  const quote = firstLine(thread.anchor.quote ?? "");
  return quote === "" ? "Comment" : `Comment on “${quote}”`;
}

/**
 * The thread's searchable text.
 *
 * Every message, so that searching a workspace for a phrase finds the conversation about it and
 * not only the document it is about.
 */
export function threadContent(thread: ThreadBody): string {
  return thread.messages.map((message) => mentionPlainText(message.body)).join("\n\n");
}

export interface ThreadProblem {
  field: keyof ThreadBody | "messages";
  message: string;
}

function validAnchor(anchor: ThreadAnchor): string | null {
  if (typeof anchor.object_id !== "string" || anchor.object_id.trim() === "") {
    return "A thread is a comment on something.";
  }
  if (!isThreadAnchorKind(anchor.kind)) return "Choose what the thread is anchored to.";
  if (anchor.kind === "text_range") {
    const from = anchor.from;
    const to = anchor.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return "A comment on a passage needs the passage.";
    }
    if ((from ?? 0) < 0 || (to ?? 0) < (from ?? 0)) return "That passage is not a passage.";
  }
  if (anchor.kind === "section" && (anchor.section_id ?? "").trim() === "") {
    return "A comment on a section needs the section.";
  }
  if ((anchor.quote ?? "").length > THREAD_LIMITS.quote) {
    return "The quoted passage is too long to store.";
  }
  return null;
}

export function validateThread(thread: ThreadBody): ThreadProblem[] {
  const problems: ThreadProblem[] = [];
  const add = (field: ThreadProblem["field"], message: string) => problems.push({ field, message });

  const anchor = validAnchor(thread.anchor);
  if (anchor !== null) add("anchor", anchor);

  if (!isThreadStatus(thread.status)) add("status", "A thread is either open or resolved.");
  if (thread.status === "resolved" && thread.resolved_at === null) {
    add("resolved_at", "A resolved thread records when it was resolved.");
  }

  if (thread.messages.length === 0) add("messages", "A thread is at least one comment.");
  if (thread.messages.length > THREAD_LIMITS.messages) {
    add("messages", `A thread cannot hold more than ${THREAD_LIMITS.messages} comments.`);
  }
  const ids = new Set<string>();
  for (const message of thread.messages) {
    if (message.id.trim() === "" || ids.has(message.id)) {
      add("messages", "Every comment needs an identifier of its own.");
      break;
    }
    ids.add(message.id);
  }
  if (thread.messages.some((message) => message.author_id.trim() === "")) {
    add("messages", "Every comment records who wrote it.");
  }
  if (thread.messages.some((message) => message.body.trim() === "")) {
    add("messages", "An empty comment says nothing.");
  }
  if (thread.messages.some((message) => message.body.length > THREAD_LIMITS.body)) {
    add("messages", "That comment is too long to store.");
  }
  return problems;
}

const EMPTY_ANCHOR: ThreadAnchor = { object_id: "", kind: "object" };

function readAnchor(value: unknown): ThreadAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_ANCHOR;
  const stored = value as Partial<ThreadAnchor>;
  return {
    object_id: typeof stored.object_id === "string" ? stored.object_id : "",
    kind: isThreadAnchorKind(stored.kind) ? stored.kind : "object",
    ...(Number.isInteger(stored.from) ? { from: stored.from as number } : {}),
    ...(Number.isInteger(stored.to) ? { to: stored.to as number } : {}),
    ...(typeof stored.section_id === "string" ? { section_id: stored.section_id } : {}),
    ...(typeof stored.quote === "string" ? { quote: stored.quote } : {}),
  };
}

function readMessage(value: unknown): ThreadMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as Partial<ThreadMessage>;
  if (typeof stored.id !== "string" || stored.id === "") return null;
  return {
    id: stored.id,
    author_id: typeof stored.author_id === "string" ? stored.author_id : "",
    author_name: typeof stored.author_name === "string" ? stored.author_name : "",
    body: typeof stored.body === "string" ? stored.body : "",
    created_at: typeof stored.created_at === "string" ? stored.created_at : "",
    edited_at: typeof stored.edited_at === "string" ? stored.edited_at : null,
  };
}

export function isThread(value: unknown): value is ThreadBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ThreadBody>;
  return typeof candidate.anchor === "object" && Array.isArray(candidate.messages);
}

/**
 * A stored thread, read defensively.
 *
 * The derived arrays are recomputed rather than trusted. They are denormalised for the sake of
 * the inbox query, and a file written by an older build, or merged by another machine, is not a
 * reason to show a thread with a participant who never wrote in it.
 */
export function readThread(value: unknown): ThreadBody | null {
  if (!isThread(value)) return null;
  const stored = value as Partial<ThreadBody>;
  const messages = (Array.isArray(stored.messages) ? stored.messages : [])
    .map(readMessage)
    .filter((message): message is ThreadMessage => message !== null);
  return withThreadMessages(
    {
      anchor: readAnchor(stored.anchor),
      status: isThreadStatus(stored.status) ? stored.status : "open",
      resolved_by: typeof stored.resolved_by === "string" ? stored.resolved_by : null,
      resolved_at: typeof stored.resolved_at === "string" ? stored.resolved_at : null,
      messages: [],
      participants: [],
      mentions: [],
    },
    messages,
  );
}
