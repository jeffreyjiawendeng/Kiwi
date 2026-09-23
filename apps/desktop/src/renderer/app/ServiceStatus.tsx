import { useCallback, useEffect, useState } from "react";
import {
  readBridge,
  type RendererAccountServiceStatus,
  type RendererRuntimeHealth,
} from "./bridge.js";
import { offlineExplanation, serviceRows } from "./service-status.js";
import type { SyncStanding } from "./sync-status.js";

const POLL_MS = 15_000;

/**
 * The state of everything Kiwi runs behind the page, on Home.
 *
 * Polled rather than pushed, like presence and sync status, for the same reason: there is no
 * channel from the main process back to the renderer yet. Fifteen seconds, which is slower than
 * either of those because nothing here changes on a save.
 *
 * The switch is the one control on this page that changes what Kiwi does rather than what it
 * shows, so it says the consequence underneath rather than only its own name.
 */
export function ServiceStatus({
  sharing,
  pollMs = POLL_MS,
}: {
  sharing: SyncStanding | null;
  pollMs?: number;
}): React.JSX.Element {
  const [service, setService] = useState<RendererAccountServiceStatus | null>(null);
  const [runtime, setRuntime] = useState<RendererRuntimeHealth | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  const look = useCallback(async () => {
    const bridge = readBridge();
    if (bridge === null) return;
    // Three separate readings, and a panel that reports two of them is better than one that
    // reports none. Each is caught on its own, and the whole thing again: an older bridge that
    // does not have one of these at all throws before there is a promise to catch on.
    try {
      const [next, health, chosen] = await Promise.all([
        Promise.resolve(bridge.getAccountServiceStatus()).catch(() => null),
        Promise.resolve(bridge.getRuntimeHealth()).catch(() => null),
        Promise.resolve(bridge.readOfflineMode()).catch(() => false),
      ]);
      setService(next);
      setRuntime(health);
      setOffline(chosen);
    } catch {
      // Nothing was read, so nothing is claimed: the rows keep saying they have not checked.
    }
  }, []);

  useEffect(() => {
    void look();
    const timer = setInterval(() => void look(), pollMs);
    return () => clearInterval(timer);
  }, [look, pollMs]);

  function choose(next: boolean): void {
    const bridge = readBridge();
    if (bridge === null) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => bridge.setOfflineMode({ offline: next }))
      .then((settled) => setOffline(settled))
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        void look();
      });
  }

  const rows = serviceRows({ service, runtime, sharing, offline });

  return (
    <section className="service-status" aria-label="Service status">
      <h3>Service status</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.name} data-state={row.state}>
            <span className="service-status__name">{row.name}</span>
            <span className="service-status__detail">{row.detail}</span>
          </li>
        ))}
      </ul>
      <label className="service-status__offline">
        <input
          type="checkbox"
          checked={offline}
          disabled={busy}
          onChange={(event) => choose(event.currentTarget.checked)}
        />
        Work offline
      </label>
      <p className="service-status__explanation">{offlineExplanation(offline)}</p>
    </section>
  );
}
