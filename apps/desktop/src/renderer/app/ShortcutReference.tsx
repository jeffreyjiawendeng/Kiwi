import { useEffect } from "react";
import { SHORTCUT_GROUPS } from "./shortcuts.js";

/**
 * What every key does, in one place somebody can get to.
 *
 * Reachable two ways, on purpose: `?` for whoever already knows there is a reference, and an entry
 * in the palette for whoever does not. Nothing in Kiwi is reachable only by shortcut, and a list of
 * shortcuts would be a poor place to break that rule.
 *
 * Where each one applies is a column rather than an omission. Several of these work in one editor
 * or one list and nowhere else, and a reference that listed them beside the global ones without
 * saying so would be teaching somebody a key that does nothing where they are standing.
 */
export function ShortcutReference({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    function dismiss(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);

  return (
    <div className="shortcut-reference" role="dialog" aria-label="Keyboard shortcuts">
      <header>
        <h2>Keyboard shortcuts</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3>{group.heading}</h3>
          <ul>
            {group.shortcuts.map((shortcut) => (
              <li key={shortcut.keys}>
                <kbd>{shortcut.keys}</kbd>
                <span className="shortcut-reference__does">{shortcut.does}</span>
                <span className="shortcut-reference__where">{shortcut.where}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
