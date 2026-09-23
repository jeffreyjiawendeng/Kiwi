import { useEffect, useState } from "react";
import { readBridge } from "./bridge.js";
import {
  UNDO_WINDOW_MS,
  forgetUndo,
  lastUndo,
  subscribeUndo,
  type UndoableAction,
} from "./undo-stack.js";

/**
 * The offer to take back what just happened.
 *
 * Transient on purpose. It appears when something undoable is done, says what it will undo, and
 * goes away on its own: a bar that stayed would become part of the furniture and stop being read,
 * which is the failure mode of every permanent notification anybody has ever built.
 *
 * It never takes focus and it is not a dialog. Somebody who meant to do the thing should be able
 * to carry on typing without pressing anything, and somebody who did not should find one button
 * where they are already looking.
 */
export function UndoBar({ workspaceId }: { workspaceId: string | null }): React.JSX.Element | null {
  const [offer, setOffer] = useState<UndoableAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setOffer(lastUndo());
    return subscribeUndo((action) => {
      setFailed(false);
      setOffer(action);
    });
  }, []);

  useEffect(() => {
    if (offer === null) return;
    // Measured from when the action happened, not from when this rendered: an offer restored
    // after a re-render should not get a fresh twenty seconds.
    const remaining = UNDO_WINDOW_MS - (Date.now() - offer.at);
    if (remaining <= 0) {
      setOffer(null);
      return;
    }
    const timer = setTimeout(() => setOffer(null), remaining);
    return () => clearTimeout(timer);
  }, [offer]);

  if (offer === null) return null;

  async function run(action: UndoableAction): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || workspaceId === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const requestId = crypto.randomUUID();
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: action.command,
        args: action.args,
      });
      if (result.error !== undefined) {
        // Said rather than swallowed. The usual cause is that the thing moved on since -- somebody
        // else saved it, or it was changed again here -- and that is worth knowing.
        setFailed(true);
        return;
      }
      forgetUndo();
      setOffer(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="undo-bar" role="status" aria-label="Undo">
      <span className="undo-bar__what">
        {failed ? "That could not be undone. It has changed since." : offer.label + "?"}
      </span>
      {failed ? null : (
        <button type="button" disabled={busy} onClick={() => void run(offer)}>
          {offer.label}
        </button>
      )}
      <button
        type="button"
        className="undo-bar__dismiss"
        onClick={() => {
          forgetUndo();
          setOffer(null);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
