/**
 * Asking the main process what is still waiting to be sent.
 *
 * Everything the answer is made of already lives in this machine's own queues, so this is a read
 * of local state rather than a request to anybody. It is still a poll: synchronization runs when a
 * command is saved and there is no channel from the main process back to the renderer yet, so the
 * only way to notice that a queue has drained is to look. Ten seconds, which is slow enough to
 * cost nothing and quick enough that a save does not sit under the word "Syncing" for long.
 *
 * It stops when the window is not focused, like presence does. Nothing here announces anything, so
 * stopping only saves work -- but it also freezes the "last synchronized" time, which is why
 * coming back to the window asks again straight away instead of waiting out the tick.
 */

import { useEffect, useMemo, useState } from "react";
import { readBridge, type RendererWorkspaceSyncStatusResult } from "./bridge.js";
import { standingFrom, type SyncStanding } from "./sync-status.js";

export const SYNC_STATUS_INTERVAL_MS = 10_000;

const NOTHING: RendererWorkspaceSyncStatusResult = { status: "unknown" };

export function useSyncStatus(workspaceId: string | null): SyncStanding | null {
  // Which workspace the answer is about, and not only what it said: switching workspaces is a
  // render and clearing the answer is an effect, so for one flush the answer in hand is about the
  // workspace that was open a moment ago.
  const [answer, setAnswer] = useState<{
    result: RendererWorkspaceSyncStatusResult;
    at: Date;
    about: string | null;
  }>({ result: NOTHING, at: new Date(), about: null });

  useEffect(() => {
    setAnswer({ result: NOTHING, at: new Date(), about: workspaceId });
    const bridge = readBridge();
    if (bridge === null || workspaceId === null || workspaceId === "") return;

    let live = true;
    let focused = document.hasFocus();
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const ask = async (): Promise<void> => {
      if (asking || !live || !focused) return;
      asking = true;
      let result: RendererWorkspaceSyncStatusResult;
      try {
        result = await bridge.readWorkspaceSyncStatus();
      } catch {
        result = NOTHING;
      } finally {
        asking = false;
      }
      if (!live || !focused) return;
      setAnswer({ result, at: new Date(), about: workspaceId });
      stop();
      timer = setTimeout(() => void ask(), SYNC_STATUS_INTERVAL_MS);
    };

    const onFocus = (): void => {
      if (focused) return;
      focused = true;
      void ask();
    };

    const onBlur = (): void => {
      focused = false;
      stop();
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    void ask();

    return () => {
      live = false;
      stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [workspaceId]);

  // Against the clock the answer came on, not this render's. How long ago it last synchronized is
  // what that answer supports; measuring it again later would count the same minutes twice.
  return useMemo(
    () => (answer.about === workspaceId ? standingFrom(answer.result, answer.at) : null),
    [answer, workspaceId],
  );
}
