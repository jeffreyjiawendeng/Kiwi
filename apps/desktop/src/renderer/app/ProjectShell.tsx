import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PROJECT_PAGE_COUNTED_TYPE,
  PROJECT_PAGE_LABELS,
  PROJECT_PAGE_PURPOSE,
  defaultProjectSettings,
  isProjectPage,
  objectTypeLabel,
  projectPageEnabled,
  projectRailPages,
  readAnnotationLocation,
  readProjectSettings,
  type ProjectPage,
  type ProjectSettings,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import { CollectionWorkbench } from "./CollectionWorkbench.js";
import { CommentThreads } from "./CommentThreads.js";
import { LinksPanel } from "./LinksPanel.js";
import { InboxWorkbench } from "./InboxWorkbench.js";
import { LiveNotesWorkbench } from "./LiveNotesWorkbench.js";
import { MembersPage } from "./MembersPage.js";
import { ManagedAssetImport } from "./ManagedAssetImport.js";
import { ReferenceImport } from "./ReferenceImport.js";
import { ObjectTasks } from "./ObjectTasks.js";
import {
  QuickCapture,
  readQuickCaptureSelection,
  type QuickCaptureLaunch,
  type QuickCaptureObjectContext,
  type QuickCaptureSelection,
} from "./QuickCapture.js";
import { documentMoved } from "./reader-split.js";
import { ReaderSplit, type ReaderDocument } from "./ReaderSplit.js";
import { SearchWorkbench } from "./SearchWorkbench.js";
import { HistoryPage } from "./HistoryPage.js";
import { useCollaborationSnapshot } from "./collaboration-snapshot.js";
import { peopleNames } from "./people-names.js";
import { ShortcutReference } from "./ShortcutReference.js";
import { shouldOpenReference } from "./shortcuts.js";
import { TrashWorkbench } from "./TrashWorkbench.js";
import { PaperPanel } from "./PaperPanel.js";
import { ProjectDashboard } from "./ProjectDashboard.js";
import { ProjectPages } from "./ProjectPages.js";
import { useTasks } from "./tasks.js";
import { ProjectSettingsPage } from "./ProjectSettingsPage.js";
import { BibliographyPage } from "./BibliographyPage.js";
import { ReviewPage } from "./ReviewPage.js";
import { ProtocolPage } from "./ProtocolPage.js";
import { ClaimsPage } from "./ClaimsPage.js";
import { TasksPage } from "./TasksPage.js";
import type { ObjectOrganizationAction } from "./ObjectOrganizationMenu.js";

/**
 * The shell a project lives in.
 *
 * The rail lists the pages somebody opens daily; clicking one replaces the centre. Everything
 * else is behind More, which is where a page you open twice a month belongs. Tabs exist only for
 * documents, because "Settings" in a tab beside a PDF is a window manager, not a research tool.
 *
 * The dock appears because something is selected and goes away when nothing is. A panel that sat
 * there saying "Nothing selected" was a third of the window spent telling somebody what they
 * could already see.
 *
 * There is no page bar. The page's name is in the top bar beside the project's, where somebody
 * looks to find out where they are, and each page draws its own heading and its own controls --
 * which is the difference between a bar that says "Library" and a bar that does something.
 */

export type DockTool = "details" | "comments" | "history";

/** A tab in the Reader's strip. The Reader page itself decides how many of them are drawn. */
type DocumentTab = ReaderDocument;

interface ShellLayout {
  version: 3;
  page: ProjectPage;
  railCollapsed: boolean;
  railWidth: number;
  dockWidth: number;
  dockTool: DockTool;
  /** Whether the rest of the pages are unfolded under More. */
  moreOpen: boolean;
  focusMode: boolean;
  collectionFamily: string;
}

const DEFAULT_LAYOUT: ShellLayout = {
  version: 3,
  page: "dashboard",
  railCollapsed: false,
  railWidth: 200,
  dockWidth: 300,
  dockTool: "details",
  moreOpen: false,
  focusMode: false,
  collectionFamily: "source",
};

/** Per project, because the panes wanted while screening are not the panes wanted while writing. */
export function shellKey(workspaceId: string, projectId: string | null): string {
  return projectId === null
    ? `kiwi.shell.${workspaceId}`
    : `kiwi.shell.${workspaceId}.${projectId}`;
}

/**
 * Which tool a stored layout opens on.
 *
 * The dock had four; Inspector and Links were two halves of one answer and are now one. A layout
 * naming either of them opens on the tool that absorbed it rather than being discarded for it.
 */
function readDockTool(value: unknown): DockTool {
  if (value === "inspector" || value === "links" || value === "details") return "details";
  return value === "comments" || value === "history" ? value : DEFAULT_LAYOUT.dockTool;
}

