import type { AnnotationKind, AnnotationRect } from "@kiwi/contracts";
import type { DragPoint } from "./pdf-capture.js";

/**
 * Marks that point at a place on the page rather than at a passage of it.
 *
 * A highlight needs words underneath it, and most of what a reader wants to say has none: a
 * question about a figure, a doubt about a table, a reminder next to a blank half-page where the
 * method should have been. Those get an anchor that is a point, a sticky note, which is a pin
 * you open to read, or a text box, which is words drawn on the page itself.
 *
 * The point is still stored as a rectangle, because that is the one anchor the annotation model
 * has and a second one would be a second thing to orphan, to render and to send to a note. It is
 * simply a very small square, and what is drawn at it does not take its size from it.
 */

export const POINT_KINDS = ["note", "text"] as const;
export type PointKind = (typeof POINT_KINDS)[number];

/**
 * How much of the page the anchor square claims.
 *
 * Small enough to read as a point, large enough that the model's "a region must be a fraction of
 * the page" check has something to accept, and large enough to survive a document whose pages
 * are cropped differently from one another.
 */
export const POINT_SIZE = 0.02;

export function isPointKind(kind: AnnotationKind): kind is PointKind {
  return (POINT_KINDS as readonly string[]).includes(kind);
}

/**
 * The anchor square for a point somebody clicked, centred on it.
 *
 * Clamped to the page, so a click on the very edge leaves an anchor that is still on the page it
 * belongs to. A point that is not a number at all becomes the top left corner rather than an
 * anchor nothing can draw: the mark is then in the wrong place, which can be seen and fixed,
 * instead of nowhere, which cannot.
 */
export function pointRect(at: DragPoint): AnnotationRect {
  const place = (value: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(value - POINT_SIZE / 2, 0), 1 - POINT_SIZE) : 0;
  return { left: place(at.x), top: place(at.y), width: POINT_SIZE, height: POINT_SIZE };
}
