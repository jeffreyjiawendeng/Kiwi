import { useEffect, useRef, useState } from "react";
import type { SyncStanding } from "./sync-status.js";

/**
 * Whether this workspace is reaching anybody else, in the top bar.
 *
 * A dot while everything is working, and a dot with the word beside it when it is not. Nothing
 * needs saying about a synchronization that is happening; "Offline" and "Conflicted" are two
 * things somebody has to act on, and a colour is not a thing you can act on if you cannot see it.
 *
 * The reason it is a button and not a label is that every one of the four states raises a
 * question -- what is waiting, what was refused, how long has this been true -- and the answer is
 * a few lines rather than a tooltip.
 */
export function SyncStatus({
  standing,
}: {
  standing: SyncStanding | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function dismiss(event: PointerEvent): void {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpen(false);
    }

    function dismissWithKeyboard(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [open]);

  // Nothing signed in, or no workspace on this window. See `standingFrom`: there is no state of
  // sharing to report, and a resting state would be a claim about one.
  if (standing === null) return null;

  // Working and waiting are the two states nobody has to do anything about.
  const quiet = standing.state === "synchronized" || standing.state === "syncing";

  return (
    <div className="sync-status" ref={box}>
      <button
        type="button"
        className="sync-status__trigger"
        data-state={standing.state}
        data-quiet={quiet || undefined}
        aria-expanded={open}
        title={standing.label}
        aria-label={`Synchronization: ${standing.label}. ${standing.summary}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sync-status__dot" aria-hidden="true" />
        {quiet ? null : <span>{standing.label}</span>}
      </button>
      {open ? (
        <section className="sync-status__popover" aria-label="Synchronization">
          <strong>{standing.label}</strong>
          <p>{standing.summary}</p>
          {standing.pending.length > 0 ? (
            <ul className="sync-status__pending">
              {standing.pending.map((line) => (
                <li key={line.label}>
                  <span>{line.label}</span>
                  <b>{line.count}</b>
                </li>
              ))}
            </ul>
          ) : null}
          {standing.failure === null ? null : (
            <p className="sync-status__failure">{standing.failure}</p>
          )}
          <p className="sync-status__age">{standing.lastSuccess}</p>
        </section>
      ) : null}
    </div>
  );
}
