import { CROSS_REFERENCE_NODE } from "./crossref.js";
import { MENTION_NODE, mentionNodeText } from "./mention.js";
import { QUOTATION_NODE, quotationNodeText } from "./quotation.js";
import { isDocumentNode, type DocumentNode } from "./document.js";
import { latexFileName } from "./latex.js";

/**
 * A manuscript, written the way Word reads one.
 *
 * A `.docx` is a ZIP holding a dozen XML parts. This file writes the parts and nothing else:
 * the container is bytes and compression, which belongs in the main process, and this package
 * is imported by the renderer where `node:zlib` does not exist. So the seam is here, a pure
 * function from a node tree to a list of named parts, and a packer on the other side.
 *
 * The reason to carry `.docx` at all is that co-authors and journals ask for it. A rich
 * manuscript is a node tree, WordprocessingML is a node tree, and the two agree about most of
 * what a paper contains. Where they disagree the export says so rather than quietly dropping
 * something, because a missing equation found by a reviewer is worse than one explained here.
 */

export interface DocxFigure {
  /** The name the document uses for the figure, with the extension its bytes earned. */
  name: string;
  bytes: Uint8Array;
}

export interface DocxOptions {
  title?: string | undefined;
  authors?: string[] | undefined;
  figures?: DocxFigure[] | undefined;
  /** The reference list, already formatted in the project's style, in its printed order. */
  references?: string[] | undefined;
  /** The current label for each cited object, from the bibliography that is on screen. */
  citationLabels?: Record<string, string> | undefined;
}

/** One file inside the archive. Text parts are XML; byte parts are pictures. */
export interface DocxPart {
  name: string;
  data: string | Uint8Array;
}

export interface DocxDocument {
  parts: DocxPart[];
  /** What the format could not carry, said plainly enough to act on. */
  notes: string[];
}

/** English Metric Units. Every length in a drawing is one of these. */
const EMU_PER_PIXEL = 9525;
/** Letter paper with one-inch margins leaves six and a half inches of column. */
const COLUMN_EMU = 5_943_600;
/** Twentieths of a point, which is how a table states its width. */
const COLUMN_TWIPS = 9360;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/**
 * Escapes text for XML.
 *
 * The last branch is the one that matters. A control character is not valid in XML 1.0 at any
 * escape, and Word does not skip over one: it refuses to open the file and offers to repair it,
 * which is how an export turns into a lost afternoon. They come in through pasted text more
 * often than anyone expects.
 */
export function escapeXml(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "&") out += "&amp;";
    else if (character === "<") out += "&lt;";
    else if (character === ">") out += "&gt;";
    else if (character === '"') out += "&quot;";
    else if (code < 0x20 && character !== "\t") continue;
    else out += character;
  }
  return out;
}

