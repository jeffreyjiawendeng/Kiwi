/**
 * The compiled PDF beside the source.
 *
 * A preview shows the last compile, not what has just been typed. Compiling is a process, and
 * compiling on every keystroke would be a process per keystroke, so the pane is given a new PDF
 * only when one has been made. While one is being made it dims what it already has rather than
 * emptying itself: a pane that goes blank every time typing stops is harder to work beside than
 * one that is briefly a few seconds out of date.
 *
 * The pages are drawn through the same PDF.js seam the Reader uses, so this is the paper as it
 * will print rather than a second guess at how the source would look. It scrolls on its own:
 * the source and the preview are two views of the same document, not one view in two halves, and
 * nothing here tries to keep them level with each other.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadPdfDocument, type PdfDocument, type PdfLoader, type PdfPage } from "./pdf-document.js";

interface LatexPreviewProps {
  /** The last PDF the compiler produced, as a data URL, or null if there has not been one. */
  pdf: string | null;
  /** True while a compile is running. What is on screen is the PDF from before it started. */
  compiling: boolean;
  /** Injected by tests. PDF.js needs a canvas, which the test environment does not have. */
  loader?: PdfLoader;
}

/** A page's place on screen, known before the page itself has been drawn. */
interface PageBox {
  number: number;
  label: string;
  /** Size in CSS pixels at scale 1. */
  width: number;
  height: number;
}

/** How much of the pane's width is left around a page, in CSS pixels. */
const GUTTER = 24;

function PreviewPage({
  state,
  page,
  scale,
  onNear,
}: {
  state: PageBox;
  page: PdfPage | null;
  scale: number;
  onNear: (pageNumber: number) => void;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (page === null || canvas.current === null) return;
    // The document this page came from may have been replaced by a newer compile while the
    // drawing was in flight. A page that cannot be drawn is left as the blank it already is.
    void page.render(canvas.current, scale).catch(() => undefined);
  }, [page, scale]);

  useEffect(() => {
    const element = box.current;
    if (element === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) onNear(state.number);
      },
      { threshold: 0.1 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onNear, state.number]);

  return (
    <div
      ref={box}
      className="latex-preview__page"
      style={{
        width: `${String(Math.round(state.width * scale))}px`,
        height: `${String(Math.round(state.height * scale))}px`,
      }}
      role="img"
      aria-label={`Page ${state.label}`}
    >
      <canvas ref={canvas} />
    </div>
  );
}

export function LatexPreview({
  pdf,
  compiling,
  loader = loadPdfDocument,
}: LatexPreviewProps): React.JSX.Element {
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [boxes, setBoxes] = useState<PageBox[]>([]);
  const [pages, setPages] = useState<Record<number, PdfPage>>({});
  const [current, setCurrent] = useState(1);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(520);
  const scroller = useRef<HTMLDivElement>(null);
  // Where the pane was scrolled to in the PDF being replaced.
  const wasAt = useRef<number | null>(null);

  useEffect(() => {
    if (pdf === null) return;
    let active = true;
    // Read before the swap, not after: a recompile of the same paper should leave someone who
    // is editing page nine looking at page nine.
    wasAt.current = scroller.current?.scrollTop ?? null;
    void loader(pdf)
      .then(async (opened) => {
        // Every page of a manuscript is the same size, so the first one measures all of them.
        const first = await opened.page(1);
        if (!active) {
          opened.destroy();
          return;
        }
        setDocument(opened);
        setBoxes(
          Array.from({ length: opened.pageCount }, (_unused, index) => ({
            number: index + 1,
            label: opened.pageLabel(index + 1),
            width: first.width,
            height: first.height,
          })),
        );
        setPages({ 1: first });
        setFailed(false);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [loader, pdf]);

  // The previous document is let go once the new one has taken its place on screen.
  useEffect(() => {
    return () => document?.destroy();
  }, [document]);

  useLayoutEffect(() => {
    const at = wasAt.current;
    const element = scroller.current;
    if (at === null || element === null) return;
    wasAt.current = null;
    element.scrollTop = at;
  }, [boxes]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth || 520);
    return () => observer.disconnect();
  }, []);

  // Pages are drawn as they are reached rather than all at once. A preview of a thesis that
  // redraws two hundred pages on every recompile is a preview nobody leaves open.
  useEffect(() => {
    if (document === null) return;
    let active = true;
    for (const number of [current - 1, current, current + 1]) {
      if (number < 1 || number > document.pageCount || pages[number] !== undefined) continue;
      void document.page(number).then((page) => {
        if (active) setPages((previous) => ({ ...previous, [number]: page }));
      });
    }
    return () => {
      active = false;
    };
  }, [current, document, pages]);

  const first = boxes[0];
  const scale = useMemo(
    () => (first === undefined ? 1 : Math.max((width - GUTTER) / first.width, 0.1)),
    [first, width],
  );

  /**
   * What the pane says about itself.
   *
   * A compile that failed leaves the pages from the compile before it up. The report under the
   * editor is where a failure is explained; blanking the preview as well would take away the
   * last good copy of the paper at the moment it is most wanted.
   */
  function note(): string {
    if (failed) return "Kiwi could not open the compiled PDF.";
    if (compiling) return "Compiling";
    if (boxes.length === 0) return "Nothing compiled yet";
    return boxes.length === 1 ? "1 page" : `${String(boxes.length)} pages`;
  }

  return (
    <section className="latex-preview" aria-label="Preview">
      <p className="latex-preview__note">{note()}</p>
      <div
        ref={scroller}
        className={`latex-preview__pages${compiling ? " latex-preview__pages--stale" : ""}`}
      >
        {boxes.map((box) => (
          <PreviewPage
            key={box.number}
            state={box}
            page={pages[box.number] ?? null}
            scale={scale}
            onNear={setCurrent}
          />
        ))}
      </div>
    </section>
  );
}
