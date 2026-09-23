/**
 * What survives a paste.
 *
 * The rule the whole file follows: what survives a paste is what would survive being retyped by
 * someone who understood the document. A heading is a heading because of what it says, not because
 * it is sixteen-point Cambria, so headings, lists, tables, links, and the marks that change what a
 * word means are kept, and everything describing how another application drew the text is thrown
 * away. It described a page that is not this one, and carrying it in is how a manuscript ends up
 * with four fonts nobody chose.
 *
 * Everything here is done on a parsed document rather than with expressions over the markup.
 * Word's HTML is not markup anyone would write by hand, and a regular expression that survives one
 * paste from it is a regular expression that fails on the next.
 */

/** Elements that survive, and the attributes each may keep. Everything else is unwrapped. */
const KEEP: Readonly<Record<string, readonly string[]>> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  ul: [],
  ol: [],
  li: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  blockquote: [],
  pre: [],
  code: [],
  strong: [],
  em: [],
  u: [],
  s: [],
  sup: [],
  sub: [],
  a: ["href"],
  br: [],
  hr: [],
};

/**
 * Elements dropped with everything inside them.
 *
 * Images are on this list on purpose. One pasted from Word points at a temporary file on whichever
 * computer did the copying, and one pasted from a browser points at a server the content policy
 * will not load from, both arrive as a broken box. A figure in Kiwi is a managed asset, and Insert
 * figure is the way to get one.
 */
const DISCARD = new Set([
  "script",
  "style",
  "head",
  "meta",
  "link",
  "title",
  "noscript",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "svg",
  "canvas",
  "img",
  "picture",
  "source",
  "video",
  "audio",
]);

/** Tags that mean the same thing under another name. */
const RENAME: Readonly<Record<string, string>> = {
  b: "strong",
  i: "em",
  strike: "s",
  del: "s",
  ins: "u",
};

/** Link schemes that may survive. A `file:` link points at somebody else's disk. */
const SCHEMES = /^(https?:|mailto:|doi:|#)/i;

/** Block-level tags, used to decide whether a `div` is standing in for a paragraph. */
const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "blockquote",
  "pre",
  "div",
  "hr",
]);

/**
 * Cleans one clipboard payload.
 *
 * A paste that came from this editor is returned untouched. ProseMirror writes its own clipboard
 * HTML with the open and close depths of the copied slice recorded in an attribute, and cleaning
 * that would turn copying half a list into pasting a mangled one, the cleaner exists for HTML
 * written by other programs.
 */
export function cleanPastedHtml(html: string): string {
  if (html === "" || html.includes("data-pm-slice")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const body = parsed.body;
  // Before the attributes are stripped, because both of these read them.
  convertWordLists(body);
  cleanChildren(body);
  dropEmptyBlocks(body);
  return body.innerHTML;
}

function cleanChildren(parent: Element): void {
  // A copy, because cleaning a child can insert, unwrap, or remove nodes around it.
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === 8) {
      // Word's conditional comments carry the list markers, which have already been read.
      child.remove();
      continue;
    }
    if (child.nodeType === 1) cleanElement(child as Element);
  }
}

function cleanElement(element: Element): void {
  const tag = element.tagName.toLowerCase();
  // Word emits `<o:p>` and `<v:shape>`; nothing namespaced means anything here.
  if (DISCARD.has(tag) || tag.includes(":")) {
    element.remove();
    return;
  }

  const style = element.getAttribute("style") ?? "";
  const implied = impliedMarks(style);
  cleanChildren(element);

  const name = RENAME[tag] ?? (tag === "div" ? divName(element) : tag);
  // A browser writes a whole copied page inside `<b style="font-weight:normal">`, and honouring
  // the tag over the style it carries is why a paste from one arrives entirely in bold.
  const denied =
    (name === "strong" && /^(normal|[1-5]00)$/.test(readStyle(style, "font-weight"))) ||
    (name === "em" && readStyle(style, "font-style") === "normal");
  const kept = !denied && Object.hasOwn(KEEP, name) ? name : null;
  const target = kept === null || kept === tag ? element : rename(element, kept);

  // Applied to the children rather than around the element, so a bold `<span>` that is about to be
  // unwrapped still leaves its word bold.
  wrapChildren(
    target,
    implied.filter((mark) => mark !== kept),
  );

  if (kept === null) {
    unwrap(target);
    return;
  }
  for (const attribute of target.getAttributeNames()) {
    if (!KEEP[kept]?.includes(attribute)) target.removeAttribute(attribute);
  }
  // A link to nowhere reachable is a phrase in blue that does nothing when clicked.
  if (kept === "a" && !SCHEMES.test(target.getAttribute("href") ?? "")) unwrap(target);
}

