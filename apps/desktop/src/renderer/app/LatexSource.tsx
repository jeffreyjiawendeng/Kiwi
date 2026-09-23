/**
 * The LaTeX source editor: a textarea with the colouring painted behind it.
 *
 * The field is a plain textarea with transparent text, and underneath it sits the same source cut
 * into coloured spans, aligned character for character. Typing, selecting, undo, spell-check, and
 * the caret are all still the browser's, which is the point: a document that co-edits as plain
 * text in P11 stays plain text, and nothing here has to be taught what a keystroke is.
 *
 * The two boxes must agree on every measurement that decides where a character lands, font,
 * size, line height, padding, border, and how lines wrap. Those live together in `shell.css`
 * under one selector for exactly that reason.
 *
 * Folding is the one thing the field cannot do to itself, because a textarea has no way to hide
 * part of its own value. So a folded run is cut out of what the field holds, and this component is
 * the only place that knows the difference between the source and the text on screen: `latex-
 * folding.ts` converts between the two, and everything outside still speaks in source positions.
 */

import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { spotInText, type CaretSpot } from "./caret-spots.js";
import { RemoteCarets } from "./RemoteCarets.js";
import type { RemoteCaret } from "./remote-carets.js";
import { highlightSpans, type SourceRange, type SourceSpan } from "./latex-syntax.js";
import {
  applyFieldEdit,
  foldMarks,
  foldableRegions,
  foldedText,
  regionAt,
  revealRange,
  toField,
  toSource,
  toggleFold,
  visibleSegments,
  type FoldedEdit,
} from "./latex-folding.js";

/** What the toolbar and the rest of the editor can ask of the field. */
export interface LatexSourceControls {
  /** Selects a range of the **source**, opening whatever fold hides it. */
  select(from: number, to: number, focus: boolean): void;
  /** Folds the innermost section or environment at the caret, or opens it if it is folded. */
  fold(): void;
  /** Opens everything, leaving the caret where it was. */
  unfoldAll(): void;
}

interface LatexSourceProps {
  id: string;
  value: string;
  writable: boolean;
  field: React.RefObject<HTMLTextAreaElement | null>;
  controls?: React.RefObject<LatexSourceControls | null>;
  onChange(next: string): void;
  /** Everybody else's caret, in **source** positions. Drawn on the painting; see below. */
  carets?: readonly RemoteCaret[];
  /**
   * Where the selection now is, in the **source**.
   *
   * Reported rather than read off the field, because the field holds the source with the folded
   * runs cut out of it and its own positions mean nothing outside this component.
   */
  onSelection?(from: number, to: number): void;
}

/** Where the selection is going once the field has been re-rendered with a run hidden or shown. */
interface Placement {
  from: number;
  to: number;
  focus: boolean;
}

/**
 * How much source is coloured at all, in characters.
 *
 * Colouring runs on every keystroke, so a buffer nobody could have typed, a pasted appendix of
 * generated tables, would be walked again for each one. Past this it is shown plain: an editor
 * that keeps up matters more than a colour.
 */
const HIGHLIGHT_LIMIT = 120_000;

/** One array for every field with nobody else in the document, so the placing is not redone. */
const NOBODY: readonly RemoteCaret[] = [];

function spanClass(span: SourceSpan): string {
  const classes = ["latex-token"];
  if (span.kind !== null) classes.push(`latex-token--${span.kind}`);
  if (span.match) classes.push("latex-token--match");
  return classes.join(" ");
}

/** The painted spans cut wherever a run is hidden, so a marker can be drawn between two of them. */
function cutSpans(spans: readonly SourceSpan[], marks: readonly number[]): SourceSpan[] {
  if (marks.length === 0) return [...spans];
  const out: SourceSpan[] = [];
  let seen = 0;
  for (const span of spans) {
    let rest = span;
    let start = seen;
    for (const mark of marks) {
      if (mark <= start || mark >= seen + span.text.length) continue;
      out.push({ ...rest, text: rest.text.slice(0, mark - start) });
      rest = { ...rest, text: rest.text.slice(mark - start) };
      start = mark;
    }
    out.push(rest);
    seen += span.text.length;
  }
  return out;
}

