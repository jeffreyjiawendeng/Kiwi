import { useCallback, useEffect, useRef, useState } from "react";
import { PdfReader } from "./PdfReader.js";
import { clampShare, companionFor, splitAfter } from "./reader-split.js";
import type { PdfLoader } from "./pdf-document.js";

/**
 * The Reader page, holding one document or two.
 *
 * A paper is usually read against something: the paper it argues with, the one it takes its
 * method from, the supplement its numbers are in. So the second document opens inside the Reader
 * beside the first, with the tab strip above still saying what is open, rather than in a second
 * window somebody then has to arrange.
 *
 * Each side is a whole Reader, its own zoom, its own search, its own marks, because half a
 * Reader is not much use for the paper you are checking against.
 */

export interface ReaderDocument {
  assetId: string;
  title: string;
  objectId: string;
}

/** How far the divider moves per arrow key: enough to see, small enough to aim with. */
const KEYBOARD_STEP = 0.04;

export function ReaderSplit({
  workspaceId,
  documents,
  activeDocument,
  projectId,
  writable,
  onDetach,
  reveal = null,
  loader,
}: {
  workspaceId: string;
  documents: readonly ReaderDocument[];
  activeDocument: string | null;
  projectId?: string | null;
  writable?: boolean;
  /** Opens one of the two documents in a window of its own. */
  onDetach?: (document: ReaderDocument) => void;
  /**
   * A mark to open on, in whichever of the open documents it is on.
   *
   * Named by file rather than handed to whichever side is active: a quotation followed back to a
   * paper that is already open beside the one being read belongs on that side, not on this one.
   */
  reveal?: { assetId: string; annotationId: string; token: number } | null;
  /** Injected by tests, and handed to both sides. */
  loader?: PdfLoader;
}): React.JSX.Element | null {
  const [compared, setCompared] = useState<string | null>(null);
  const [share, setShare] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const panes = useRef<HTMLDivElement>(null);
  // The tab that was selected before this one. Read while rendering rather than after it, so a
  // swap never draws the same document on both sides, even for a frame.
  const previous = useRef<string | null>(null);

  const left = documents.find((tab) => tab.assetId === activeDocument) ?? documents[0];
  const active = left?.assetId ?? null;
  const open = documents.map((tab) => tab.assetId);
  const right = active === null ? null : splitAfter(compared, active, previous.current, open);
  const beside = documents.find((tab) => tab.assetId === right);

  useEffect(() => {
    previous.current = active;
    if (right !== compared) setCompared(right);
  }, [active, compared, right]);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent): void => {
      const box = panes.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0) return;
      setShare(clampShare((event.clientX - box.left) / box.width));
    };
    const stop = (): void => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging]);

  const nudge = useCallback((event: React.KeyboardEvent): void => {
    if (event.key === "ArrowLeft") setShare((current) => clampShare(current - KEYBOARD_STEP));
    else if (event.key === "ArrowRight") setShare((current) => clampShare(current + KEYBOARD_STEP));
    else if (event.key === "Home") setShare(0.5);
    else return;
    event.preventDefault();
  }, []);

  if (left === undefined || active === null) return null;

  const reader = (tab: ReaderDocument): React.JSX.Element => (
    // The Paper is what marks hang from, and the project is what a claim made while reading is
    // filed in. Without them the Reader can turn pages and nothing else.
    <PdfReader
      workspaceId={workspaceId}
      assetId={tab.assetId}
      title={tab.title}
      objectId={tab.objectId}
      projectId={projectId ?? null}
      writable={writable ?? false}
      reveal={
        reveal !== null && reveal.assetId === tab.assetId
          ? { annotationId: reveal.annotationId, token: reveal.token }
          : null
      }
      {...(onDetach === undefined ? {} : { onDetach: () => onDetach(tab) })}
      {...(loader === undefined ? {} : { loader })}
    />
  );

  return (
    <div className="reader-split">
      <div className="reader-split__bar">
        {beside === undefined ? (
          <button
            type="button"
            disabled={documents.length < 2}
            title={
              documents.length < 2
                ? "Open a second document to compare this one against"
                : "Show a second document beside this one"
            }
            onClick={() => setCompared(companionFor(open, active, previous.current))}
          >
            Compare
          </button>
        ) : (
          <>
            <label htmlFor="reader-compare-with">Beside it</label>
            <select
              id="reader-compare-with"
              value={beside.assetId}
              onChange={(event) => setCompared(event.target.value)}
            >
              {documents
                .filter((tab) => tab.assetId !== active)
                .map((tab) => (
                  <option key={tab.assetId} value={tab.assetId}>
                    {tab.title}
                  </option>
                ))}
            </select>
            <button type="button" onClick={() => setCompared(null)}>
              Close comparison
            </button>
          </>
        )}
      </div>

      {/* Keyed by document rather than by side, so swapping the two sides moves each Reader
          across with everything it was holding: the page it is on, its zoom, its search. */}
      <div className="reader-split__panes" ref={panes}>
        <section
          key={left.assetId}
          className="reader-split__pane"
          data-document={left.assetId}
          style={beside === undefined ? undefined : { flex: `0 0 ${String(share * 100)}%` }}
        >
          {reader(left)}
        </section>
        {beside === undefined ? null : (
          <div
            key="handle"
            className="reader-split__handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Width of the left document"
            aria-valuenow={Math.round(share * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            tabIndex={0}
            onKeyDown={nudge}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
          />
        )}
        {beside === undefined ? null : (
          <section
            key={beside.assetId}
            className="reader-split__pane"
            data-document={beside.assetId}
          >
            {reader(beside)}
          </section>
        )}
      </div>
    </div>
  );
}
