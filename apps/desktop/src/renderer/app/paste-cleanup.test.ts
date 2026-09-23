import { describe, expect, it, vi } from "vitest";
import { cleanPastedHtml, createPasteHandlers } from "./paste-cleanup.js";

/** The cleaned markup, with the whitespace between tags taken out so a test can read. */
function clean(html: string): string {
  return cleanPastedHtml(html).replaceAll(/\n\s*/gu, "");
}

describe("cleanPastedHtml", () => {
  it("keeps the structure a person would retype", () => {
    const out = clean(
      '<h2 style="font-family:Cambria;font-size:16pt">Method</h2>' +
        '<p class="MsoNormal" style="margin-bottom:12pt">We <b>counted</b> them.</p>' +
        "<ul><li>First</li><li>Second</li></ul>",
    );

    expect(out).toBe(
      "<h2>Method</h2><p>We <strong>counted</strong> them.</p><ul><li>First</li><li>Second</li></ul>",
    );
  });

  it("drops the presentation a person would not", () => {
    const out = clean(
      '<p style="color:#c00000;font-size:9pt;margin-left:36pt" class="MsoBodyText" ' +
        'align="center" bgcolor="#eeeeee" id="x">Text</p>',
    );

    expect(out).toBe("<p>Text</p>");
  });

  it("reads bold and italic out of the style before throwing the style away", () => {
    // A browser writes emphasis this way rather than with tags, so stripping the style first and
    // asking afterwards is how a pasted page arrives with nothing emphasised.
    const out = clean(
      '<p><span style="font-weight:700">Loud</span> and ' +
        '<span style="font-style:italic">leaning</span> and ' +
        '<span style="text-decoration:underline">under</span></p>',
    );

    expect(out).toBe("<p><strong>Loud</strong> and <em>leaning</em> and <u>under</u></p>");
  });

  it("does not make the whole document bold when a wrapper says it is not", () => {
    // The wrapper a browser puts around a copied page. Reading the tag and ignoring the style it
    // carries is the single most familiar broken paste there is.
    const out = clean('<b style="font-weight:normal" id="docs-guid-1"><p>Plain</p></b>');

    expect(out).toBe("<p>Plain</p>");
  });

  it("keeps a raised marker as a superscript", () => {
    const out = clean('<p>Rats<span style="vertical-align:super;font-size:60%">12</span></p>');

    expect(out).toBe("<p>Rats<sup>12</sup></p>");
  });

  it("keeps tables, with the spans that say what shape they are", () => {
    const out = clean(
      '<table border="1" cellspacing="0" width="640"><tbody><tr>' +
        '<th style="background:#ddd" colspan="2">Group</th></tr>' +
        '<tr><td width="320">A</td><td width="320">B</td></tr></tbody></table>',
    );

    expect(out).toBe(
      '<table><tbody><tr><th colspan="2">Group</th></tr><tr><td>A</td><td>B</td></tr></tbody></table>',
    );
  });

  it("keeps a link, and keeps only the address", () => {
    const out = clean(
      '<p><a href="https://example.org/paper" target="_blank" class="ext" ' +
        'style="color:#1155cc">the paper</a></p>',
    );

    expect(out).toBe('<p><a href="https://example.org/paper">the paper</a></p>');
  });

  it("keeps the words of a link that points somewhere nobody else can reach", () => {
    // A `file:` address is a path on whichever computer did the copying.
    const out = clean('<p><a href="file:///C:/Users/someone/draft.docx">draft</a></p>');

    expect(out).toBe("<p>draft</p>");
  });

  it("turns Word's list paragraphs into a list", () => {
    const out = clean(
      '<p class="MsoListParagraphCxSpFirst" style="mso-list:l0 level1 lfo1">' +
        '<span style="mso-list:Ignore">1.<span>&nbsp;&nbsp;</span></span>Collect</p>' +
        '<p class="MsoListParagraphCxSpLast" style="mso-list:l0 level1 lfo1">' +
        '<span style="mso-list:Ignore">2.<span>&nbsp;&nbsp;</span></span>Count</p>' +
        '<p class="MsoNormal">After</p>',
    );

    expect(out).toBe("<ol><li>Collect</li><li>Count</li></ol><p>After</p>");
  });

  it("does not leave the numbers behind as text", () => {
    // Numbers that stay behind as text do not renumber when a line is added, which is worse than
    // no list at all because it looks right until it is edited.
    const out = clean(
      '<p style="mso-list:l0 level1 lfo1">' +
        '<span style="mso-list:Ignore">1.<span>&nbsp;</span></span>Collect</p>',
    );

    expect(out).not.toContain("1.");
  });

  it("indents a sub-list rather than starting a second list", () => {
    const out = clean(
      '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>Top</p>' +
        '<p style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o<span>&nbsp;</span></span>Under</p>' +
        '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>Back</p>',
    );

    expect(out).toBe("<ul><li>Top<ul><li>Under</li></ul></li><li>Back</li></ul>");
  });

  it("reads the marker Word left as ordinary text", () => {
    // Older Word hid the marker in a conditional comment, and the parser leaves it in the text.
    const out = clean('<p class="MsoListParagraph" style="margin-left:36pt">1) Collect</p>');

    expect(out).toBe("<ol><li>Collect</li></ol>");
  });

  it("drops the paragraphs that were only spacing", () => {
    const out = clean("<p>Words</p><p>&nbsp;</p><p></p><p><o:p></o:p></p><p><br></p><p>More</p>");

    expect(out).toBe("<p>Words</p><p>More</p>");
  });

  it("does not call a paragraph empty because its content is not text", () => {
    const out = clean("<p><table><tbody><tr><td>A</td></tr></tbody></table></p>");

    expect(out).toContain("<table>");
  });

  it("drops what a document brings that is not the document", () => {
    const out = clean(
      "<style>p{color:red}</style><script>steal()</script>" +
        '<p>Kept<o:p></o:p></p><img src="file:///C:/temp/image001.png" alt="chart">',
    );

    expect(out).toBe("<p>Kept</p>");
  });

  it("treats a browser's line divisions as paragraphs", () => {
    const out = clean('<div class="page"><div>One</div><div>Two</div></div>');

    expect(out).toBe("<p>One</p><p>Two</p>");
  });

  it("leaves a paste from this editor exactly as it was copied", () => {
    // ProseMirror records the open and close depths of the copied slice in the markup, and
    // cleaning that is how copying half a list becomes pasting a mangled one.
    const html = '<ul data-pm-slice="2 2 []"><li><p style="x">Half</p></li></ul>';

    expect(cleanPastedHtml(html)).toBe(html);
  });
});

