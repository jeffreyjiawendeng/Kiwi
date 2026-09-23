import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ANNOTATION_COLORS,
  CLAIM_LIMITS,
  tagLabel,
  userTagId,
  type Annotation,
  type AnnotationColor,
  type EvidenceStance,
  type ManuscriptSection,
} from "@kiwi/contracts";
import {
  createAnnotation,
  draftAnnotation,
  importCapturedImage,
  listAnnotations,
  listClaimChoices,
  listManuscripts,
  listManuscriptSections,
  listNotes,
  pageElementFor,
  selectionRects,
  sendAnnotationsToNote,
  sendEvidenceToClaim,
  sendPassageToManuscript,
  tagAnnotation,
  trashAnnotation,
  updateAnnotation,
  type ClaimChoice,
  type ManuscriptChoice,
  type SendToClaimTarget,
  type SendToManuscriptTarget,
  type SendToNoteTarget,
  type StoredAnnotationView,
} from "./annotations.js";
import { marksWithTags, stillChosen, tagsOnMarks } from "./annotation-tags.js";
import { marksByShownAuthors, type MarkAuthor } from "./annotation-authors.js";
import { captureName, cropCanvas, isCaptureWorthKeeping } from "./pdf-capture.js";
import { isPointKind, type PointKind } from "./point-marks.js";
import { CommentThreads, countOpenThreads } from "./CommentThreads.js";

export interface AnnotationTarget {
  /** The Paper the marks belong to. A file on its own has nothing to hang them from. */
  objectId: string;
  assetId: string;
}

interface PendingSelection {
  page: number;
  pageLabel: string;
  rects: Annotation["rects"];
  quoted: string;
}

export interface CaptureRequest {
  page: number;
  pageLabel: string;
  rect: Annotation["rects"][number];
  canvas: HTMLCanvasElement | null;
}

/** A place on a page, waiting for the words that will be left there. */
export interface PendingPoint {
  kind: PointKind;
  page: number;
  pageLabel: string;
  rect: Annotation["rects"][number];
}