/**
 * How big a picture is, in pixels, read from the picture itself.
 *
 * Word needs a width and a height on every drawing and will not work them out from the file.
 * Getting them wrong stretches the figure, so they are read from the bytes; a format this does
 * not know falls back to a shape that at least looks deliberate.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const be = (at: number): number =>
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0);

  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: be(16) >>> 0, height: be(20) >>> 0 };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49) {
    return {
      width: (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
      height: (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8),
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG keeps its dimensions in a start-of-frame segment somewhere after the header, so the
    // segments have to be walked until one turns up.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1] ?? 0;
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return {
          height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0),
          width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0),
        };
      }
      at += 2 + (((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
    }
  }
  return { width: 600, height: 400 };
}

/** A picture scaled to the column, but never blown up past the size it actually is. */
function drawingExtent(bytes: Uint8Array): { cx: number; cy: number } {
  const { width, height } = imageSize(bytes);
  const safeWidth = width > 0 ? width : 600;
  const safeHeight = height > 0 ? height : 400;
  const cx = Math.min(safeWidth * EMU_PER_PIXEL, COLUMN_EMU);
  return { cx, cy: Math.round((cx * safeHeight) / safeWidth) };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

interface Media {
  /** The relationship id the body refers to the picture by. */
  id: string;
  part: string;
  bytes: Uint8Array;
  extension: string;
}

interface RenderState {
  figures: Map<string, DocxFigure>;
  media: Media[];
  labels: Record<string, string>;
  equations: number;
  unplaceable: Set<string>;
  drawings: number;
}

function marksOf(node: DocumentNode): string[] {
  return (node.marks ?? []).map((mark) => mark.type);
}

function runProperties(marks: string[]): string {
  const parts: string[] = [];
  if (marks.includes("code")) parts.push('<w:rStyle w:val="CodeChar"/>');
  if (marks.includes("bold") || marks.includes("strong")) parts.push("<w:b/>");
  if (marks.includes("italic") || marks.includes("em")) parts.push("<w:i/>");
  if (marks.includes("strike")) parts.push("<w:strike/>");
  if (marks.includes("underline")) parts.push('<w:u w:val="single"/>');
  if (marks.includes("superscript")) parts.push('<w:vertAlign w:val="superscript"/>');
  if (marks.includes("subscript")) parts.push('<w:vertAlign w:val="subscript"/>');
  return parts.length === 0 ? "" : `<w:rPr>${parts.join("")}</w:rPr>`;
}

/**
 * One run of text.
 *
 * `xml:space="preserve"` is not optional. Without it Word discards the space at either end of a
 * run, so "the <b>fast</b> fox" closes up into "the fastfox" wherever formatting changes
 * mid-sentence.
 */
function textRun(text: string, marks: string[]): string {
  if (text === "") return "";
  const body = text
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("<w:br/>");
  return `<w:r>${runProperties(marks)}${body}</w:r>`;
}

/** What a citation reads as on the page, with its locator folded into the brackets. */
export function docxCitationText(
  attrs: Record<string, unknown> | undefined,
  labels: Record<string, string>,
): string {
  const objectId = String(attrs?.["objectId"] ?? "");
  const stored = String(attrs?.["label"] ?? "");
  const label = labels[objectId] ?? (stored === "" ? "(?)" : stored);
  const locator = String(attrs?.["locator"] ?? "").trim();
  if (locator === "") return label;
  const closer = label.slice(-1);
  if (closer === ")" || closer === "]") return `${label.slice(0, -1)}, ${locator}${closer}`;
  return `${label} (${locator})`;
}

function inlineContent(node: DocumentNode, state: RenderState, depth: number): string {
  return (node.content ?? []).map((child) => inlineNode(child, state, depth + 1)).join("");
}

function inlineNode(node: DocumentNode, state: RenderState, depth: number): string {
  if (!isDocumentNode(node) || depth > 32) return "";
  switch (node.type) {
    case "text":
      return textRun(node.text ?? "", marksOf(node));
    case "hardBreak":
      return "<w:r><w:br/></w:r>";
    case "citation":
      return textRun(docxCitationText(node.attrs, state.labels), marksOf(node));
    case CROSS_REFERENCE_NODE: {
      // The words, not a Word field. A REF field would renumber itself in Word, but only against
      // numbering Word had produced, and nothing here numbers figures the way Word does. Writing
      // the text keeps the exported file saying what the manuscript says.
      const label = String(node.attrs?.["label"] ?? "");
      return textRun(label === "" ? "(?)" : label, marksOf(node));
    }
    case MENTION_NODE:
      // The name, as prose, for the reason the LaTeX conversion writes it: a reviewer opening the
      // file in Word has no Kiwi to be sent to.
      return textRun(mentionNodeText(node), marksOf(node));
    case QUOTATION_NODE:
      return textRun(quotationNodeText(node), marksOf(node));
    case "mathInline":
      state.equations += 1;
      return textRun(String(node.attrs?.["latex"] ?? ""), ["code"]);
    case "image":
      return imageRun(node, state);
    default:
      return inlineContent(node, state, depth);
  }
}

function imageRun(node: DocumentNode, state: RenderState): string {
  const base = latexFileName(String(node.attrs?.["src"] ?? ""));
  const figure = base === null ? undefined : state.figures.get(base);
  if (figure === undefined) return "";
  const extension = extensionOf(figure.name);
  if (IMAGE_CONTENT_TYPES[extension] === undefined) {
    // A PDF or an SVG figure is a picture Word will not place. Saying so is the whole point:
    // the alternative is a paper that silently lost its figure between here and the reviewer.
    state.unplaceable.add(extension === "" ? "an unrecognised format" : `.${extension}`);
    return "";
  }
  let media = state.media.find((entry) => entry.part === `word/media/${figure.name}`);
  if (media === undefined) {
    media = {
      id: `rId${String(state.media.length + 3)}`,
      part: `word/media/${figure.name}`,
      bytes: figure.bytes,
      extension,
    };
    state.media.push(media);
  }
  state.drawings += 1;
  const id = String(state.drawings);
  const { cx, cy } = drawingExtent(figure.bytes);
  const name = escapeXml(figure.name);
  return [
    "<w:r><w:drawing>",
    '<wp:inline distT="0" distB="0" distL="0" distR="0">',
    `<wp:extent cx="${String(cx)}" cy="${String(cy)}"/>`,
    `<wp:docPr id="${id}" name="Picture ${id}"/>`,
    "<a:graphic>",
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    "<pic:pic>",
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${media.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>',
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>",
  ].join("");
}

function paragraph(body: string, properties = ""): string {
  const pPr = properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`;
  return `<w:p>${pPr}${body}</w:p>`;
}

function numbering(numId: number, level: number): string {
  return `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${String(level)}"/><w:numId w:val="${String(numId)}"/></w:numPr>`;
}

/**
 * A list, flattened.
 *
 * WordprocessingML has no list element. It has paragraphs that name a numbering definition and
 * a depth, and Word draws the bullets. So nesting is carried by the level, not by the shape.
 */
function listBlocks(node: DocumentNode, state: RenderState, level: number, depth: number): string {
  const numId = node.type === "orderedList" ? 2 : 1;
  const blocks: string[] = [];
  for (const item of node.content ?? []) {
    let first = true;
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        blocks.push(listBlocks(child, state, Math.min(level + 1, 8), depth + 1));
        continue;
      }
      // Only the first paragraph of an item is numbered. Numbering the rest would count a
      // two-paragraph item as two items.
      const properties = first ? numbering(numId, level) : '<w:pStyle w:val="ListParagraph"/>';
      blocks.push(paragraph(inlineContent(child, state, depth + 1), properties));
      first = false;
    }
  }
  return blocks.join("");
}

