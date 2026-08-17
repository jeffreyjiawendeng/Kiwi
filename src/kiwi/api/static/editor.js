// A markdown surface whose stored value is its source. Every source line
// is one block element, which is what lets a gutter mark sit beside the
// line it belongs to. Decoration never rewrites text: the syntax stays
// visible, so reading the source back is textContent.

import { el, escapeHtml } from "./core.js";

const TOKEN = new RegExp(
  [
    /\[@doc_[0-9a-f]{16}\]/.source,
    /\*\*[^*\n]+\*\*/.source,
    /\*[^*\n]+\*/.source,
    /`[^`\n]+`/.source,
  ].join("|"),
  "g"
);

// Re-rendering a line costs the browser's own undo for that line. A line
// carrying no syntax character, before or after an edit, cannot change how
// it is decorated, so it is left untouched.
const SYNTAX = /[[\]*`#>]/;

const HEADING = /^(#{1,6})\s/;

// A citation marker names a document by id, because that is what
// survives a rename and a re-parse. A reader should not be shown a hash,
// so the marker carries the citation it stands for and the stylesheet
// shows that instead. The text itself is untouched: reading the source
// back is still textContent, and deleting the marker deletes the id.
function lineHtml(text, labelFor) {
  if (!text) return "<br>";
  return escapeHtml(text).replace(TOKEN, (match) => {
    if (match.startsWith("[@")) {
      const label = labelFor ? labelFor(match.slice(2, -1)) : "";
      const attr = label ? ` data-cite="${escapeHtml(label)}"` : "";
      return `<span class="citation"${attr}>${match}</span>`;
    }
    if (match.startsWith("**")) return `<strong>${match}</strong>`;
    if (match.startsWith("*")) return `<em>${match}</em>`;
    return `<code>${match}</code>`;
  });
}

function lineClass(text) {
  const heading = HEADING.exec(text);
  if (heading) return `pe__line pe__line--h${heading[1].length}`;
  if (/^\s*>/.test(text)) return "pe__line pe__line--quote";
  return "pe__line";
}

function paint(line, text, labelFor) {
  line.dataset.src = text;
  line.className = lineClass(text);
  line.innerHTML = lineHtml(text, labelFor);
}

function makeLine(text, labelFor) {
  const line = document.createElement("div");
  paint(line, text, labelFor);
  return line;
}

/* --- Caret ---------------------------------------------------------------- */

function caretPosition(root) {
  const selection = getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  let line = range.startContainer;
  if (line.nodeType !== 1) line = line.parentNode;
  while (line && line.parentNode !== root) line = line.parentNode;
  if (!line) return null;

  const upto = range.cloneRange();
  upto.selectNodeContents(line);
  upto.setEnd(range.startContainer, range.startOffset);
  return {
    index: Array.prototype.indexOf.call(root.children, line),
    offset: upto.toString().length,
  };
}

function placeCaret(root, { index, offset }) {
  const line = root.children[index];
  if (!line) return;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = offset;
  while (node && remaining > node.length) {
    remaining -= node.length;
    const next = walker.nextNode();
    if (!next) break;
    node = next;
  }
  const range = document.createRange();
  if (node) range.setStart(node, Math.min(remaining, node.length));
  else range.setStart(line, 0);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/* --- Source offsets ------------------------------------------------------- */

// The stored value is the lines joined by newlines, so an offset into it
// is a line and an offset within that line. Everything that decorates a
// sentence rather than a line goes through here.
function locate(root, offset) {
  let remaining = Math.max(0, offset);
  const lines = root.children;
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index].textContent.length;
    if (remaining <= length) return { index, offset: remaining };
    remaining -= length + 1;
  }
  const last = lines.length - 1;
  return { index: last, offset: lines[last] ? lines[last].textContent.length : 0 };
}

// The text node and offset a character sits at, walking the decorated
// spans the renderer produced.
function pointIn(line, offset) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = offset;
  while (node && remaining > node.length) {
    remaining -= node.length;
    const next = walker.nextNode();
    if (!next) break;
    node = next;
  }
  return node ? [node, Math.min(remaining, node.length)] : [line, 0];
}

function offsetBefore(root, index) {
  let total = 0;
  for (let i = 0; i < index; i += 1) total += root.children[i].textContent.length + 1;
  return total;
}

/* --- Editor --------------------------------------------------------------- */