/**
 * Whether a `div` is a paragraph or a wrapper.
 *
 * Browsers write a line as a `div`, and unwrapping those runs a page together into one paragraph.
 * A `div` holding blocks of its own is only a container, and becomes nothing.
 */
function divName(element: Element): string {
  for (const child of element.children) {
    if (BLOCKS.has(child.tagName.toLowerCase())) return "div";
  }
  return "p";
}

/**
 * The marks an element's inline style is standing in for.
 *
 * This is the half of the job that is easy to get backwards. Stripping the style attribute is
 * right, but a browser writes bold as `font-weight: 700` on a plain span, so stripping it first
 * and asking questions later is how a pasted page comes out uniformly unemphasised. The style is
 * read for what it means, and only then thrown away.
 */
function impliedMarks(style: string): string[] {
  if (style === "") return [];
  const marks: string[] = [];
  const weight = readStyle(style, "font-weight");
  const decoration = readStyle(style, "text-decoration") + readStyle(style, "text-decoration-line");
  const align = readStyle(style, "vertical-align");
  if (/^(bold|bolder|[6-9]00)$/.test(weight)) marks.push("strong");
  if (/^(italic|oblique)/.test(readStyle(style, "font-style"))) marks.push("em");
  if (decoration.includes("underline")) marks.push("u");
  if (decoration.includes("line-through")) marks.push("s");
  if (align === "super") marks.push("sup");
  if (align === "sub") marks.push("sub");
  return marks;
}

function readStyle(style: string, property: string): string {
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== property) continue;
    return declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
  }
  return "";
}

function wrapChildren(element: Element, tags: readonly string[]): void {
  if (tags.length === 0 || element.firstChild === null) return;
  const document_ = element.ownerDocument;
  let inner = document_.createElement(tags[0] ?? "span");
  while (element.firstChild !== null) inner.appendChild(element.firstChild);
  for (const tag of tags.slice(1)) {
    const outer = document_.createElement(tag);
    outer.appendChild(inner);
    inner = outer;
  }
  element.appendChild(inner);
}

function rename(element: Element, tag: string): Element {
  const replacement = element.ownerDocument.createElement(tag);
  while (element.firstChild !== null) replacement.appendChild(element.firstChild);
  for (const attribute of element.getAttributeNames()) {
    replacement.setAttribute(attribute, element.getAttribute(attribute) ?? "");
  }
  element.replaceWith(replacement);
  return replacement;
}

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (parent === null) return;
  while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
  element.remove();
}

/**
 * Paragraphs that hold nothing.
 *
 * Word ends a document with a run of them, and a page pasted from a browser is full of them where
 * the layout wanted air. Nobody retyping the document would press Enter four times, so they go. A
 * paragraph holding a table or a list is not empty whatever its text says.
 */
function dropEmptyBlocks(body: Element): void {
  for (const block of [...body.querySelectorAll("p, h1, h2, h3, h4, h5, h6")]) {
    if (block.querySelector("table, ul, ol, hr") !== null) continue;
    // The character being replaced below is a non-breaking space, which is what Word leaves in a
    // paragraph that holds nothing and what stops `trim` from seeing it as empty.
    if (block.textContent?.replaceAll(" ", " ").trim() !== "") continue;
    block.remove();
  }
}

/**
 * Word's list paragraphs, turned into lists.
 *
 * Word does not write `<ul>`. It writes a run of ordinary paragraphs, each carrying an `mso-list`
 * style, each starting with a hidden span holding the bullet or the number as literal text. Pasted
 * as they are, the indentation dies with the styles and the numbers stay behind as text that does
 * not renumber when a line is added, which is the single most familiar way a pasted document is
 * wrong.
 */
function convertWordLists(body: Element): void {
  const paragraphs = [...body.querySelectorAll("p")];
  let index = 0;
  while (index < paragraphs.length) {
    const first = paragraphs[index];
    if (first === undefined || !isListParagraph(first)) {
      index += 1;
      continue;
    }
    const run: Element[] = [];
    let node: Element | null = first;
    while (node !== null && isListParagraph(node)) {
      run.push(node);
      node = node.nextElementSibling;
    }
    buildList(run, first);
    index += run.length;
  }
}

