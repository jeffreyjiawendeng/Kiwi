/**
 * Markdown to HTML, for the documents Kiwi publishes on its website.
 *
 * The same files are read in the repository and on the site, so they stay Markdown and this turns
 * them into pages. It understands what those documents use and nothing else: headings, paragraphs,
 * bulleted lists, tables, bold, inline code, and links. A document that reaches for anything more
 * fails the build instead of reaching the site with stray asterisks in a privacy policy.
 */

export interface MarkdownOptions {
  /**
   * Where a link in the document goes on the site. `null` drops the link and keeps its text, for
   * targets that only make sense inside the repository.
   */
  resolveLink: (target: string) => string | null;
}

export interface RenderedDocument {
  title: string;
  html: string;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Bold, inline code, links, and bare email addresses, in text that is otherwise escaped. */
export function renderInline(text: string, options: MarkdownOptions): string {
  let html = "";
  let rest = text;

  while (rest.length > 0) {
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      html += `<code>${escapeHtml(code[1] ?? "")}</code>`;
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      const label = renderInline(link[1] ?? "", options);
      const href = options.resolveLink(link[2] ?? "");
      html += href === null ? label : `<a href="${escapeHtml(href)}">${label}</a>`;
      rest = rest.slice(link[0].length);
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold !== null) {
      html += `<strong>${renderInline(bold[1] ?? "", options)}</strong>`;
      rest = rest.slice(bold[0].length);
      continue;
    }
    const plain = /^[^`[*]+/.exec(rest);
    const chunk = plain?.[0] ?? rest.slice(0, 1);
    html += escapeHtml(chunk).replace(
      EMAIL,
      (address) => `<a href="mailto:${address}">${address}</a>`,
    );
    rest = rest.slice(chunk.length);
  }

  if (/\*\*|(^|[^\w])\*[^\s*]|`/.test(html.replace(/<code>[\s\S]*?<\/code>/g, ""))) {
    throw new Error(`Unsupported Markdown in: ${text}`);
  }
  return html;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Renders a whole document. Its first-level heading becomes the title, not part of the body. */
export function renderMarkdown(source: string, options: MarkdownOptions): RenderedDocument {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let title: string | null = null;
  let index = 0;

  const at = (i: number): string => lines[i] ?? "";

  while (index < lines.length) {
    const line = at(index);

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      if (level === 1) {
        if (title !== null) throw new Error("A document has one first-level heading.");
        title = text;
      } else {
        blocks.push(`<h${level} id="${slug(text)}">${renderInline(text, options)}</h${level}>`);
      }
      index += 1;
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && at(index).startsWith("- ")) {
        let item = at(index).slice(2);
        index += 1;
        // A continuation is indented to the item's text.
        while (index < lines.length && /^ {2}\S/.test(at(index))) {
          item += ` ${at(index).trim()}`;
          index += 1;
        }
        items.push(`<li>${renderInline(item, options)}</li>`);
      }
      blocks.push(`<ul>\n${items.join("\n")}\n</ul>`);
      continue;
    }

    if (line.startsWith("|")) {
      const header = tableCells(line);
      const divider = at(index + 1);
      if (!/^\|[\s:|-]+\|$/.test(divider.trim()))
        throw new Error(`A table needs a divider: ${line}`);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && at(index).startsWith("|")) {
        rows.push(tableCells(at(index)));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell, options)}</th>`).join("");
      const body = rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell, options)}</td>`).join("")}</tr>`,
        )
        .join("\n");
      blocks.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
      continue;
    }

    if (/^(#{4,}|>|```|\d+\. |\* |\+ | {4})/.test(line)) {
      throw new Error(`Unsupported Markdown block: ${line}`);
    }

    const paragraph: string[] = [];
    while (index < lines.length && at(index).trim() !== "" && !/^(#{1,6} |- |\|)/.test(at(index))) {
      paragraph.push(at(index).trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join(" "), options)}</p>`);
  }

  if (title === null) throw new Error("A document needs a first-level heading for its title.");
  return { title, html: blocks.join("\n") };
}
