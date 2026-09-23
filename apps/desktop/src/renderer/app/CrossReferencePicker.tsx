import { useId, useMemo, useState } from "react";
import { crossReferenceLabel } from "@kiwi/contracts";
import type { EditorTarget } from "./crossref-extension.js";

/**
 * Choosing what a cross-reference points at.
 *
 * The list is the document's own figures, tables, sections, and displayed equations, in the order
 * they appear, with the numbers they currently carry. Numbers are shown because they are what the
 * author is looking for, "the third figure" is how a figure is held in mind while writing, and
 * they are not what is stored, because by the time the paper is read they may be different.
 */

export interface CrossReferencePickerProps {
  targets: readonly EditorTarget[];
  onInsert: (target: EditorTarget) => void;
  onCancel: () => void;
}

/** A short description of a target, so two figures are told apart by more than their number. */
function describe(target: EditorTarget): string {
  const text = target.text.trim().replace(/\s+/gu, " ");
  if (text === "") return "No caption";
  return text.length > 80 ? `${text.slice(0, 79)}...` : text;
}

export function CrossReferencePicker({
  targets,
  onInsert,
  onCancel,
}: CrossReferencePickerProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return targets;
    return targets.filter((target) => {
      const label = crossReferenceLabel(target.kind, target.number).toLocaleLowerCase();
      return label.includes(needle) || target.text.toLocaleLowerCase().includes(needle);
    });
  }, [query, targets]);

  return (
    <div className="citation-picker__backdrop" role="presentation">
      <section
        className="citation-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Insert a cross-reference"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <label htmlFor={searchId}>Find what to point at</label>
        <input
          id={searchId}
          type="search"
          autoFocus
          value={query}
          placeholder="Figure, table, section, or equation"
          onChange={(event) => setQuery(event.target.value)}
        />

        {matching.length === 0 ? (
          <p className="citation-picker__quiet">
            {targets.length === 0
              ? "There is nothing to point at yet. A figure, a table, a heading, or a displayed equation is what a cross-reference refers to."
              : "Nothing here matches that."}
          </p>
        ) : (
          <ul className="citation-picker__results">
            {matching.map((target) => (
              <li key={target.position}>
                <button type="button" onClick={() => onInsert(target)}>
                  <strong>{crossReferenceLabel(target.kind, target.number)}</strong>
                  <span>{describe(target)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="citation-picker__actions">
          <button className="button" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
