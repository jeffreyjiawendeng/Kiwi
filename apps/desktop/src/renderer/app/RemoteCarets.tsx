/**
 * Everybody else's caret, drawn.
 *
 * Placed rather than laid out: the marks sit on top of the text and take no space in it, because a
 * caret that pushed the words along would move the document under the person reading it every time
 * somebody else typed somewhere above.
 *
 * Hidden from screen readers. The row of avatars in the top bar already says who is here, by name,
 * and a caret that announced itself every five seconds would talk over whatever is being read.
 *
 * Where the marks go is measured, and measuring has to happen after the browser has laid the text
 * out, which is why it is a layout effect and not a calculation during rendering. What is drawn is
 * therefore always one measurement behind nothing: the effect runs in the same frame.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { CaretSpot } from "./caret-spots.js";
import type { RemoteCaret } from "./remote-carets.js";

interface RemoteCaretsProps {
  carets: readonly RemoteCaret[];
  /**
   * Where an offset sits in the box these are drawn in, or null if it does not sit anywhere.
   *
   * Must keep its identity while the text it measures is unchanged: it is what says the placing
   * has to be done again.
   */
  locate(offset: number): CaretSpot | null;
}

const NOWHERE: ReadonlyMap<string, CaretSpot> = new Map();

export function RemoteCarets({ carets, locate }: RemoteCaretsProps): React.JSX.Element | null {
  const [spots, setSpots] = useState<ReadonlyMap<string, CaretSpot>>(NOWHERE);
  // The text has not changed but the lines it is broken into have, so every caret is somewhere
  // else. Nothing else on the screen can tell us that.
  const [resized, setResized] = useState(0);

  const place = useCallback(() => {
    const found = new Map<string, CaretSpot>();
    for (const caret of carets) {
      const spot = locate(caret.offset);
      if (spot !== null) found.set(caret.userId, spot);
    }
    setSpots(found.size === 0 ? NOWHERE : found);
  }, [carets, locate]);

  useLayoutEffect(() => {
    place();
  }, [place, resized]);

  useEffect(() => {
    function again(): void {
      setResized((count) => count + 1);
    }
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, []);

  if (carets.length === 0) return null;

  return (
    <div className="remote-carets" aria-hidden="true">
      {carets.map((caret) => {
        const spot = spots.get(caret.userId);
        if (spot === undefined) return null;
        const style: React.CSSProperties = {
          left: `${spot.left}px`,
          top: `${spot.top}px`,
          background: caret.colour,
        };
        if (spot.height > 0) style.height = `${spot.height}px`;
        return (
          <span
            key={caret.userId}
            className="remote-caret"
            data-person={caret.userId}
            style={style}
          >
            <span
              className={`remote-caret__name${caret.labelled ? "" : " remote-caret__name--gone"}`}
              style={{ background: caret.colour }}
            >
              {caret.name}
            </span>
          </span>
        );
      })}
    </div>
  );
}
