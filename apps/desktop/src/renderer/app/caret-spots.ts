/**
 * Turning an offset into a place on the screen.
 *
 * A textarea will not say where one of its characters is. The LaTeX editor already solves that for
 * itself: the colouring painted behind the field is the same text laid out the same way, so a
 * character in the painting is over the same character in the field. Measuring the painting is
 * therefore measuring the field, and this is the only reason a remote caret can be drawn on a
 * plain textarea at all.
 *
 * The rich editor has no such problem -- it is real nodes and it will say where a position is --
 * so it does not come through here. What both share is the answer: a place in the coordinates of
 * whatever box the caret is going to be drawn in, so the drawing is the same in both.
 */

/** Where a caret goes, measured from the top left of the box it is drawn in, scrolling included. */
export interface CaretSpot {
  left: number;
  top: number;
  height: number;
}

/** A character offset landed on a piece of text. */
export interface TextPoint {
  node: Text;
  offset: number;
}

/**
 * The text node an offset into the whole of a subtree's text falls in.
 *
 * On the seam between two runs the earlier one wins, so a caret between a coloured command and the
 * plain text after it is drawn at the end of the command rather than at the start of the text --
 * the same place, reached from the side that already exists.
 *
 * Past the end of the text, nothing. That is a real answer: a caret from somebody whose copy of
 * the document is longer than this one has nowhere honest to go, and drawing it at the end would
 * be inventing a position rather than reporting one.
 */
export function textPointAt(root: Node, offset: number): TextPoint | null {
  if (!Number.isFinite(offset) || offset < 0) return null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    const text = node as Text;
    if (offset <= seen + text.data.length) return { node: text, offset: offset - seen };
    seen += text.data.length;
  }
  return null;
}

/**
 * Where a character offset into some text sits inside the box it is drawn in.
 *
 * The text walked and the box measured against are given separately, because the marks are drawn
 * inside the same box so that they scroll with it, and a mark's own name label is text that is not
 * part of the document. Walking the box would count it.
 *
 * A range collapsed on the spot is what gives the position. Some of them measure as having no
 * height, and a caret no pixels tall is a caret nobody can see, so the character after it is
 * measured instead and only its height is taken -- the position stays the collapsed one, which is
 * the accurate of the two.
 */
export function spotInText(box: HTMLElement, text: Node, offset: number): CaretSpot | null {
  const point = textPointAt(text, offset);
  if (point === null) return null;

  const range = document.createRange();
  try {
    range.setStart(point.node, point.offset);
    range.collapse(true);
  } catch {
    return null;
  }
  const at = range.getBoundingClientRect();
  let height = at.height;
  if (height === 0 && point.offset < point.node.data.length) {
    try {
      range.setEnd(point.node, point.offset + 1);
      height = range.getBoundingClientRect().height;
    } catch {
      height = 0;
    }
  }

  const frame = box.getBoundingClientRect();
  return {
    left: at.left - frame.left + box.scrollLeft,
    top: at.top - frame.top + box.scrollTop,
    height,
  };
}
