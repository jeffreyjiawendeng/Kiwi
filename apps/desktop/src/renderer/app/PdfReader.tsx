import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assetUrl,
  loadPdfDocument,
  type PdfDocument,
  type PdfLoader,
  type PdfOutlineEntry,
  type PdfPage,
  type PdfTextItem,
} from "./pdf-document.js";
import {
  AnnotationOverlay,
  AnnotationSidebar,
  PointMarkComposer,
  SelectionMenu,
  SendToClaimDialog,
  SendToManuscriptDialog,
  SendToNoteDialog,
  useReaderAnnotations,
  type AnnotationTarget,
} from "./ReaderAnnotations.js";
import type { StoredAnnotationView } from "./annotations.js";
import { resolveAnchors } from "./annotation-anchors.js";
import {
  authorsOnMarks,
  marksByShownAuthors,
  stillHidden,
  useAuthorDirectory,
} from "./annotation-authors.js";
import { findPageByLabel, labelsDifferFromPositions } from "./page-labels.js";
import { dragRect, isCaptureWorthKeeping, pointerFraction } from "./pdf-capture.js";
import { pointRect, type PointKind } from "./point-marks.js";
import { searchDocument, type SearchMatch } from "./pdf-search.js";
import {
  markOpened,
  pageOffsetFraction,
  readReaderPosition,
  scrollTopForOffset,
  writeReaderPosition,
  type ReaderPosition,
} from "./reader-position.js";
import type { AnnotationRect } from "@kiwi/contracts";

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** What a document starts with and falls back to: nothing known to have lost its place. */
const EMPTY_ORPHANS: ReadonlySet<string> = new Set<string>();

/** How a document opens: everybody's marks showing, including the people you have never met. */
const NOBODY_HIDDEN: ReadonlySet<string> = new Set<string>();

/** How wide a thumbnail is drawn, in CSS pixels. */
export const THUMBNAIL_WIDTH = 120;
export type FitMode = "width" | "page" | "fixed";

/**
 * What a click on the page is for.
 *
 * One at a time, because a click cannot be both the corner of a capture and the place a sticky
 * note goes. Reading is the tool nothing has to be turned on to get.
 */
export type ReaderTool = "read" | "capture" | PointKind;

interface PdfReaderProps {
  workspaceId: string;
  assetId: string;
  title?: string;
  /** The Paper the marks belong to. Without one the Reader is read-only. */
  objectId?: string | null;
  /** The open project. A claim made from the Reader is filed in it. */
  projectId?: string | null;
  writable?: boolean;
  /**
   * Opens this document in a window of its own. Absent in a window that is already one, and in
   * any surface that has nowhere to put a second window.
   */
  onDetach?: () => void;
  /**
   * A mark to open on, asked for from somewhere else -- a quotation in a note being followed
   * back to the page it came from.
   *
   * The token is what makes clicking the same quotation a second time a second request. Without
   * one, a reader who followed a quotation, paged away, and clicked it again would be handing
   * the Reader an instruction it had already carried out.
   */
  reveal?: { annotationId: string; token: number } | null;
  /** Injected by tests. PDF.js needs a canvas, which the test environment does not have. */
  loader?: PdfLoader;
}

interface PageState {
  number: number;
  label: string;
  width: number;
  height: number;
}

/**
 * Where the top of a page sits in the scroller, whatever has been scrolled past already.
 *
 * Measured rather than added up from page heights: pages are drawn as they are approached, so
 * the heights above this one are not all known, and the ones that are known change with the zoom.
 */
