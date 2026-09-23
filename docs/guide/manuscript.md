# Manuscript

The manuscript is the piece of writing a project produces. It is written in Kiwi, cites the
Library, and leaves as a PDF, a Word document, or LaTeX source.

![The manuscript editor](../assets/manuscript.png)

## Writing

The editor is a document editor with a toolbar of marks: bold, italic, underline, strikethrough,
superscript and subscript, three heading levels, bullet and numbered lists, quotations, tables,
images, citations, inline and block mathematics, footnotes, mentions, and alignment. The word
count sits in the toolbar. Everything saves itself.

**Ctrl+F** finds text; **Ctrl+H** finds and replaces on the same bar. **Ctrl+Shift+V** pastes
without formatting. Undo and redo are on the toolbar and on **Ctrl+Z** and **Ctrl+Y**.

**Detach** opens the manuscript in a window of its own.

## Citing

The **[1]** mark inserts a citation. The picker searches the Library; choose a paper and the
citation is placed at the caret. Citations are numbered or authored according to the project's
citation style, chosen in Settings from APA, MLA, Chicago, IEEE, and Nature. The **Bibliography**
page lists everything the manuscript cites, in that style.

## Mathematics

Inline mathematics and block mathematics are written in LaTeX and rendered in place. The block
form takes a full line.

## Compiling and exporting

- **Compile** produces a PDF. The engine is chosen in the toolbar, lualatex or xelatex. Compiling
  runs on this computer when TeX Live or MiKTeX is installed, and otherwise through the account
  service when it offers compilation.
- **Export LaTeX** writes the manuscript as LaTeX source with its bibliography, for a journal's
  template or a co-author who works in LaTeX.
- **Export Word** writes a `.docx` with headings, lists, tables, images, footnotes, and citations.

## Versions

Every save is a version. The **History** tool in the dock lists them, compares two, and restores
one with a reason.
