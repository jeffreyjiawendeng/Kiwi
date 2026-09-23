/**
 * Asking, every five seconds, who else has this open.
 *
 * The poll is both halves of presence at once: the request records that you are here and the
 * answer says who else is. That is why it stops when the window loses focus. A window sitting
 * behind three others is not somebody you can expect an answer from, so it stops announcing
 * itself and drops off everybody else's row about thirty seconds later, which is what presence is
 * supposed to mean. It also stops showing anything, because avatars that are no longer being
 * refreshed claim knowledge that stopped being gathered.
 *
 * Nothing here is a subscription. There is no channel from the main process to the renderer yet,
 * and a five-second tick does not need one; see workspace-operations.md for where that stands.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { readBridge, type RendererWorkspacePresenceResult } from "./bridge.js";
import { readingFrom, type PresenceMember, type PresenceReading } from "./presence.js";

/** Records live thirty seconds. Six polls to lose somebody is slack enough for one to be dropped. */
export const PRESENCE_INTERVAL_MS = 5_000;

const NOTHING: RendererWorkspacePresenceResult = { status: "unavailable" };

export function usePresence(options: {
  /** The object being looked at, or null when the window is not on one. */
  documentId: string | null;
  /** For names. Presence with no roster shows nobody -- see below. */
  members: readonly PresenceMember[];
  /** The reader, so they can be left out of their own row. */
  selfUserId: string | null;
  /** Where the caret is. Everybody else's window draws it; see `remote-carets.ts`. */
  cursor?: number;
}): PresenceReading {
  const { documentId, members, selfUserId, cursor = 0 } = options;
  // Which document the answer is about, and not only what it said. Clearing it is an effect and
  // opening a document is a render, so for one flush the answer in hand is about the document that
  // was open a moment ago -- and an answer about another document is not a late answer, it is
  // somebody else's.
  const [answer, setAnswer] = useState<{
    result: RendererWorkspacePresenceResult;
    at: Date;
    about: string | null;
  }>({ result: NOTHING, at: new Date(), about: null });

  // The caret moves far more often than the poll fires, and a new document is a new effect. Read
  // through a ref so that typing does not tear down the timer and start the interval over.
  const caret = useRef(cursor);
  caret.current = cursor;

  useEffect(() => {
    setAnswer({ result: NOTHING, at: new Date(), about: documentId });
    const bridge = readBridge();
    if (bridge === null || documentId === null) return;

    let live = true;
    let focused = document.hasFocus();
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const poll = async (): Promise<void> => {
      // One question at a time. A poll that takes longer than the tick must not have another
      // stacked behind it, or a slow service turns into a queue that never empties.
      if (asking || !live || !focused) return;
      asking = true;
      let result: RendererWorkspacePresenceResult;
      try {
        result = await bridge.readWorkspacePresence({ documentId, cursor: caret.current });
      } catch {
        result = NOTHING;
      } finally {
        asking = false;
      }
      // An answer that arrives after the window was left, or after this document was closed, is
      // about a moment that has passed. It is not shown, and it does not schedule another.
      if (!live || !focused) return;
      setAnswer({ result, at: new Date(), about: documentId });
      stop();
      timer = setTimeout(() => void poll(), PRESENCE_INTERVAL_MS);
    };

    const onFocus = (): void => {
      if (focused) return;
      focused = true;
      // Straight away rather than on the next tick. Coming back to a window and waiting five
      // seconds to be told who is here reads as nobody being here.
      void poll();
    };

    const onBlur = (): void => {
      focused = false;
      stop();
      setAnswer({ result: NOTHING, at: new Date(), about: documentId });
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    void poll();

    return () => {
      live = false;
      stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [documentId]);

  // Shaped at render rather than on arrival, so that a roster which lands after the first answer
  // names the people already on screen instead of leaving them unnamed until the next tick.
  //
  // The clock used is the moment the answer came, not the moment of this render. Expiry is what
  // that answer supports; re-reading it against a later clock would be counting the same thirty
  // seconds twice.
  return useMemo(
    () =>
      readingFrom(answer.about === documentId ? answer.result : NOTHING, {
        members,
        selfUserId,
        now: answer.at,
      }),
    [answer, documentId, members, selfUserId],
  );
}