export function LatexSource({
  id,
  value,
  writable,
  field,
  controls,
  onChange,
  carets = NOBODY,
  onSelection,
}: LatexSourceProps): React.JSX.Element {
  const ink = useRef<HTMLPreElement>(null);
  const painting = useRef<HTMLSpanElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [folds, setFolds] = useState<readonly SourceRange[]>([]);
  // Where the caret last was, kept past a blur. Clicking Fold in the toolbar takes focus out of the
  // field, and the region to fold is the one it was standing in when it left.
  const at = useRef(0);
  const placing = useRef<Placement | null>(null);
  // Folds are runs of this buffer. A buffer that arrived from somewhere else, a replace-all, a
  // section moved in the outline, a different document, is not the one they were measured against.
  const seen = useRef(value);
  if (seen.current !== value) {
    seen.current = value;
    if (folds.length > 0) setFolds([]);
  }

  const segments = useMemo(() => visibleSegments(value.length, folds), [value, folds]);
  const text = useMemo(() => foldedText(value, segments), [value, segments]);
  const marks = useMemo(() => foldMarks(segments), [segments]);

  const painted = useMemo(() => {
    const spans =
      text.length > HIGHLIGHT_LIMIT
        ? [{ text, kind: null, match: false }]
        : highlightSpans(text, caret);
    const pieces: Array<{ text: string; className: string; folded: boolean }> = [];
    let offset = 0;
    for (const span of cutSpans(spans, marks)) {
      pieces.push({ text: span.text, className: spanClass(span), folded: marks.includes(offset) });
      offset += span.text.length;
    }
    // A run hidden at the very end of the buffer has no span after it to hang its marker on.
    return { pieces, trailing: marks.includes(offset) };
  }, [text, caret, marks]);

  function place(target: Placement): void {
    const box = field.current;
    if (box === null) return;
    if (target.focus) box.focus();
    box.setSelectionRange(target.from, target.to);
    at.current = target.from;
    setCaret(target.from);
  }

  /** Hides or shows runs, then puts the selection at a source range once the field has caught up. */
  function reshape(next: readonly SourceRange[], from: number, to: number, focus: boolean): void {
    const after = visibleSegments(value.length, next);
    const target: Placement = { from: toField(after, from), to: toField(after, to), focus };
    const same = next.length === folds.length && next.every((fold, index) => fold === folds[index]);
    if (same) {
      place(target);
      return;
    }
    placing.current = target;
    setFolds(next);
  }

  useLayoutEffect(() => {
    const target = placing.current;
    if (target === null) return;
    placing.current = null;
    place(target);
  });

  /** Folds the region the caret is standing in, or opens it if it is already folded. */
  function foldHere(): void {
    const here = toSource(segments, at.current, false);
    const region = regionAt(foldableRegions(value), here);
    if (region === null) return;
    reshape(
      toggleFold(folds, { from: region.from, to: region.to }),
      region.start,
      region.start,
      true,
    );
  }

  useLayoutEffect(() => {
    if (controls === undefined) return;
    controls.current = {
      select(from, to, focus) {
        reshape(revealRange(folds, from, to), from, to, focus);
      },
      fold: foldHere,
      unfoldAll() {
        const here = toSource(segments, at.current, false);
        reshape([], here, here, true);
      },
    };
  });

  /**
   * Says where the selection now is, in source positions.
   *
   * Measured against the segments given rather than the ones on screen, because typing is one of
   * the ways the selection moves and an edit can open or close a folded run as it lands. After an
   * edit the shape to measure against is the one the edit left behind.
   */
  /**
   * Where a source offset is on the screen, for a caret that is not this window's.
   *
   * Through the field's own positions first: a folded run is not on the screen at all, and
   * somebody standing inside one belongs at the marker that stands for it rather than nowhere.
   * Then measured on the painting, because a textarea will not say where its characters are and
   * the painting is the same characters in the same places.
   */
  const locate = useCallback(
    (offset: number): CaretSpot | null => {
      const box = ink.current;
      const text = painting.current;
      if (box === null || text === null) return null;
      // Somebody whose copy of the source is longer than this one. `toField` would give the end of
      // the painting for anything past it, and a caret drawn at the end is a caret in the wrong
      // place rather than a caret nobody has been given yet.
      if (!Number.isInteger(offset) || offset < 0 || offset > value.length) return null;
      return spotInText(box, text, toField(segments, offset));
    },
    [segments, value],
  );

  function report(against: readonly SourceRange[], start: number, end: number): void {
    onSelection?.(toSource(against, start, false), toSource(against, end, true));
  }

  function edit(next: string): FoldedEdit {
    const outcome = applyFieldEdit(value, folds, next);
    // Claimed before the parent hands the new buffer back, or it would look like someone else's.
    seen.current = outcome.source;
    if (
      outcome.folds.length !== folds.length ||
      outcome.folds.some((fold, index) => fold !== folds[index])
    ) {
      setFolds(outcome.folds);
    }
    onChange(outcome.source);
    return outcome;
  }

  return (
    <div className="latex-source">
      {/* Hidden from the reading order: it is the same text as the field, painted. */}
      <pre className="latex-source__ink" aria-hidden="true" ref={ink}>
        {/* Wrapped so that a caret can be measured against the text alone. The marks are drawn
            inside this box too, so that they scroll with it, and their name labels are text. */}
        <span className="latex-source__painting" ref={painting}>
          {painted.pieces.map((piece, index) => (
            <Fragment key={index}>
              {piece.folded ? <i className="latex-fold" /> : null}
              <span className={piece.className}>{piece.text}</span>
            </Fragment>
          ))}
          {painted.trailing ? <i className="latex-fold" /> : null}
          {/* A textarea keeps a line after a final newline. Without this the painting is one line
              short of the field at the bottom of the buffer. */}
          {"\n"}
        </span>
        <RemoteCarets carets={carets} locate={locate} />
      </pre>
      <textarea
        id={id}
        ref={field}
        className="document-editor__source latex-source__field"
        spellCheck={false}
        value={text}
        readOnly={!writable}
        onChange={(event) => {
          const outcome = edit(event.target.value);
          at.current = event.target.selectionStart;
          setCaret(event.target.selectionStart);
          report(
            visibleSegments(outcome.source.length, outcome.folds),
            event.target.selectionStart,
            event.target.selectionEnd,
          );
        }}
        onSelect={(event) => {
          at.current = event.currentTarget.selectionStart;
          setCaret(event.currentTarget.selectionStart);
          report(segments, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
        }}
        onBlur={() => {
          // A pair drawn under a caret that is no longer there is a pair nobody is looking at.
          setCaret(null);
        }}
        onKeyDown={(event) => {
          // The same key VS Code folds with, and folding is a view, so it works read-only too.
          if (!event.ctrlKey || !event.shiftKey || event.key !== "[") return;
          event.preventDefault();
          foldHere();
        }}
        onScroll={(event) => {
          const behind = ink.current;
          if (behind === null) return;
          behind.scrollTop = event.currentTarget.scrollTop;
          behind.scrollLeft = event.currentTarget.scrollLeft;
        }}
      />
    </div>
  );
}
