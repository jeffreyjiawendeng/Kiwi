import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { announceCaret } from "./caret.js";
import type { CaretSpot } from "./caret-spots.js";
import { RemoteCarets } from "./RemoteCarets.js";
import { useRemoteCarets } from "./remote-carets.js";
import { MathBlock, MathInline } from "./math-extension.js";
import { Subscript, Superscript } from "./text-marks.js";
import { createPasteHandlers } from "./paste-cleanup.js";
import { createCitationNode } from "./citation-extension.js";
import { CitationPicker, type CitablePaper } from "./CitationPicker.js";
import {
  CrossReferenceTargets,
  TARGET_ID_ATTRIBUTE,
  createCrossReferenceNode,
  editorTargets,
  renumberCrossReferences,
  RENUMBER_META,
  type EditorTarget,
} from "./crossref-extension.js";
import { CrossReferencePicker } from "./CrossReferencePicker.js";
import {
  RESTAMP_META,
  createMentionNode,
  createMentionTrigger,
  mentionKind,
  mentionTriggerRange,
  restampMentions,
} from "./mention-extension.js";
import { MentionPicker, type MentionableObject } from "./MentionPicker.js";
import { createQuotationNode } from "./quotation-extension.js";
import { FindReplaceBar } from "./FindReplaceBar.js";
import { TableMenu, TableToolbar, type MenuAt } from "./TableControls.js";
import { readTableState, runTableCommand, type TableCommandName } from "./table-commands.js";
import { OutlinePanel } from "./OutlinePanel.js";
import { CommentThreads, type ThreadPassages } from "./CommentThreads.js";
import { LinksPanel } from "./LinksPanel.js";
import {
  editorPosition,
  richManuscript,
  selectedPassage,
  sourceManuscript,
  type ManuscriptPassage,
  type ManuscriptText,
} from "./manuscript-anchors.js";
import { LatexSource, type LatexSourceControls } from "./LatexSource.js";
import { LatexPreview } from "./LatexPreview.js";
import type { PdfLoader } from "./pdf-document.js";
import {
  buildOutline,
  latexBlocks,
  moveInText,
  type OutlineBlock,
  type OutlineHeading,
  type SectionMove,
} from "./outline.js";
import {
  collectMatches,
  findMatches,
  matchSummary,
  replaceAllMatches,
  replaceMatch,
  type DocumentMatch,
  type FindOptions,
  type TextRun,
} from "./find-replace.js";
import {
  DEFAULT_LATEX_ENGINE,
  LATEX_ENGINES,
  countWords,
  crossReferenceLabel,
  documentFigures,
  documentText,
  documentToLatex,
  emptyDocument,
  MENTION_NODE,
  MENTION_RELATION,
  mentionedObjects,
  bibtexKey,
  EMPTY_REFERENCE,
  isDocumentMode,
  readDocument,
  resolveThreadAnchor,
  type CitationStyle,
  type DocumentMode,
  type LatexEngine,
  type RichDocument,
} from "@kiwi/contracts";
import {
  readBridge,
  type RendererCompileOutcome,
  type RendererDocumentExportOutcome,
} from "./bridge.js";

export interface DocumentRecord {
  id: string;
  type: string;
  title: string;
  version: number;
  content_hash: string;
  content?: string;
  document?: unknown;
  document_mode?: unknown;
}

interface DocumentEditorProps {
  workspaceId: string;
  record: DocumentRecord;
  writable?: boolean;
  onSaved?(record: DocumentRecord): void;
  /** The project's citation style. Changing it re-renders every citation in place. */
  citationStyle?: CitationStyle;
  /** Injected by tests, and passed straight through to the preview. */
  pdfLoader?: PdfLoader;
  /**
   * Whether this editor may open itself in a window of its own.
   *
   * False in a window that is already one, because a document detached from its detached window
   * would be the same document twice with nowhere new to put it.
   */
  detachable?: boolean;
  /**
   * Follows an `@` link to what it points at.
   *
   * Absent where the surface has nowhere to send anyone, and a mention is then a name rather than
   * a link. A detached window is the case: it holds one document and no way to show another.
   */
  onOpenObject?: (objectId: string, type: string) => void;
  /**
   * Follows a quotation back to the page it was read on.
   *
   * Absent where there is no Reader to open, on the same terms as the one above. The attribution
   * line then says where the passage came from without offering to show it.
   */
  onOpenAnnotation?: (annotationId: string, paperId?: string) => void;
}

/** One reference list, as the bibliography command returns it. */
interface BibliographyView {
  entries: Array<{
    id: string;
    key: string;
    number: number;
    text: string;
    in_text: string;
    incomplete: string[];
  }>;
  broken: Array<{ object_id: string; reason: string }>;
  bibtex: string;
}

/** The file name the bundle carries a bibliography under. */
const BIBLIOGRAPHY_NAME = "references";

/** How long typing pauses before a save is attempted, in milliseconds. */
const AUTOSAVE_IDLE_MS = 1_200;

/**
 * How long typing pauses before the preview recompiles, in milliseconds.
 *
 * Longer than a save, because a save writes a file and a compile starts a TeX run. Short enough
 * that a preview left open is a picture of the paper rather than a picture of an older paper.
 */
const PREVIEW_IDLE_MS = 2_000;

type SaveState = "clean" | "dirty" | "saving" | "saved" | "failed";

/**
 * The manuscript's headings, read from the node tree.
 *
 * Only the top level is walked. A heading inside a table cell or a quotation is not a section of
 * the paper, and moving one would take the cell with it.
 */
function documentOutline(editor: Editor): OutlineHeading[] {
  const blocks: OutlineBlock[] = [];
  editor.state.doc.forEach((node, offset) => {
    const level = node.type.name === "heading" ? Number(node.attrs["level"]) : null;
    blocks.push({
      level: level === null || Number.isNaN(level) ? null : level,
      text: node.textContent,
      from: offset,
      to: offset + node.nodeSize,
    });
  });
  return buildOutline(blocks);
}

/** One line drawing, at the size the toolbar draws them. */
function stroke(path: React.ReactNode): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}

/**
 * What a formatting button shows.
 *
 * Twenty-four buttons spelled out in words wrapped into nine rows and read as a wall of text
 * above the document. The name each one answers to is unchanged: it is still the button's
 * `aria-label`, so it is what a screen reader says, what a test asks for, and what the tooltip
 * shows. Only what is drawn is shorter.
 */