function pageTopWithin(element: Element, scroller: Element): number {
  return (
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

function PageCanvas({
  page,
  state,
  scale,
  onVisible,
  marks,
  authorSlots,
  activeMark,
  onSelectMark,
  capturing,
  onCapture,
  placing,
  onPlace,
  matches,
  activeMatch,
}: {
  page: PdfPage | null;
  state: PageState;
  scale: number;
  onVisible: (pageNumber: number) => void;
  marks: StoredAnnotationView[];
  /** The layer colour of everybody but the reader, so a page says whose marks it is carrying. */
  authorSlots: ReadonlyMap<string, number>;
  activeMark: string | null;
  onSelectMark: (id: string) => void;
  /** True while the reader is dragging out figures rather than selecting text. */
  capturing: boolean;
  onCapture: (rect: AnnotationRect, canvas: HTMLCanvasElement | null) => void;
  /** The kind of mark the next click on the page leaves, and null when a click is just a click. */
  placing: PointKind | null;
  onPlace: (rect: AnnotationRect) => void;
  matches: SearchMatch[];
  activeMatch: SearchMatch | null;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [textItems, setTextItems] = useState<PdfTextItem[]>([]);
  const [dragFrom, setDragFrom] = useState<{ x: number; y: number } | null>(null);
  const [dragTo, setDragTo] = useState<{ x: number; y: number } | null>(null);
  const marquee = dragFrom === null || dragTo === null ? null : dragRect(dragFrom, dragTo);

  useEffect(() => {
    if (page === null || canvas.current === null) return;
    let active = true;
    void page.render(canvas.current, scale).catch(() => undefined);
    void page.textItems().then((items) => {
      if (active) setTextItems(items);
    });
    return () => {
      active = false;
    };
  }, [page, scale]);

  useEffect(() => {
    const element = container.current;
    if (element === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) onVisible(state.number);
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, state.number]);

  return (
    <div
      ref={container}
      className={`pdf-page${capturing ? " pdf-page--capturing" : ""}${
        placing === null ? "" : " pdf-page--placing"
      }`}
      data-page={state.number}
      data-page-label={state.label}
      id={`pdf-page-${String(state.number)}`}
      style={{
        width: `${String(state.width * scale)}px`,
        height: `${String(state.height * scale)}px`,
      }}
      aria-label={`Page ${state.label}`}
      role="img"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Placing a mark is one click and is over on the way down: there is nothing to drag out,
        // and a pin that followed the pointer until it was let go would be a pin that moved.
        if (placing !== null) {
          event.preventDefault();
          onPlace(pointRect(pointerFraction(event.currentTarget, event.clientX, event.clientY)));
          return;
        }
        if (!capturing) return;
        event.preventDefault();
        const at = pointerFraction(event.currentTarget, event.clientX, event.clientY);
        setDragFrom(at);
        setDragTo(at);
      }}
      onPointerMove={(event) => {
        if (dragFrom === null) return;
        setDragTo(pointerFraction(event.currentTarget, event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        if (dragFrom === null) return;
        const rect = dragRect(
          dragFrom,
          pointerFraction(event.currentTarget, event.clientX, event.clientY),
        );
        setDragFrom(null);
        setDragTo(null);
        if (isCaptureWorthKeeping(rect)) onCapture(rect, canvas.current);
      }}
    >
      <canvas ref={canvas} />
      {/* The text layer sits over the drawing, invisible, so a selection lands on real text.
          It never replaces the rendering, the page you see is the page PDF.js drew. */}
      <div className="pdf-page__text" aria-hidden="true">
        {textItems.map((item, index) => (
          <span
            key={`${String(index)}-${item.text}`}
            style={{
              left: `${String(item.left * scale)}px`,
              top: `${String(item.top * scale)}px`,
              fontSize: `${String(Math.max(item.height * scale, 1))}px`,
            }}
          >
            {item.text}
          </span>
        ))}
      </div>
      <AnnotationOverlay
        marks={marks}
        authorSlots={authorSlots}
        activeId={activeMark}
        onSelect={onSelectMark}
      />
      {matches.length === 0 ? null : (
        <div className="pdf-page__matches" aria-hidden="true">
          {matches.flatMap((match) =>
            match.rects.map((rect, index) => (
              <span
                key={`${String(match.offset)}-${String(index)}`}
                className={`pdf-match${
                  activeMatch !== null &&
                  activeMatch.page === match.page &&
                  activeMatch.offset === match.offset
                    ? " pdf-match--active"
                    : ""
                }`}
                style={{
                  left: `${String(rect.left * 100)}%`,
                  top: `${String(rect.top * 100)}%`,
                  width: `${String(rect.width * 100)}%`,
                  height: `${String(rect.height * 100)}%`,
                }}
              />
            )),
          )}
        </div>
      )}
      {marquee === null ? null : (
        <div
          className="pdf-page__marquee"
          aria-hidden="true"
          style={{
            left: `${String(marquee.left * 100)}%`,
            top: `${String(marquee.top * 100)}%`,
            width: `${String(marquee.width * 100)}%`,
            height: `${String(marquee.height * 100)}%`,
          }}
        />
      )}
    </div>
  );
}

/**
 * A page drawn small, for navigating a long document visually.
 *
 * Rendered only once it is near the viewport: drawing four hundred thumbnails when the sidebar
 * opens would freeze the window for exactly the documents the sidebar exists to help with.
 */
function PageThumbnail({
  page,
  state,
  active,
  onOpen,
  onNeeded,
}: {
  page: PdfPage | null;
  state: PageState;
  active: boolean;
  onOpen: () => void;
  /** Asks for this page to be loaded, once the thumbnail is close to being seen. */
  onNeeded: (pageNumber: number) => void;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const item = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (page === null || canvas.current === null) return;
    const scale = Math.min(THUMBNAIL_WIDTH / state.width, 1);
    void page.render(canvas.current, scale).catch(() => undefined);
  }, [page, state.width]);

  useEffect(() => {
    const element = item.current;
    if (element === null) return;
    if (typeof IntersectionObserver !== "function") {
      // No observer to lean on: ask for the page rather than showing a permanently blank box.
      onNeeded(state.number);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) onNeeded(state.number);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onNeeded, state.number]);

  return (
    <li ref={item}>
      <button
        type="button"
        className={`pdf-thumbnail${active ? " pdf-thumbnail--active" : ""}`}
        // "i" on its own is not a page number to anybody listening rather than looking.
        aria-label={`Page ${state.label}`}
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        <canvas ref={canvas} />
        <span>{state.label}</span>
      </button>
    </li>
  );
}

export function PdfReader({
  workspaceId,
  assetId,
  title = "Document",
  objectId = null,
  projectId = null,
  writable = true,
  onDetach,
  reveal = null,
  loader = loadPdfDocument,
}: PdfReaderProps): React.JSX.Element {
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [loaded, setLoaded] = useState<Record<number, PdfPage>>({});
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [current, setCurrent] = useState(() => readReaderPosition(workspaceId, assetId).page);
  // What is half-typed in the pager, and null when nothing is: the box then shows the page in
  // view. Held rather than acted on keystroke by keystroke, because a page called "iv" is not
  // reachable by a box that jumps away the moment "i" is a page of its own.
  const [typedPage, setTypedPage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<FitMode>("width");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [sidebar, setSidebar] = useState<"closed" | "outline" | "thumbnails" | "annotations">(
    "annotations",
  );
  const [activeMark, setActiveMark] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<ReadonlySet<string>>(EMPTY_ORPHANS);
  const [turnedOff, setTurnedOff] = useState<ReadonlySet<string>>(NOBODY_HIDDEN);
  const [tool, setTool] = useState<ReaderTool>("read");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState<string[] | null>(null);
  // Marks bound for a claim, or an empty list meaning the passage under the cursor, which is
  // not a mark yet and becomes one when the send goes through.
  const [claiming, setClaiming] = useState<string[] | null>(null);
  // Marks bound for a draft, on the same terms: an empty list is the passage under the cursor.
  const [drafting, setDrafting] = useState<string[] | null>(null);
  const searchRun = useRef(0);
  const target: AnnotationTarget | null = useMemo(
    () => (objectId === null ? null : { objectId, assetId }),
    [assetId, objectId],
  );
  const marks = useReaderAnnotations(workspaceId, target, writable);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  // The place this document was left, held until there is something on screen to put it back on.
  // Nothing is written back over it in the meantime: a save that ran before the restore would
  // overwrite last week's page with the page one that is showing while the file is still opening.
  const resume = useRef<ReaderPosition>(readReaderPosition(workspaceId, assetId));
  const resumed = useRef(false);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setPages([]);
    setLoaded({});
    // Half a page number typed at the last document is not half a page number at this one.
    setTypedPage(null);
    // A different file is a different place to go back to, and the reader has not been put there
    // yet. Read before the load rather than after, so nothing has had a chance to save over it.
    const saved = readReaderPosition(workspaceId, assetId);
    resume.current = saved;
    resumed.current = false;
    setCurrent(saved.page);
    void loader(assetUrl(workspaceId, assetId))
      .then(async (opened) => {
        if (!active) {
          opened.destroy();
          return;
        }
        const first = await opened.page(1);
        if (!active) {
          opened.destroy();
          return;
        }
        setDocument(opened);
        setPages(
          Array.from({ length: opened.pageCount }, (_unused, index) => ({
            number: index + 1,
            label: opened.pageLabel(index + 1),
            width: first.width,
            height: first.height,
          })),
        );
        setLoaded({ 1: first });
        setBusy(false);
        void opened.outline().then((entries) => {
          if (active) setOutline(entries);
        });
      })
      .catch(() => {
        if (!active) return;
        setError("Kiwi could not open this file. It may not be a readable PDF.");
        setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [assetId, loader, workspaceId]);

  useEffect(() => {
    return () => document?.destroy();
  }, [document]);

  /**
   * Which marks no longer point at anything in the file that is open.
   *
   * Worked out against the document each time it or the marks change, rather than stored on the
   * annotation: whether a passage is still there is a fact about this file, and swapping the
   * preprint back for the published version has to bring its highlights back with it.
   */
  useEffect(() => {
    if (document === null) {
      setOrphans(EMPTY_ORPHANS);
      return;
    }
    let active = true;
    void resolveAnchors(document, marks.annotations).then((lost) => {
      if (active) setOrphans(lost);
    });
    return () => {
      active = false;
    };
  }, [document, marks.annotations]);

  /**
   * Whose marks these are, and whose are being shown.
   *
   * Everybody the document carries, worked out from the marks themselves, the same records the
   * page has always drawn, now told apart by the id each was written under. Nobody is hidden
   * until somebody says so, and what is hidden is kept against the people who are actually here:
   * a colleague whose last mark is deleted while their layer is off would otherwise leave a
   * switch turned off with nothing on screen to turn it back on.
   */
  const directory = useAuthorDirectory(workspaceId);
  const authors = useMemo(
    () => authorsOnMarks(marks.annotations, directory),
    [marks.annotations, directory],
  );
  const hiddenAuthors = useMemo(() => stillHidden(turnedOff, authors), [turnedOff, authors]);
  const authorSlots = useMemo(
    () =>
      new Map(authors.filter((author) => !author.isSelf).map((author) => [author.id, author.slot])),
    [authors],
  );
  const toggleAuthor = useCallback((id: string): void => {
    setTurnedOff((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  /**
   * The marks drawn on one page.
   *
   * An orphan is not among them. Its rectangles say where the passage used to be, and a
   * highlight drawn there would be a misquotation Kiwi made on the reader's behalf. It stays in
   * the sidebar, where it can say what has happened to it.
   */
  const drawnOn = useCallback(
    (pageNumber: number): StoredAnnotationView[] => {
      const onPage = marks.byPage.get(pageNumber) ?? [];
      const shown = marksByShownAuthors(onPage, hiddenAuthors);
      return orphans.size === 0 ? shown : shown.filter((mark) => !orphans.has(mark.id));
    },
    [marks.byPage, orphans, hiddenAuthors],
  );

  /**
   * Writes down the page in view and how far down it the window has got.
   *
   * Called on every scroll, which sounds like a lot and is one small string into browser storage;
   * the alternative is a timer that can be beaten by closing the window, which is exactly when
   * the position matters most.
   */
  const savePosition = useCallback((): void => {
    if (!resumed.current) return;
    const element = window.document.getElementById(`pdf-page-${String(current)}`);
    const box = scroller.current;
    const offset =
      element === null || box === null
        ? 0
        : pageOffsetFraction(
            box.scrollTop,
            pageTopWithin(element, box),
            element.getBoundingClientRect().height,
          );
    writeReaderPosition(workspaceId, assetId, { page: current, offset });
  }, [assetId, current, workspaceId]);

  useEffect(() => {
    savePosition();
  }, [savePosition]);

  /**
   * Puts the reader back where they were, once there is a page to put them on.
   *
   * Once per document. After this the page in view is whatever the reader has scrolled to, and
   * a second restore would drag them back from it.
   */
  useEffect(() => {
    if (busy || pages.length === 0 || resumed.current) return;
    resumed.current = true;
    const wanted = resume.current;
    const element = window.document.getElementById(`pdf-page-${String(wanted.page)}`);
    const box = scroller.current;
    if (element === null || box === null) return;
    // Scrolling is presentation, and not every environment the renderer runs in implements it.
    // The page number is already right whether or not this part happens.
    if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
    if (wanted.offset > 0)
      box.scrollTop = scrollTopForOffset(
        pageTopWithin(element, box),
        element.getBoundingClientRect().height,
        wanted.offset,
      );
  }, [busy, pages.length]);

  /**
   * Notes in the machine's index that this paper has been opened, which is what the Library's
   * last-opened column reads.
   *
   * Once the document is actually open, not when the Reader is mounted: a file that turns out to
   * be unreadable was not opened, whatever the click that led here intended. Nothing here waits
   * on the answer.
   */
  useEffect(() => {
    if (busy || error !== null || objectId === null) return;
    void markOpened(workspaceId, objectId);
  }, [busy, error, objectId, workspaceId]);

  // Pages load as they are approached rather than all at once, so a 400-page thesis opens as
  // fast as a two-page note.
  useEffect(() => {
    if (document === null) return;
    let active = true;
    const wanted = [current - 1, current, current + 1].filter(
      (number) => number >= 1 && number <= document.pageCount,
    );
    for (const number of wanted) {
      if (loaded[number] !== undefined) continue;
      void document.page(number).then((page) => {
        if (active) setLoaded((previous) => ({ ...previous, [number]: page }));
      });
    }
    return () => {
      active = false;
    };
  }, [current, document, loaded]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    observer.observe(element);
    setViewportWidth(element.clientWidth || 900);
    return () => observer.disconnect();
  }, []);

  const first = pages[0];
  const scale = useMemo(() => {
    if (first === undefined) return zoom;
    if (fit === "width") return Math.max((viewportWidth - 48) / first.width, 0.1);
    if (fit === "page") return Math.max((viewportWidth - 48) / first.width, 0.1);
    return zoom;
  }, [first, fit, viewportWidth, zoom]);

  const runSearch = useCallback(
    async (text: string): Promise<void> => {
      searchRun.current += 1;
      const run = searchRun.current;
      if (document === null || text.trim() === "") {
        setMatches(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      const found = await searchDocument(document, text, {
        cancelled: () => searchRun.current !== run,
      });
      if (searchRun.current !== run) return;
      setMatches(found);
      setMatchIndex(0);
      setSearching(false);
    },
    [document],
  );

  const matchesByPage = useMemo(() => {
    const grouped = new Map<number, SearchMatch[]>();
    for (const match of matches ?? []) {
      const list = grouped.get(match.page) ?? [];
      list.push(match);
      grouped.set(match.page, list);
    }
    return grouped;
  }, [matches]);

  /**
   * Loads a page the interface has asked for.
   *
   * Thumbnails ask as they scroll into view rather than all at once: drawing four hundred of
   * them when the sidebar opens would freeze the window for exactly the documents the sidebar
   * exists to help with.
   */
  const requestPage = useCallback(
    (pageNumber: number): void => {
      if (document === null || pageNumber < 1 || pageNumber > document.pageCount) return;
      setLoaded((current) => {
        if (current[pageNumber] !== undefined) return current;
        void document.page(pageNumber).then((page) => {
          setLoaded((previous) =>
            previous[pageNumber] === undefined ? { ...previous, [pageNumber]: page } : previous,
          );
        });
        return current;
      });
    },
    [document],
  );

  const goToPage = useCallback((pageNumber: number) => {
    setCurrent(pageNumber);
    const element = window.document.getElementById(`pdf-page-${String(pageNumber)}`);
    // Moving the page number is the part that must happen. Scrolling is presentation, and
    // not every environment the renderer runs in implements it.
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
  }, []);

  /**
   * Opens on the mark somebody asked for, once there is a page to open on.
   *
   * The marks arrive after the file does, and the request usually arrives before either. So this
   * waits rather than failing: the token is only recorded as carried out once the page has been
   * turned to, which means a request made while the document was still opening is honoured when
   * it finishes rather than dropped.
   *
   * A mark that never arrives leaves the Reader on the file, which is the honest answer for a
   * quotation whose highlight has since been deleted.
   */
  const revealed = useRef(0);
  useEffect(() => {
    if (reveal === null || reveal.token === revealed.current || pages.length === 0) return;
    const mark = marks.annotations.find((entry) => entry.id === reveal.annotationId);
    if (mark === undefined) return;
    revealed.current = reveal.token;
    setSidebar("annotations");
    setActiveMark(mark.id);
    goToPage(mark.annotation.page);
  }, [goToPage, marks.annotations, pages.length, reveal]);

  const labels = useMemo(() => pages.map((page) => page.label), [pages]);
  /** True for the documents where saying which page of the file this is tells the reader something. */
  const printedDifferently = useMemo(() => labelsDifferFromPositions(labels), [labels]);

  /**
   * Acts on what was typed into the pager, and puts the box back to showing the page in view.
   *
   * Something that names no page of this document leaves the reader where they are. Refusing to
   * move is the honest answer to `xiv` in a document that stops at x, and better than the two
   * alternatives, which are guessing at a page and clearing the box as though nothing was typed.
   */
  const commitTypedPage = useCallback((): void => {
    if (typedPage === null) return;
    const wanted = findPageByLabel(labels, typedPage);
    setTypedPage(null);
    if (wanted !== null) goToPage(wanted);
  }, [goToPage, labels, typedPage]);

  function changeZoom(delta: number): void {
    const index = ZOOM_STEPS.findIndex((step) => step >= scale);
    const next = ZOOM_STEPS[Math.min(Math.max(index + delta, 0), ZOOM_STEPS.length - 1)] ?? 1;
    setFit("fixed");
    setZoom(next);
  }

  if (error !== null) {
    return (
      <section className="pdf-reader pdf-reader--error" aria-label={`${title} reader`}>
        <p role="alert">{error}</p>
      </section>
    );
  }

  return (
    <section className="pdf-reader" aria-label={`${title} reader`}>
      <div className="pdf-reader__toolbar" role="toolbar" aria-label="Document controls">
        <button
          type="button"
          aria-pressed={sidebar === "outline"}
          onClick={() => setSidebar((value) => (value === "outline" ? "closed" : "outline"))}
        >
          Contents
        </button>
        <button
          type="button"
          aria-pressed={sidebar === "thumbnails"}
          onClick={() => setSidebar((value) => (value === "thumbnails" ? "closed" : "thumbnails"))}
        >
          Pages
        </button>
        <button
          type="button"
          aria-pressed={sidebar === "annotations"}
          onClick={() =>
            setSidebar((value) => (value === "annotations" ? "closed" : "annotations"))
          }
        >
          Annotations
        </button>
        <form
          className="pdf-reader__search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
        >
          <label className="sr-only" htmlFor="pdf-search">
            Find in document
          </label>
          <input
            id="pdf-search"
            type="search"
            placeholder="Find in document"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // Clearing the box clears the marks rather than leaving the last search
              // highlighted over a document nobody is searching any more.
              if (event.target.value.trim() === "") setMatches(null);
            }}
          />
          <span aria-live="polite">
            {searching
              ? "Searching"
              : matches === null
                ? ""
                : matches.length === 0
                  ? "No matches"
                  : `${String(matchIndex + 1)} of ${String(matches.length)}`}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={matches === null || matches.length === 0}
            onClick={() => {
              if (matches === null || matches.length === 0) return;
              const next = (matchIndex - 1 + matches.length) % matches.length;
              setMatchIndex(next);
              const match = matches[next];
              if (match !== undefined) goToPage(match.page);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={matches === null || matches.length === 0}
            onClick={() => {
              if (matches === null || matches.length === 0) return;
              const next = (matchIndex + 1) % matches.length;
              setMatchIndex(next);
              const match = matches[next];
              if (match !== undefined) goToPage(match.page);
            }}
          >
            ›
          </button>
        </form>
        {writable && target !== null ? (
          <div className="pdf-reader__tools" role="group" aria-label="Mark the page">
            {/*
              Pressing the tool that is already on puts the Reader back to reading, so there is
              always a way out that does not involve choosing something else.
            */}
            <button
              type="button"
              aria-pressed={tool === "capture"}
              title="Drag a rectangle around a figure to capture it as an image"
              onClick={() => setTool((current) => (current === "capture" ? "read" : "capture"))}
            >
              Capture area
            </button>
            <button
              type="button"
              aria-pressed={tool === "note"}
              title="Click the page to leave a note where there is nothing to select"
              onClick={() => setTool((current) => (current === "note" ? "read" : "note"))}
            >
              Sticky note
            </button>
            <button
              type="button"
              aria-pressed={tool === "text"}
              title="Click the page to write words onto it"
              onClick={() => setTool((current) => (current === "text" ? "read" : "text"))}
            >
              Text box
            </button>
          </div>
        ) : null}
        <div className="pdf-reader__pager">
          <button
            type="button"
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => goToPage(current - 1)}
          >
            ‹
          </button>
          <label className="sr-only" htmlFor="pdf-page-number">
            Page
          </label>
          <input
            id="pdf-page-number"
            value={typedPage ?? pages[current - 1]?.label ?? String(current)}
            size={4}
            title="The number printed on the page. Type one and press Enter."
            onChange={(event) => setTypedPage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTypedPage();
              }
              // Changed their mind: the box goes back to the page in view rather than to
              // whatever was typed before it.
              if (event.key === "Escape") setTypedPage(null);
            }}
            onBlur={commitTypedPage}
          />
          <span>of {pages.length === 0 ? "…" : String(pages.length)}</span>
          {/* Where in the file that page is, for documents that print something else on it.
              "iv" says nothing about how far into a thesis you are; "#4 of 312" does. */}
          {printedDifferently ? (
            <span className="pdf-reader__sheet" title="Where this page sits in the file">
              #{String(current)}
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Next page"
            disabled={current >= pages.length}
            onClick={() => goToPage(current + 1)}
          >
            ›
          </button>
        </div>
        <div className="pdf-reader__zoom">
          <button type="button" aria-label="Zoom out" onClick={() => changeZoom(-1)}>
            −
          </button>
          <span aria-live="polite">{`${String(Math.round(scale * 100))}%`}</span>
          <button type="button" aria-label="Zoom in" onClick={() => changeZoom(1)}>
            +
          </button>
          <button type="button" aria-pressed={fit === "width"} onClick={() => setFit("width")}>
            Fit width
          </button>
          <button type="button" aria-pressed={fit === "page"} onClick={() => setFit("page")}>
            Fit page
          </button>
        </div>
        {/*
          Last on the toolbar, because it is the one control that moves the document rather than
          changing how it is drawn.
        */}
        {onDetach === undefined ? null : (
          <button
            type="button"
            className="pdf-reader__detach"
            aria-label="Open in a new window"
            onClick={onDetach}
          >
            Detach
          </button>
        )}
      </div>

      <div className="pdf-reader__body">
        {sidebar === "outline" ? (
          <nav className="pdf-reader__outline" aria-label="Document contents">
            {outline.length === 0 ? (
              <p>This document has no contents list.</p>
            ) : (
              <OutlineList entries={outline} onOpen={goToPage} />
            )}
          </nav>
        ) : null}
        {sidebar === "thumbnails" ? (
          <nav className="pdf-reader__thumbnails" aria-label="Pages">
            <ul>
              {pages.map((page) => (
                <PageThumbnail
                  key={page.number}
                  page={loaded[page.number] ?? null}
                  state={page}
                  active={page.number === current}
                  onOpen={() => goToPage(page.number)}
                  onNeeded={requestPage}
                />
              ))}
            </ul>
          </nav>
        ) : null}
        {sidebar === "annotations" ? (
          <nav className="pdf-reader__outline" aria-label="Annotations">
            <AnnotationSidebar
              workspaceId={workspaceId}
              marks={marks.annotations}
              orphans={orphans}
              authors={authors}
              hiddenAuthors={hiddenAuthors}
              onToggleAuthor={toggleAuthor}
              activeId={activeMark}
              writable={writable && target !== null}
              busy={marks.busy}
              threadCounts={marks.threadCounts}
              onThreadsChanged={() => void marks.reloadThreads()}
              onOpen={(mark) => {
                setActiveMark(mark.id);
                goToPage(mark.annotation.page);
              }}
              onComment={(mark, text) => void marks.comment(mark, text)}
              onRecolor={(mark, color) => void marks.recolor(mark, color)}
              onRemove={(mark) => void marks.remove(mark)}
              {...(writable && target !== null
                ? {
                    onSend: setSending,
                    onSendToClaim: setClaiming,
                    onSendToManuscript: setDrafting,
                    onTag: (mark, name, action) => void marks.tag(mark, name, action),
                  }
                : {})}
            />
          </nav>
        ) : null}

        <div
          className="pdf-reader__pages"
          ref={scroller}
          tabIndex={0}
          onScroll={savePosition}
          onMouseUp={marks.captureSelection}
          onKeyUp={(event) => {
            if (event.shiftKey) marks.captureSelection();
          }}
        >
          {busy ? <p role="status">Opening document</p> : null}
          {pages.map((page) => (
            <PageCanvas
              key={page.number}
              page={loaded[page.number] ?? null}
              state={page}
              scale={scale}
              onVisible={setCurrent}
              marks={drawnOn(page.number)}
              authorSlots={authorSlots}
              activeMark={activeMark}
              onSelectMark={setActiveMark}
              capturing={tool === "capture"}
              onCapture={(rect, canvas) =>
                void marks.captureArea({
                  page: page.number,
                  pageLabel: page.label,
                  rect,
                  canvas,
                })
              }
              placing={tool === "note" || tool === "text" ? tool : null}
              onPlace={(rect) => {
                if (tool !== "note" && tool !== "text") return;
                marks.placePoint({ kind: tool, page: page.number, pageLabel: page.label, rect });
                // One press of the tool leaves one mark. Otherwise the next click somewhere else
                // on the page would throw away the words being typed for this one.
                setTool("read");
              }}
              matches={matchesByPage.get(page.number) ?? []}
              activeMatch={matches?.[matchIndex] ?? null}
            />
          ))}
        </div>
      </div>

      {marks.pending !== null ? (
        <SelectionMenu
          busy={marks.busy}
          onHighlight={(color) => void marks.commitPending(color, "highlight")}
          onUnderline={(color) => void marks.commitPending(color, "underline")}
          onSendToClaim={writable && target !== null ? () => setClaiming([]) : undefined}
          onSendToManuscript={writable && target !== null ? () => setDrafting([]) : undefined}
          onCancel={marks.cancelPending}
        />
      ) : null}
      {marks.pendingPoint === null ? null : (
        <PointMarkComposer
          kind={marks.pendingPoint.kind}
          busy={marks.busy}
          onSave={(text, color) => void marks.commitPoint(text, color)}
          onCancel={marks.cancelPoint}
        />
      )}
      {sending === null ? null : (
        <SendToNoteDialog
          workspaceId={workspaceId}
          count={sending.length}
          suggestedTitle={`Notes on ${title}`}
          busy={marks.busy}
          onCancel={() => setSending(null)}
          onSend={(destination) => {
            void marks.sendToNote(sending, destination).then(() => setSending(null));
          }}
        />
      )}
      {claiming === null ? null : (
        <SendToClaimDialog
          workspaceId={workspaceId}
          projectId={projectId}
          count={claiming.length === 0 ? 1 : claiming.length}
          busy={marks.busy}
          onCancel={() => setClaiming(null)}
          onSend={(destination, stance) => {
            void marks
              .sendToClaim(claiming, destination, stance, claiming.length === 0)
              .then(() => setClaiming(null));
          }}
        />
      )}
      {drafting === null ? null : (
        <SendToManuscriptDialog
          workspaceId={workspaceId}
          count={drafting.length === 0 ? 1 : drafting.length}
          busy={marks.busy}
          onCancel={() => setDrafting(null)}
          onSend={(destination) => {
            void marks
              .sendToManuscript(drafting, destination, drafting.length === 0)
              .then(() => setDrafting(null));
          }}
        />
      )}
      {marks.error !== null ? (
        <p className="auth__error" role="alert">
          {marks.error}
        </p>
      ) : null}
    </section>
  );
}

/** The document's own section tree, at whatever depth it has. */
function OutlineList({
  entries,
  onOpen,
}: {
  entries: PdfOutlineEntry[];
  onOpen: (pageNumber: number) => void;
}): React.JSX.Element {
  return (
    <ul>
      {entries.map((entry) => (
        <li key={`${entry.title}-${String(entry.pageNumber)}`}>
          <button
            type="button"
            disabled={entry.pageNumber === null}
            onClick={() => entry.pageNumber !== null && onOpen(entry.pageNumber)}
          >
            {entry.title}
          </button>
          {/* A flat list of a thesis's headings loses which chapter each one is in, which is
              most of what a contents list is for. */}
          {entry.children.length === 0 ? null : (
            <OutlineList entries={entry.children} onOpen={onOpen} />
          )}
        </li>
      ))}
    </ul>
  );
}
