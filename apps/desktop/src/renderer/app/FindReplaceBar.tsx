import { useEffect, useRef } from "react";
import type { FindOptions } from "./find-replace.js";

/**
 * The find and replace bar.
 *
 * It knows nothing about what is being searched. The manuscript is a node tree in one mode and a
 * buffer of source in the other, and the editor above owns both, this only collects what to look
 * for and reports which button was pressed.
 */

export interface FindReplaceBarProps {
  query: string;
  replacement: string;
  options: FindOptions;
  /** How many matches there are and which one is current, already worded. */
  summary: string;
  /** What the last replacement did, if anything. */
  notice: string | null;
  /** LaTeX source opened read-only still searches; it just cannot be rewritten. */
  writable: boolean;
  /** Ids have to be unique on a page that may hold more than one editor. */
  idPrefix: string;
  onQueryChange(next: string): void;
  onReplacementChange(next: string): void;
  onOptionsChange(next: FindOptions): void;
  /**
   * Moves to the next or previous match. `reveal` asks for the caret to be put in the manuscript,
   * which a click can afford and Enter in the find field cannot, the next Enter would type there.
   */
  onStep(direction: 1 | -1, reveal: boolean): void;
  onReplace(): void;
  onReplaceAll(): void;
  onClose(): void;
}

export function FindReplaceBar({
  query,
  replacement,
  options,
  summary,
  notice,
  writable,
  idPrefix,
  onQueryChange,
  onReplacementChange,
  onOptionsChange,
  onStep,
  onReplace,
  onReplaceAll,
  onClose,
}: FindReplaceBarProps): React.JSX.Element {
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Opening the bar and then having to click into it is the whole gesture done twice.
    field.current?.focus();
    field.current?.select();
  }, []);

  return (
    <div className="find-replace" role="search" aria-label="Find and replace">
      <div className="find-replace__row">
        <label htmlFor={`${idPrefix}-find`}>Find</label>
        <input
          id={`${idPrefix}-find`}
          ref={field}
          type="text"
          value={query}
          autoComplete="off"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1, false);
          }}
        />
        <span className="find-replace__count" role="status">
          {query === "" ? "" : summary}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          disabled={query === ""}
          onClick={() => onStep(-1, true)}
        >
          Previous
        </button>
        <button
          type="button"
          aria-label="Next match"
          disabled={query === ""}
          onClick={() => onStep(1, true)}
        >
          Next
        </button>
        <button type="button" aria-label="Close find and replace" onClick={onClose}>
          Close
        </button>
      </div>

      {writable ? (
        <div className="find-replace__row">
          <label htmlFor={`${idPrefix}-replace`}>Replace with</label>
          <input
            id={`${idPrefix}-replace`}
            type="text"
            value={replacement}
            autoComplete="off"
            onChange={(event) => onReplacementChange(event.target.value)}
          />
          <button type="button" disabled={query === ""} onClick={onReplace}>
            Replace
          </button>
          <button type="button" disabled={query === ""} onClick={onReplaceAll}>
            Replace all
          </button>
          {notice === null ? null : (
            <span className="find-replace__notice" role="status">
              {notice}
            </span>
          )}
        </div>
      ) : null}

      <div className="find-replace__row">
        <label>
          <input
            type="checkbox"
            checked={options.caseSensitive}
            onChange={(event) =>
              onOptionsChange({ ...options, caseSensitive: event.target.checked })
            }
          />
          Match case
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.wholeWord}
            onChange={(event) => onOptionsChange({ ...options, wholeWord: event.target.checked })}
          />
          Whole word
        </label>
      </div>
    </div>
  );
}