export function proseEditor({
  id,
  value = "",
  onChange = null,
  onCaret = null,
  labelFor = null,
}) {
  const root = el("div", {
    class: "pe",
    id,
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "true",
  });

  let composing = false;

  function set(text) {
    // Not .map(makeLine): map passes the index as the second argument,
    // which would arrive here as the labeller.
    root.replaceChildren(
      ...String(text)
        .split("\n")
        .map((line) => makeLine(line, labelFor))
    );
  }

  function get() {
    return Array.from(root.children)
      .map((line) => line.textContent)
      .join("\n");
  }

  // Enter, paste, and drop all leave nodes the renderer does not own.
  function normalize() {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === 1 && node.tagName === "DIV") continue;
      const line = document.createElement("div");
      line.className = "pe__line";
      root.insertBefore(line, node);
      line.append(node);
    }
    if (!root.firstChild) root.append(makeLine("", labelFor));
  }

  function repaint() {
    const caret = caretPosition(root);
    let moved = false;
    for (const line of root.children) {
      const text = line.textContent;
      const previous = line.dataset.src;
      if (previous === text) continue;
      if (previous !== undefined && !SYNTAX.test(text) && !SYNTAX.test(previous)) {
        line.dataset.src = text;
        line.className = lineClass(text);
        continue;
      }
      paint(line, text, labelFor);
      moved = true;
    }
    if (moved && caret) placeCaret(root, caret);
  }

  root.addEventListener("compositionstart", () => (composing = true));
  root.addEventListener("compositionend", () => {
    composing = false;
    normalize();
    repaint();
    if (onChange) onChange();
  });

  root.addEventListener("input", () => {
    if (composing) return;
    normalize();
    repaint();
    if (onChange) onChange();
  });

  // Pasted markup would survive as nested elements the line model cannot
  // read back.
  root.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  });

  // Caret position is only observable from the document. A replaced
  // editor drops its listener rather than leaving one per visit.
  if (onCaret) {
    const watch = () => {
      if (!root.isConnected) {
        document.removeEventListener("selectionchange", watch);
        return;
      }
      if (!root.contains(getSelection()?.anchorNode ?? null)) return;
      const caret = caretPosition(root);
      if (caret) onCaret(caret.index);
    };
    document.addEventListener("selectionchange", watch);
  }

  set(value);

  return {
    root,
    get,
    set,
    // Offsets are measured against the editor's own top so the gutter,
    // which is its sibling, can use them unchanged.
    lineTops() {
      const base = root.getBoundingClientRect().top;
      return Array.from(root.children).map((line) => ({
        top: line.getBoundingClientRect().top - base,
        height: line.offsetHeight,
      }));
    },
    height() {
      return root.scrollHeight;
    },

    // Repaint every marker, for when the papers a draft cites are known
    // only after the draft is on screen.
    relabel() {
      for (const line of root.children) paint(line, line.textContent, labelFor);
    },

    // The boxes a run of source occupies, measured against the editor's
    // own top so an overlay that is its sibling can use them unchanged.
    // A sentence wrapped over three lines returns three boxes.
    rectsFor(start, end) {
      const from = locate(root, start);
      const to = locate(root, end);
      const first = root.children[from.index];
      const last = root.children[to.index];
      if (!first || !last) return [];

      const range = document.createRange();
      range.setStart(...pointIn(first, from.offset));
      range.setEnd(...pointIn(last, to.offset));
      const base = root.getBoundingClientRect();
      return Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 || rect.height > 0)
        .map((rect) => ({
          top: rect.top - base.top,
          left: rect.left - base.left,
          width: rect.width,
          height: rect.height,
        }));
    },

    // Which character the pointer is over, as an offset into the source.
    // Returns null outside the text.
    offsetAt(x, y) {
      let node = null;
      let offset = 0;
      if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (!position) return null;
        node = position.offsetNode;
        offset = position.offset;
      } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (!range) return null;
        node = range.startContainer;
        offset = range.startOffset;
      } else {
        return null;
      }
      if (!root.contains(node)) return null;

      let line = node.nodeType === 1 ? node : node.parentNode;
      while (line && line.parentNode !== root) line = line.parentNode;
      if (!line) return null;

      const upto = document.createRange();
      upto.selectNodeContents(line);
      upto.setEnd(node, offset);
      const index = Array.prototype.indexOf.call(root.children, line);
      return offsetBefore(root, index) + upto.toString().length;
    },
    focusLine(index, offset = 0) {
      const line = root.children[index];
      if (!line) return;
      root.focus();
      placeCaret(root, { index, offset });
      line.scrollIntoView({ block: "center" });
    },
  };
}

// A claim records where its sentence sat when the draft was scored. The
// draft may have been edited since, so the recorded offset is trusted only
// when the text still matches, and the sentence is searched for otherwise.
export function lineIndexOf(source, exact, start) {
  if (!exact) return -1;
  let at = -1;
  if (typeof start === "number" && source.slice(start, start + exact.length) === exact) {
    at = start;
  } else {
    at = source.indexOf(exact);
  }
  if (at < 0) return -1;
  return source.slice(0, at).split("\n").length - 1;
}