export function storedShellLayout(workspaceId: string, projectId: string | null): ShellLayout {
  try {
    const raw = window.localStorage.getItem(shellKey(workspaceId, projectId));
    if (raw === null) return DEFAULT_LAYOUT;
    const value = JSON.parse(raw) as Omit<Partial<ShellLayout>, "version"> & {
      version?: number;
    };
    // Version 2 laid out the same regions with two flags this build derives instead. What it
    // says about the page, the rail and the dock's tool is still true, and re-reading it is the
    // difference between a build that remembers where somebody was and one that forgets.
    if (value.version !== 2 && value.version !== 3) return DEFAULT_LAYOUT;
    return {
      ...DEFAULT_LAYOUT,
      ...value,
      version: 3,
      // A page name from a newer build, or one the project has since switched off, would
      // otherwise leave the centre blank with no way to say so.
      page: isProjectPage(value.page) ? value.page : DEFAULT_LAYOUT.page,
      dockTool: readDockTool(value.dockTool),
      moreOpen: value.moreOpen === true,
      // A layout written while this field was set from whatever was opened last could say
      // "note" or "output", and a Library told to list those lists them.
      collectionFamily: readLibraryFamily(value.collectionFamily),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export interface PinnedObject {
  id: string;
  type: string;
  title: string;
}

/**
 * Pins live on this machine, not in the workspace.
 *
 * What somebody keeps one click away is a personal convenience, not a fact about the research.
 * Writing it into the canonical files would put one person's shortcuts in everybody's history.
 */
export function pinKey(workspaceId: string, projectId: string | null): string {
  return `${shellKey(workspaceId, projectId)}.pins`;
}

export function storedPins(workspaceId: string, projectId: string | null): PinnedObject[] {
  try {
    const raw = window.localStorage.getItem(pinKey(workspaceId, projectId));
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is PinnedObject =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as PinnedObject).id === "string" &&
            typeof (entry as PinnedObject).title === "string" &&
            typeof (entry as PinnedObject).type === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** The pages that list and edit one family of objects through the shared collection surface. */
const COLLECTION_PAGES: Partial<Record<ProjectPage, string>> = {
  library: "source",
  notes: "note",
  manuscript: "output",
};

/** The two families the Library lists: papers, or the files that came with them. */
const LIBRARY_FAMILIES = ["source", "asset"] as const;

function readLibraryFamily(value: unknown): string {
  return (LIBRARY_FAMILIES as readonly string[]).includes(value as string)
    ? (value as string)
    : DEFAULT_LAYOUT.collectionFamily;
}

/** Where an object of each type is opened. Anything else is a paper as far as the shell knows. */
const PAGE_FOR_TYPE: Readonly<Record<string, ProjectPage>> = {
  source: "library",
  asset: "library",
  note: "notes",
  output: "manuscript",
  claim: "claims",
  task: "tasks",
};

async function invoke(
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult | null> {
  const bridge = readBridge();
  if (bridge === null) return null;
  return bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      command,
      args,
    })
    .catch(() => null);
}

/**
 * Whether a drag is carrying files in from outside, rather than moving something around inside.
 *
 * The board moves cards and the editors move text by dragging, and a shell that claimed every drag
 * would take those over. Only "Files" is intercepted, which is the one kind the operating system
 * puts there and nothing in the application ever sets.
 */
function draggingFiles(event: React.DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/**
 * A page's name in a collapsed rail.
 *
 * Two letters rather than one: "Notes" and "No" are both readable, where "N" could be either of
 * two pages and is really just a shape. Manuscript is the one that needs saying, because "Ma" is
 * not how anybody abbreviates it.
 */
function monogram(page: ProjectPage): string {
  return page === "manuscript" ? "Ms" : PROJECT_PAGE_LABELS[page].slice(0, 2);
}

/** A reference library rather than something to copy in whole, decided by the name it arrives under. */
function isReferenceLibrary(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return lower.endsWith(".bib") || lower.endsWith(".ris");
}

export interface ProjectShellProps {
  workspaceId: string;
  workspaceTitle: string;
  writable: boolean;
  projectId: string | null;
  /**
   * The person reading, for the surfaces that have to say who somebody is.
   *
   * Optional because the shell was built before anything needed it, and a page that does not
   * ask who you are should not be made to wait for the answer.
   */
  account?: { id: string; email: string } | undefined;
  onOpenSettings?: () => void;
  onLeaveProject?: () => void;
}

export function ProjectShell({
  workspaceId,
  workspaceTitle,
  writable,
  projectId,
  account,
  onOpenSettings,
  onLeaveProject,
}: ProjectShellProps): React.JSX.Element {
  const [layout, setLayout] = useState<ShellLayout>(() =>
    storedShellLayout(workspaceId, projectId),
  );
  const [project, setProject] = useState<{
    title: string;
    settings: ProjectSettings;
    version: number;
    contentHash: string;
    /** How many of each kind of object are filed in it, for the numbers in the rail. */
    counts: Record<string, number>;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [documents, setDocuments] = useState<DocumentTab[]>([]);
  // The mark the Reader has been asked to open on, and which file it is on.
  const [revealed, setRevealed] = useState<{
    assetId: string;
    annotationId: string;
    token: number;
  } | null>(null);
  const [activeDocument, setActiveDocument] = useState<string | null>(null);
  const [requestedObjectId, setRequestedObjectId] = useState<string | null>(null);
  // The last Manuscript that was open. The Bibliography page belongs to a manuscript, and
  // asking which one every time it is opened would be a question with one obvious answer.
  const [openManuscript, setOpenManuscript] = useState<string | null>(null);
  const [requestedObjectAction, setRequestedObjectAction] = useState<{
    objectId: string;
    /** Null opens the menu itself rather than one of the things on it. */
    action: ObjectOrganizationAction | null;
    revision: number;
  } | null>(null);
  const [activeObject, setActiveObject] = useState<QuickCaptureObjectContext | null>(null);
  const [dockPinned, setDockPinned] = useState(false);
  /**
   * The object whose dock was dismissed with Escape.
   *
   * The dock is open because something is selected, so there is no flag to turn off: what
   * Escape does is say "not this one". Selecting anything else brings it back, which is the
   * behaviour somebody expects from a panel they did not ask to open.
   */
  const [dismissedDock, setDismissedDock] = useState<string | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const [pins, setPins] = useState<PinnedObject[]>(() => storedPins(workspaceId, projectId));
  // What each account is called, for the pages that say who did something. The log on disk
  // records accounts by id; the roster is the one place the names are.
  const snapshot = useCollaborationSnapshot(workspaceId);
  const people = useMemo(() => peopleNames(snapshot, account), [snapshot, account]);
  const [quickCapture, setQuickCapture] = useState<QuickCaptureLaunch | null>(null);
  const [managedAssetOpen, setManagedAssetOpen] = useState(false);
  const [referenceImportOpen, setReferenceImportOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);

  const regions = useRef<HTMLDivElement>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const captureReturnFocus = useRef<HTMLElement | null>(null);
  const managedAssetReturnFocus = useRef<HTMLElement | null>(null);
  const referenceImportReturnFocus = useRef<HTMLElement | null>(null);
  const pinnedObject = useRef<QuickCaptureObjectContext | null>(null);
  const recentSelection = useRef<{
    selection: QuickCaptureSelection;
    objectId: string | null;
    page: ProjectPage;
    recordedAt: number;
  } | null>(null);

  const settings = project?.settings ?? defaultProjectSettings();

  useEffect(() => {
    window.localStorage.setItem(shellKey(workspaceId, projectId), JSON.stringify(layout));
  }, [layout, projectId, workspaceId]);

  useEffect(() => {
    window.localStorage.setItem(pinKey(workspaceId, projectId), JSON.stringify(pins));
  }, [pins, projectId, workspaceId]);

  /**
   * The breadcrumb belongs to the top bar, which sits above the workspace and knows nothing
   * about pages. Announcing it is how the two stay apart, the same way object selection is
   * already announced.
   *
   * `writable` travels with it because the bar is where the read-only badge now sits, beside the
   * project it is true of, rather than in a status row nobody looked at.
   */
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("kiwi:breadcrumb", {
        detail: {
          workspace: workspaceTitle,
          project: project?.title ?? null,
          page: PROJECT_PAGE_LABELS[layout.page],
          writable,
          railCollapsed: layout.railCollapsed,
        },
      }),
    );
  }, [layout.page, layout.railCollapsed, project, workspaceTitle, writable]);

  useEffect(() => {
    if (projectId === null) {
      setProject(null);
      return;
    }
    let active = true;
    void invoke("kiwi.project.list", {}).then((result) => {
      if (!active) return;
      const projects = ((result?.data ?? {})["projects"] ?? []) as Array<{
        id: string;
        title: string;
        version: number;
        content_hash: string;
        settings: unknown;
        counts?: Record<string, number>;
      }>;
      const found = projects.find((entry) => entry.id === projectId);
      setProject(
        found === undefined
          ? null
          : {
              title: found.title,
              settings: readProjectSettings(found.settings),
              version: found.version,
              contentHash: found.content_hash,
              counts: found.counts ?? {},
            },
      );
    });
    return () => {
      active = false;
    };
    // `projectRevision` is bumped after Settings saves, so the rail and the title follow a
    // change made on this screen without a reload.
  }, [projectId, projectRevision]);

  const openPage = useCallback((page: ProjectPage): void => {
    setLayout((current) => ({ ...current, page }));
  }, []);

  // A page the project has switched off must not stay open. Landing on the Dashboard is the
  // one destination every project has.
  useEffect(() => {
    if (project !== null && !projectPageEnabled(project.settings, layout.page)) {
      openPage("dashboard");
    }
  }, [layout.page, openPage, project]);

  const openDocument = useCallback((assetId: string, title: string, objectId: string): void => {
    setDocuments((current) =>
      current.some((tab) => tab.assetId === assetId)
        ? current
        : [...current, { assetId, title, objectId }],
    );
    setActiveDocument(assetId);
    setLayout((current) => ({ ...current, page: "reader" }));
  }, []);

  const closeDocument = useCallback((assetId: string): void => {
    setDocuments((current) => {
      const next = current.filter((tab) => tab.assetId !== assetId);
      setActiveDocument((active) => (active === assetId ? (next.at(-1)?.assetId ?? null) : active));
      return next;
    });
  }, []);

  /**
   * Moves a document out of this window and into one of its own.
   *
   * The tab goes with it, so the document is in one place rather than two. Two Readers on one
   * file would also be two of them remembering where that file was left off, and the second one
   * to be scrolled would win an argument nobody meant to start.
   */
  const detachDocument = useCallback(
    (tab: DocumentTab): void => {
      const bridge = readBridge();
      if (bridge === null) return;
      void bridge
        .detachDocument({ objectId: tab.objectId, kind: "reader", assetId: tab.assetId })
        .then((result) => {
          if (documentMoved(result)) closeDocument(tab.assetId);
        })
        .catch(() => undefined);
    },
    [closeDocument],
  );

  const openObject = useCallback(
    (objectId: string, type: string): void => {
      setRequestedObjectId(objectId);
      const page = PAGE_FOR_TYPE[type] ?? "library";
      openPage(page);
      // Only the Library has a family to remember, papers or files. This used to record the
      // family of whatever page was opened, so that opening a note left the Library listing
      // notes, and opening the manuscript left it listing manuscripts.
      if (page === "library")
        setLayout((current) => ({
          ...current,
          collectionFamily: type === "asset" ? "asset" : "source",
        }));
    },
    [openPage],
  );

  /**
   * Follows a quotation back to the page it was read on.
   *
   * The quotation stores the mark and nothing else that would go stale, so where that mark is is
   * asked for at the moment somebody clicks rather than remembered in the note. The Reader opens
   * on the file the mark is on, turns to its page, and selects it.
   *
   * A mark that has been deleted since leaves the paper, which the quotation also carries. That
   * is less than was asked for and much more than a click that does nothing: the passage is gone
   * from the file, and the paper it was read in is still the place to go looking.
   */
  const openAnnotation = useCallback(
    (annotationId: string, paperId?: string): void => {
      void invoke("kiwi.annotation.locate", { annotation_id: annotationId }).then((result) => {
        const location =
          result === null || result.error !== undefined
            ? null
            : readAnnotationLocation(result.data);
        if (location === null) {
          if (paperId !== undefined && paperId !== "") openObject(paperId, "source");
          return;
        }
        openDocument(location.asset_id, location.file_title, location.object_id);
        // A token per request, so following the same quotation after paging away is a second
        // request rather than one the Reader has already carried out.
        setRevealed((current) => ({
          assetId: location.asset_id,
          annotationId,
          token: (current?.token ?? 0) + 1,
        }));
      });
    },
    [openDocument, openObject],
  );

  const togglePin = useCallback((object: PinnedObject): void => {
    setPins((current) =>
      current.some((pin) => pin.id === object.id)
        ? current.filter((pin) => pin.id !== object.id)
        : // A rail of forty pins is not a shortcut. Ten is where it stops being one.
          [...current, object].slice(-10),
    );
  }, []);

  function openQuickCapture(): void {
    if (quickCapture !== null) return;
    captureReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const currentSelection = readQuickCaptureSelection();
    const remembered = recentSelection.current;
    // A selection made a moment ago on this same object is still what the reader means, even
    // though clicking Capture cleared it.
    const selection =
      currentSelection ??
      (remembered !== null &&
      Date.now() - remembered.recordedAt < 30_000 &&
      remembered.objectId === (activeObject?.id ?? null) &&
      remembered.page === layout.page
        ? remembered.selection
        : null);
    setQuickCapture({
      surface: layout.page,
      projectId,
      object: activeObject,
      selection,
    });
  }

  function closeQuickCapture(): void {
    setQuickCapture(null);
    window.setTimeout(() => {
      if (captureReturnFocus.current?.isConnected === true) captureReturnFocus.current.focus();
    }, 0);
  }

  function openManagedAsset(file: File | null = null): void {
    if (managedAssetOpen) return;
    managedAssetReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDroppedFile(file);
    setManagedAssetOpen(true);
  }

  function closeManagedAsset(): void {
    setManagedAssetOpen(false);
    setDroppedFile(null);
    window.setTimeout(() => {
      if (managedAssetReturnFocus.current?.isConnected === true)
        managedAssetReturnFocus.current.focus();
    }, 0);
  }

  function openReferenceImport(file: File | null = null): void {
    if (referenceImportOpen) return;
    referenceImportReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDroppedFile(file);
    setReferenceImportOpen(true);
  }

  function closeReferenceImport(): void {
    setReferenceImportOpen(false);
    setDroppedFile(null);
    window.setTimeout(() => {
      if (referenceImportReturnFocus.current?.isConnected === true)
        referenceImportReturnFocus.current.focus();
    }, 0);
  }

  /**
   * Runs one thing off the New menu.
   *
   * Focus goes back to the trigger before the action runs, because every one of these opens a
   * dialog that remembers where to put focus when it closes, and "the menu item that has just
   * been unmounted" is not a place focus can go back to.
   */
  function chooseNew(run: () => void): void {
    setNewMenuOpen(false);
    newTrigger.current?.focus();
    run();
  }

  /**
   * A new note, made from the rail rather than from the Notes page.
   *
   * Filed in the project on the way, because a note made from inside a project and left outside
   * it is a note somebody will look for on the page they made it from and not find. Where the
   * shell has no project open there is nothing to file it in, and the note is simply made.
   */
  async function createNote(): Promise<void> {
    if (!writable || creatingNote) return;
    setCreatingNote(true);
    try {
      const made = await invoke("kiwi.object.create", {
        type: "note",
        title: "Untitled note",
        content: "",
      });
      const created = ((made?.data ?? {})["object"] ?? null) as { id: string } | null;
      if (made === null || made.error !== undefined || created === null) return;
      if (projectId !== null)
        await invoke("kiwi.project.assign", { object_id: created.id, project_id: projectId });
      openObject(created.id, "note");
    } finally {
      setCreatingNote(false);
    }
  }

  /**
   * A file dropped anywhere on the window, sent to whichever importer it belongs to.
   *
   * The name settles it, which is a guess -- a BibTeX export saved as `.txt` lands in the asset
   * importer instead. That is the survivable half of the guess: the file is copied in whole and
   * still there to import properly, where the other way round would run a library through the
   * hasher. The dialogs are left alone once open, because each has a drop target of its own and
   * a second file arriving over an unfinished review would throw the review away.
   */
  function dropFile(event: React.DragEvent): void {
    if (!draggingFiles(event)) return;
    // Swallowed either way: an unhandled file drop navigates the window to the file, and the
    // application is gone.
    event.preventDefault();
    if (!writable || managedAssetOpen || referenceImportOpen) return;
    const file = event.dataTransfer.files[0];
    if (event.dataTransfer.files.length !== 1 || file === undefined) return;
    if (isReferenceLibrary(file.name)) openReferenceImport(file);
    else openManagedAsset(file);
  }

  useEffect(() => {
    function command(event: Event): void {
      const detail = (
        event as CustomEvent<{
          page?: string;
          action?: string;
          objectId?: string;
          objectAction?: ObjectOrganizationAction;
        }>
      ).detail;
      if (detail.objectId !== undefined) setRequestedObjectId(detail.objectId);
      if (detail.objectId !== undefined && detail.objectAction !== undefined)
        setRequestedObjectAction({
          objectId: detail.objectId,
          action: detail.objectAction,
          revision: Date.now(),
        });
      if (isProjectPage(detail.page)) openPage(detail.page);
      if (detail.action === "focus")
        setLayout((current) => ({ ...current, focusMode: !current.focusMode }));
      if (detail.action === "settings") onOpenSettings?.();
      if (detail.action === "quick-capture") openQuickCapture();
      if (detail.action === "add-managed-file") openManagedAsset();
      if (detail.action === "import-references") openReferenceImport();
      if (detail.action === "new-note") void createNote();
      // Both live in the top bar's project menu now, and the top bar sits above the workspace:
      // it knows there is a project open, not what leaving one would mean.
      if (detail.action === "all-projects") onLeaveProject?.();
      if (detail.action === "collapse-rail")
        setLayout((current) => ({ ...current, railCollapsed: !current.railCollapsed }));
    }
    window.addEventListener("kiwi:workbench-command", command);
    return () => window.removeEventListener("kiwi:workbench-command", command);
  });

  useEffect(() => {
    function shortcuts(event: KeyboardEvent): void {
      if (!event.ctrlKey) return;
      const key = event.key.toLocaleLowerCase("en-US");
      if (event.shiftKey && key === "i") {
        event.preventDefault();
        openQuickCapture();
      } else if (key === "b") {
        event.preventDefault();
        setLayout((current) => ({ ...current, railCollapsed: !current.railCollapsed }));
      } else if (key === "\\") {
        // The dock cannot be hidden any more -- it is there because something is selected --
        // so the key that used to hide it now holds it on what is selected now.
        event.preventDefault();
        pinnedObject.current = dockPinned ? null : activeObject;
        setDockPinned((value) => !value);
      } else if (key === "w" && activeDocument !== null) {
        event.preventDefault();
        closeDocument(activeDocument);
      } else if (event.key === "Tab" && documents.length > 1) {
        event.preventDefault();
        const at = documents.findIndex((tab) => tab.assetId === activeDocument);
        const next =
          documents[(at + (event.shiftKey ? -1 : 1) + documents.length) % documents.length];
        if (next !== undefined) setActiveDocument(next.assetId);
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  });

  // A bare key, so it only counts when nobody is typing. See `shouldOpenReference`.
  useEffect(() => {
    function reference(event: KeyboardEvent): void {
      if (!shouldOpenReference(event)) return;
      event.preventDefault();
      setShortcutsOpen(true);
    }
    function requested(): void {
      setShortcutsOpen(true);
    }
    window.addEventListener("keydown", reference);
    window.addEventListener("kiwi:show-shortcuts", requested);
    return () => {
      window.removeEventListener("keydown", reference);
      window.removeEventListener("kiwi:show-shortcuts", requested);
    };
  }, []);

  useEffect(() => {
    function updateObject(event: Event): void {
      const detail = (event as CustomEvent<QuickCaptureObjectContext>).detail;
      if (
        typeof detail?.id === "string" &&
        typeof detail.title === "string" &&
        typeof detail.type === "string" &&
        Number.isInteger(detail.version) &&
        typeof detail.content_hash === "string"
      ) {
        setActiveObject(detail);
        if (detail.type === "output") setOpenManuscript(detail.id);
      }
    }
    window.addEventListener("kiwi:object-context", updateObject);
    return () => window.removeEventListener("kiwi:object-context", updateObject);
  }, []);

  useEffect(() => {
    if (COLLECTION_PAGES[layout.page] === undefined && layout.page !== "inbox")
      setActiveObject(null);
  }, [layout.page]);

  useEffect(() => {
    function rememberSelection(): void {
      const selection = readQuickCaptureSelection();
      if (selection === null) return;
      recentSelection.current = {
        selection,
        objectId: activeObject?.id ?? null,
        page: layout.page,
        recordedAt: Date.now(),
      };
    }
    document.addEventListener("selectionchange", rememberSelection);
    return () => document.removeEventListener("selectionchange", rememberSelection);
  }, [activeObject, layout.page]);

  function cycleRegions(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "F6") return;
    event.preventDefault();
    const available = [
      ...(regions.current?.querySelectorAll<HTMLElement>("[data-shell-region]") ?? []),
    ].filter((element) => element.offsetParent !== null);
    if (available.length === 0) return;
    const index = available.findIndex((element) => element.contains(document.activeElement));
    const delta = event.shiftKey ? -1 : 1;
    available[(index + delta + available.length) % available.length]?.focus();
  }

  const rail = useMemo(() => projectRailPages(settings), [settings]);
  const inspected = dockPinned ? (pinnedObject.current ?? activeObject) : activeObject;
  // A page reached from More has to be visible while it is open, or the rail would deny the page
  // somebody is standing on.
  const moreExpanded = layout.moreOpen || rail.more.includes(layout.page);
  const dockOpen = !layout.focusMode && inspected !== null && dismissedDock !== inspected.id;

  // The one number in the rail that is not a count of objects. It is asked for once, the way the
  // Dashboard asks for it, rather than polled: the rail is not a task list.
  const board = useTasks({ workspaceId, projectId, mine: true });
  const openTasks = board.tasks.filter((entry) => entry.task.status !== "done").length;

  /** What goes to the right of a page's name, or nothing when the number would say nothing. */
  function railCount(page: ProjectPage): number | null {
    if (page === "tasks") return account === undefined || openTasks === 0 ? null : openTasks;
    const type = PROJECT_PAGE_COUNTED_TYPE[page];
    if (type === undefined) return null;
    const count = project?.counts[type] ?? 0;
    // Zero is not news. A page with nothing on it is still in the rail, and a "0" beside it
    // would be the rail telling somebody off for not having started.
    return count === 0 ? null : count;
  }

  function railPage(page: ProjectPage): React.JSX.Element {
    const count = railCount(page);
    return (
      <li key={page}>
        <button
          type="button"
          aria-current={layout.page === page ? "page" : undefined}
          // Collapsed, the button reads "Li". The label is what a screen reader and a test both
          // need, and it must not change with the width.
          aria-label={PROJECT_PAGE_LABELS[page]}
          title={`${PROJECT_PAGE_LABELS[page]}: ${PROJECT_PAGE_PURPOSE[page]}`}
          onClick={() => openPage(page)}
        >
          <span className="rail__page-name">
            {layout.railCollapsed ? monogram(page) : PROJECT_PAGE_LABELS[page]}
          </span>
          {count === null || layout.railCollapsed ? null : (
            <span className="rail__count">{count}</span>
          )}
        </button>
      </li>
    );
  }

  return (
    <div
      ref={regions}
      className={`project-shell${layout.focusMode ? " project-shell--focus" : ""}${
        dockOpen ? " project-shell--docked" : ""
      }`}
      style={
        {
          "--rail-width": layout.railCollapsed ? "56px" : `${layout.railWidth}px`,
          "--dock-width": `${layout.dockWidth}px`,
        } as React.CSSProperties
      }
      onKeyDown={cycleRegions}
      onDragOver={(event) => {
        if (draggingFiles(event)) event.preventDefault();
      }}
      onDrop={dropFile}
    >
      {shortcutsOpen ? <ShortcutReference onClose={() => setShortcutsOpen(false)} /> : null}
      {!layout.focusMode ? (
        <nav className="rail" aria-label="Project pages" tabIndex={-1} data-shell-region>
          <ul className="rail__pages">
            {rail.core.map((page) => railPage(page))}
            {rail.more.length === 0 ? null : (
              <li>
                <button
                  type="button"
                  className="rail__more"
                  aria-label="More pages"
                  aria-expanded={moreExpanded}
                  title="Every other page this project has"
                  onClick={() => setLayout((current) => ({ ...current, moreOpen: !moreExpanded }))}
                >
                  <span className="rail__page-name">{layout.railCollapsed ? "⋯" : "More"}</span>
                  {layout.railCollapsed ? null : (
                    <span aria-hidden="true" className="rail__caret">
                      ⌄
                    </span>
                  )}
                </button>
              </li>
            )}
            {moreExpanded ? rail.more.map((page) => railPage(page)) : null}
          </ul>

          <div className="rail__spacer" />

          {pins.length === 0 ? null : (
            <section className="rail__pins" aria-label="Pinned">
              {layout.railCollapsed ? null : <h3>Pinned</h3>}
              <ul>
                {pins.map((pin) => (
                  <li key={pin.id}>
                    <button
                      type="button"
                      aria-label={pin.title}
                      title={`${pin.title} (${objectTypeLabel(pin.type)})`}
                      onClick={() => openObject(pin.id, pin.type)}
                    >
                      {layout.railCollapsed ? pin.title.slice(0, 1) : pin.title}
                    </button>
                    {layout.railCollapsed ? null : (
                      <button
                        type="button"
                        className="rail__unpin"
                        aria-label={`Unpin ${pin.title}`}
                        onClick={() => togglePin(pin)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* One button rather than three. Adding a paper, adding a library and capturing a
              thought are the same intention arriving three ways, and three buttons made the
              rail look like a toolbar. */}
          <div className="rail__new">
            <button
              ref={newTrigger}
              type="button"
              className="rail__new-trigger"
              aria-label="New"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              disabled={!writable}
              title={writable ? "Add something to this project" : "This workspace is read only"}
              onClick={() => setNewMenuOpen((open) => !open)}
            >
              <span aria-hidden="true" className="rail__new-plus">
                +
              </span>
              {layout.railCollapsed ? null : <span>New</span>}
            </button>
            {newMenuOpen ? (
              <div className="rail__new-menu" role="menu" aria-label="New">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => chooseNew(() => openManagedAsset())}
                >
                  Paper (PDF)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => chooseNew(() => openReferenceImport())}
                >
                  References (.bib / .ris)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={creatingNote}
                  onClick={() => chooseNew(() => void createNote())}
                >
                  Note
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => chooseNew(() => openQuickCapture())}
                >
                  Capture
                </button>
              </div>
            ) : null}
          </div>
        </nav>
      ) : null}

      <main className="page-area" aria-label="Page" tabIndex={-1} data-shell-region>
        {layout.page === "reader" && documents.length > 0 ? (
          <div className="document-tabs" role="tablist" aria-label="Open documents">
            {documents.map((tab) => (
              <div className="document-tab" key={tab.assetId}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeDocument === tab.assetId}
                  onClick={() => setActiveDocument(tab.assetId)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="document-tab__close"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeDocument(tab.assetId)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="page-area__content">
          <PageContent
            page={layout.page}
            workspaceId={workspaceId}
            writable={writable}
            projectId={projectId}
            account={account}
            people={people}
            projectTitle={project?.title ?? workspaceTitle}
            settings={settings}
            projectVersion={project?.version ?? 1}
            projectHash={project?.contentHash ?? ""}
            onProjectSaved={() => setProjectRevision((value) => value + 1)}
            onProjectDeleted={() => {
              // The page is about a project that is not there any more, so this leaves rather
              // than redrawing an empty one.
              onLeaveProject?.();
            }}
            collectionFamily={layout.collectionFamily}
            requestedObjectId={requestedObjectId}
            requestedObjectAction={requestedObjectAction}
            reloadToken={projectRevision}
            documents={documents}
            activeDocument={activeDocument}
            openManuscriptId={openManuscript}
            onOpenPage={openPage}
            onOpenObject={openObject}
            onOpenAnnotation={openAnnotation}
            revealedAnnotation={revealed}
            onOpenFile={openDocument}
            onDetachFile={detachDocument}
            onQuickCapture={openQuickCapture}
            onImportFile={openManagedAsset}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </main>

      {dockOpen && inspected !== null ? (
        <aside
          className="dock"
          aria-label="Details"
          tabIndex={-1}
          data-shell-region
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setDismissedDock(inspected.id);
          }}
        >
          <div className="dock__tools">
            <div className="dock__pills" role="tablist" aria-label="Detail tools">
              {(["details", "comments", "history"] as const).map((tool) => (
                <button
                  key={tool}
                  type="button"
                  role="tab"
                  aria-selected={layout.dockTool === tool}
                  onClick={() => setLayout((current) => ({ ...current, dockTool: tool }))}
                >
                  {tool.slice(0, 1).toLocaleUpperCase() + tool.slice(1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="dock__star"
              aria-pressed={pins.some((pin) => pin.id === inspected.id)}
              aria-label={
                pins.some((pin) => pin.id === inspected.id)
                  ? `Unpin ${inspected.title} from the rail`
                  : `Pin ${inspected.title} to the rail`
              }
              title="Keep this one click away in the rail"
              onClick={() =>
                togglePin({
                  id: inspected.id,
                  type: inspected.type,
                  title: inspected.title,
                })
              }
            >
              ★
            </button>
            <div className="dock__overflow">
              <button
                type="button"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={dockMenuOpen}
                onClick={() => setDockMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {dockMenuOpen ? (
                <div className="dock__menu" role="menu" aria-label="More actions">
                  <button
                    type="button"
                    role="menuitem"
                    aria-pressed={dockPinned}
                    title={
                      dockPinned
                        ? "Stop holding, so the details follow the selection again"
                        : "Hold, so the details stay on this object"
                    }
                    onClick={() => {
                      setDockMenuOpen(false);
                      pinnedObject.current = dockPinned ? null : activeObject;
                      setDockPinned((value) => !value);
                    }}
                  >
                    {dockPinned ? "Stop keeping these details" : "Keep these details"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDockMenuOpen(false);
                      setRequestedObjectId(inspected.id);
                      setRequestedObjectAction({
                        objectId: inspected.id,
                        action: null,
                        revision: Date.now(),
                      });
                    }}
                  >
                    Organize…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!writable}
                    onClick={() => {
                      setDockMenuOpen(false);
                      setRequestedObjectId(inspected.id);
                      setRequestedObjectAction({
                        objectId: inspected.id,
                        action: "trash",
                        revision: Date.now(),
                      });
                    }}
                  >
                    Move to Trash…
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <DockContent
            tool={layout.dockTool}
            object={inspected}
            workspaceId={workspaceId}
            projectId={projectId}
            writable={writable}
            onOpenObject={openObject}
            onOpenFile={openDocument}
            onObjectChanged={() => setProjectRevision((value) => value + 1)}
          />
        </aside>
      ) : null}

      {quickCapture === null ? null : (
        <QuickCapture
          workspaceId={workspaceId}
          writable={writable}
          launch={quickCapture}
          onClose={closeQuickCapture}
          onCaptured={(objectId) => {
            setQuickCapture(null);
            setRequestedObjectId(objectId);
            openPage("inbox");
          }}
        />
      )}
      {managedAssetOpen ? (
        <ManagedAssetImport
          workspaceId={workspaceId}
          writable={writable}
          dropped={droppedFile}
          onClose={closeManagedAsset}
          onOpenAsset={(assetId) => {
            setManagedAssetOpen(false);
            setDroppedFile(null);
            setRequestedObjectId(assetId);
            setLayout((current) => ({ ...current, collectionFamily: "asset", page: "library" }));
          }}
        />
      ) : null}
      {referenceImportOpen ? (
        <ReferenceImport
          workspaceId={workspaceId}
          writable={writable}
          dropped={droppedFile}
          onClose={closeReferenceImport}
          onImported={(objectIds) => {
            closeReferenceImport();
            // Landing on the first of them rather than on a page of four hundred. Somebody who has
            // just imported a library wants to see that it arrived, and one Paper open is the
            // shortest way of showing that.
            const first = objectIds[0];
            if (first !== undefined) setRequestedObjectId(first);
            setLayout((current) => ({ ...current, collectionFamily: "source", page: "library" }));
          }}
        />
      ) : null}
    </div>
  );
}

function PageContent({
  page,
  workspaceId,
  writable,
  projectId,
  account,
  people,
  projectTitle,
  settings,
  projectVersion,
  projectHash,
  onProjectSaved,
  onProjectDeleted,
  collectionFamily,
  requestedObjectId,
  requestedObjectAction,
  reloadToken,
  documents,
  activeDocument,
  openManuscriptId,
  onOpenPage,
  onOpenObject,
  onOpenAnnotation,
  revealedAnnotation,
  onOpenFile,
  onDetachFile,
  onQuickCapture,
  onImportFile,
  onOpenSettings,
}: {
  page: ProjectPage;
  workspaceId: string;
  writable: boolean;
  projectId: string | null;
  account: { id: string; email: string } | undefined;
  people: ReadonlyMap<string, string>;
  projectTitle: string;
  settings: ProjectSettings;
  projectVersion: number;
  projectHash: string;
  onProjectSaved: () => void;
  onProjectDeleted: () => void;
  collectionFamily: string;
  requestedObjectId: string | null;
  requestedObjectAction: {
    objectId: string;
    action: ObjectOrganizationAction | null;
    revision: number;
  } | null;
  reloadToken: number;
  documents: DocumentTab[];
  activeDocument: string | null;
  openManuscriptId: string | null;
  onOpenPage: (page: ProjectPage) => void;
  onOpenObject: (objectId: string, type: string) => void;
  onOpenAnnotation: (annotationId: string, paperId?: string) => void;
  revealedAnnotation: { assetId: string; annotationId: string; token: number } | null;
  onOpenFile: (assetId: string, title: string, objectId: string) => void;
  onDetachFile: (document: DocumentTab) => void;
  onQuickCapture: () => void;
  onImportFile: () => void;
  onOpenSettings?: (() => void) | undefined;
}): React.JSX.Element {
  if (page === "dashboard") {
    if (projectId === null) {
      return (
        <ProjectPages.Empty page="dashboard" title="No project open">
          This workspace is open, but no project inside it is. Choose one from All projects.
        </ProjectPages.Empty>
      );
    }
    return (
      <ProjectDashboard
        workspaceId={workspaceId}
        projectId={projectId}
        projectTitle={projectTitle}
        account={account}
        people={people}
        settings={settings}
        writable={writable}
        onOpenPage={onOpenPage}
        onOpenObject={onOpenObject}
        onQuickCapture={onQuickCapture}
        onImportFile={onImportFile}
      />
    );
  }

  if (page === "inbox")
    return (
      <InboxWorkbench
        workspaceId={workspaceId}
        writable={writable}
        initialObjectId={requestedObjectId}
      />
    );

  const family = COLLECTION_PAGES[page];
  if (family !== undefined) {
    const objectFamily = page === "library" ? collectionFamily : family;
    return (
      // Keyed by family. Three pages share this one surface, and an instance carried from the
      // Library to Notes kept the Library's view: it listed papers under a heading that said
      // notes, and wrote that view away under the Notes' name.
      <CollectionWorkbench
        key={objectFamily}
        workspaceId={workspaceId}
        writable={writable}
        objectFamily={objectFamily}
        requestedObjectId={requestedObjectId}
        requestedAction={requestedObjectAction}
        reloadToken={reloadToken}
        citationStyle={settings.citation_style}
        onOpenFile={onOpenFile}
        onOpenObject={onOpenObject}
        onOpenAnnotation={onOpenAnnotation}
      />
    );
  }

  if (page === "reader") {
    return documents.length === 0 ? (
      <ProjectPages.Empty page="reader" title="No document open">
        Open a Paper in the Library and choose Read on one of its files. Every document you open
        stays here as a tab.
      </ProjectPages.Empty>
    ) : (
      <ReaderSplit
        workspaceId={workspaceId}
        documents={documents}
        activeDocument={activeDocument}
        projectId={projectId}
        writable={writable}
        onDetach={onDetachFile}
        reveal={revealedAnnotation}
      />
    );
  }

  if (page === "bibliography")
    return (
      <BibliographyPage
        workspaceId={workspaceId}
        style={settings.citation_style}
        manuscriptId={openManuscriptId}
        {...(onOpenObject === undefined ? {} : { onOpenObject })}
      />
    );
  if (page === "review")
    return (
      <ReviewPage
        workspaceId={workspaceId}
        writable={writable}
        projectId={projectId}
        onOpenObject={onOpenObject}
      />
    );
  if (page === "history")
    return <HistoryPage workspaceId={workspaceId} people={people} onOpenObject={onOpenObject} />;
  if (page === "import") return <SearchWorkbench workspaceId={workspaceId} />;
  if (page === "trash") return <TrashWorkbench workspaceId={workspaceId} writable={writable} />;
  if (page === "settings")
    return projectId === null ? (
      <ProjectPages.Empty
        page="settings"
        title="No project open"
        action="Open workspace settings"
        onAction={onOpenSettings}
      >
        Project settings need a project. Workspace settings are open to you either way.
      </ProjectPages.Empty>
    ) : (
      <ProjectSettingsPage
        projectId={projectId}
        projectTitle={projectTitle}
        settings={settings}
        version={projectVersion}
        contentHash={projectHash}
        writable={writable}
        onSaved={onProjectSaved}
        onOpenWorkspaceSettings={onOpenSettings}
        onDeleted={onProjectDeleted}
      />
    );
  if (page === "claims")
    return projectId === null ? (
      // A claim is filed in a project, and what it answers is that project's protocol. Without
      // one there is nothing to assert anything about.
      <ProjectPages.Empty page="claims" title="No project open">
        Claims belong to a project, and answer the questions that project asked. Choose one from All
        projects.
      </ProjectPages.Empty>
    ) : (
      <ClaimsPage workspaceId={workspaceId} projectId={projectId} writable={writable} />
    );
  if (page === "question")
    return projectId === null ? (
      // The protocol belongs to a project. Without one there is nothing to be asking.
      <ProjectPages.Empty page="question" title="No project open">
        A question and a protocol belong to a project. Choose one from All projects.
      </ProjectPages.Empty>
    ) : (
      <ProtocolPage
        workspaceId={workspaceId}
        projectId={projectId}
        projectTitle={projectTitle}
        settings={settings}
        projectVersion={projectVersion}
        projectHash={projectHash}
        writable={writable}
        onProjectSaved={onProjectSaved}
      />
    );
  if (page === "members")
    return account === undefined ? (
      // The roster belongs to the account service, and it will not say who is in a workspace to
      // somebody it cannot identify. There is nothing to show and nothing to ask for.
      <ProjectPages.Empty page="members" title="Not signed in">
        Who is in a workspace is kept by the account service, so this page opens once Kiwi knows who
        you are.
      </ProjectPages.Empty>
    ) : (
      <MembersPage workspaceId={workspaceId} account={account} />
    );
  if (page === "notes") return <LiveNotesWorkbench workspaceId={workspaceId} writable={writable} />;
  if (page === "tasks")
    return account === undefined ? (
      // Assigning work needs to know who is doing the assigning. Showing a board that cannot
      // answer that would be a board where every card is anonymous.
      <ProjectPages.Empty page="tasks" title="Not signed in">
        Tasks belong to people, so this page opens once Kiwi knows who you are.
      </ProjectPages.Empty>
    ) : (
      <TasksPage
        workspaceId={workspaceId}
        projectId={projectId}
        account={account}
        settings={settings}
        writable={writable}
      />
    );

  return <ProjectPages.Empty page={page} title={PROJECT_PAGE_LABELS[page]} />;
}

/**
 * What the dock shows about the selected object.
 *
 * Details is one tool rather than two. The Inspector said the kind and the version and nothing
 * else, which is a line, not a panel; Links said what draws on the object. Splitting a line off
 * from the thing it belongs to and calling it a tab made somebody click to read a sentence.
 *
 * A Paper is the one kind with a panel of its own, because a paper is a file you open and a
 * record you correct as well as an object with links. That panel used to occupy a second column
 * of the Library, which meant the Library was half a list.
 */
function DockContent({
  tool,
  object,
  workspaceId,
  projectId,
  writable,
  onOpenObject,
  onOpenFile,
  onObjectChanged,
}: {
  tool: DockTool;
  object: QuickCaptureObjectContext;
  workspaceId: string;
  projectId: string | null;
  writable: boolean;
  /** Where a link in the dock sends you. */
  onOpenObject: (objectId: string, type: string) => void;
  /** Where Read PDF sends you. */
  onOpenFile: (assetId: string, title: string, objectId: string) => void;
  /** Said when something written here changes the object, so the page behind can catch up. */
  onObjectChanged: () => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<Array<{ version: number; updated_at: string }> | null>(
    null,
  );

  useEffect(() => {
    if (tool !== "history") return;
    let active = true;
    void invoke("kiwi.object.history", { object_id: object.id }).then((result) => {
      if (!active) return;
      setHistory(
        (result?.data?.["history"] ?? []) as Array<{ version: number; updated_at: string }>,
      );
    });
    return () => {
      active = false;
    };
  }, [object, tool]);

  /** Which object this is, for the two tools that are not about the object's own fields. */
  const identity = (
    <div className="dock__identity">
      <span>
        {objectTypeLabel(object.type)} · v{object.version}
      </span>
      <h3>{object.title}</h3>
    </div>
  );

  if (tool === "details")
    return (
      <div className="dock__body">
        {object.type === "source" ? (
          <PaperPanel
            workspaceId={workspaceId}
            paper={object}
            writable={writable}
            onOpenFile={onOpenFile}
            onChanged={onObjectChanged}
            onOpenObject={onOpenObject}
          />
        ) : (
          <>
            {identity}
            <LinksPanel workspaceId={workspaceId} objectId={object.id} onOpen={onOpenObject} />
          </>
        )}
        {/* The only part of this dock anybody writes to, so it sits at the bottom where a form
            does not push the reading matter down the panel. */}
        <ObjectTasks
          workspaceId={workspaceId}
          projectId={projectId}
          objectId={object.id}
          objectTitle={object.title}
          writable={writable}
        />
      </div>
    );

  if (tool === "history")
    return (
      <div className="dock__body">
        {identity}
        {history === null || history.length === 0 ? (
          <p className="dock__quiet">No earlier versions.</p>
        ) : (
          <ul className="dock__list">
            {history.map((entry) => (
              <li key={entry.version}>
                Version {entry.version} · {entry.updated_at.slice(0, 10)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  return (
    <div className="dock__body">
      {identity}
      <CommentThreads
        workspaceId={workspaceId}
        objectId={object.id}
        writable={writable}
        empty={`No comments on ${object.title}. A comment is a question you can leave open.`}
      />
    </div>
  );
}