describe("createPasteHandlers", () => {
  function keydown(key: string, held: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent {
    return { key, ctrlKey: held.ctrl ?? false, shiftKey: held.shift ?? false } as KeyboardEvent;
  }

  function paste(text: string): ClipboardEvent {
    return { clipboardData: { getData: () => text } } as unknown as ClipboardEvent;
  }

  it("leaves an ordinary paste to the editor", () => {
    const handlers = createPasteHandlers();
    const view = { pasteText: vi.fn() };

    handlers.handleKeyDown(null, keydown("v", { ctrl: true }));

    expect(handlers.handlePaste(view, paste("<p>x</p>"))).toBe(false);
    expect(view.pasteText).not.toHaveBeenCalled();
  });

  it("pastes the words alone on Ctrl+Shift+V", () => {
    const handlers = createPasteHandlers();
    const view = { pasteText: vi.fn() };

    handlers.handleKeyDown(null, keydown("V", { ctrl: true, shift: true }));

    expect(handlers.handlePaste(view, paste("Words"))).toBe(true);
    expect(view.pasteText).toHaveBeenCalledWith("Words");
  });

  it("does not claim the keystroke", () => {
    // The paste that follows still has to arrive.
    const handlers = createPasteHandlers();

    expect(handlers.handleKeyDown(null, keydown("V", { ctrl: true, shift: true }))).toBe(false);
  });

  it("strips one paste rather than every paste after it", () => {
    const handlers = createPasteHandlers();
    const view = { pasteText: vi.fn() };

    handlers.handleKeyDown(null, keydown("V", { ctrl: true, shift: true }));
    handlers.handlePaste(view, paste("first"));

    expect(handlers.handlePaste(view, paste("second"))).toBe(false);
    expect(view.pasteText).toHaveBeenCalledTimes(1);
  });

  it("forgets a chord that pasted nothing", () => {
    // The chord can be pressed with an empty clipboard, and the paste that never came must not
    // strip the formatting off whatever is pasted an hour later.
    const handlers = createPasteHandlers();
    const view = { pasteText: vi.fn() };

    handlers.handleKeyDown(null, keydown("V", { ctrl: true, shift: true }));
    handlers.handleKeyDown(null, keydown("a"));

    expect(handlers.handlePaste(view, paste("later"))).toBe(false);
  });
});
