import type { AnnotationRect } from "@kiwi/contracts";

/**
 * Capturing a region of a page as an image.
 *
 * This is what makes a figure reusable, the feature most readers reach for and most tools
 * omit. The crop is taken from the canvas PDF.js already drew, so what is captured is exactly
 * what was on screen, at whatever resolution it was rendered.
 */

/** The smallest drag worth treating as a capture rather than a stray click. */
export const MINIMUM_CAPTURE = 0.01;

export interface DragPoint {
  x: number;
  y: number;
}

/**
 * The rectangle between two points, as fractions of the page.
 *
 * Normalized, because a drag upwards and to the left is as valid as one downwards and to the
 * right, and clamped, because a drag that leaves the page should stop at its edge rather than
 * describe a region that is not there.
 */
export function dragRect(from: DragPoint, to: DragPoint): AnnotationRect {
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const right = Math.max(from.x, to.x);
  const bottom = Math.max(from.y, to.y);
  const clampedLeft = Math.min(Math.max(left, 0), 1);
  const clampedTop = Math.min(Math.max(top, 0), 1);
  return {
    left: clampedLeft,
    top: clampedTop,
    width: Math.min(Math.max(right, 0), 1) - clampedLeft,
    height: Math.min(Math.max(bottom, 0), 1) - clampedTop,
  };
}

export function isCaptureWorthKeeping(rect: AnnotationRect): boolean {
  return rect.width >= MINIMUM_CAPTURE && rect.height >= MINIMUM_CAPTURE;
}

/** Where a pointer landed within an element, as fractions of it. */
export function pointerFraction(element: Element, clientX: number, clientY: number): DragPoint {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
}

/** Strips the `data:image/png;base64,` prefix, leaving what the main process decodes. */
export function base64Of(dataUrl: string): string | null {
  const marker = "base64,";
  const at = dataUrl.indexOf(marker);
  if (at < 0 || !dataUrl.startsWith("data:image/png")) return null;
  const payload = dataUrl.slice(at + marker.length);
  return payload === "" ? null : payload;
}

/**
 * A file name for the capture.
 *
 * Names the page it came from, because a folder of `capture-1.png` tells the person who opens
 * it in six months nothing at all.
 */
export function captureName(pageLabel: string, now: Date): string {
  const safe = pageLabel.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return `page-${safe === "" ? "capture" : safe}-${stamp}.png`;
}

/**
 * Crops a rectangle out of a rendered page canvas.
 *
 * Returns null rather than a blank image when the environment has no working canvas: the test
 * environment has none, and a reader whose graphics stack fails should be told the capture did
 * not happen rather than handed an empty picture.
 */
export function cropCanvas(
  source: HTMLCanvasElement,
  rect: AnnotationRect,
  create: () => HTMLCanvasElement,
): string | null {
  const width = Math.round(rect.width * source.width);
  const height = Math.round(rect.height * source.height);
  if (width < 1 || height < 1) return null;
  const target = create();
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (context === null) return null;
  try {
    context.drawImage(
      source,
      Math.round(rect.left * source.width),
      Math.round(rect.top * source.height),
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const url = target.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url : null;
  } catch {
    return null;
  }
}
