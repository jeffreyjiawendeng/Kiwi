/**
 * Where the caret is, on its way to everybody else.
 *
 * Presence carries one number per person, and this is the number: where that person's caret sits
 * in the document they have open. The coordinate is the document's own rather than something
 * invented to sit between the two kinds, a character offset into the source of a LaTeX
 * manuscript, a position in the node tree of a rich one. Which of the two a document counts in is
 * a property of the document and not of the window looking at it, so two windows on one document
 * are always counting in the same units, and neither has to say which units it meant.
 *
 * The editor announces and the top bar carries. They are far apart in the tree and neither owns
 * the other, which is why this is an event and not a prop, the same as `kiwi:object-context`.
 *
 * Announcing sends nothing. It is in-process, and the presence poll reads whatever the latest
 * value is on its next turn. That is the debounce: a caret crossed from one paragraph to the next
 * leaves as one number five seconds later, not as one per keystroke.
 */

import { useEffect, useState } from "react";

export const CARET_CHANNEL = "kiwi:caret";

export interface CaretAt {
  documentId: string;
  offset: number;
}

/**
 * The offset the presence request will actually accept.
 *
 * A cursor that is not a whole number at or above zero is refused by the main process, and it
 * refuses the whole poll rather than the number, which would cost presence for everybody in the
 * document over one bad caret. So it is made acceptable here instead.
 */
export function caretOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The last caret announced, so that a listener which starts after the editor has spoken is not
 * left at zero until the next time somebody moves the caret.
 *
 * One entry, because one document is open at a time. A listener for any other document ignores it.
 */
let last: CaretAt | null = null;

/** Forgets it. For tests, and for anywhere that wants a window to stop having a caret at all. */
export function forgetCaret(): void {
  last = null;
}

export function announceCaret(at: CaretAt): void {
  last = { documentId: at.documentId, offset: caretOffset(at.offset) };
  window.dispatchEvent(new CustomEvent(CARET_CHANNEL, { detail: last }));
}

/**
 * The caret in one document, or zero.
 *
 * Zero for a document nobody has announced a caret in, which is also where a caret starts, so
 * there is nothing to distinguish and nothing worth distinguishing: the beginning of the document
 * is a true enough answer for somebody who has not moved yet.
 */
export function useCaretFor(documentId: string | null): number {
  const [latest, setLatest] = useState<CaretAt | null>(null);

  useEffect(() => {
    if (documentId === null) return;
    function heard(event: Event): void {
      const detail = (event as CustomEvent<Partial<CaretAt>>).detail;
      if (detail === null || detail === undefined) return;
      if (detail.documentId !== documentId || typeof detail.offset !== "number") return;
      setLatest({ documentId, offset: caretOffset(detail.offset) });
    }
    window.addEventListener(CARET_CHANNEL, heard);
    return () => window.removeEventListener(CARET_CHANNEL, heard);
  }, [documentId]);

  // Answered while rendering rather than from an effect, because the poll for a document that has
  // just been opened is started by an effect too, and it would read a caret set by a later one.
  // Falling back to what was announced before anybody was listening is the same fallback in a
  // different place: `latest` covers this document once it has spoken, and `last` covers it
  // before that.
  const known = latest !== null && latest.documentId === documentId ? latest : last;
  return known !== null && known.documentId === documentId ? known.offset : 0;
}
