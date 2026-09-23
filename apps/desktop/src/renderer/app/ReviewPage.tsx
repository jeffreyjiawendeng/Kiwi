import { useCallback, useEffect, useState } from "react";
import type { ThreadBody, ThreadStatus } from "@kiwi/contracts";
import { CommentThreads } from "./CommentThreads.js";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * The Review page: every comment in the project, whatever it is attached to.
 *
 * The other three surfaces show the comments on the thing you are already looking at. This one
 * answers the opposite question, what is waiting for me, which is the only way to find a reply
 * left on a paragraph you have not opened in a week.
 *
 * The filters are asked of the workspace rather than applied here, because most of them are about
 * the person asking. `mine`, `mentions`, and `involving_me` are matched against account ids the
 * renderer has no business knowing, so the command takes them as questions about the caller and
 * answers them against the account already in its context.
 */

interface ThreadEntry {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  thread: ThreadBody;
}

/** One thing that has been commented on, and the comments on it that matched the filters. */
interface CommentedItem {
  id: string;
  title: string;
  type: string;
  /** False when the thing commented on is no longer in the workspace. */
  present: boolean;
  threads: ThreadEntry[];
  latest: string;
}

export interface ReviewPageProps {
  workspaceId: string;
  writable: boolean;
  /** The project whose comments these are. Null is the whole workspace, and says so. */
  projectId: string | null;
  onOpenObject?: (objectId: string, type: string) => void;
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

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function resultData<T>(result: RendererCommandResult, key: string): T | undefined {
  if (result.error !== undefined) throw new Error(result.error.message);
  return (result.data ?? {})[key] as T | undefined;
}

/**
 * The threads gathered under the things they are about, newest first.
 *
 * An inbox is read from the top, so an item is placed by its most recent comment rather than by
 * its title: what was said an hour ago is why anybody opened this page.
 */
function gather(
  threads: readonly ThreadEntry[],
  titles: ReadonlyMap<string, { title: string; type: string }>,
): CommentedItem[] {
  const items = new Map<string, CommentedItem>();
  for (const entry of threads) {
    const objectId = entry.thread.anchor.object_id;
    const known = titles.get(objectId);
    const item = items.get(objectId) ?? {
      id: objectId,
      // A comment outlives the thing it is about: the object can be in Trash while the argument
      // over it is still open. Saying so is better than showing an id nobody can read.
      title: known?.title ?? "Something no longer in the project",
      type: known?.type ?? "",
      present: known !== undefined,
      threads: [],
      latest: entry.updated_at,
    };
    item.threads.push(entry);
    if (entry.updated_at > item.latest) item.latest = entry.updated_at;
    items.set(objectId, item);
  }
  for (const item of items.values()) {
    item.threads.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }
  return [...items.values()].sort((left, right) => right.latest.localeCompare(left.latest));
}

export function ReviewPage({
  workspaceId,
  writable,
  projectId,
  onOpenObject,
}: ReviewPageProps): React.JSX.Element {
  const [status, setStatus] = useState<ThreadStatus | "all">("open");
  const [mine, setMine] = useState(false);
  const [mentions, setMentions] = useState(false);
  const [involving, setInvolving] = useState(false);
  const [items, setItems] = useState<CommentedItem[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<CommentedItem[]> => {
    // The titles come from one pass over the workspace rather than one read per thread. Ten
    // comments on one paper would otherwise be ten reads of the same paper.
    const [listed, objects] = await Promise.all([
      invoke(workspaceId, "kiwi.thread.list", {
        ...(status === "all" ? {} : { status }),
        ...(mine ? { mine: true } : {}),
        ...(mentions ? { mentions: true } : {}),
        ...(involving ? { involving_me: true } : {}),
        ...(projectId === null ? {} : { project_id: projectId }),
      }),
      invoke(workspaceId, "kiwi.object.list", {}),
    ]);
    const threads = resultData<ThreadEntry[]>(listed, "threads") ?? [];
    const known = resultData<Array<{ id: string; title: string; type: string }>>(
      objects,
      "objects",
    );
    return gather(threads, new Map((known ?? []).map((object) => [object.id, object])));
  }, [involving, mentions, mine, projectId, status, workspaceId]);

  useEffect(() => {
    let active = true;
    setItems(null);
    setError(null);
    void load()
      .then((gathered) => {
        if (active) setItems(gathered);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Kiwi could not read the comments.");
        setItems([]);
      });
    return () => {
      active = false;
    };
  }, [load, revision]);

  // The chosen item follows the list: a filter that no longer includes what was open has to leave
  // something on the screen, and the top of the inbox is what the page is showing anyway.
  const showing = (items ?? []).find((item) => item.id === chosen) ?? (items ?? [])[0] ?? null;

  const narrowed = status !== "open" || mine || mentions || involving;

  function filterButton(label: string, pressed: boolean, press: () => void): React.JSX.Element {
    return (
      <button type="button" aria-pressed={pressed} onClick={press}>
        {label}
      </button>
    );
  }

  return (
    <section className="review" aria-labelledby="review-title">
      <header className="page-head">
        <h2 id="review-title">Review</h2>
        {/* The filters are chips in the control row, where the Library keeps its own. */}
        <div className="review__filters" role="group" aria-label="Which comments to show">
          {filterButton("Open", status === "open", () => setStatus("open"))}
          {filterButton("Settled", status === "resolved", () => setStatus("resolved"))}
          {filterButton("Both", status === "all", () => setStatus("all"))}
          <span className="review__divider" aria-hidden="true" />
          {/*
            Involves me is the union of the other two rather than a third kind of thing: written in
            or named in. It is here because it is what the Dashboard counts, and a number on the
            Dashboard that cannot be reached from the page it points at is a number nobody can act
            on.
          */}
          {filterButton("Involves me", involving, () => setInvolving((value) => !value))}
          {filterButton("Mine", mine, () => setMine((value) => !value))}
          {filterButton("Mentions me", mentions, () => setMentions((value) => !value))}
        </div>
      </header>
      <p className="page-lead">
        {projectId === null
          ? "Every comment in this workspace. No project is open, so nothing is narrowed to one."
          : "Every comment in this project, wherever it was left."}
      </p>

      {error === null ? null : (
        <p className="review__error" role="alert">
          {error}
        </p>
      )}

      {items === null ? <p className="review__quiet">Reading comments…</p> : null}

      {items !== null && items.length === 0 ? (
        <p className="review__quiet">
          {narrowed
            ? "No comments match. Widen the filters to see the rest."
            : "Nothing has been asked yet. Comments left on a paper, a note, or a passage of the manuscript arrive here."}
        </p>
      ) : null}

      {items === null || items.length === 0 ? null : (
        <div className="review__body">
          <ul className="review__items" aria-label="Comments by what they are about">
            {items.map((item) => (
              <li key={item.id} className="review__item" aria-current={showing?.id === item.id}>
                <h4>
                  {item.title}
                  <small>
                    {item.threads.length}{" "}
                    {item.threads.length === 1 ? "conversation" : "conversations"}
                  </small>
                </h4>
                <ul>
                  {item.threads.map((entry) => (
                    <li key={entry.id} data-status={entry.thread.status}>
                      <button type="button" onClick={() => setChosen(item.id)}>
                        <span>{entry.title}</span>
                        <small>
                          {entry.thread.messages.length}{" "}
                          {entry.thread.messages.length === 1 ? "message" : "messages"} ·{" "}
                          {displayTime(entry.updated_at)}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          {showing === null ? null : (
            <div className="review__panel">
              <header>
                <h4>{showing.title}</h4>
                {!showing.present || onOpenObject === undefined ? null : (
                  <button type="button" onClick={() => onOpenObject(showing.id, showing.type)}>
                    Open it
                  </button>
                )}
              </header>
              {/*
                The whole conversation on this item, not the part of it the filters matched. A
                reply only means something beside what it answers, and a settled comment hidden
                from a page filtered to open ones would take its own argument with it.
              */}
              <CommentThreads
                workspaceId={workspaceId}
                objectId={showing.id}
                writable={writable}
                onChange={() => setRevision((value) => value + 1)}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
