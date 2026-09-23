/**
 * The outline, beside the manuscript.
 *
 * A list of the headings, each with the words of the section under it, and each a way to get
 * there. Dragging one reorders the manuscript itself rather than the list, so what is dragged is
 * the whole section, see {@link planMove}. Alt with an arrow key does the same move, because a
 * panel that can only be operated by dragging is a panel some people cannot operate.
 */

import { useState } from "react";
import { planMove, planStep, type OutlineHeading, type SectionMove } from "./outline.js";

interface OutlinePanelProps {
  headings: readonly OutlineHeading[];
  /** A read-only manuscript still has an outline; it just cannot be rearranged from it. */
  writable: boolean;
  onJump(heading: OutlineHeading): void;
  onMove(plan: SectionMove): void;
}

/** How far each level is set in, and where the first one starts, in pixels. */
const INDENT = 12;
const MARGIN = 6;

export function OutlinePanel({
  headings,
  writable,
  onJump,
  onMove,
}: OutlinePanelProps): React.JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null);

  function move(plan: SectionMove | null): void {
    if (plan !== null) onMove(plan);
  }

  function step(index: number, event: React.KeyboardEvent): void {
    if (!writable || !event.altKey) return;
    const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
    if (direction === null) return;
    // Claimed, so the manuscript underneath does not also scroll.
    event.preventDefault();
    move(planStep(headings, index, direction));
  }

  return (
    <nav className="outline" aria-label="Outline">
      {headings.length === 0 ? (
        <p className="outline__empty">No headings yet</p>
      ) : (
        <ol className="outline__list">
          {headings.map((heading, index) => (
            <li
              key={`${String(heading.from)}-${heading.title}`}
              className={
                dragging === index ? "outline__item outline__item--dragging" : "outline__item"
              }
              draggable={writable}
              onDragStart={(event) => {
                setDragging(index);
                // Firefox does not begin a drag from an element that puts nothing on the clipboard.
                event.dataTransfer?.setData("text/plain", heading.title);
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              onDragOver={(event) => {
                // Without this the drop never arrives: the default is to refuse it.
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) move(planMove(headings, dragging, index));
                setDragging(null);
              }}
            >
              <button
                type="button"
                className={`outline__link outline__link--${String(heading.level)}`}
                style={{ paddingLeft: `${String(MARGIN + (heading.level - 1) * INDENT)}px` }}
                aria-label={`${heading.title === "" ? "Untitled" : heading.title}, ${String(heading.words)} ${heading.words === 1 ? "word" : "words"}`}
                onClick={() => {
                  onJump(heading);
                }}
                onKeyDown={(event) => {
                  step(index, event);
                }}
              >
                <span className="outline__title">
                  {heading.title === "" ? "Untitled" : heading.title}
                </span>
                <span className="outline__words">{heading.words}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
