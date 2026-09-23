/**
 * A mark made on a page while reading.
 *
 * Annotations are never written into the PDF. The file is stored with a sha256 and
 * deduplicated by it, so rewriting it would break both and would mean the copy kept is no
 * longer the copy that was downloaded. An annotation is a separate record pointing at a page
 * and a region of it, which also makes it searchable, versioned, and reusable in a note.
 */

export const ANNOTATION_KINDS = ["highlight", "underline", "note", "text", "area"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/**
 * Kiwi's own palette. A colour is stored as a name rather than a hex value so the same
 * annotation reads correctly in a light and a dark theme, and so "yellow" still means
 * something if the palette is ever adjusted.
 */
export const ANNOTATION_COLORS = ["yellow", "green", "blue", "purple", "red", "orange"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/**
 * A region of a page, as a fraction of the page's width and height.
 *
 * Fractions rather than points: the same annotation then lands in the right place at any zoom,
 * on any screen, and the numbers stay meaningful when read straight out of the JSON.
 */
export interface AnnotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Annotation {
  kind: AnnotationKind;
  /** The imported file this mark is on. A Paper may hold a preprint and a published PDF. */
  asset_id: string;
  /** One-based, matching what the Reader shows. */
  page: number;
  /** The page's own label, kept so a quotation can cite "p. iv" rather than "p. 4". */
  page_label: string;
  rects: AnnotationRect[];
  color: AnnotationColor;
  /** The words under a highlight or underline, exactly as the document has them. */
  quoted: string;
  /** What the reader thought. */
  comment: string;
  /** For an area capture: the cropped image, stored as its own managed asset. */
  image_asset_id: string | null;
}

export const EMPTY_ANNOTATION: Omit<Annotation, "asset_id" | "page" | "page_label"> = {
  kind: "highlight",
  rects: [],
  color: "yellow",
  quoted: "",
  comment: "",
  image_asset_id: null,
};

export const ANNOTATION_LIMITS = {
  quoted: 20_000,
  comment: 20_000,
  rects: 400,
  page: 100_000,
} as const;

export interface AnnotationProblem {
  field: keyof Annotation;
  message: string;
}

function validRect(rect: AnnotationRect): boolean {
  const values = [rect.left, rect.top, rect.width, rect.height];
  if (!values.every((value) => Number.isFinite(value))) return false;
  // A rectangle may sit slightly outside the page box on a document with odd cropping, so the
  // bounds are generous. What is rejected is a value that cannot be a fraction at all.
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= -1 &&
    rect.top >= -1 &&
    rect.left + rect.width <= 2 &&
    rect.top + rect.height <= 2
  );
}

export function validateAnnotation(annotation: Annotation): AnnotationProblem[] {
  const problems: AnnotationProblem[] = [];
  const add = (field: keyof Annotation, message: string) => problems.push({ field, message });

  if (!(ANNOTATION_KINDS as readonly string[]).includes(annotation.kind)) {
    add("kind", "Choose a kind of annotation.");
  }
  if (!(ANNOTATION_COLORS as readonly string[]).includes(annotation.color)) {
    add("color", "Choose a colour from the palette.");
  }
  if (annotation.asset_id.trim() === "") add("asset_id", "An annotation belongs to a file.");
  if (
    !Number.isInteger(annotation.page) ||
    annotation.page < 1 ||
    annotation.page > ANNOTATION_LIMITS.page
  ) {
    add("page", "An annotation belongs to a page.");
  }
  if (annotation.rects.length > ANNOTATION_LIMITS.rects) {
    add("rects", `An annotation cannot cover more than ${ANNOTATION_LIMITS.rects} regions.`);
  }
  if (!annotation.rects.every(validRect)) {
    add("rects", "A region must be a fraction of the page.");
  }
  // A note is a pin and needs somewhere to sit; the marks that follow text need something to
  // mark. Only a free text box may be regionless.
  if (annotation.rects.length === 0 && annotation.kind !== "text") {
    add("rects", "This annotation needs a region of the page.");
  }
  if (annotation.quoted.length > ANNOTATION_LIMITS.quoted) {
    add("quoted", "The quoted passage is too long to store.");
  }
  if (annotation.comment.length > ANNOTATION_LIMITS.comment) {
    add("comment", "The comment is too long to store.");
  }
  if (annotation.kind === "area" && annotation.image_asset_id === null) {
    add("image_asset_id", "An area capture keeps the image it captured.");
  }
  return problems;
}

export function isAnnotation(value: unknown): value is Annotation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Annotation>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.asset_id === "string" &&
    typeof candidate.page === "number" &&
    Array.isArray(candidate.rects)
  );
}

export function readAnnotation(value: unknown): Annotation | null {
  if (!isAnnotation(value)) return null;
  const stored = value as Annotation;
  return {
    ...EMPTY_ANNOTATION,
    ...stored,
    kind: (ANNOTATION_KINDS as readonly string[]).includes(stored.kind) ? stored.kind : "highlight",
    color: (ANNOTATION_COLORS as readonly string[]).includes(stored.color)
      ? stored.color
      : "yellow",
    page_label: typeof stored.page_label === "string" ? stored.page_label : String(stored.page),
    rects: Array.isArray(stored.rects) ? stored.rects.filter(validRect) : [],
    quoted: typeof stored.quoted === "string" ? stored.quoted : "",
    comment: typeof stored.comment === "string" ? stored.comment : "",
    image_asset_id: typeof stored.image_asset_id === "string" ? stored.image_asset_id : null,
  };
}

/** The title an annotation object carries, so a list of them reads without opening each. */
export function annotationTitle(annotation: Annotation): string {
  const words = annotation.quoted.trim().replace(/\s+/gu, " ");
  if (words !== "") return words.length > 80 ? `${words.slice(0, 79)}…` : words;
  const comment = annotation.comment.trim().replace(/\s+/gu, " ");
  if (comment !== "") return comment.length > 80 ? `${comment.slice(0, 79)}…` : comment;
  const kind = annotation.kind === "area" ? "Figure" : "Note";
  return `${kind} on page ${annotation.page_label}`;
}

/** Reading order: down the page, then across, so a sidebar matches the eye. */
export function compareAnnotations(left: Annotation, right: Annotation): number {
  if (left.page !== right.page) return left.page - right.page;
  const leftTop = left.rects[0]?.top ?? 0;
  const rightTop = right.rects[0]?.top ?? 0;
  if (Math.abs(leftTop - rightTop) > 0.01) return leftTop - rightTop;
  return (left.rects[0]?.left ?? 0) - (right.rects[0]?.left ?? 0);
}