const TOOLBAR_MARKS: Record<string, React.JSX.Element> = {
  bold: <strong>B</strong>,
  italic: <em>I</em>,
  underline: <span className="document-editor__mark--underline">U</span>,
  strike: <s>S</s>,
  /* Raised and lowered by style rather than by <sup> and <sub>: the mark on a button is a
     drawing, not a raised character in the document, and the document is what those elements
     are read and searched for. */
  superscript: (
    <span>
      x<span className="document-editor__mark--raised">2</span>
    </span>
  ),
  subscript: (
    <span>
      x<span className="document-editor__mark--lowered">2</span>
    </span>
  ),
  "heading-1": <span>H1</span>,
  "heading-2": <span>H2</span>,
  "heading-3": <span>H3</span>,
  bulletList: stroke(
    <>
      <circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M6 4h8M6 8h8M6 12h8" />
    </>,
  ),
  orderedList: stroke(
    <>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M1.5 3.2 2.6 2.6v3M1.4 8.2c0-.9 1.7-.9 1.7 0 0 .7-1.7 1.3-1.7 2.3h1.8M1.5 11.6h1.6l-1 1.2c.8 0 1.2.3 1.2.9s-.6.9-1.8.6" />
    </>,
  ),
  blockquote: (
    <span className="document-editor__mark--quote" aria-hidden="true">
      &ldquo;
    </span>
  ),
  table: stroke(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 6.5h13M6 6.5v7M10.5 6.5v7" />
    </>,
  ),
  figure: stroke(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="5.5" cy="6.5" r="1.2" />
      <path d="m2.5 12 3.5-3.5 3 2.5 2-1.5 2.5 2.5" />
    </>,
  ),
  citation: <span>[1]</span>,
  "math-inline": <span className="document-editor__mark--math">&#8721;</span>,
  "math-block": (
    <span className="document-editor__mark--boxed" aria-hidden="true">
      &#8721;
    </span>
  ),
  crossref: <span>&#167;</span>,
  mention: <span>@</span>,
  outline: stroke(<path d="M2 3.5h12M4.5 8h9.5M7 12.5h7" />),
  find: stroke(
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.3 3.3" />
    </>,
  ),
  comments: stroke(
    <path d="M2 4.2A1.7 1.7 0 0 1 3.7 2.5h8.6A1.7 1.7 0 0 1 14 4.2v5a1.7 1.7 0 0 1-1.7 1.7H6.6L3 13.5v-2.6a1.7 1.7 0 0 1-1-1.6Z" />,
  ),
  undo: stroke(
    <>
      <path d="M2.5 5.5h7a4 4 0 0 1 0 8H6" />
      <path d="M5 2.5 2 5.5l3 3" />
    </>,
  ),
  redo: stroke(
    <>
      <path d="M13.5 5.5h-7a4 4 0 0 0 0 8H10" />
      <path d="m11 2.5 3 3-3 3" />
    </>,
  ),
};

