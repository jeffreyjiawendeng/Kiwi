import { useCallback, useEffect, useState } from "react";
import {
  mentionPlainText,
  type ThreadAnchor,
  type ThreadAnchorResolution,
  type ThreadBody,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * The comment threads on one object, and the ways to add to them.
 *
 * One component for every surface that shows comments, the dock, the Reader, the Manuscript
 * margin, the review inbox, because a thread replied to in the margin and the same thread
 * replied to in the dock must be the same thread, written the same way. What changes between
 * surfaces is the anchor a new thread is filed against, which is a prop.
 */

interface ThreadView {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  created_at: string;
  updated_at: string;
  thread: ThreadBody;
}

async function invoke(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult> {
  const bridge = readBridge();
  if (bridge === null) throw new Error("The desktop bridge is unavailable.");
  const requestId = crypto.randomUUID();
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command,
    args,
  });
}

/**
 * How many open threads hang off each thing commented on, across the whole workspace.
 *
 * One call rather than one per anchor. `kiwi.thread.list` reads every thread object whether or
 * not it is filtered, so asking separately about two hundred marks on a paper would be two
 * hundred passes over the same files to answer one question. The caller looks up the ids it is
 * showing and ignores the rest.
 */
export async function countOpenThreads(workspaceId: string): Promise<Record<string, number>> {
  const result = await invoke(workspaceId, "kiwi.thread.list", { status: "open" });
  if (result.error !== undefined) throw new Error(result.error.message);
  const threads = ((result.data ?? {})["threads"] as ThreadView[] | undefined) ?? [];
  const counts: Record<string, number> = {};
  for (const entry of threads) {
    const anchored = entry.thread.anchor.object_id;
    counts[anchored] = (counts[anchored] ?? 0) + 1;
  }
  return counts;
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

/**
 * The name to file a comment under.
 *
 * Resolved here rather than passed in, because no surface that shows comments has any business
 * knowing who is signed in. The email is the fallback and not a placeholder: it is the name the
 * account has when the display name cannot be read, which is every time the machine is offline.
 */
function useAuthorName(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) return;
    let active = true;
    void bridge
      .getAccountAuthState()
      .then(async (auth) => {
        if (!active || auth.status !== "authenticated") return;
        const settings = auth.connection === "online" ? await bridge.getAccountSettings() : null;
        if (!active) return;
        setName(
          settings?.status === "ok" ? settings.settings.account.display_name : auth.account.email,
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return name;
}

/**
 * What a surface that shows the commented text can say about where the comments are.
 *
 * Only a surface holding the manuscript can answer any of this, so it is a prop rather than
 * something this component works out. Given one, the threads are ordered by where they sit in the
 * text, each carries a way of showing the passage it is about, and the ones whose passage has
 * been edited away are listed at the end where they can be pointed at something again.
 */
export interface ThreadPassages {
  /** Where this anchor lands in the manuscript as it now reads. */
  locate(anchor: ThreadAnchor): ThreadAnchorResolution;
  /** Show the passage, at the positions `locate` gave for it. */
  reveal(from: number, to: number): void;
  /** The passage now selected, which is what an orphan can be pointed at. */
  selected: { from: number; to: number; quote: string } | null;
}

export interface CommentThreadsProps {
  workspaceId: string;
  /** The object the threads are about. */
  objectId: string;
  writable: boolean;
  /**
   * What a new thread is anchored to. The whole object by default, which is what the dock means:
   * a passage is only a thing you can point at where the passage is on the screen.
   */
  anchor?: ThreadAnchor;
  /** Told to somebody looking at an object nobody has commented on. */
  empty?: string;
  /**
   * Called once the workspace has been reread after a write. A surface that shows something
   * about the threads other than the threads themselves, such as a count in a margin or a mark
   * on a page, has no other way to learn that the count changed.
   */
  onChange?: () => void;
  /** Where the commented text is, from a surface that is showing it. */
  passages?: ThreadPassages;
}

export function CommentThreads({
  workspaceId,
  objectId,
  writable,
  anchor,
  empty,
  onChange,
  passages,
}: CommentThreadsProps): React.JSX.Element {
  const authorName = useAuthorName();
  const [threads, setThreads] = useState<ThreadView[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await invoke(workspaceId, "kiwi.thread.list", { object_id: objectId });
    if (result.error !== undefined) throw new Error(result.error.message);
    setThreads(((result.data ?? {})["threads"] as ThreadView[] | undefined) ?? []);
  }, [objectId, workspaceId]);

  useEffect(() => {
    let active = true;
    setThreads(null);
    setError(null);
    void load().catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Kiwi could not read the comments.");
      setThreads([]);
    });
    return () => {
      active = false;
    };
  }, [load]);

  // Every write ends the same way: the thread as the workspace now holds it. Rereading rather
  // than patching what is on the screen is what keeps a reply written on another machine, and
  // arriving in the same second, from being rendered away.
  async function write(command: string, args: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, command, args);
      if (result.error !== undefined) throw new Error(result.error.message);
      await load();
      onChange?.();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not save that comment.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function startThread(): Promise<void> {
    const body = opening.trim();
    if (body === "" || authorName === null) return;
    const written = await write("kiwi.thread.start", {
      anchor: anchor ?? { object_id: objectId, kind: "object" },
      body,
      author_name: authorName,
    });
    if (written) setOpening("");
  }

  async function reply(threadId: string): Promise<void> {
    const body = (drafts[threadId] ?? "").trim();
    if (body === "" || authorName === null) return;
    const written = await write("kiwi.thread.reply", {
      thread_id: threadId,
      body,
      author_name: authorName,
    });
    if (written) setDrafts((current) => ({ ...current, [threadId]: "" }));
  }

  /** Points an orphan at whatever is selected now. */
  async function reanchor(threadId: string): Promise<void> {
    const passage = passages?.selected;
    if (passage === undefined || passage === null) return;
    await write("kiwi.thread.reanchor", { thread_id: threadId, ...passage });
  }

  // Nothing can be written under a name that is not known yet, and the wait is one call long.
  const canComment = writable && authorName !== null;
  const open = (threads ?? []).filter((entry) => entry.thread.status === "open");
  const resolved = (threads ?? []).filter((entry) => entry.thread.status === "resolved");
  const shown = showResolved ? [...open, ...resolved] : open;

  /**
   * Each thread beside where it is in the text, with the ones that have lost their place apart.
   *
   * Sorted by position rather than by age, because a margin is read down the page. A comment on
   * the whole object has no position and sorts first, which is where a remark about the paper as
   * a whole belongs.
   */
  const located = shown.map((entry) => ({
    entry,
    where: passages === undefined ? null : passages.locate(entry.thread.anchor),
  }));
  const orphans = located.filter((item) => item.where?.state === "orphaned");
  const placed = located
    .filter((item) => item.where?.state !== "orphaned")
    .sort((left, right) => (left.where?.from ?? -1) - (right.where?.from ?? -1));

  /** The quotation, as the control that shows where the passage is when there is somewhere to go. */
  function quotation(
    thread: ThreadBody,
    where: ThreadAnchorResolution | null,
  ): React.JSX.Element | null {
    const quote = thread.anchor.quote ?? "";
    if (quote === "") return null;
    if (where === null || where.from === null || where.to === null) {
      return <blockquote className="comments__quote">{quote}</blockquote>;
    }
    const { from, to } = where;
    return (
      <button
        type="button"
        className="comments__quote comments__quote--linked"
        aria-label={`Show the text of ${quote}`}
        onClick={() => passages?.reveal(from, to)}
      >
        {quote}
      </button>
    );
  }

  function threadItem(entry: ThreadView, where: ThreadAnchorResolution | null): React.JSX.Element {
    const thread = entry.thread;
    const settled = thread.status === "resolved";
    return (
      <li key={entry.id} className="comments__thread" data-status={thread.status}>
        {quotation(thread, where)}
        <ol className="comments__messages">
          {thread.messages.map((message) => (
            <li key={message.id}>
              <span className="comments__byline">
                <strong>{message.author_name}</strong>
                <small>
                  {displayTime(message.created_at)}
                  {message.edited_at === null ? "" : " · edited"}
                </small>
              </span>
              <p>{mentionPlainText(message.body)}</p>
            </li>
          ))}
        </ol>
        <div className="comments__actions">
          <textarea
            rows={2}
            value={drafts[entry.id] ?? ""}
            disabled={!canComment || busy}
            aria-label={`Reply to ${entry.title}`}
            placeholder="Reply"
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [entry.id]: event.target.value }))
            }
          />
          <div>
            <button
              type="button"
              disabled={!canComment || busy || (drafts[entry.id] ?? "").trim() === ""}
              onClick={() => void reply(entry.id)}
            >
              Reply
            </button>
            <button
              type="button"
              disabled={!canComment || busy}
              onClick={() =>
                void write(settled ? "kiwi.thread.reopen" : "kiwi.thread.resolve", {
                  thread_id: entry.id,
                })
              }
            >
              {settled ? "Reopen" : "Resolve"}
            </button>
            {where?.state !== "orphaned" ? null : (
              <button
                type="button"
                disabled={!canComment || busy || (passages?.selected ?? null) === null}
                onClick={() => void reanchor(entry.id)}
              >
                Point at the selection
              </button>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <section className="comments" aria-label="Comments" aria-busy={busy || threads === null}>
      {threads === null ? <p className="comments__quiet">Reading comments…</p> : null}

      {threads !== null && open.length === 0 ? (
        <p className="comments__quiet">
          {empty ?? "No comments on this yet. A comment is a question you can leave open."}
        </p>
      ) : null}

      {resolved.length === 0 ? null : (
        <button
          type="button"
          className="comments__toggle"
          aria-pressed={showResolved}
          onClick={() => setShowResolved((value) => !value)}
        >
          {showResolved ? "Hide" : "Show"} {resolved.length} settled
        </button>
      )}

      <ol className="comments__list">{placed.map((item) => threadItem(item.entry, item.where))}</ol>

      {/*
        An anchor that stopped resolving is not permission to hide somebody's argument. The
        comment keeps its quotation, which is what whoever re-anchors it has to go on, and it is
        listed at the end because it is no longer about anything on the page above it.
      */}
      {orphans.length === 0 ? null : (
        <section className="comments__orphans" aria-label="Comments that lost their place">
          <h4>
            {orphans.length} {orphans.length === 1 ? "comment has" : "comments have"} lost the text
            {orphans.length === 1 ? " it was" : " they were"} about
          </h4>
          <ol className="comments__list">
            {orphans.map((item) => threadItem(item.entry, item.where))}
          </ol>
        </section>
      )}

      {!canComment ? null : (
        <div className="comments__compose">
          {(passages?.selected ?? null) === null ? null : (
            <blockquote className="comments__quote">{passages?.selected?.quote}</blockquote>
          )}
          <textarea
            rows={2}
            value={opening}
            disabled={busy}
            aria-label="Start a comment"
            placeholder={
              (passages?.selected ?? null) === null ? "Comment on this" : "Comment on the selection"
            }
            onChange={(event) => setOpening(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || opening.trim() === ""}
            onClick={() => void startThread()}
          >
            Comment
          </button>
        </div>
      )}

      {error === null ? null : (
        <p className="comments__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
