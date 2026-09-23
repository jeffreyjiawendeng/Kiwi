import { useEffect, useState } from "react";
import { readBridge, type RendererRuntimeHealth } from "./bridge.js";

const POLL_MS = 4000;

export interface RuntimeNoticeProps {
  pollMs?: number;
}

/**
 * Nonblocking surface for a contained failure. It reports what recovered and never takes
 * focus, so a background crash cannot interrupt what the user is doing.
 */
export function RuntimeNotice({ pollMs = POLL_MS }: RuntimeNoticeProps): React.JSX.Element | null {
  const [health, setHealth] = useState<RendererRuntimeHealth | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) return;

    let active = true;

    async function poll(): Promise<void> {
      try {
        const next = await bridge!.getRuntimeHealth();
        if (!active) return;
        setHealth((previous) => {
          if (next.rendererFailure !== null || next.worker === "failed") setDismissed(false);
          return next.rendererFailure === null &&
            previous !== null &&
            previous.rendererFailure !== null
            ? { ...next, rendererFailure: previous.rendererFailure }
            : next;
        });
      } catch {
        // Health reporting is advisory. A failed poll is not itself worth surfacing.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  if (health === null || dismissed) return null;

  const workerFailed = health.worker === "failed";
  const rendererRecovered = health.rendererFailure !== null;

  if (!workerFailed && !rendererRecovered && health.workerRestarts === 0) return null;

  return (
    <div className="notice" role="status">
      <div className="notice__body">
        {rendererRecovered ? (
          <p className="notice__line">
            The window stopped responding and reloaded. Unsaved input in the panel was lost.
          </p>
        ) : null}
        {workerFailed ? (
          <p className="notice__line">
            The background worker stopped after repeated failures. Kiwi keeps working without it.
          </p>
        ) : null}
        {!workerFailed && health.workerRestarts > 0 ? (
          <p className="notice__line">
            The background worker restarted {health.workerRestarts}{" "}
            {health.workerRestarts === 1 ? "time" : "times"}.
          </p>
        ) : null}
      </div>
      <button type="button" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