export function useReaderAnnotations(
  workspaceId: string,
  target: AnnotationTarget | null,
  writable: boolean,
) {
  const [annotations, setAnnotations] = useState<StoredAnnotationView[]>([]);
  const [threadCounts, setThreadCounts] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null);
  const [color, setColor] = useState<AnnotationColor>("yellow");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (target === null) {
      setAnnotations([]);
      return;
    }
    setAnnotations(await listAnnotations(workspaceId, target.objectId, target.assetId));
  }, [target, workspaceId]);

  /**
   * How many open conversations each mark is carrying.
   *
   * A count that cannot be read leaves no badge, which is the same thing the reader sees when
   * nobody has commented. Failing louder would put an error over a document somebody is reading
   * about a number they did not ask for.
   */
  const reloadThreads = useCallback(async () => {
    if (target === null) {
      setThreadCounts({});
      return;
    }
    setThreadCounts(await countOpenThreads(workspaceId).catch(() => ({})));
  }, [target, workspaceId]);

  useEffect(() => {
    void reload();
    void reloadThreads();
  }, [reload, reloadThreads]);

  /** Reads whatever is selected, if it lies inside one rendered page. */
  const captureSelection = useCallback(() => {
    if (!writable || target === null) return;
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      setPending(null);
      return;
    }
    const anchor = pageElementFor(selection.anchorNode);
    const focus = pageElementFor(selection.focusNode);
    // A selection dragged across a page break has no single page to belong to. Rather than
    // guess, the offer is withheld until the reader selects within one page.
    if (anchor === null || focus === null || anchor !== focus) {
      setPending(null);
      return;
    }
    const rects = selectionRects(selection, anchor);
    if (rects.length === 0) {
      setPending(null);
      return;
    }
    setPending({
      page: Number.parseInt(anchor.dataset["page"] ?? "1", 10),
      pageLabel: anchor.dataset["pageLabel"] ?? anchor.dataset["page"] ?? "1",
      rects,
      quoted: selection.toString(),
    });
  }, [target, writable]);

  async function commitPending(chosen: AnnotationColor, kind: "highlight" | "underline") {
    if (pending === null || target === null) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await createAnnotation(
      workspaceId,
      target.objectId,
      draftAnnotation({
        kind,
        assetId: target.assetId,
        page: pending.page,
        pageLabel: pending.pageLabel,
        rects: pending.rects,
        color: chosen,
        quoted: pending.quoted,
      }),
    );
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setColor(chosen);
    setPending(null);
    window.getSelection()?.removeAllRanges();
    await reload();
  }

  /**
   * Takes down where a mark that has no passage under it will go.
   *
   * Nothing is written yet: a pin with nothing in it is a mark somebody has to open to find out
   * that it says nothing, so the words come first and the annotation is created with them.
   */
  function placePoint(request: PendingPoint) {
    if (!writable || target === null) return;
    // The place has been chosen, so whatever was selected a moment ago is not what this is about.
    setPending(null);
    setPendingPoint(request);
  }

  async function commitPoint(text: string, chosen: AnnotationColor) {
    const words = text.trim();
    if (pendingPoint === null || target === null || words === "") return;
    setBusy(true);
    setError(null);
    const { error: failure } = await createAnnotation(
      workspaceId,
      target.objectId,
      draftAnnotation({
        kind: pendingPoint.kind,
        assetId: target.assetId,
        page: pendingPoint.page,
        pageLabel: pendingPoint.pageLabel,
        rects: [pendingPoint.rect],
        color: chosen,
        comment: words,
      }),
    );
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setColor(chosen);
    setPendingPoint(null);
    await reload();
  }

  async function comment(stored: StoredAnnotationView, text: string) {
    setBusy(true);
    const { error: failure } = await updateAnnotation(workspaceId, stored, {
      ...stored.annotation,
      comment: text,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    await reload();
  }

  async function recolor(stored: StoredAnnotationView, chosen: AnnotationColor) {
    setBusy(true);
    const { error: failure } = await updateAnnotation(workspaceId, stored, {
      ...stored.annotation,
      color: chosen,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    await reload();
  }

  /**
   * Puts a tag on a mark, or takes one off.
   *
   * The tag is written by the command that tags any other object, so a mark tagged here is
   * found by the same chip in the Library. The name is turned into an id first: two readers who
   * typed `Method` and `method` have to have tagged the same thing.
   */
  async function tag(stored: StoredAnnotationView, name: string, action: "add" | "remove") {
    const tagId = action === "add" ? userTagId(name) : name;
    if (tagId === "") {
      setError("Give the tag a name.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await tagAnnotation(workspaceId, stored, tagId, action);
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    await reload();
  }

  async function remove(stored: StoredAnnotationView) {
    setBusy(true);
    const { error: failure } = await trashAnnotation(workspaceId, stored);
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    await reload();
  }

  /**
   * Captures a dragged region as an image and marks it on the page.
   *
   * The image becomes a managed asset like any other file, so it is hashed, deduplicated, and
   * reusable in a note or a manuscript rather than trapped inside the annotation record.
   */
  async function captureArea(request: CaptureRequest, chosen: AnnotationColor = color) {
    if (!writable || target === null) return;
    // A stray click is not a capture. Committing one would leave an invisible mark somebody
    // has to hunt for in the sidebar to delete.
    if (!isCaptureWorthKeeping(request.rect)) return;
    if (request.canvas === null) {
      setError("Kiwi could not read that page, so there was nothing to capture.");
      return;
    }
    setBusy(true);
    setError(null);

    const cropped = cropCanvas(request.canvas, request.rect, () =>
      window.document.createElement("canvas"),
    );
    if (cropped === null) {
      setBusy(false);
      setError("Kiwi could not capture that region.");
      return;
    }

    const imported = await importCapturedImage(
      workspaceId,
      cropped,
      captureName(request.pageLabel, new Date()),
    );
    if (imported.assetId === undefined) {
      setBusy(false);
      setError(imported.error ?? "Kiwi could not store the captured region.");
      return;
    }

    const { error: failure } = await createAnnotation(
      workspaceId,
      target.objectId,
      draftAnnotation({
        kind: "area",
        assetId: target.assetId,
        page: request.page,
        pageLabel: request.pageLabel,
        rects: [request.rect],
        color: chosen,
        imageAssetId: imported.assetId,
      }),
    );
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    await reload();
  }

  /** Copies marks into a note. Nothing is moved; the mark stays on the page. */
  async function sendToNote(annotationIds: string[], destination: SendToNoteTarget) {
    if (annotationIds.length === 0) return null;
    setBusy(true);
    setError(null);
    const { noteId, error: failure } = await sendAnnotationsToNote(
      workspaceId,
      annotationIds,
      destination,
    );
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return null;
    }
    return noteId ?? null;
  }

  /**
   * The passage under the cursor as a mark that has not been made yet, or null when nothing is
   * selected.
   *
   * Sending straight from a selection makes the highlight on the way past, so the quotation can
   * still be found on the page it came from rather than only where it was sent.
   */
  function selectionExcerpt(): { objectId: string; annotation: Annotation } | null {
    if (target === null || pending === null) return null;
    return {
      objectId: target.objectId,
      annotation: draftAnnotation({
        kind: "highlight",
        assetId: target.assetId,
        page: pending.page,
        pageLabel: pending.pageLabel,
        rects: pending.rects,
        color,
        quoted: pending.quoted,
      }),
    };
  }

  /** Puts the selection away once a send has taken it, so it is not sent twice. */
  function selectionSent(): void {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }

  /**
   * Sends marks, or the passage under the cursor, to a claim.
   *
   * A selection nobody has marked yet becomes a highlight on the way past, so the quotation can
   * still be found on the page it came from rather than only inside the claim.
   */
  async function sendToClaim(
    markIds: string[],
    claimTarget: SendToClaimTarget,
    stance: EvidenceStance,
    fromSelection: boolean,
  ): Promise<string | null> {
    if (target === null) return null;
    const excerpt = fromSelection ? selectionExcerpt() : null;
    if (excerpt === null && markIds.length === 0) return null;

    setBusy(true);
    setError(null);
    const { claimId, error: failure } = await sendEvidenceToClaim(workspaceId, claimTarget, {
      objectIds: markIds,
      ...(excerpt === null ? {} : { excerpt }),
      stance,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return null;
    }
    if (excerpt !== null) selectionSent();
    await reload();
    return claimId ?? null;
  }

  /**
   * Sends marks, or the passage under the cursor, into a section of a manuscript.
   *
   * The quotation is written into the draft where the writer said, and the paper it came from is
   * recorded as something the draft draws on. Nothing leaves the Reader: the mark stays on the
   * page it was made on.
   */
  async function sendToManuscript(
    markIds: string[],
    destination: SendToManuscriptTarget,
    fromSelection: boolean,
  ): Promise<boolean> {
    if (target === null) return false;
    const excerpt = fromSelection ? selectionExcerpt() : null;
    if (excerpt === null && markIds.length === 0) return false;

    setBusy(true);
    setError(null);
    const { error: failure } = await sendPassageToManuscript(workspaceId, destination, {
      objectIds: markIds,
      ...(excerpt === null ? {} : { excerpt }),
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return false;
    }
    if (excerpt !== null) selectionSent();
    await reload();
    return true;
  }

  const byPage = useMemo(() => {
    const grouped = new Map<number, StoredAnnotationView[]>();
    for (const entry of annotations) {
      const list = grouped.get(entry.annotation.page) ?? [];
      list.push(entry);
      grouped.set(entry.annotation.page, list);
    }
    return grouped;
  }, [annotations]);

  return {
    annotations,
    threadCounts,
    reloadThreads,
    byPage,
    pending,
    pendingPoint,
    color,
    error,
    busy,
    setColor,
    captureSelection,
    commitPending,
    cancelPending: () => setPending(null),
    placePoint,
    commitPoint,
    cancelPoint: () => setPendingPoint(null),
    captureArea,
    sendToNote,
    sendToClaim,
    sendToManuscript,
    comment,
    recolor,
    tag,
    remove,
    reload,
  };
}

export function AnnotationOverlay({
  marks,
  onSelect,
  activeId,
  authorSlots,
}: {
  marks: StoredAnnotationView[];
  onSelect: (id: string) => void;
  activeId: string | null;
  /**
   * The layer colour of everybody but the reader, by the id their marks carry.
   *
   * Your own marks are absent from it and are drawn as they always were. Somebody else's keeps
   * the colour they chose, recolouring it would be putting words in their mouth, and is edged
   * in theirs, which is what makes a page of four people's reading legible.
   */
  authorSlots: ReadonlyMap<string, number>;
}): React.JSX.Element {
  return (
    <div className="pdf-page__marks">
      {marks.flatMap((mark) =>
        mark.annotation.rects.map((rect, index) => {
          // A point mark is put where its anchor is and then left to be its own size: a pin
          // stays a pin at any zoom, and a text box is as big as the words in it. Stretching
          // either to the anchor square would draw a mark nobody can read.
          const point = isPointKind(mark.annotation.kind);
          // A pin shows nothing of itself, so hovering it is the quickest way to read it.
          const hover = mark.annotation.kind === "note" ? { title: mark.annotation.comment } : {};
          const slot = authorSlots.get(mark.author);
          return (
            <button
              key={`${mark.id}-${String(index)}`}
              type="button"
              className={`pdf-mark pdf-mark--${mark.annotation.kind} pdf-mark--${mark.annotation.color}${
                slot === undefined ? "" : ` pdf-mark--author-${String(slot)}`
              }${activeId === mark.id ? " pdf-mark--active" : ""}`}
              style={{
                left: `${String(rect.left * 100)}%`,
                top: `${String(rect.top * 100)}%`,
                ...(point
                  ? {}
                  : {
                      width: `${String(rect.width * 100)}%`,
                      height: `${String(rect.height * 100)}%`,
                    }),
              }}
              aria-label={`${mark.annotation.kind} ${mark.title}`}
              {...hover}
              onClick={() => onSelect(mark.id)}
            >
              {/* A text box says its piece on the page. A sticky note is opened to be read. */}
              {mark.annotation.kind === "text" ? mark.annotation.comment : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

/**
 * Writing what will be left at a place on the page.
 *
 * The words are asked for before the mark is made, rather than after: an empty pin is a mark
 * that has to be opened to find out it says nothing, and there would be one on the page for
 * every click that missed.
 */
export function PointMarkComposer({
  kind,
  busy,
  onSave,
  onCancel,
}: {
  kind: PointKind;
  busy: boolean;
  onSave: (text: string, color: AnnotationColor) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<AnnotationColor>("yellow");
  const field = useId();
  const sticky = kind === "note";
  return (
    <form
      className="pdf-point-composer"
      aria-label={sticky ? "New sticky note" : "New text box"}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text, chosen);
      }}
    >
      <label className="sr-only" htmlFor={field}>
        {sticky ? "Note" : "Words on the page"}
      </label>
      <textarea
        id={field}
        rows={2}
        value={text}
        disabled={busy}
        placeholder={sticky ? "What is worth saying here" : "What the page should say"}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="pdf-selection-menu__colors">
        {ANNOTATION_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            className={`pdf-color pdf-color--${value}${chosen === value ? " pdf-color--chosen" : ""}`}
            aria-label={value}
            aria-pressed={chosen === value}
            onClick={() => setChosen(value)}
          />
        ))}
      </div>
      <button type="submit" disabled={busy || text.trim() === ""}>
        Save
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function SelectionMenu({
  onHighlight,
  onUnderline,
  onSendToClaim,
  onSendToManuscript,
  onCancel,
  busy,
}: {
  onHighlight: (color: AnnotationColor) => void;
  onUnderline: (color: AnnotationColor) => void;
  /** Sends this passage to a claim, marking it on the way past. Absent when read-only. */
  onSendToClaim?: (() => void) | undefined;
  /** Sends this passage into a draft, marking it on the way past. Absent when read-only. */
  onSendToManuscript?: (() => void) | undefined;
  onCancel: () => void;
  busy: boolean;
}): React.JSX.Element {
  const [chosen, setChosen] = useState<AnnotationColor>("yellow");
  return (
    <div className="pdf-selection-menu" role="group" aria-label="Annotate selection">
      <div className="pdf-selection-menu__colors">
        {ANNOTATION_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            className={`pdf-color pdf-color--${value}${chosen === value ? " pdf-color--chosen" : ""}`}
            aria-label={value}
            aria-pressed={chosen === value}
            onClick={() => setChosen(value)}
          />
        ))}
      </div>
      <button type="button" disabled={busy} onClick={() => onHighlight(chosen)}>
        Highlight
      </button>
      <button type="button" disabled={busy} onClick={() => onUnderline(chosen)}>
        Underline
      </button>
      {onSendToClaim === undefined ? null : (
        <button type="button" disabled={busy} onClick={onSendToClaim}>
          Send to claim
        </button>
      )}
      {onSendToManuscript === undefined ? null : (
        <button type="button" disabled={busy} onClick={onSendToManuscript}>
          Send to manuscript
        </button>
      )}
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function AnnotationSidebar({
  workspaceId,
  marks,
  orphans,
  authors,
  hiddenAuthors,
  onToggleAuthor,
  activeId,
  writable,
  busy,
  threadCounts,
  onOpen,
  onComment,
  onRecolor,
  onTag,
  onRemove,
  onSend,
  onSendToClaim,
  onSendToManuscript,
  onThreadsChanged,
}: {
  workspaceId: string;
  marks: StoredAnnotationView[];
  /** The marks whose anchors no longer resolve against the file that is open. */
  orphans: ReadonlySet<string>;
  /** Everybody whose marks are on this document, the reader first. */
  authors: readonly MarkAuthor[];
  /** Whose layers are off. Their marks are neither listed here nor drawn on the page. */
  hiddenAuthors: ReadonlySet<string>;
  onToggleAuthor: (id: string) => void;
  activeId: string | null;
  writable: boolean;
  busy: boolean;
  /** Open threads per mark, so a conversation can be found without opening every mark. */
  threadCounts: Record<string, number>;
  onOpen: (mark: StoredAnnotationView) => void;
  onComment: (mark: StoredAnnotationView, text: string) => void;
  onRecolor: (mark: StoredAnnotationView, color: AnnotationColor) => void;
  /** Puts a tag on one mark or takes it off. Absent while the Reader is read-only. */
  onTag?: (mark: StoredAnnotationView, name: string, action: "add" | "remove") => void;
  onRemove: (mark: StoredAnnotationView) => void;
  /** Copies the given marks into a note. Absent while the Reader is read-only. */
  onSend?: (ids: string[]) => void;
  /** Points the given marks at a claim. Absent while the Reader is read-only. */
  onSendToClaim?: (ids: string[]) => void;
  /** Writes the given marks into a draft. Absent while the Reader is read-only. */
  onSendToManuscript?: (ids: string[]) => void;
  onThreadsChanged: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tagging, setTagging] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const previous = useRef<string | null>(null);
  const tagList = useId();

  useEffect(() => {
    if (previous.current === editing) return;
    previous.current = editing;
    const mark = marks.find((entry) => entry.id === editing);
    setDraft(mark?.annotation.comment ?? "");
  }, [editing, marks]);

  // A layer that is off is off for everything below it: the list, the tag chips, which offer
  // exactly the tags the list carries, and what "send all" means.
  const showing = useMemo(() => marksByShownAuthors(marks, hiddenAuthors), [marks, hiddenAuthors]);
  const byAuthor = useMemo(() => new Map(authors.map((author) => [author.id, author])), [authors]);
  const tags = useMemo(() => tagsOnMarks(showing), [showing]);
  // What was picked, minus anything the document no longer carries. Filtering by a tag that has
  // just been taken off the last mark holding it would empty the sidebar and keep it empty.
  const chosen = useMemo(() => stillChosen(picked, showing), [picked, showing]);
  // Every chosen tag is on at least one mark, so this is never empty unless a layer is off.
  const shown = useMemo(() => marksWithTags(showing, chosen), [showing, chosen]);
  // A mark that has lost its place is listed at the end rather than among the others. In the
  // list proper it would be read as pointing at the page it names, which is the one thing it
  // no longer does.
  const located = shown.filter((mark) => !orphans.has(mark.id));
  const lost = shown.filter((mark) => orphans.has(mark.id));

  /**
   * One mark in the list, wherever in the list it belongs.
   *
   * A mark that has lost its place is the same mark, and reads the same way: the quotation,
   * the comment, the tags and every action are all still there. What it does not get is a
   * highlight drawn on the page, and what it does get is a line saying so.
   */
  function markItem(mark: StoredAnnotationView, lost: boolean): React.JSX.Element {
    const open = threadCounts[mark.id] ?? 0;
    const active = activeId === mark.id;
    // Yours are the marks you expect to be reading, so they are the ones left unsigned. A name
    // on every row would be your own name a hundred times over.
    const by = byAuthor.get(mark.author);
    const signed = by !== undefined && !by.isSelf ? by : null;
    return (
      <li key={mark.id} className={active ? "is-active" : undefined}>
        <button
          type="button"
          className={`pdf-annotation pdf-annotation--${mark.annotation.color}${
            lost ? " pdf-annotation--lost" : ""
          }`}
          onClick={() => onOpen(mark)}
        >
          <span className="pdf-annotation__page">p. {mark.annotation.page_label}</span>
          {signed === null ? null : (
            <span
              className={`pdf-annotation__author pdf-annotation__author--${String(signed.slot)}`}
            >
              {signed.name}
            </span>
          )}
          {lost ? (
            <span className="pdf-annotation__lost">Not found in the file any more</span>
          ) : null}
          <span className="pdf-annotation__quote">
            {mark.annotation.kind === "area" && mark.annotation.quoted === ""
              ? "Captured region"
              : mark.title}
          </span>
          {mark.annotation.comment === "" ? null : (
            <span className="pdf-annotation__comment">{mark.annotation.comment}</span>
          )}
          {open === 0 || active ? null : (
            <span className="pdf-annotation__threads">
              {open} open {open === 1 ? "comment" : "comments"}
            </span>
          )}
        </button>
        {mark.tags.length === 0 && onTag === undefined ? null : (
          <div className="pdf-annotation__tags">
            {mark.tags.map((id) => (
              <span key={id} className="pdf-tag">
                {tagLabel(id)}
                {onTag === undefined ? null : (
                  <button
                    type="button"
                    aria-label={`Remove tag ${tagLabel(id)}`}
                    disabled={busy}
                    onClick={() => onTag(mark, id, "remove")}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {onTag === undefined ? null : tagging === mark.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onTag(mark, tagDraft, "add");
                  setTagging(null);
                }}
              >
                <label className="sr-only" htmlFor={`tag-${mark.id}`}>
                  Tag
                </label>
                {/* The names already on this document are offered back, so the twentieth
                          mark tagged `method` is tagged the same `method` as the first. */}
                <input
                  id={`tag-${mark.id}`}
                  list={tagList}
                  value={tagDraft}
                  disabled={busy}
                  onChange={(event) => setTagDraft(event.target.value)}
                />
                <button type="submit" disabled={busy || tagDraft.trim() === ""}>
                  Add
                </button>
                <button type="button" disabled={busy} onClick={() => setTagging(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="pdf-tag pdf-tag--add"
                disabled={busy}
                onClick={() => {
                  setTagDraft("");
                  setTagging(mark.id);
                }}
              >
                Add tag
              </button>
            )}
          </div>
        )}
        {writable ? (
          <div className="pdf-annotation__actions">
            {editing === mark.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onComment(mark, draft.trim());
                  setEditing(null);
                }}
              >
                <label className="sr-only" htmlFor={`comment-${mark.id}`}>
                  Comment
                </label>
                <textarea
                  id={`comment-${mark.id}`}
                  rows={2}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" disabled={busy}>
                  Save
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => setEditing(mark.id)}>
                  {mark.annotation.comment === "" ? "Add comment" : "Edit comment"}
                </button>
                <div className="pdf-selection-menu__colors">
                  {ANNOTATION_COLORS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`pdf-color pdf-color--${value}`}
                      aria-label={`Recolor to ${value}`}
                      disabled={busy}
                      onClick={() => onRecolor(mark, value)}
                    />
                  ))}
                </div>
                {onSend === undefined ? null : (
                  <button type="button" disabled={busy} onClick={() => onSend([mark.id])}>
                    Send to note
                  </button>
                )}
                {onSendToClaim === undefined ? null : (
                  <button type="button" disabled={busy} onClick={() => onSendToClaim([mark.id])}>
                    Send to claim
                  </button>
                )}
                {onSendToManuscript === undefined ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSendToManuscript([mark.id])}
                  >
                    Send to manuscript
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => onRemove(mark)}>
                  Delete
                </button>
              </>
            )}
          </div>
        ) : null}
        {/*
              The conversation opens with the mark rather than behind a control of its own. A
              highlight is already the thing being pointed at, so choosing it is the same gesture
              as asking what was said about it.
            */}
        {active ? (
          <CommentThreads
            workspaceId={workspaceId}
            objectId={mark.id}
            writable={writable}
            anchor={{ object_id: mark.id, kind: "annotation" }}
            empty="Nothing discussed here yet. The comment above is your own note; a thread is where somebody answers."
            onChange={onThreadsChanged}
          />
        ) : null}
      </li>
    );
  }

  if (marks.length === 0) {
    return (
      <div className="pdf-reader__annotations">
        <p className="pdf-reader__empty">
          Nothing marked yet. Select a passage to highlight it, drag a rectangle around a figure to
          capture it, or leave a sticky note where there is nothing to select.
        </p>
      </div>
    );
  }

  return (
    <div className="pdf-reader__annotations">
      {onSend === undefined ? null : (
        <div className="pdf-reader__annotations-bar">
          {/* With a filter on, "all" is what the filter left: sending the marks that are not on
              screen would send work somebody has just said they are not looking at. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onSend(shown.map((mark) => mark.id))}
          >
            {chosen.length === 0 ? "Send all to a note" : "Send these to a note"}
          </button>
        </div>
      )}
      {/* One person reading alone is not a layer to choose between, so there is nothing to
          offer until somebody else's marks are here too. */}
      {authors.length < 2 ? null : (
        <div className="pdf-reader__people" role="group" aria-label="Show marks by">
          {authors.map((person) => {
            const on = !hiddenAuthors.has(person.id);
            return (
              <button
                key={person.id}
                type="button"
                className={`pdf-person pdf-person--${String(person.slot)}${on ? " pdf-person--on" : ""}`}
                aria-pressed={on}
                onClick={() => onToggleAuthor(person.id)}
              >
                {person.name} <span className="pdf-tag__count">{person.count}</span>
              </button>
            );
          })}
        </div>
      )}
      {tags.length === 0 ? null : (
        <div className="pdf-reader__tag-filter" role="group" aria-label="Filter by tag">
          {tags.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`pdf-tag pdf-tag--filter${chosen.includes(entry.id) ? " pdf-tag--chosen" : ""}`}
              aria-pressed={chosen.includes(entry.id)}
              onClick={() =>
                setPicked((current) =>
                  current.includes(entry.id)
                    ? current.filter((id) => id !== entry.id)
                    : [...current, entry.id],
                )
              }
            >
              {entry.label} <span className="pdf-tag__count">{entry.count}</span>
            </button>
          ))}
          {chosen.length === 0 ? null : (
            <button type="button" className="pdf-tag pdf-tag--clear" onClick={() => setPicked([])}>
              Show all
            </button>
          )}
        </div>
      )}
      <datalist id={tagList}>
        {tags.map((entry) => (
          <option key={entry.id} value={entry.label} />
        ))}
      </datalist>
      {shown.length > 0 ? null : (
        <p className="pdf-reader__empty">
          Every layer is off. Turn somebody back on to read their marks.
        </p>
      )}
      <ul>{located.map((mark) => markItem(mark, false))}</ul>
      {lost.length === 0 ? null : (
        <section className="pdf-reader__orphans" aria-label="Marks that lost their place">
          <p>
            {lost.length === 1
              ? "One mark no longer points"
              : `${String(lost.length)} marks no longer point`}{" "}
            at anything in this file. Nothing has been deleted.
          </p>
          <ul>{lost.map((mark) => markItem(mark, true))}</ul>
        </section>
      )}
    </div>
  );
}

/**
 * Choosing where highlights should land.
 *
 * Existing notes first, because gathering marks from several papers into one thematic note is
 * the point of the feature; a new note is the fallback rather than the default.
 */
export function SendToNoteDialog({
  workspaceId,
  count,
  suggestedTitle,
  busy,
  onSend,
  onCancel,
}: {
  workspaceId: string;
  count: number;
  suggestedTitle: string;
  busy: boolean;
  onSend: (target: SendToNoteTarget) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [notes, setNotes] = useState<Array<{ id: string; title: string }> | null>(null);
  const [choice, setChoice] = useState<string>("new");
  const [title, setTitle] = useState(suggestedTitle);
  // Generated rather than written out: a hand-written id collided with the heading's, which
  // pointed the label at the heading and left the field with no accessible name at all.
  const headingId = useId();
  const targetId = useId();
  const titleId = useId();

  useEffect(() => {
    let active = true;
    void listNotes(workspaceId).then((found) => {
      if (!active) return;
      setNotes(found);
      if (found[0] !== undefined) setChoice(found[0].id);
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return (
    <div className="pdf-send__backdrop" role="presentation">
      <section
        className="pdf-send"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <h3 id={headingId}>
          Send {count} {count === 1 ? "annotation" : "annotations"} to a note
        </h3>
        <p className="pdf-send__hint">
          The marks stay on the page. The note gets the quotation and a link back to it.
        </p>
        <label htmlFor={targetId}>Note</label>
        <select
          id={targetId}
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value)}
        >
          {(notes ?? []).map((note) => (
            <option key={note.id} value={note.id}>
              {note.title}
            </option>
          ))}
          <option value="new">New note</option>
        </select>
        {choice === "new" ? (
          <>
            <label htmlFor={titleId}>Name</label>
            <input
              id={titleId}
              type="text"
              maxLength={200}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </>
        ) : null}
        <div className="pdf-send__actions">
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || (choice === "new" && title.trim() === "")}
            onClick={() =>
              onSend(choice === "new" ? { noteTitle: title.trim() } : { noteId: choice })
            }
          >
            {busy ? "Sending" : "Send"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Choosing what a passage stands behind.
 *
 * Claims the project has already written come first: the reason to send a passage while reading
 * is usually that it bears on something already asserted. A new claim is the fallback, and it is
 * a draft, because one piece of evidence is not what makes a claim supported.
 */
export function SendToClaimDialog({
  workspaceId,
  projectId,
  count,
  busy,
  onSend,
  onCancel,
}: {
  workspaceId: string;
  projectId: string | null;
  count: number;
  busy: boolean;
  onSend: (target: SendToClaimTarget, stance: EvidenceStance) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [claims, setClaims] = useState<ClaimChoice[] | null>(null);
  const [choice, setChoice] = useState<string>("new");
  const [statement, setStatement] = useState("");
  const [stance, setStance] = useState<EvidenceStance>("supports");
  const headingId = useId();
  const targetId = useId();
  const statementId = useId();
  const stanceId = useId();

  useEffect(() => {
    let active = true;
    void listClaimChoices(workspaceId, projectId).then((found) => {
      if (!active) return;
      setClaims(found);
      if (found[0] !== undefined) setChoice(found[0].id);
    });
    return () => {
      active = false;
    };
  }, [projectId, workspaceId]);

  // A claim is filed in a project. With none open there is nothing a new one could belong to,
  // so the only offer is the claims that already exist.
  const writing = choice === "new";
  const nothingToSendTo = projectId === null && (claims ?? []).length === 0;

  return (
    <div className="pdf-send__backdrop" role="presentation">
      <section
        className="pdf-send"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <h3 id={headingId}>
          Send {count} {count === 1 ? "passage" : "passages"} to a claim
        </h3>
        <p className="pdf-send__hint">
          The mark stays on the page. The claim gets it as evidence, and says so on the Claims page.
        </p>
        {nothingToSendTo ? (
          <p className="pdf-send__hint">
            No project is open and this workspace has no claims yet. Open a project to write one.
          </p>
        ) : (
          <>
            <label htmlFor={targetId}>Claim</label>
            <select
              id={targetId}
              value={choice}
              disabled={busy}
              onChange={(event) => setChoice(event.target.value)}
            >
              {(claims ?? []).map((claim) => (
                <option key={claim.id} value={claim.id}>
                  {claim.title}
                </option>
              ))}
              {projectId === null ? null : <option value="new">New claim</option>}
            </select>
            {writing ? (
              <>
                <label htmlFor={statementId}>What the project asserts</label>
                <textarea
                  id={statementId}
                  rows={3}
                  maxLength={CLAIM_LIMITS.statement}
                  value={statement}
                  disabled={busy}
                  onChange={(event) => setStatement(event.target.value)}
                />
              </>
            ) : null}
            <label htmlFor={stanceId}>This passage</label>
            <select
              id={stanceId}
              value={stance}
              disabled={busy}
              onChange={(event) => setStance(event.target.value as EvidenceStance)}
            >
              <option value="supports">Supports the claim</option>
              <option value="contradicts">Contradicts the claim</option>
            </select>
          </>
        )}
        <div className="pdf-send__actions">
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || nothingToSendTo || (writing && statement.trim() === "")}
            onClick={() =>
              onSend(
                writing && projectId !== null
                  ? { projectId, statement: statement.trim() }
                  : { claimId: choice },
                stance,
              )
            }
          >
            {busy ? "Sending" : "Send"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The section option meaning no section in particular.
 *
 * Empty, which is not a heading anybody has typed: the command takes a heading of at least one
 * character, so there is no manuscript in which this could name a real section.
 */
const END_OF_MANUSCRIPT = "";

/**
 * Choosing where in a draft a passage goes.
 *
 * A manuscript and one of its sections. The sections are read from the manuscript when this
 * opens, because somebody may have renamed one since the Reader was last looking, and a heading
 * offered from memory is a heading the send would not find.
 */
export function SendToManuscriptDialog({
  workspaceId,
  count,
  busy,
  onSend,
  onCancel,
}: {
  workspaceId: string;
  count: number;
  busy: boolean;
  onSend: (target: SendToManuscriptTarget) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [manuscripts, setManuscripts] = useState<ManuscriptChoice[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [sections, setSections] = useState<ManuscriptSection[] | null>(null);
  const [section, setSection] = useState<string>(END_OF_MANUSCRIPT);
  const headingId = useId();
  const targetId = useId();
  const sectionId = useId();

  useEffect(() => {
    let active = true;
    void listManuscripts(workspaceId).then((found) => {
      if (!active) return;
      setManuscripts(found);
      if (found[0] !== undefined) setChosen(found[0].id);
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (chosen === "") return undefined;
    let active = true;
    setSections(null);
    // Back to the end of the manuscript whenever the manuscript changes: a heading chosen in one
    // draft means nothing in the next one.
    setSection(END_OF_MANUSCRIPT);
    void listManuscriptSections(workspaceId, chosen).then((found) => {
      if (active) setSections(found);
    });
    return () => {
      active = false;
    };
  }, [chosen, workspaceId]);

  const nothingToSendTo = (manuscripts ?? []).length === 0;

  return (
    <div className="pdf-send__backdrop" role="presentation">
      <section
        className="pdf-send"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <h3 id={headingId}>
          Send {count} {count === 1 ? "passage" : "passages"} to a manuscript
        </h3>
        <p className="pdf-send__hint">
          The passage is written into the draft as a quotation, with the paper and page it came
          from. The mark stays on the page.
        </p>
        {nothingToSendTo ? (
          <p className="pdf-send__hint">
            {manuscripts === null
              ? "Looking for manuscripts."
              : "This workspace has no manuscripts yet. Write one first."}
          </p>
        ) : (
          <>
            <label htmlFor={targetId}>Manuscript</label>
            <select
              id={targetId}
              value={chosen}
              disabled={busy}
              onChange={(event) => setChosen(event.target.value)}
            >
              {(manuscripts ?? []).map((manuscript) => (
                <option key={manuscript.id} value={manuscript.id}>
                  {manuscript.title}
                </option>
              ))}
            </select>
            <label htmlFor={sectionId}>Section</label>
            <select
              id={sectionId}
              value={section}
              disabled={busy}
              onChange={(event) => setSection(event.target.value)}
            >
              {/* Always offered, and what a manuscript with no headings yet gets. */}
              <option value={END_OF_MANUSCRIPT}>End of the manuscript</option>
              {(sections ?? []).map((entry, index) => (
                <option key={`${String(index)}-${entry.title}`} value={entry.title}>
                  {/* Indented by its level, with spaces rather than rules: a menu of headings
                      reads as an outline, and the indent is all that has to say so. */}
                  {`${"   ".repeat(entry.level - 1)}${entry.title}`}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="pdf-send__actions">
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || nothingToSendTo}
            onClick={() =>
              onSend({
                manuscriptId: chosen,
                ...(section === END_OF_MANUSCRIPT ? {} : { section }),
              })
            }
          >
            {busy ? "Sending" : "Send"}
          </button>
        </div>
      </section>
    </div>
  );
}