function tableBlock(node: DocumentNode, state: RenderState, depth: number): string {
  const rows = node.content ?? [];
  const columns = Math.max(1, ...rows.map((row) => (row.content ?? []).length));
  const width = Math.floor(COLUMN_TWIPS / columns);
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${String(width)}"/>`).join(
    "",
  );
  const body = rows
    .map((row) => {
      const cells = (row.content ?? [])
        .map((cell) => {
          const header = cell.type === "tableHeader";
          const blocks = (cell.content ?? [])
            .map((child) =>
              paragraph(
                inlineContent(child, state, depth + 2),
                header ? '<w:pStyle w:val="TableHeading"/>' : "",
              ),
            )
            .join("");
          // A cell with no paragraph in it is the single most common reason Word offers to
          // repair a document, and an empty cell is ordinary in a real table.
          return `<w:tc><w:tcPr><w:tcW w:w="${String(width)}" w:type="dxa"/></w:tcPr>${blocks === "" ? "<w:p/>" : blocks}</w:tc>`;
        })
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  const properties = [
    '<w:tblStyle w:val="TableGrid"/>',
    '<w:tblW w:w="0" w:type="auto"/>',
    "<w:tblBorders>",
    ...["top", "left", "bottom", "right", "insideH", "insideV"].map(
      (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`,
    ),
    "</w:tblBorders>",
  ].join("");
  // The trailing paragraph keeps two adjacent tables from merging into one.
  return `<w:tbl><w:tblPr>${properties}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

function blockNode(node: DocumentNode, state: RenderState, depth: number): string {
  if (!isDocumentNode(node) || depth > 32) return "";
  switch (node.type) {
    case "paragraph": {
      const body = inlineContent(node, state, depth);
      return paragraph(body);
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.["level"] ?? 1), 1), 6);
      return paragraph(
        inlineContent(node, state, depth),
        `<w:pStyle w:val="Heading${String(level)}"/>`,
      );
    }
    case "bulletList":
    case "orderedList":
      return listBlocks(node, state, 0, depth);
    case "blockquote":
      return (node.content ?? [])
        .map((child) =>
          paragraph(inlineContent(child, state, depth + 1), '<w:pStyle w:val="Quote"/>'),
        )
        .join("");
    case "codeBlock": {
      const text = (node.content ?? []).map((child) => child.text ?? "").join("");
      return paragraph(textRun(text, []), '<w:pStyle w:val="SourceCode"/>');
    }
    case "horizontalRule":
      return paragraph(
        "",
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>',
      );
    case "mathBlock": {
      state.equations += 1;
      return paragraph(
        textRun(String(node.attrs?.["latex"] ?? ""), []),
        '<w:pStyle w:val="SourceCode"/><w:jc w:val="center"/>',
      );
    }
    case "image": {
      const picture = imageRun(node, state);
      const caption = String(node.attrs?.["alt"] ?? "").trim();
      const figure = picture === "" ? "" : paragraph(picture, '<w:jc w:val="center"/>');
      // The caption is written even when the picture could not be placed, so the sentence that
      // refers to "Figure 2" still has something to point at.
      const line =
        caption === "" ? "" : paragraph(textRun(caption, []), '<w:pStyle w:val="Caption"/>');
      return `${figure}${line}`;
    }
    case "table":
      return tableBlock(node, state, depth);
    default:
      return (node.content ?? []).map((child) => blockNode(child, state, depth + 1)).join("");
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function referenceBlocks(references: string[]): string {
  if (references.length === 0) return "";
  const heading = paragraph(textRun("References", []), '<w:pStyle w:val="Heading1"/>');
  const entries = references
    .map((entry) => paragraph(textRun(entry, []), '<w:pStyle w:val="Bibliography"/>'))
    .join("");
  return `${heading}${entries}`;
}

function documentPart(body: string): string {
  const namespaces = [
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  ].join(" ");
  const section =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  // A body with nothing in it is not a document Word will open.
  const content = body === "" ? "<w:p/>" : body;
  return `${XML_HEADER}<w:document ${namespaces}><w:body>${content}${section}</w:body></w:document>`;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function contentTypesPart(extensions: string[]): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...extensions.map(
      (extension) =>
        `<Default Extension="${extension}" ContentType="${IMAGE_CONTENT_TYPES[extension] ?? "application/octet-stream"}"/>`,
    ),
  ].join("");
  const overrides = [
    ["/word/document.xml", "wordprocessingml.document.main"],
    ["/word/styles.xml", "wordprocessingml.styles"],
    ["/word/numbering.xml", "wordprocessingml.numbering"],
  ]
    .map(
      ([part, kind]) =>
        `<Override PartName="${part ?? ""}" ContentType="application/vnd.openxmlformats-officedocument.${kind ?? ""}+xml"/>`,
    )
    .join("");
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`;
}

function relationship(id: string, kind: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>`;
}

function relationshipsPart(inner: string): string {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
}

/**
 * The styles the body refers to.
 *
 * The order of the children inside a `w:pPr` is part of the schema rather than a matter of
 * taste, spacing before indentation before justification before outline level, and Word
 * treats a document that gets it wrong as damaged.
 */
function stylesPart(): string {
  const heading = (level: number, size: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${String(level)}"><w:name w:val="heading ${String(level)}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${String(level - 1)}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${String(size)}"/></w:rPr></w:style>`;
  const styles = [
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Author"><w:name w:val="Author"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>',
    heading(1, 32),
    heading(2, 28),
    heading(3, 26),
    heading(4, 24),
    heading(5, 22),
    heading(6, 22),
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:sz w:val="20"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="TableHeading"><w:name w:val="Table Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>',
    // A reference list hangs every line but the first, in every style Kiwi knows. The name is
    // the one Word already has for a reference list, so a person's own template restyles it.
    '<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/><w:ind w:left="720" w:hanging="720"/></w:pPr></w:style>',
    '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>',
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr/></w:style>',
  ].join("");
  return `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`;
}

function numberingPart(): string {
  const levels = (format: string, text: (level: number) => string, symbol: string): string =>
    Array.from({ length: 9 }, (_unused, level) => {
      const font =
        symbol === "" ? "" : '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>';
      return `<w:lvl w:ilvl="${String(level)}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text(level)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${String(720 * (level + 1))}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
    }).join("");
  const bullet = levels("bullet", () => "&#xF0B7;", "symbol");
  // Each level restarts its own count, which is what a reader expects from a nested list.
  const decimal = levels("decimal", (level) => `%${String(level + 1)}.`, "");
  return [
    XML_HEADER,
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullet}</w:abstractNum>`,
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimal}</w:abstractNum>`,
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>',
    "</w:numbering>",
  ].join("");
}

/**
 * Turns a rich document into the parts of a `.docx`.
 *
 * The conversion is one-way, like the LaTeX one. Nothing reads a `.docx` back in, so this is a
 * rendering to a third format rather than a translation between Kiwi's two writing modes, and
 * the manuscript on disk is untouched by it.
 */
export function documentToDocxParts(document: unknown, options: DocxOptions = {}): DocxDocument {
  const state: RenderState = {
    figures: new Map(
      (options.figures ?? []).map((figure) => {
        const dot = figure.name.lastIndexOf(".");
        return [dot === -1 ? figure.name : figure.name.slice(0, dot), figure];
      }),
    ),
    media: [],
    labels: options.citationLabels ?? {},
    equations: 0,
    unplaceable: new Set<string>(),
    drawings: 0,
  };

  const front: string[] = [];
  const title = (options.title ?? "").trim();
  if (title !== "") front.push(paragraph(textRun(title, []), '<w:pStyle w:val="Title"/>'));
  const authors = options.authors ?? [];
  if (authors.length > 0) {
    front.push(paragraph(textRun(authors.join(", "), []), '<w:pStyle w:val="Author"/>'));
  }

  const body = isDocumentNode(document)
    ? (document.content ?? []).map((child) => blockNode(child, state, 0)).join("")
    : "";
  const references = referenceBlocks(options.references ?? []);

  const parts: DocxPart[] = [
    {
      name: "[Content_Types].xml",
      data: contentTypesPart([...new Set(state.media.map((m) => m.extension))]),
    },
    {
      name: "_rels/.rels",
      data: relationshipsPart(relationship("rId1", "officeDocument", "word/document.xml")),
    },
    { name: "word/document.xml", data: documentPart(`${front.join("")}${body}${references}`) },
    {
      name: "word/_rels/document.xml.rels",
      data: relationshipsPart(
        [
          relationship("rId1", "styles", "styles.xml"),
          relationship("rId2", "numbering", "numbering.xml"),
          ...state.media.map((media) =>
            relationship(media.id, "image", `media/${media.part.slice("word/media/".length)}`),
          ),
        ].join(""),
      ),
    },
    { name: "word/styles.xml", data: stylesPart() },
    { name: "word/numbering.xml", data: numberingPart() },
    ...state.media.map((media) => ({ name: media.part, data: media.bytes })),
  ];

  const notes: string[] = [];
  if (state.equations > 0) {
    notes.push(
      `${String(state.equations)} ${plural(state.equations, "equation was", "equations were")} written as LaTeX source. Word will show the source, not the rendered equation.`,
    );
  }
  if (state.unplaceable.size > 0) {
    notes.push(
      `Word cannot place a figure saved as ${[...state.unplaceable].sort().join(" or ")}. Those figures were left out and their captions kept.`,
    );
  }
  return { parts, notes };
}
