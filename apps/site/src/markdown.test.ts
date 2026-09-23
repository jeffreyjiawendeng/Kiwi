import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderInline, renderMarkdown, slug } from "./markdown.js";
import { DOCUMENTS, resolveDocumentLink } from "./pages.js";

const plain = { resolveLink: (target: string) => target };

describe("inline text", () => {
  it("escapes what would otherwise be markup", () => {
    expect(renderInline("a < b & c > d", plain)).toBe("a &lt; b &amp; c &gt; d");
  });

  it("renders bold, code, and links", () => {
    expect(renderInline("**Operator:** see `LICENSE` or [terms](TERMS.md)", plain)).toBe(
      '<strong>Operator:</strong> see <code>LICENSE</code> or <a href="TERMS.md">terms</a>',
    );
  });

  it("makes a bare email address something a reader can click", () => {
    expect(renderInline("Write to someone@example.org.", plain)).toBe(
      'Write to <a href="mailto:someone@example.org">someone@example.org</a>.',
    );
  });

  it("keeps the words of a link whose target has no page", () => {
    expect(renderInline("see [the runbook](docs/runbook.md)", { resolveLink: () => null })).toBe(
      "see the runbook",
    );
  });

  it("refuses emphasis it does not understand rather than publishing asterisks", () => {
    expect(() => renderInline("an *important* point", plain)).toThrow(/Unsupported/);
  });
});

describe("documents", () => {
  it("takes the first heading as the title and renders the rest", () => {
    const rendered = renderMarkdown(
      "# Privacy\n\nIntro line one\nline two.\n\n## What we keep\n",
      plain,
    );

    expect(rendered.title).toBe("Privacy");
    expect(rendered.html).toBe(
      '<p>Intro line one line two.</p>\n<h2 id="what-we-keep">What we keep</h2>',
    );
  });

  it("joins a list item's continuation lines to it", () => {
    const rendered = renderMarkdown("# T\n\n- first item\n  continues here\n- second\n", plain);

    expect(rendered.html).toBe("<ul>\n<li>first item continues here</li>\n<li>second</li>\n</ul>");
  });

  it("renders a table", () => {
    const rendered = renderMarkdown(
      "# T\n\n| What | Kept for |\n| ---- | -------- |\n| Codes | 30 days |\n",
      plain,
    );

    expect(rendered.html).toContain("<th>What</th><th>Kept for</th>");
    expect(rendered.html).toContain("<td>Codes</td><td>30 days</td>");
  });

  it("refuses a numbered list, a quote, or a code block", () => {
    for (const block of ["1. first", "> quoted", "```", "    indented code"]) {
      expect(() => renderMarkdown(`# T\n\n${block}\n`, plain)).toThrow(/Unsupported/);
    }
  });

  it("needs exactly one title", () => {
    expect(() => renderMarkdown("No heading here.\n", plain)).toThrow(/first-level heading/);
    expect(() => renderMarkdown("# One\n\n# Two\n", plain)).toThrow(/one first-level heading/);
  });

  it("makes heading anchors from their words", () => {
    expect(slug("Who else touches your data")).toBe("who-else-touches-your-data");
    expect(slug("Locked out of your account?")).toBe("locked-out-of-your-account");
  });
});

describe("the published documents", () => {
  const root = join(import.meta.dirname, "..", "..", "..");

  for (const document of DOCUMENTS) {
    it(`renders ${document.file} with nothing left over`, () => {
      const source = readFileSync(join(root, document.file), "utf8");
      const rendered = renderMarkdown(source, {
        resolveLink: (target) => resolveDocumentLink(target, "../", null),
      });
      const text = rendered.html.replace(/<code>[\s\S]*?<\/code>/g, "");

      expect(rendered.title.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\*\*|`|\]\(/);
      // A link from one published document to another has to go to its page, not to the file,
      // and a document named as a file is one a reader on the site cannot open.
      expect(rendered.html).not.toMatch(/href="[^"]*\.md/);
      expect(rendered.html).not.toMatch(/<code>(LICENSE|[A-Z]+\.md)<\/code>/);
    });
  }
});