function isListParagraph(element: Element): boolean {
  if (element.tagName.toLowerCase() !== "p") return false;
  if ((element.getAttribute("style") ?? "").toLowerCase().includes("mso-list:")) return true;
  return /mso-?list-?paragraph/i.test(element.getAttribute("class") ?? "");
}

function buildList(run: readonly Element[], anchor: Element): void {
  const parent = anchor.parentNode;
  if (parent === null) return;
  const document_ = anchor.ownerDocument;
  // One entry per open list, outermost first. A deeper paragraph opens a list inside the item
  // above it, which is what makes an indented sub-list an indented sub-list rather than a
  // second list next to the first.
  const open: Array<{ level: number; list: Element }> = [];
  for (const paragraph of run) {
    const marker = takeMarker(paragraph);
    const level = Number(/level(\d+)/i.exec(paragraph.getAttribute("style") ?? "")?.[1] ?? "1");
    while (open.length > 1 && (open[open.length - 1]?.level ?? 1) > level) open.pop();
    const top = open[open.length - 1];
    if (top === undefined || top.level < level) {
      const list = document_.createElement(ordered(marker) ? "ol" : "ul");
      if (top === undefined) parent.insertBefore(list, anchor);
      else (top.list.lastElementChild ?? top.list).appendChild(list);
      open.push({ level, list });
    }
    const item = document_.createElement("li");
    while (paragraph.firstChild !== null) item.appendChild(paragraph.firstChild);
    open[open.length - 1]?.list.appendChild(item);
    paragraph.remove();
  }
}

/**
 * Removes the marker from a list paragraph and returns it.
 *
 * The marker is what says whether the list is numbered, and it must not also survive as text:
 * "1. 1. First point" is what a paste looks like when only one of those two things is done.
 */
function takeMarker(paragraph: Element): string {
  for (const span of paragraph.querySelectorAll("span")) {
    if (!(span.getAttribute("style") ?? "").toLowerCase().includes("mso-list:ignore")) continue;
    const text = span.textContent ?? "";
    span.remove();
    return text.trim();
  }
  // Older Word hid the marker in a conditional comment instead, and the browser's parser leaves
  // the marker behind as ordinary text at the front of the paragraph.
  const leading = /^\s*([·•▪●o-]|\w{1,4}[.)])\s+/.exec(paragraph.textContent ?? "");
  if (leading === null) return "";
  trimLeading(paragraph, leading[0].length);
  return leading[1] ?? "";
}

function trimLeading(paragraph: Element, length: number): void {
  let left = length;
  const walker = paragraph.ownerDocument.createTreeWalker(paragraph, 4);
  while (left > 0) {
    const text = walker.nextNode();
    if (text === null) return;
    const taken = Math.min(left, text.textContent?.length ?? 0);
    text.textContent = (text.textContent ?? "").slice(taken);
    left -= taken;
  }
}

/** A marker is a number when it counts. A bare `o` is Word's second-level bullet, not a letter. */
function ordered(marker: string): boolean {
  return /^[\da-z]{1,4}[.)]$/i.test(marker);
}

/** What the editor does with a pasted payload, in a form that can be tested without an editor. */
export interface PlainPasteTarget {
  pasteText(text: string): void;
}

export interface PasteHandlers {
  transformPastedHTML(html: string): string;
  handleKeyDown(view: unknown, event: KeyboardEvent): boolean;
  handlePaste(view: PlainPasteTarget, event: ClipboardEvent): boolean;
}

/**
 * The paste behaviour of one editor.
 *
 * `Ctrl+Shift+V` pastes the words with none of their formatting, which is the escape hatch for
 * everything the cleaner keeps and this particular paste did not want. A paste event does not say
 * which keys were held to start it, so the keystroke immediately before it is what has to be
 * remembered; the flag is set from every keystroke rather than only from that one, so a chord that
 * pastes nothing cannot leave the next ordinary paste stripped.
 */
export function createPasteHandlers(): PasteHandlers {
  let plain = false;
  return {
    transformPastedHTML: cleanPastedHtml,
    handleKeyDown(_view, event) {
      plain = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v";
      // Never claimed: the paste that follows is still the browser's to deliver.
      return false;
    },
    handlePaste(view, event) {
      if (!plain) return false;
      // Cleared first. The plain paste below comes back through this handler, and that one is an
      // ordinary paste of text.
      plain = false;
      view.pasteText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    },
  };
}