function ToolbarButton({
  editor,
  action,
  label,
  isActive,
  run,
}: {
  editor: Editor | null;
  action: string;
  label: string;
  isActive?: () => boolean;
  run(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={isActive?.() ?? false}
      disabled={editor === null}
      onClick={run}
      data-action={action}
      data-mark={TOOLBAR_MARKS[action] === undefined ? undefined : ""}
    >
      {TOOLBAR_MARKS[action] ?? label}
    </button>
  );
}

export function DocumentEditor({
  workspaceId,
  record,
  writable = true,
  onSaved,
  citationStyle = "apa",
  pdfLoader,
  detachable = true,
  onOpenObject,
  onOpenAnnotation,
}: DocumentEditorProps): React.JSX.Element {
  const mode: DocumentMode = isDocumentMode(record.document_mode) ? record.document_mode : "rich";
  const [state, setState] = useState<SaveState>("clean");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(() => record.content ?? "");
  const [words, setWords] = useState(() => countWords(record.content ?? ""));
  // The version moves with every save, and the next save has to quote the current one.
  const version = useRef({ version: record.version, hash: record.content_hash });
  const timer = useRef<number | null>(null);
  const [engine, setEngine] = useState<LatexEngine>(DEFAULT_LATEX_ENGINE);
  const [compiling, setCompiling] = useState(false);
  const [compiled, setCompiled] = useState<RendererCompileOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // The source the compiler was last given. The idle timer restarts whenever a compile ends, and
  // without this a compile that nothing has been typed since would start another one.
  const previewed = useRef<string | null>(null);
  const [bibliography, setBibliography] = useState<BibliographyView | null>(null);
  const [picking, setPicking] = useState(false);
  const [referencing, setReferencing] = useState(false);
  const [mentioning, setMentioning] = useState(false);
  // Bumped when this document writes a link of its own, so the panel does not lag the sentence.
  const [linkRevision, setLinkRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<RendererDocumentExportOutcome | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
  });
  const [current, setCurrent] = useState(0);
  const [replaced, setReplaced] = useState<string | null>(null);
  // React never sees the edits the rich editor makes to its own document, and the match count has
  // to follow the text as it is typed. Bumped only while the bar or the margin is open, so a
  // manuscript nobody is searching or commenting on costs nothing.
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [outlining, setOutlining] = useState(false);
  const [commenting, setCommenting] = useState(false);
  // Where the selection is in the **source** of a LaTeX manuscript. The rich editor is asked for
  // its own selection instead, because it keeps one and reports when it moves.
  const [sourceSelection, setSourceSelection] = useState<{ from: number; to: number } | null>(null);
  const findingRef = useRef(false);
  const commentingRef = useRef(false);
  const sourceField = useRef<HTMLTextAreaElement>(null);
  // The LaTeX field holds the source with the folded runs cut out of it, so it is the only thing
  // that can turn a position in the source into a position on screen.
  const sourceControls = useRef<LatexSourceControls | null>(null);
  // The box a rich manuscript's remote carets are placed in, and the one they are measured against.
  const stage = useRef<HTMLDivElement>(null);
  // Read by the citation node view on every render, so a label follows a style change without
  // the editor being torn down and rebuilt.
  const labels = useRef(new Map<string, string>());

  const reloadBibliography = useCallback(async (): Promise<void> => {
    const bridge = readBridge();
    if (bridge === null) return;
    const requestId = crypto.randomUUID();
    const result = await bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        workspace_id: workspaceId,
        command: "kiwi.bibliography.for-document",
        args: { object_id: record.id, style: citationStyle },
      })
      .catch(() => null);
    if (result === null || result.error !== undefined) return;
    // Read rather than asserted: an older service, or a command that answered with something
    // unexpected, must not take the editor down with it.
    const data = (result.data ?? {}) as Partial<BibliographyView>;
    const view: BibliographyView = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      broken: Array.isArray(data.broken) ? data.broken : [],
      bibtex: typeof data.bibtex === "string" ? data.bibtex : "",
    };
    labels.current = new Map(view.entries.map((entry) => [entry.id, entry.in_text]));
    setBibliography(view);
  }, [citationStyle, record.id, workspaceId]);

  useEffect(() => {
    void reloadBibliography();
  }, [reloadBibliography]);

  const Citation = useMemo(
    () => createCitationNode({ label: (objectId) => labels.current.get(objectId) ?? null }),
    [],
  );

  const CrossReference = useMemo(() => createCrossReferenceNode(), []);

  // Read by the mention node views, which ProseMirror builds once and keeps. Handing them the
  // callback this render happens to hold would freeze them on the first one.
  const opener = useRef(onOpenObject);
  opener.current = onOpenObject;

  const Mention = useMemo(
    () =>
      createMentionNode({
        linked: () => opener.current !== undefined,
        open: (target, kind) => opener.current?.(target, kind),
      }),
    [],
  );

  const MentionTrigger = useMemo(() => createMentionTrigger(() => setMentioning(true)), []);

  // Read by the quotation node views on the same terms as the mention ones above.
  const reader = useRef(onOpenAnnotation);
  reader.current = onOpenAnnotation;

  const Quotation = useMemo(
    () =>
      createQuotationNode({
        linked: () => reader.current !== undefined,
        open: (annotationId, paperId) => reader.current?.(annotationId, paperId),
      }),
    [],
  );

  useEffect(() => {
    version.current = { version: record.version, hash: record.content_hash };
  }, [record.content_hash, record.version]);

  const initial = useMemo<RichDocument>(
    () => (mode === "rich" ? readDocument(record.document) : emptyDocument()),
    [mode, record.document],
  );

  const save = useCallback(
    async (payload: { document?: RichDocument; source?: string }) => {
      const bridge = readBridge();
      if (bridge === null || !writable) return;
      setState("saving");
      setError(null);
      const requestId = crypto.randomUUID();
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: "kiwi.object.set-document",
        args: {
          object_id: record.id,
          expected_version: version.current.version,
          expected_hash: version.current.hash,
          mode,
          ...(payload.document === undefined ? {} : { document: payload.document }),
          ...(payload.source === undefined ? {} : { source: payload.source }),
        },
      });
      if (result.error !== undefined) {
        setState("failed");
        setError(result.error.message);
        return;
      }
      const saved = (result.data ?? {})["object"] as DocumentRecord | undefined;
      if (saved !== undefined) {
        version.current = { version: saved.version, hash: saved.content_hash };
        onSaved?.(saved);
      }
      setWords(((result.data ?? {})["words"] as number | undefined) ?? words);
      setState("saved");
    },
    [mode, onSaved, record.id, words, workspaceId, writable],
  );

  // One flag between a keystroke and the paste it starts, so it has to outlive a render.
  const paste = useMemo(() => createPasteHandlers(), []);

  const editor = useEditor(
    {
      editable: writable && mode === "rich",
      extensions: [
        // StarterKit already carries underline; registering it again warns and shadows.
        StarterKit,
        Image,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Superscript,
        Subscript,
        MathInline,
        MathBlock,
        Citation,
        CrossReferenceTargets,
        CrossReference,
        Mention,
        MentionTrigger,
        Quotation,
      ],
      editorProps: {
        transformPastedHTML: paste.transformPastedHTML,
        handleKeyDown: paste.handleKeyDown,
        handlePaste: paste.handlePaste,
      },
      content: initial,
      onUpdate({ editor: edited, transaction }) {
        // Renumbering is a consequence of an edit, not one. Treating it as typing would mark a
        // document dirty for having been opened, and save it back unchanged.
        if (transaction.getMeta(RENUMBER_META) === true) return;
        // A rename made somewhere else is not an edit to this document either. Treating it as
        // one would save the document back for having been opened next to a rename.
        if (transaction.getMeta(RESTAMP_META) === true) return;
        // Before the JSON is read, so what is saved already carries the numbers document order
        // gives it rather than the ones it had a moment ago.
        renumberCrossReferences(edited);
        setState("dirty");
        const json = edited.getJSON() as RichDocument;
        setWords(countWords(documentText(json)));
        if (findingRef.current || commentingRef.current) setRevision((value) => value + 1);
        if (timer.current !== null) window.clearTimeout(timer.current);
        // Saving on every keystroke would write a checkpoint per character. Saving only on
        // close would lose the work a crash interrupts. A pause in typing is the moment that
        // is both cheap and meaningful.
        timer.current = window.setTimeout(() => {
          void save({ document: json });
        }, AUTOSAVE_IDLE_MS);
      },
    },
    [Citation, Mention, MentionTrigger, Quotation, mode, record.id],
  );

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  /**
   * The table the caret is in, or null when it is not in one.
   *
   * Subscribed to rather than read during render, because moving the caret from a paragraph into a
   * table changes nothing React knows about, and controls that appear only after the next
   * keystroke are controls a person has already given up looking for.
   */
  const tableState = useEditorState({
    editor,
    selector: ({ editor: live }) => (live === null ? null : readTableState(live)),
  });

  function runTable(name: TableCommandName): void {
    if (editor === null || !writable) return;
    runTableCommand(editor, name);
    setMenu(null);
  }

  /**
   * Right-click inside a table opens the operations under the pointer.
   *
   * The caret has already moved to what was clicked by the time this runs, which is what makes the
   * menu act on the cell the pointer is over. Outside a table nothing is claimed, so the click
   * stays the browser's to handle.
   */
  function openTableMenu(event: React.MouseEvent): void {
    // Asked of the editor rather than of the last render: the caret moved on the mouse press that
    // preceded this event, and the render that follows it may not have happened yet.
    if (!writable || editor === null || readTableState(editor) === null) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }

  /** A change to the LaTeX buffer, from typing or from a replacement. Both save the same way. */
  function changeSource(next: string): void {
    setSource(next);
    setWords(countWords(next));
    setState("dirty");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void save({ source: next });
    }, AUTOSAVE_IDLE_MS);
  }

  /**
   * The headings of a rich manuscript, followed as they are typed.
   *
   * Subscribed to for the same reason the table state is: React is not told when the editor
   * rewrites its own document, and an outline that only catches up on the next render is an
   * outline that sends people to the wrong place. Nothing is read while the panel is closed.
   */
  const richOutline = useEditorState({
    editor,
    selector: ({ editor: live }) =>
      live === null || !outlining ? ([] as OutlineHeading[]) : documentOutline(live),
  });

  /**
   * What can be pointed at, and how much of what points is now pointing at nothing.
   *
   * The list is only built while the picker is open, because a document with two hundred sections
   * builds it for nothing on every keystroke otherwise. The count of broken references is not
   * gated: it is one walk looking for a reference whose number has been emptied, and it is the
   * only warning an author gets that a deleted figure took a sentence's meaning with it.
   */
  const crossReferences = useEditorState({
    editor,
    selector: ({ editor: live }) => {
      if (live === null) return { targets: [] as EditorTarget[], broken: 0, mentions: 0 };
      let broken = 0;
      let mentions = 0;
      live.state.doc.descendants((node) => {
        if (node.type.name === "crossReference" && node.attrs["label"] === "") broken += 1;
        // Counted in the same walk, and for the same reason: a link whose object has gone is
        // still a readable sentence, so nothing but a count will make anyone look.
        if (node.type.name === MENTION_NODE && node.attrs["missing"] === true) mentions += 1;
        return true;
      });
      return { targets: referencing ? editorTargets(live) : [], broken, mentions };
    },
  }) ?? { targets: [] as EditorTarget[], broken: 0, mentions: 0 };

  /**
   * The numbers a document opens with.
   *
   * A manuscript last edited by an older build, or one whose figures were reordered by a
   * co-author, arrives with numbers that were true when it was saved. This is what makes them
   * true again before anyone reads them.
   */
  useEffect(() => {
    if (editor !== null) renumberCrossReferences(editor);
  }, [editor]);

  /**
   * The names a document opens with.
   *
   * Each mentioned object is asked for its title, and the answer is written back into the node.
   * That is what carries a rename across: nothing tells this editor that a paper was retitled in
   * the Library, so the only moment the sentence can be corrected is the moment it is opened.
   *
   * Asked one at a time, by id, rather than by listing the workspace and looking ids up in the
   * result. A list has a page size; a note that mentions the paper on page nine of it would be
   * told its paper had been deleted.
   */
  useEffect(() => {
    if (editor === null) return;
    const bridge = readBridge();
    if (bridge === null) return;
    const wanted = mentionedObjects(editor.getJSON());
    if (wanted.length === 0) return;
    let active = true;
    void Promise.all(
      wanted.map(async (objectId) => {
        const result = await bridge
          .invokeCommand({
            protocol_version: "1.0.0",
            request_id: crypto.randomUUID(),
            workspace_id: workspaceId,
            command: "kiwi.object.read",
            args: { object_id: objectId },
          })
          .catch(() => null);
        if (result === null || result.error !== undefined) return null;
        const object = (result.data ?? {})["object"] as { title?: unknown } | undefined;
        if (object === undefined) return null;
        return [objectId, String(object.title ?? "")] as const;
      }),
    ).then((answers) => {
      if (!active || editor.isDestroyed) return;
      restampMentions(editor, new Map(answers.filter((entry) => entry !== null)));
    });
    return () => {
      active = false;
    };
  }, [editor, workspaceId]);

  /** The same headings for a LaTeX manuscript, parsed out of the source. */
  const latexOutline = useMemo<OutlineHeading[]>(
    () => (mode === "latex" && outlining ? buildOutline(latexBlocks(source)) : []),
    [mode, outlining, source],
  );

  const headings: readonly OutlineHeading[] = mode === "latex" ? latexOutline : richOutline;

  /**
   * Selects a range of the LaTeX source.
   *
   * Everything outside the field counts positions in the source, folded or not, so the field is
   * asked rather than told: it opens whatever hides the range and converts the position itself.
   */
  function selectSource(from: number, to: number, focus: boolean): void {
    const controls = sourceControls.current;
    if (controls !== null) {
      controls.select(from, to, focus);
      return;
    }
    const field = sourceField.current;
    if (field === null) return;
    if (focus) field.focus();
    field.setSelectionRange(from, to);
  }

  /** Puts the caret at a heading, which is what scrolls the manuscript to it. */
  function jumpTo(heading: OutlineHeading): void {
    if (mode === "latex") {
      selectSource(heading.from, heading.from, true);
      return;
    }
    // One past the heading's own position, which is inside it rather than in front of it.
    editor
      ?.chain()
      .focus()
      .setTextSelection(heading.from + 1)
      .scrollIntoView()
      .run();
  }

  /**
   * Moves a section, with everything under it.
   *
   * One transaction in the rich editor, so a drag that turns out to be wrong is a single undo.
   * The cut is made before the delete, because after it those positions describe other text.
   */
  function moveSection(plan: SectionMove): void {
    if (!writable) return;
    if (mode === "latex") {
      changeSource(moveInText(source, plan));
      return;
    }
    editor
      ?.chain()
      .command(({ tr }) => {
        const section = tr.doc.slice(plan.from, plan.to);
        tr.delete(plan.from, plan.to);
        tr.insert(tr.mapping.map(plan.at), section.content);
        return true;
      })
      .run();
  }

  function outlinePanel(): React.JSX.Element | null {
    if (!outlining) return null;
    return (
      <OutlinePanel headings={headings} writable={writable} onJump={jumpTo} onMove={moveSection} />
    );
  }

  /**
   * The manuscript as one string, with the way back to where each word is on the screen.
   *
   * Built only while the margin is open, for the same reason the match list is built only while
   * the find bar is: a manuscript nobody is commenting on should not be flattened on every
   * keystroke. `revision` is what carries a rich edit across, since React never sees one.
   */
  const manuscript = useMemo<ManuscriptText>(() => {
    if (!commenting) return sourceManuscript("");
    if (mode === "latex") return sourceManuscript(source);
    if (editor === null) return sourceManuscript("");
    const runs: TextRun[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && typeof node.text === "string") runs.push({ text: node.text, pos });
    });
    return richManuscript(runs);
  }, [commenting, editor, mode, revision, source]);

  /**
   * What is selected in the rich manuscript, in the editor's own positions.
   *
   * Asked of the editor rather than read during a render, because the selection moves without
   * React hearing about it, and the margin has to know whether there is a passage to comment on
   * before anybody presses the button. Nothing is watched while the margin is shut.
   */
  const richSelection =
    useEditorState({
      editor,
      selector: ({ editor: live }) =>
        !commenting || live === null
          ? null
          : { from: live.state.selection.from, to: live.state.selection.to },
    }) ?? null;

  const selection = mode === "latex" ? sourceSelection : richSelection;

  /**
   * Where this window's caret is, in the document's own positions.
   *
   * Watched whether or not anything on this screen wants it, because somebody else's screen does:
   * presence carries this number and their window draws a caret with it. Cheap in both modes:
   * one number off the selection for a rich manuscript, and for a LaTeX one the source position
   * the field already works out for itself.
   *
   * The start of what is selected rather than the end of it, so that the answer means the same
   * thing whichever way round somebody dragged. A selection is two numbers and presence carries
   * one, so what leaves here is the caret alone.
   */
  const richCaret =
    useEditorState({
      editor,
      selector: ({ editor: live }) => live?.state.selection.from ?? 0,
    }) ?? 0;
  const caret = mode === "latex" ? (sourceSelection?.from ?? 0) : richCaret;

  useEffect(() => {
    announceCaret({ documentId: record.id, offset: caret });
  }, [caret, record.id]);

  /**
   * Everybody else's caret in this document, in the same positions this window counts in.
   *
   * Handed over by the top bar, which is where the poll lives. Nothing is asked for here.
   */
  const carets = useRemoteCarets(record.id);

  /**
   * Where one of those sits on the screen, for a rich manuscript.
   *
   * The editor keeps real nodes and will say where a position is, so there is nothing to mirror --
   * this is the whole of it. Measured against the box the marks are drawn in so that scrolling the
   * manuscript takes them with it.
   *
   * Not remeasured while somebody types. These numbers are up to one poll old, so placing them
   * again against text they were never measured against would buy a precision the numbers do not
   * have; the next answer puts them where they belong.
   */
  const richLocate = useCallback(
    (offset: number): CaretSpot | null => {
      const view = editor?.view ?? null;
      const box = stage.current;
      if (view === null || box === null) return null;
      if (!Number.isInteger(offset) || offset < 0 || offset > view.state.doc.content.size) {
        return null;
      }
      let at: { left: number; top: number; bottom: number };
      try {
        at = view.coordsAtPos(offset);
      } catch {
        // A position the document no longer has. It was true when it was sent.
        return null;
      }
      const frame = box.getBoundingClientRect();
      return {
        left: at.left - frame.left + box.scrollLeft,
        top: at.top - frame.top + box.scrollTop,
        height: at.bottom - at.top,
      };
    },
    [editor],
  );

  const selected = useMemo<ManuscriptPassage | null>(
    () => (selection === null ? null : selectedPassage(manuscript, selection.from, selection.to)),
    [manuscript, selection],
  );

  /**
   * Puts the selection on the passage a comment is about.
   *
   * The selection is how this manuscript has always pointed at a passage, it is what the outline
   * does to a heading and what find does to a match, so a comment's quotation points the same
   * way rather than inventing a second kind of highlight over the same words.
   */
  function revealPassage(from: number, to: number): void {
    if (mode === "latex") {
      selectSource(from, to, true);
      return;
    }
    editor
      ?.chain()
      .focus()
      .setTextSelection({
        from: editorPosition(manuscript, from),
        to: editorPosition(manuscript, to),
      })
      .scrollIntoView()
      .run();
  }

  /**
   * The margin: every comment on this manuscript, beside the words it is about.
   *
   * A comment is located from its quotation on every read, so a passage that moved is found again
   * without anything being written. `kiwi.thread.reanchor` is left for the one case a quotation
   * cannot answer, the words are gone, and a person has to say what the comment was about.
   */
  const passages: ThreadPassages = {
    locate: (anchor) => resolveThreadAnchor(anchor, { text: manuscript.text }),
    reveal: revealPassage,
    selected,
  };

  function commentsPanel(): React.JSX.Element | null {
    if (!commenting) return null;
    return (
      <aside className="document-editor__comments">
        <CommentThreads
          workspaceId={workspaceId}
          objectId={record.id}
          writable={writable}
          passages={passages}
          empty="Nothing has been asked about this manuscript. Select a passage to comment on it."
          {...(selected === null
            ? {}
            : { anchor: { object_id: record.id, kind: "text_range" as const, ...selected } })}
        />
      </aside>
    );
  }

  function toggleComments(): void {
    commentingRef.current = !commenting;
    setCommenting(!commenting);
  }

  /**
   * Where the query currently matches.
   *
   * Recomputed on every render rather than cached, because the text can change underneath in two
   * different ways, a keystroke in the rich editor, a replacement in either, and a count that
   * lags the document sends a replace-all at matches that are no longer there. A closed bar
   * searches nothing, so the cost only exists while the bar is open.
   */
  const matches = useMemo<DocumentMatch[]>(() => {
    if (!finding || query === "") return [];
    if (mode === "latex") {
      return findMatches(source, query, findOptions).map((match) => ({
        from: match.start,
        to: match.end,
      }));
    }
    if (editor === null) return [];
    const runs: TextRun[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && typeof node.text === "string") runs.push({ text: node.text, pos });
    });
    return collectMatches(runs, query, findOptions);
  }, [editor, finding, findOptions, mode, query, revision, source]);

  // The document changes under the bar, so the match a person was on can stop existing.
  const index = matches.length === 0 ? 0 : Math.min(current, matches.length - 1);

  /**
   * Selects a match.
   *
   * `reveal` says whether to put the caret in the manuscript. Pressing Enter in the find field
   * must not, or the next Enter types into the document instead of stepping; clicking Next has
   * already taken focus out of the field, so there it can.
   */
  function showMatch(at: number, reveal: boolean): void {
    const match = matches[at];
    if (match === undefined) return;
    if (mode === "latex") {
      selectSource(match.from, match.to, reveal);
      return;
    }
    const chain = editor?.chain();
    if (chain === undefined) return;
    (reveal ? chain.focus() : chain)
      .setTextSelection({ from: match.from, to: match.to })
      .scrollIntoView()
      .run();
  }

  function stepMatch(direction: 1 | -1, reveal: boolean): void {
    if (matches.length === 0) return;
    const next = (index + direction + matches.length) % matches.length;
    setCurrent(next);
    setReplaced(null);
    showMatch(next, reveal);
  }

  /**
   * Rewrites matches in the rich document.
   *
   * Every one goes into a single transaction, so a replace-all is a single undo. Applied last
   * match first, because rewriting an earlier one moves every position after it.
   */
  function replaceInDocument(targets: readonly DocumentMatch[]): void {
    if (editor === null || targets.length === 0) return;
    editor
      .chain()
      .command(({ tr, state: editorState }) => {
        for (const match of [...targets].reverse()) {
          if (replacement === "") {
            tr.delete(match.from, match.to);
            continue;
          }
          // The marks inside the match, so replacing a word inside a bold run leaves it bold.
          const marks = editorState.doc.resolve(match.from + 1).marks();
          tr.replaceWith(match.from, match.to, editorState.schema.text(replacement, marks));
        }
        return true;
      })
      .run();
  }

  function replaceCurrent(): void {
    const match = matches[index];
    if (match === undefined || !writable) return;
    if (mode === "latex") {
      changeSource(replaceMatch(source, { start: match.from, end: match.to }, replacement));
    } else {
      replaceInDocument([match]);
    }
    // The match that was here is gone, so this index now names the one that followed it.
    setReplaced("Replaced 1");
  }

  function replaceEveryMatch(): void {
    if (!writable) return;
    if (mode === "latex") {
      const outcome = replaceAllMatches(source, query, replacement, findOptions);
      if (outcome.replaced === 0) {
        setReplaced("Nothing to replace");
        return;
      }
      changeSource(outcome.text);
      setReplaced(`Replaced ${String(outcome.replaced)}`);
      return;
    }
    if (matches.length === 0) {
      setReplaced("Nothing to replace");
      return;
    }
    const count = matches.length;
    replaceInDocument(matches);
    setCurrent(0);
    setReplaced(`Replaced ${String(count)}`);
  }

  function openFind(): void {
    findingRef.current = true;
    setFinding(true);
    setCurrent(0);
    setReplaced(null);
  }

  function closeFind(): void {
    findingRef.current = false;
    setFinding(false);
    setReplaced(null);
  }

  function handleKeys(event: React.KeyboardEvent<HTMLElement>): void {
    // The menu is the nearest thing open, so Escape closes it before it closes anything else.
    if (event.key === "Escape" && menu !== null) {
      setMenu(null);
      return;
    }
    if (event.key === "Escape" && finding) {
      closeFind();
      return;
    }
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    // Ctrl+H is the same bar. Replacing without first finding is not a separate act.
    if (key !== "f" && key !== "h") return;
    event.preventDefault();
    if (!finding) openFind();
  }

  function findBar(): React.JSX.Element | null {
    if (!finding) return null;
    return (
      <FindReplaceBar
        query={query}
        replacement={replacement}
        options={findOptions}
        summary={matchSummary(matches.length, index)}
        notice={replaced}
        writable={writable}
        idPrefix={`find-${record.id}`}
        onQueryChange={(next) => {
          setQuery(next);
          setCurrent(0);
          setReplaced(null);
        }}
        onReplacementChange={setReplacement}
        onOptionsChange={(next) => {
          setFindOptions(next);
          setCurrent(0);
        }}
        onStep={stepMatch}
        onReplace={replaceCurrent}
        onReplaceAll={replaceEveryMatch}
        onClose={closeFind}
      />
    );
  }

  async function insertFigure(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || editor === null) return;
    setError(null);
    const chosen = await bridge.chooseManagedAsset();
    if (chosen === null) return;
    const requestId = crypto.randomUUID();
    const result = await bridge.invokeCommand({
      protocol_version: "1.0.0",
      request_id: requestId,
      idempotency_key: requestId,
      workspace_id: workspaceId,
      command: "kiwi.asset.import-managed",
      args: { selection_id: chosen.id },
    });
    if (result.error !== undefined) {
      setError(result.error.message);
      return;
    }
    const asset = (result.data ?? {})["asset"] as
      { id: string; original_filename?: string } | undefined;
    if (asset === undefined) return;
    editor
      .chain()
      .focus()
      .setImage({
        src: `kiwi-asset://${workspaceId}/${asset.id}`,
        alt: asset.original_filename ?? "Figure",
      })
      .run();
  }

  function insertCitation(paper: CitablePaper, locator: string): void {
    setPicking(false);
    if (editor === null) return;
    const key = bibtexKey(
      {
        title: paper.title,
        reference: { ...EMPTY_REFERENCE, authors: paper.authors, year: paper.year },
      },
      new Set(bibliography?.entries.map((entry) => entry.key) ?? []),
    );
    editor
      .chain()
      .focus()
      .insertContent({
        type: "citation",
        attrs: { objectId: paper.id, key, locator, label: paper.preview },
      })
      .run();
    // The reference list changes the moment a citation is added, and a numeric style renumbers
    // everything after it.
    void save({ document: editor.getJSON() as RichDocument }).then(reloadBibliography);
  }

  /**
   * Links a sentence to another Paper, Note, Manuscript, or Claim.
   *
   * Two things are written, and they answer opposite questions. The node is what this sentence
   * reads as. The relation beside the document is what lets the other object answer "what points
   * at me", which is otherwise only answerable by opening and scanning every document in the
   * workspace.
   *
   * The `@` that opened the picker is taken out here rather than when it was typed, so dismissing
   * the picker leaves the sentence exactly as it was typed.
   */
  function insertMention(object: MentionableObject): void {
    setMentioning(false);
    if (editor === null) return;
    const range = mentionTriggerRange(editor);
    const chain = editor.chain().focus();
    if (range.from !== range.to) chain.deleteRange(range);
    chain
      .insertContent([
        {
          type: MENTION_NODE,
          attrs: {
            target: object.id,
            kind: mentionKind(object.type),
            label: object.title,
            missing: false,
          },
        },
        // A space after it, because the next thing typed is the rest of the sentence and an atom
        // with the caret jammed against it is awkward to type past.
        { type: "text", text: " " },
      ])
      .run();
    void save({ document: editor.getJSON() as RichDocument }).then(() => recordMention(object.id));
  }

  /** Writes the relation the link is found by from the other end. */
  async function recordMention(objectId: string): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    const requestId = crypto.randomUUID();
    const result = await bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: "kiwi.relation.create",
        args: { type: MENTION_RELATION, subject_id: record.id, object_id: objectId },
      })
      .catch(() => null);
    if (result === null || result.error !== undefined) {
      // The link itself is in the document and works. What was lost is the other direction, and
      // saying nothing would leave someone wondering why their backlinks are one short.
      setError("The link was inserted, but Kiwi could not record it. It will not show in links.");
      return;
    }
    // The panel below the text has just gone out of date by one row.
    setLinkRevision((value) => value + 1);
  }

  /**
   * Points a sentence at a figure, a table, a heading, or a displayed equation.
   *
   * The id is put on the target here rather than when the target was made, so a document only
   * carries identifiers for the things something actually refers to. Both changes go in one
   * transaction: setting an attribute does not move anything, so the position chosen from the
   * list is still the right position when the reference is inserted beside it.
   */
  function insertCrossReference(target: EditorTarget): void {
    setReferencing(false);
    if (editor === null) return;
    const id = target.id === "" ? crypto.randomUUID() : target.id;
    const chain = editor.chain().focus();
    if (target.id === "") {
      chain.command(({ tr }) => {
        tr.setNodeAttribute(target.position, TARGET_ID_ATTRIBUTE, id);
        return true;
      });
    }
    chain
      .insertContent({
        type: "crossReference",
        attrs: {
          target: id,
          kind: target.kind,
          label: crossReferenceLabel(target.kind, target.number),
        },
      })
      .run();
  }

  /**
   * The source and the files that have to travel with it.
   *
   * Compiling and exporting want the same thing, and they must keep wanting the same thing: a
   * PDF that differs from the exported source is a bug nobody sees until a co-author opens the
   * folder. A LaTeX manuscript is already source; a rich one is converted, figures and
   * equations included.
   */
  function latexBundle(): {
    latex: string;
    files: Array<{ name: string; asset_id?: string; text?: string }>;
  } {
    const json = mode === "rich" ? ((editor?.getJSON() ?? null) as RichDocument | null) : null;
    const cites = bibliography !== null && bibliography.entries.length > 0;
    const latex =
      mode === "latex"
        ? source
        : documentToLatex(json, {
            title: record.title,
            engine,
            ...(cites ? { bibliography: BIBLIOGRAPHY_NAME } : {}),
          });
    const files: Array<{ name: string; asset_id?: string; text?: string }> =
      json === null
        ? []
        : documentFigures(json).map((figure) => ({
            name: figure.name,
            asset_id: figure.assetId,
          }));
    // The bibliography is written by Kiwi rather than imported, so it travels as text.
    // latexmk runs BibTeX over it, which is what turns a cite into a number.
    if (cites) files.push({ name: `${BIBLIOGRAPHY_NAME}.bib`, text: bibliography?.bibtex ?? "" });
    return { latex, files };
  }

  async function compileNow(prefer?: "cloud" | "local"): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || compiling) return;
    previewed.current = source;
    setCompiling(true);
    setCompiled(null);
    setError(null);
    try {
      const { latex, files } = latexBundle();
      const outcome = await bridge.compileLatex({
        workspace_id: workspaceId,
        source: latex,
        engine,
        files,
        ...(prefer === undefined ? {} : { prefer }),
      });
      setCompiled(outcome);
    } catch {
      setError("Kiwi could not reach a compiler.");
    } finally {
      setCompiling(false);
    }
  }

  /**
   * Recompiles for the preview once typing has stopped.
   *
   * Never per keystroke: a compiler is a process, and one per keystroke is one process per
   * keystroke. The timer is cleared and set again by every edit, so a paragraph typed straight
   * through costs one compile at the end of it rather than one for each letter.
   *
   * It also restarts when a compile ends, which is what catches an edit made while the last one
   * was still running. The source the compiler was last given is remembered so that restarting
   * on a buffer nothing has happened to compiles nothing.
   */
  useEffect(() => {
    if (!previewing || mode !== "latex" || compiling || source === previewed.current) return;
    const timer = window.setTimeout(() => void compileNow(), PREVIEW_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [compiling, mode, previewing, source]);

  /** Opens or closes the preview, compiling once if there is nothing to show yet. */
  function togglePreview(): void {
    const next = !previewing;
    setPreviewing(next);
    if (next && compiled === null) void compileNow();
  }

  /**
   * What a Word export sends: the tree, and the citations as they currently read.
   *
   * LaTeX is given citation keys and formats them itself from the .bib file. Word has no such
   * step, so the labels and the reference list travel already formatted in the project's style,
   * the same words that are on screen right now.
   */
  function docxBundle(): {
    document: unknown;
    files: Array<{ name: string; asset_id?: string }>;
    references: string[];
    citation_labels: Record<string, string>;
  } {
    const json = (editor?.getJSON() ?? null) as RichDocument | null;
    const entries = bibliography?.entries ?? [];
    return {
      document: json,
      files:
        json === null
          ? []
          : documentFigures(json).map((figure) => ({
              name: figure.name,
              asset_id: figure.assetId,
            })),
      references: entries.map((entry) => entry.text),
      citation_labels: Object.fromEntries(entries.map((entry) => [entry.id, entry.in_text])),
    };
  }

  /**
   * Writes the manuscript out in a format somebody else can open.
   *
   * This is a rendering to a third format, not a conversion between Kiwi's two writing modes.
   * Nothing reads the export back in, so a rich manuscript exporting as LaTeX or as Word loses
   * nothing it had, the manuscript on disk is untouched either way.
   */
  async function exportAs(format: "tex" | "docx"): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || exporting) return;
    setExporting(true);
    setExported(null);
    try {
      // Only the format being written is rendered. Word is written from the tree and LaTeX from
      // the source, and neither needs the other's work done first.
      const latex = format === "tex" ? latexBundle() : null;
      const payload =
        latex === null
          ? { source: "", ...docxBundle() }
          : { source: latex.latex, files: latex.files };
      setExported(
        await bridge.exportDocument({
          workspace_id: workspaceId,
          format,
          title: record.title,
          ...payload,
        }),
      );
    } catch {
      setExported({ status: "error", message: "Kiwi could not write the export." });
    } finally {
      setExporting(false);
    }
  }

  function compileControls(): React.JSX.Element {
    return (
      <>
        <label className="sr-only" htmlFor={`engine-${record.id}`}>
          Compiler
        </label>
        <select
          id={`engine-${record.id}`}
          value={engine}
          disabled={compiling}
          onChange={(event) => setEngine(event.target.value as LatexEngine)}
        >
          {LATEX_ENGINES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="button" disabled={compiling} onClick={() => void compileNow()}>
          {compiling ? "Compiling" : "Compile"}
        </button>
        <button type="button" disabled={exporting} onClick={() => void exportAs("tex")}>
          {exporting ? "Exporting" : "Export LaTeX"}
        </button>
        {/*
          Word is written from the node tree, and a manuscript in LaTeX mode has no tree, it has
          source. Converting LaTeX into Word would mean reading TeX, which is a different project.
        */}
        {mode === "rich" ? (
          <button type="button" disabled={exporting} onClick={() => void exportAs("docx")}>
            {exporting ? "Exporting" : "Export Word"}
          </button>
        ) : null}
      </>
    );
  }

  /**
   * What the export wrote, and what it could not carry.
   *
   * Every export says both. An export that reports success while having silently dropped a
   * figure is the version that reaches a journal.
   */
  function exportReport(): React.JSX.Element | null {
    if (exported === null || exported.status === "cancelled") return null;
    if (exported.status === "error") {
      return (
        <section className="export-report" aria-label="Export result">
          <strong>Did not export</strong>
          <p>{exported.message}</p>
        </section>
      );
    }
    return (
      <section className="export-report" aria-label="Export result">
        <strong>Exported to {exported.destination}</strong>
        {exported.files.length === 0 ? null : (
          <ul className="export-report__files">
            {exported.files.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        {exported.notes.length === 0 ? null : (
          <ul className="export-report__notes">
            {exported.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  function compileReport(): React.JSX.Element | null {
    if (compiled === null) return null;
    return (
      <section className="compile-report" aria-label="Compile result">
        <header>
          <strong>
            {compiled.status === "ok" ? "Compiled" : "Did not compile"}
            <span className="compile-report__where">
              {compiled.ran === "cloud" ? " on the Kiwi service" : " on this computer"}
            </span>
          </strong>
          {compiled.pdf === null ? null : (
            <a href={compiled.pdf} target="_blank" rel="noreferrer">
              Open the PDF
            </a>
          )}
        </header>
        {compiled.problems.length === 0 ? null : (
          <ul>
            {compiled.problems.map((problem, index) => (
              <li
                key={`${String(index)}-${problem.message}`}
                className={`compile-report__${problem.severity}`}
              >
                <span>{problem.severity === "error" ? "Error" : "Warning"}</span>
                {problem.line === null ? null : <span>line {problem.line}</span>}
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  /**
   * Opens this document in a window of its own.
   *
   * Unsaved work goes with it only if it has been saved, so the buffer is written first. The two
   * windows share one canonical file rather than a copy of it, and each quotes a version on
   * every save, so nothing is lost either way -- but opening the second window on yesterday's
   * paragraph is a confusing way to start.
   */
  async function detachNow(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    // Waited for rather than merely started. The new window reads the canonical file, so a detach
    // that races the save opens on the paragraph before the one that was just typed -- and then
    // there are two windows, each holding a different version of the same document.
    await saveBuffer();
    await bridge.detachDocument({ objectId: record.id, kind: "document" }).catch(() => undefined);
  }

  /** A button offered only where a second window is somewhere new to put the document. */
  function detachButton(): React.JSX.Element | null {
    if (!detachable) return null;
    return (
      <button
        type="button"
        aria-label="Open in a new window"
        onClick={() => {
          void detachNow();
        }}
      >
        Detach
      </button>
    );
  }

  /** Writes the buffer, and answers when it has been written rather than when it has been sent. */
  function saveBuffer(): Promise<void> {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (mode === "latex") return save({ source });
    const json = editor?.getJSON() as RichDocument | undefined;
    return json === undefined ? Promise.resolve() : save({ document: json });
  }

  function saveNow(): void {
    void saveBuffer();
  }

  const status =
    state === "saving"
      ? "Saving"
      : state === "saved"
        ? "Saved"
        : state === "dirty"
          ? "Unsaved changes"
          : state === "failed"
            ? "Not saved"
            : "";

  if (mode === "latex") {
    return (
      <section
        className="document-editor document-editor--latex"
        aria-label={`${record.title} source`}
        onKeyDown={handleKeys}
      >
        <div className="document-editor__toolbar" role="toolbar" aria-label="Document controls">
          <span className="document-editor__mode">LaTeX</span>
          <button
            type="button"
            aria-label="Outline"
            aria-pressed={outlining}
            onClick={() => {
              setOutlining(!outlining);
            }}
          >
            Outline
          </button>
          {/*
            Folding is a way of looking at the source rather than a change to it, so it is offered
            on a manuscript that cannot be edited as well.
          */}
          <button
            type="button"
            aria-label="Fold section"
            onClick={() => sourceControls.current?.fold()}
          >
            Fold
          </button>
          <button
            type="button"
            aria-label="Unfold all"
            onClick={() => sourceControls.current?.unfoldAll()}
          >
            Unfold all
          </button>
          <button
            type="button"
            aria-label="Find and replace"
            aria-pressed={finding}
            onClick={() => (finding ? closeFind() : openFind())}
          >
            Find
          </button>
          {/*
            The preview is a picture of the last compile, so it is offered on a manuscript that
            cannot be edited too, reading the typeset paper beside its source is most of what a
            preview is for.
          */}
          <button
            type="button"
            aria-label="Preview"
            aria-pressed={previewing}
            onClick={togglePreview}
          >
            Preview
          </button>
          <button
            type="button"
            aria-label="Comments"
            aria-pressed={commenting}
            onClick={toggleComments}
          >
            Comments
          </button>
          {detachButton()}
          <span className="document-editor__status" role="status">
            {status}
          </span>
          <span className="document-editor__words">{words} words</span>
          {compileControls()}
          {writable ? (
            <button type="button" onClick={saveNow} disabled={state === "saving"}>
              Save
            </button>
          ) : null}
        </div>
        {findBar()}
        <label className="sr-only" htmlFor={`latex-${record.id}`}>
          LaTeX source
        </label>
        <div
          className={`document-editor__body${outlining ? " document-editor__body--outlined" : ""}${
            previewing ? " document-editor__body--previewed" : ""
          }${commenting ? " document-editor__body--commented" : ""}`}
        >
          {outlinePanel()}
          <LatexSource
            id={`latex-${record.id}`}
            field={sourceField}
            controls={sourceControls}
            value={source}
            writable={writable}
            carets={carets}
            onChange={changeSource}
            onSelection={(from, to) => setSourceSelection({ from, to })}
          />
          {previewing ? (
            <LatexPreview
              pdf={compiled?.pdf ?? null}
              compiling={compiling}
              {...(pdfLoader === undefined ? {} : { loader: pdfLoader })}
            />
          ) : null}
          {commentsPanel()}
        </div>
        {compileReport()}
        {exportReport()}
        {error === null ? null : (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className="document-editor"
      aria-label={`${record.title} editor`}
      onKeyDown={handleKeys}
    >
      {writable ? (
        <div className="document-editor__toolbar" role="toolbar" aria-label="Formatting">
          <ToolbarButton
            editor={editor}
            action="bold"
            label="Bold"
            isActive={() => editor?.isActive("bold") ?? false}
            run={() => editor?.chain().focus().toggleBold().run()}
          />
          <ToolbarButton
            editor={editor}
            action="italic"
            label="Italic"
            isActive={() => editor?.isActive("italic") ?? false}
            run={() => editor?.chain().focus().toggleItalic().run()}
          />
          <ToolbarButton
            editor={editor}
            action="underline"
            label="Underline"
            isActive={() => editor?.isActive("underline") ?? false}
            run={() => editor?.chain().focus().toggleUnderline().run()}
          />
          <ToolbarButton
            editor={editor}
            action="strike"
            label="Strikethrough"
            isActive={() => editor?.isActive("strike") ?? false}
            run={() => editor?.chain().focus().toggleStrike().run()}
          />
          <ToolbarButton
            editor={editor}
            action="superscript"
            label="Superscript"
            isActive={() => editor?.isActive("superscript") ?? false}
            run={() => editor?.chain().focus().toggleMark("superscript").run()}
          />
          <ToolbarButton
            editor={editor}
            action="subscript"
            label="Subscript"
            isActive={() => editor?.isActive("subscript") ?? false}
            run={() => editor?.chain().focus().toggleMark("subscript").run()}
          />
          <span className="document-editor__divider" aria-hidden="true" />
          {[1, 2, 3].map((level) => (
            <ToolbarButton
              key={level}
              editor={editor}
              action={`heading-${String(level)}`}
              label={`Heading ${String(level)}`}
              isActive={() => editor?.isActive("heading", { level }) ?? false}
              run={() =>
                editor
                  ?.chain()
                  .focus()
                  .toggleHeading({ level: level as 1 | 2 | 3 })
                  .run()
              }
            />
          ))}
          <ToolbarButton
            editor={editor}
            action="bulletList"
            label="Bulleted list"
            isActive={() => editor?.isActive("bulletList") ?? false}
            run={() => editor?.chain().focus().toggleBulletList().run()}
          />
          <ToolbarButton
            editor={editor}
            action="orderedList"
            label="Numbered list"
            isActive={() => editor?.isActive("orderedList") ?? false}
            run={() => editor?.chain().focus().toggleOrderedList().run()}
          />
          <ToolbarButton
            editor={editor}
            action="blockquote"
            label="Quote"
            isActive={() => editor?.isActive("blockquote") ?? false}
            run={() => editor?.chain().focus().toggleBlockquote().run()}
          />
          <ToolbarButton
            editor={editor}
            action="table"
            label="Insert table"
            run={() =>
              editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
          />
          <ToolbarButton
            editor={editor}
            action="figure"
            label="Insert figure"
            run={() => void insertFigure()}
          />
          <ToolbarButton
            editor={editor}
            action="citation"
            label="Insert citation"
            run={() => setPicking(true)}
          />
          <ToolbarButton
            editor={editor}
            action="math-inline"
            label="Inline equation"
            run={() => editor?.chain().focus().insertContent({ type: "mathInline" }).run()}
          />
          <ToolbarButton
            editor={editor}
            action="math-block"
            label="Display equation"
            run={() => editor?.chain().focus().insertContent({ type: "mathBlock" }).run()}
          />
          <ToolbarButton
            editor={editor}
            action="crossref"
            label="Insert cross-reference"
            run={() => setReferencing(true)}
          />
          <ToolbarButton
            editor={editor}
            action="mention"
            label="Link to something"
            run={() => setMentioning(true)}
          />
          <span className="document-editor__divider" aria-hidden="true" />
          <ToolbarButton
            editor={editor}
            action="outline"
            label="Outline"
            isActive={() => outlining}
            run={() => {
              setOutlining(!outlining);
            }}
          />
          <ToolbarButton
            editor={editor}
            action="find"
            label="Find and replace"
            isActive={() => finding}
            run={() => (finding ? closeFind() : openFind())}
          />
          <ToolbarButton
            editor={editor}
            action="comments"
            label="Comments"
            isActive={() => commenting}
            run={toggleComments}
          />
          <ToolbarButton
            editor={editor}
            action="undo"
            label="Undo"
            run={() => editor?.chain().focus().undo().run()}
          />
          <ToolbarButton
            editor={editor}
            action="redo"
            label="Redo"
            run={() => editor?.chain().focus().redo().run()}
          />
          {detachButton()}
          <span className="document-editor__status" role="status">
            {status}
          </span>
          <span className="document-editor__words">{words} words</span>
          {compileControls()}
          <button type="button" onClick={saveNow} disabled={state === "saving"}>
            Save
          </button>
        </div>
      ) : null}
      {writable && tableState !== null ? (
        <TableToolbar state={tableState} onCommand={runTable} />
      ) : null}
      {findBar()}
      <div
        className={`document-editor__body${outlining ? " document-editor__body--outlined" : ""}${
          commenting ? " document-editor__body--commented" : ""
        }`}
      >
        {outlinePanel()}
        {/* The manuscript and the marks over it in one box, so a remote caret can be placed
            against the same corner the words are laid out from. */}
        <div
          className="document-editor__surface document-editor__stage"
          ref={stage}
          onContextMenu={openTableMenu}
        >
          <EditorContent editor={editor} />
          <RemoteCarets carets={carets} locate={richLocate} />
        </div>
        {commentsPanel()}
      </div>
      {menu === null || tableState === null ? null : (
        <TableMenu
          state={tableState}
          at={menu}
          onCommand={runTable}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {bibliography === null || bibliography.broken.length === 0 ? null : (
        <p className="document-editor__broken" role="status">
          {bibliography.broken.length}{" "}
          {bibliography.broken.length === 1 ? "citation does" : "citations do"} not resolve to a
          Paper in the Library. The Bibliography page lists them.
        </p>
      )}
      {crossReferences.broken === 0 ? null : (
        <p className="document-editor__broken" role="status">
          {crossReferences.broken}{" "}
          {crossReferences.broken === 1 ? "cross-reference points" : "cross-references point"} at
          something that is no longer in this document. They read as (?).
        </p>
      )}
      {crossReferences.mentions === 0 ? null : (
        <p className="document-editor__broken" role="status">
          {crossReferences.mentions}{" "}
          {crossReferences.mentions === 1 ? "link points" : "links point"} at something that is no
          longer in the workspace. The name stays as it was, so the sentence still reads.
        </p>
      )}
      {/*
        What this document draws on, and what draws on it. Under the text rather than beside it:
        it is read after the writing, and the writing is what the width is for.
      */}
      <section className="document-editor__links" aria-label="Links from this document">
        <h4>Links</h4>
        <LinksPanel
          workspaceId={workspaceId}
          objectId={record.id}
          reload={linkRevision}
          {...(onOpenObject === undefined ? {} : { onOpen: onOpenObject })}
        />
      </section>
      {compileReport()}
      {exportReport()}
      {error === null ? null : (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      {picking ? (
        <CitationPicker
          workspaceId={workspaceId}
          style={citationStyle}
          busy={state === "saving"}
          onInsert={insertCitation}
          onCancel={() => setPicking(false)}
        />
      ) : null}
      {referencing ? (
        <CrossReferencePicker
          targets={crossReferences.targets}
          onInsert={insertCrossReference}
          onCancel={() => setReferencing(false)}
        />
      ) : null}
      {mentioning ? (
        <MentionPicker
          workspaceId={workspaceId}
          excludeId={record.id}
          onInsert={insertMention}
          onCancel={() => setMentioning(false)}
        />
      ) : null}
    </section>
  );
}
