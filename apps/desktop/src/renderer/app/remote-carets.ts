/**
 * Everybody else's caret, on its way to the editor that will draw it.
 *
 * The poll lives in the top bar and the drawing happens in the editor, which is the same shape as
 * the caret going the other way: an event rather than a prop, because the two are far apart in the
 * tree and neither owns the other. Nothing here asks the service anything. The answer the top bar
 * already has is passed along, so drawing a caret costs no extra request.
 *
 * The name label appears when somebody moves and fades once they have stopped. It has to outlast
 * the poll, or a person typing steadily would have their label go dark between one answer and the
 * next and read as somebody who keeps arriving and leaving. So the label is lit by movement and
 * goes out a few seconds after the last movement that was actually seen.
 *
 * A reading that says nobody is here -- which is what an answer that did not arrive says, see
 * `presence.ts` -- takes the carets off the screen. A caret that has stopped being refreshed is
 * pointing at where somebody was, and the whole point of drawing it is to say where they are.
 */

import { useEffect, useRef, useState } from "react";
import type { PresentPerson } from "./presence.js";

export const PRESENCE_CHANNEL = "kiwi:presence";

/** Who the last answer said was in a document. */
export interface PresenceAt {
  documentId: string;
  people: readonly PresentPerson[];
}

/** One remote caret, in the document's own positions, ready to be put somewhere on the screen. */
export interface RemoteCaret {
  userId: string;
  name: string;
  colour: string;
  offset: number;
  /** Whether their name is showing. See the note above about why this outlasts the poll. */
  labelled: boolean;
}

/**
 * How long a name stays up after the last movement seen.
 *
 * Longer than the poll on purpose. Movement is only ever noticed one answer at a time, so a label
 * that expired inside the interval would be dark more often than it was lit for somebody who had
 * not stopped typing at all.
 */
export const CARET_LABEL_MS = 8_000;

/** One array for every reading with nobody in it, so an empty answer is not a new one each tick. */
const NOBODY: readonly RemoteCaret[] = [];

/** Where somebody was last seen, and when they were last seen somewhere else. */
interface Sighting {
  cursor: number;
  at: number;
}

let last: PresenceAt | null = null;

/** Forgets it. For tests, and for a window that should stop claiming anybody is in a document. */
export function forgetPresence(): void {
  last = null;
}

export function announcePresence(at: PresenceAt): void {
  last = { documentId: at.documentId, people: at.people };
  window.dispatchEvent(new CustomEvent(PRESENCE_CHANNEL, { detail: last }));
}

/**
 * The sightings the latest answer supports.
 *
 * Somebody whose cursor is where it was keeps the moment they were last somewhere else, so their
 * label goes out on time rather than being held up by them still being here. Somebody new, and
 * somebody who left and came back, counts as having moved: arriving is worth a name.
 */
export function sightings(
  previous: ReadonlyMap<string, Sighting>,
  people: readonly PresentPerson[],
  now: number,
): Map<string, Sighting> {
  const next = new Map<string, Sighting>();
  for (const person of people) {
    const before = previous.get(person.userId);
    next.set(
      person.userId,
      before !== undefined && before.cursor === person.cursor
        ? before
        : { cursor: person.cursor, at: now },
    );
  }
  return next;
}

export function remoteCarets(
  people: readonly PresentPerson[],
  seen: ReadonlyMap<string, Sighting>,
  now: number,
): readonly RemoteCaret[] {
  if (people.length === 0) return NOBODY;
  return people.map((person) => ({
    userId: person.userId,
    name: person.name,
    colour: person.colour,
    offset: person.cursor,
    labelled: (seen.get(person.userId)?.at ?? 0) + CARET_LABEL_MS > now,
  }));
}

/** When the next label goes out, or null if none of them is lit. */
export function nextFade(seen: ReadonlyMap<string, Sighting>, now: number): number | null {
  let soonest: number | null = null;
  for (const sighting of seen.values()) {
    const out = sighting.at + CARET_LABEL_MS;
    if (out <= now) continue;
    if (soonest === null || out < soonest) soonest = out;
  }
  return soonest;
}

/**
 * The carets to draw in one document.
 *
 * The array keeps its identity between answers, because whoever draws these has to measure the
 * screen to place them and there is no reason to measure again for a reading that has not changed.
 */
export function useRemoteCarets(documentId: string | null): readonly RemoteCaret[] {
  const [carets, setCarets] = useState<readonly RemoteCaret[]>(NOBODY);
  // The people the latest answer named, so that a label going out can be redrawn without waiting
  // for the next answer to arrive.
  const here = useRef<readonly PresentPerson[]>([]);
  const seen = useRef<ReadonlyMap<string, Sighting>>(new Map());
  const fading = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    seen.current = new Map();
    here.current = [];
    if (documentId === null) {
      setCarets(NOBODY);
      return;
    }

    function show(people: readonly PresentPerson[]): void {
      const now = Date.now();
      here.current = people;
      seen.current = sightings(seen.current, people, now);
      setCarets(remoteCarets(people, seen.current, now));
      if (fading.current !== null) clearTimeout(fading.current);
      fading.current = null;
      const out = nextFade(seen.current, now);
      if (out === null) return;
      // Redrawn when the soonest label is due out, with the same people: nothing has been heard,
      // and what changes is only that somebody has now been still for long enough.
      fading.current = setTimeout(() => show(here.current), out - now);
    }

    function heard(event: Event): void {
      const detail = (event as CustomEvent<Partial<PresenceAt>>).detail;
      if (detail === null || detail === undefined) return;
      if (detail.documentId !== documentId || !Array.isArray(detail.people)) return;
      show(detail.people);
    }

    window.addEventListener(PRESENCE_CHANNEL, heard);
    // The editor is mounted by opening a document and the answer about that document may already
    // have arrived, which is the same reason the caret going the other way is remembered.
    if (last !== null && last.documentId === documentId) show(last.people);
    else setCarets(NOBODY);

    return () => {
      window.removeEventListener(PRESENCE_CHANNEL, heard);
      if (fading.current !== null) clearTimeout(fading.current);
      fading.current = null;
    };
  }, [documentId]);

  return carets;
}
