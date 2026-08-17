// Entry point. Builds the frame, the menus, and the keyboard model.

import { $, $$, api, el, guard, progress, projectQuery, reportError, setBusy, setStatus, state } from "./core.js";
import { inspectorFocused, moveCurrent, runAction, toggleDetail } from "./inspector.js";
import * as keys from "./keyboard.js";
import { askAgain, receivePages, refreshAI, registerPanels } from "./panels.js";
import {
  ai,
  applyLayout,
  centre,
  closeMenus,
  isMenuOpen,
  openMenuAt,
  openMenuBelow,
  paintIcons,
  registerLeft,
  renderLeft,
  restoreLayout,
  selectLeft,
  showLeft,
  toggleLeft,
  toggleRight,
  wirePanels,
  wireResizers,
} from "./shell.js";
import {
  activeDraft,
  changeCurrentCitation,
  createDraft,
  createNote,
  createProject,
  editCurrentSentence,
  emptyCentre,
  focusFilter,
  isDirty,
  markChecked,
  moveClaim,
  nav,
  openCurrentSource,
  openDraft,
  openNote,
  openPaper,
  openPapers,
  openProjectDialog,
  openProjectSettings,
  openUserSettings,
  panelHandles,
  refreshHome,
  rowFocused,
  rowMove,
  rowRemove,
  saveAll,
  saveCurrent,
  scoreDraft,
  suggestRevisions,
} from "./views.js";

/* --- Project --------------------------------------------------------------- */

async function refresh() {
  if (!state.project) return;
  const summary = await api("/projects/summary" + projectQuery());
  state.papers = summary.papers;
  state.notes = summary.notes;
  state.drafts = summary.drafts;
  state.folders = summary.folders || { notes: [], drafts: [] };

  const retracted = state.papers.filter((p) => p.source_status === "retracted").length;
  const issues = state.papers.filter((p) => p.verification === "issues").length;
  setBadge("#badge-references", retracted + issues, retracted > 0);
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  setStatus(
    [
      count(state.papers.length, "paper"),
      count(state.notes.length, "note"),
      count(state.drafts.length, "draft"),
    ].join(" · ")
  );
  renderLeft();
}

function setBadge(selector, count, danger) {
  const badge = $(selector);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("activity__badge--danger", Boolean(danger));
}

const openProject = guard(async (path, name) => {
  // The registry answers with the name it holds, which is the folder
  // without its .kiwi suffix. Deriving one here from the path instead
  // shows the suffix.
  const opened = await api("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  state.project = path;
  state.projectName =
    name || opened.project?.name || path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  $("#project-name").textContent = state.projectName;
  $("#project-name").hidden = false;
  await refresh();
  showLeft("explorer");
  refreshHome();
  setStatus(undefined, `Opened ${state.projectName}`);
});

const closeProject = guard(async () => {
  await saveAll();
  await centre.closeAll();
  state.project = null;
  state.projectName = "";
  state.papers = [];
  state.notes = [];
  state.drafts = [];
  state.folders = { notes: [], drafts: [] };
  $("#project-name").hidden = true;
  setStatus("", "");
  renderLeft();
  // With every file closed the centre shows the list of projects, which
  // is where closing one lands.
  refreshHome();
});

/* --- Adding papers --------------------------------------------------------- */

const addPapers = guard(async (files) => {
  if (!files.length || state.busy || !state.project) return;

  let textOnly = false;
  const ingestor = await api("/health/ingestor");
  if (!ingestor.ok) {
    // Two parsers, not a destructive action: presented inline as a choice
    // with what differs stated in one line.
    const proceed = await keys.confirmDialog({
      title: "GROBID is not running",
      body: [
        ingestor.detail,
        "Reading the text layer alone finds no section tree and no references. " +
          "The papers keep their identity, so parsing them through GROBID later replaces them in place.",
      ],
      confirmLabel: "Read the text layer",
      danger: false,
    });
    if (!proceed) {
      setStatus(undefined, "Start GROBID, then add the papers again.");
      return;
    }
    textOnly = true;
  }

  setBusy(true);
  const added = [];
  const failed = [];
  try {
    for (const [i, file] of files.entries()) {
      progress(file.name, { done: i, total: files.length });
      const body = new FormData();
      body.append("file", file);
      body.append("project", state.project);
      body.append("text_only", String(textOnly));
      try {
        const result = await api("/ingest", { method: "POST", body });
        added.push(result.document_id);
      } catch (error) {
        failed.push(`${file.name}: ${error.message}`);
      }
    }

    if (added.length) {
      progress("Indexing");
      await api("/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project }),
      });
      await refresh();
    }
  } finally {
    setBusy(false);
    progress(null);
  }

  setStatus(undefined, `${added.length} paper(s) added${textOnly ? ", text layer only" : ""}`);
  // A failure does not stop the batch; they collect and report at the end.
  if (failed.length) {
    reportError(new Error(failed.join("\n")), {
      title: `${failed.length} paper(s) failed to parse`,
    });
  }
  refreshHome();
});

/* --- Theme ----------------------------------------------------------------- */

function setTheme(mode) {
  localStorage.setItem("kiwi-theme", mode);
  const dark =
    mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme-btn").textContent = mode === "system" ? "Auto" : dark ? "Dark" : "Light";
}

function setDensity(mode) {
  localStorage.setItem("kiwi-density", mode);
  document.documentElement.dataset.density = mode;
}

/* --- Commands -------------------------------------------------------------- */

const hasProject = () => Boolean(state.project);
const hasDraft = () => Boolean(activeDraft.relpath);
const hasTab = () => Boolean(centre.active() && centre.active().closable !== false);

function registerCommands() {
  keys.register([
    { name: "Command palette", keys: ["Ctrl+K"], run: () => keys.openPalette(), hidden: true },
    {
      name: "Go to file",
      keys: ["Ctrl+P"],
      run: () => keys.openPalette(documentCommands),
      hidden: true,
    },

    { name: "Create New Project", keys: ["Ctrl+Shift+N"], run: () => createProject("") },
    { name: "Go To Project", keys: ["Ctrl+O"], run: () => openProjectDialog(null) },
    { name: "Close project", when: hasProject, run: closeProject },
    { name: "New draft", when: hasProject, run: createDraft },
    { name: "New note", when: hasProject, run: createNote },
    { name: "Import PDFs", when: hasProject, run: () => $("#paper-file-input").click() },
    { name: "Save", keys: ["Ctrl+S"], run: saveCurrent },
    { name: "Save all", keys: ["Ctrl+Alt+S"], run: saveAll },
    { name: "Close file", keys: ["Alt+W"], when: hasTab, run: () => centre.close(centre.activeId) },
    { name: "Close all files", run: () => centre.closeAll() },
    {
      name: "Close saved files",
      run: () => centre.closeAll({ keep: (tab) => isDirty(tab.id) }),
    },
    { name: "Previous file", keys: ["Alt+["], run: () => centre.step(-1) },
    { name: "Next file", keys: ["Alt+]"], run: () => centre.step(1) },

    { name: "Project settings", keys: ["Ctrl+,"], run: openProjectSettings },
    { name: "User settings", run: openUserSettings },
    { name: "All papers", when: hasProject, run: openPapers },

    { name: "Explorer", keys: ["Ctrl+1"], run: () => showLeft("explorer") },
    { name: "Search in project", keys: ["Ctrl+2"], run: () => showLeft("search") },
    { name: "Review", keys: ["Ctrl+3"], run: () => showLeft("review") },
    { name: "References", keys: ["Ctrl+4"], run: () => showLeft("references") },
    { name: "Show or hide the side panel", keys: ["Ctrl+B"], run: toggleLeft },
    { name: "Show or hide the AI panel", keys: ["Ctrl+J"], run: () => toggleRight() },
    { name: "Keyboard reference", keys: ["Ctrl+/"], run: keys.showShortcuts },
    { name: "Focus the filter", keys: ["Ctrl+F", "/"], when: filterable, run: focusFilter },

    { name: "Ask", when: hasProject, run: () => (toggleRight(true), ai.activate("ask")) },
    { name: "Score claims", when: hasDraft, run: () => scoreDraft(activeDraft.relpath) },
    { name: "Suggest revisions", when: hasDraft, run: () => suggestRevisions(activeDraft.relpath) },
    {
      name: "Verify references",
      when: hasProject,
      run: guard(async () => {
        progress("Resolving references");
        try {
          await api("/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: state.project }),
          });
        } finally {
          progress(null);
        }
        await refresh();
        setStatus(undefined, "Verification finished");
      }),
    },

    // The check loop. These work while the cursor is in the draft text, so
    // every one of them is modified.
    {
      name: "Next claim needing attention",
      keys: ["Alt+ArrowDown"],
      when: hasDraft,
      run: () => moveClaim(1),
    },
    {
      name: "Previous claim needing attention",
      keys: ["Alt+ArrowUp"],
      when: hasDraft,
      run: () => moveClaim(-1),
    },
    {
      name: "Next claim of any kind",
      keys: ["Alt+Shift+ArrowDown"],
      when: hasDraft,
      run: () => moveClaim(1, true),
    },
    { name: "Open the cited source", keys: ["Alt+Enter"], when: hasDraft, run: openCurrentSource },
    { name: "Mark the current claim checked", keys: ["Alt+K"], when: hasDraft, run: markChecked },
    {
      name: "Change the citation on the current claim",
      keys: ["Alt+C"],
      when: hasDraft,
      run: changeCurrentCitation,
    },
    { name: "Edit the current sentence", when: hasDraft, run: editCurrentSentence },

    { name: "Theme: light", run: () => setTheme("light") },
    { name: "Theme: dark", run: () => setTheme("dark") },
    { name: "Theme: follow the system", run: () => setTheme("system") },
    { name: "Density: compact", run: () => setDensity("compact") },
    { name: "Density: comfortable", run: () => setDensity("comfortable") },

    // Bare letters, live only where no text is being typed.
    { name: "Next claim", keys: ["J"], when: inspectorFocused, run: () => moveCurrent(1), hidden: true },
    {
      name: "Previous claim",
      keys: ["K"],
      when: inspectorFocused,
      run: () => moveCurrent(-1),
      hidden: true,
    },
    { name: "Toggle detail", keys: ["D"], when: inspectorFocused, run: toggleDetail, hidden: true },
    ...["Enter", "E", "C", "A", "R", "X", "S", "M"].map((key) => ({
      name: `Inspector action ${key}`,
      keys: [key],
      when: inspectorFocused,
      hidden: true,
      run: () => runAction(key === "Enter" ? "Enter" : key.toLowerCase()),
    })),

    { name: "Next row", keys: ["ArrowDown"], when: rowFocused, hidden: true, run: () => rowMove(1) },
    {
      name: "Previous row",
      keys: ["ArrowUp"],
      when: rowFocused,
      hidden: true,
      run: () => rowMove(-1),
    },
    { name: "Remove the selected row", keys: ["Delete"], when: rowFocused, run: rowRemove },

    { name: "Ask this question", keys: ["Ctrl+Enter"], run: askAgain, hidden: true },
    {
      name: "Close menu",
      keys: ["Escape"],
      when: isMenuOpen,
      hidden: true,
      run: closeMenus,
    },
    { name: "Close dialog", keys: ["Escape"], when: keys.isOverlayOpen, run: keys.closeOverlay },
  ]);
}

function filterable() {
  return Boolean($("#left-body input[type='search']") || $(".tabbody:not([hidden]) input[type='search']"));
}

function documentCommands() {
  return [
    ...state.papers.map((p) => ({
      name: `Paper: ${p.title}`,
      run: () => openPaper(p.document_id),
    })),
    ...state.notes.map((relpath) => ({ name: `Note: ${relpath}`, run: () => openNote(relpath) })),
    ...state.drafts.map((relpath) => ({ name: `Draft: ${relpath}`, run: () => openDraft(relpath) })),
  ];
}

/* --- Menu bar --------------------------------------------------------------- */

// The menus name commands from the one keyboard table, so a command has a
// single definition and its shortcut is shown wherever it appears.
const MENUS = [
  {
    name: "File",
    items: [
      "Create New Project",
      "Go To Project",
      "-",
      "New draft",
      "New note",
      "Import PDFs",
      "-",
      "Save",
      "Save all",
      "-",
      "Close file",
      "Close saved files",
      "Close all files",
      "Close project",
    ],
  },
  {
    name: "Edit",
    items: ["Edit the current sentence", "Change the citation on the current claim", "-", "Find in project"],
  },
  {
    name: "Select",
    items: [
      "Next claim needing attention",
      "Previous claim needing attention",
      "Next claim of any kind",
      "-",
      "Previous file",
      "Next file",
    ],
  },
  {
    name: "View",
    items: [
      "Explorer",
      "Search in project",
      "Review",
      "References",
      "-",
      "All papers",
      "-",
      "Show or hide the side panel",
      "Show or hide the AI panel",
      "-",
      "Theme: light",
      "Theme: dark",
      "Theme: follow the system",
      "Density: compact",
      "Density: comfortable",
    ],
  },
  {
    name: "Tools",
    items: [
      "Ask",
      "Score claims",
      "Suggest revisions",
      "Verify references",
      "-",
      "Mark the current claim checked",
      "Open the cited source",
    ],
  },
  {
    name: "Help",
    items: ["Keyboard reference", "Command palette", "User settings", "Project settings"],
  },
];

function menuItems() {
  const byName = new Map(keys.allCommands().map((command) => [command.name, command]));
  return MENUS.map((menu) => ({
    name: menu.name,
    items: menu.items.map((entry) => {
      if (entry === "-") return "-";
      const command = byName.get(entry);
      if (command) return command;
      // Named in a menu and not yet a command: shown, and inert.
      return { name: entry, when: () => false };
    }),
  }));
}

const TAB_MENU = ["Save", "Save all", "-", "Close file", "Close saved files", "Close all files"];

function tabMenuItems() {
  const byName = new Map(keys.allCommands().map((command) => [command.name, command]));
  return TAB_MENU.map((entry) => (entry === "-" ? "-" : byName.get(entry))).filter(Boolean);
}

/* --- Boot ------------------------------------------------------------------- */

function wireDropTarget() {
  const app = $("#app");
  app.addEventListener("dragover", (event) => {
    if (!state.project) return;
    event.preventDefault();
    app.classList.add("dropping");
  });
  for (const name of ["dragleave", "dragend", "drop"]) {
    app.addEventListener(name, () => app.classList.remove("dropping"));
  }
  app.addEventListener("drop", (event) => {
    if (!state.project) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf")
    );
    if (!files.length) {
      setStatus(undefined, "Only PDFs can be added by dropping them.");
      return;
    }
    addPapers(files);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  nav.openProject = openProject;
  nav.closeProject = closeProject;
  nav.refresh = refresh;
  nav.setTheme = setTheme;
  nav.setDensity = setDensity;
  nav.aiRefresh = refreshAI;

  panelHandles.openProject = () => openProjectDialog(null);
  panelHandles.refresh = refresh;
  panelHandles.suggest = () => suggestRevisions(activeDraft.relpath);
  panelHandles.changeCitation = changeCurrentCitation;

  state.actor = localStorage.getItem("kiwi-actor") || "";
  setTheme(localStorage.getItem("kiwi-theme") || "system");

  paintIcons();
  wirePanels({ onCentreChange: (tab) => onTabChange(tab), onCentreEmpty: emptyCentre });
  wireResizers();
  registerPanels();
  registerCommands();
  keys.attach();
  wireDropTarget();

  restoreLayout();
  // The centre starts with no file open, which is what draws the home
  // content: it is the empty state, not a tab.
  centre.drawEmpty();
  renderLeft();

  $("#menu-btn").addEventListener("click", (event) =>
    openMenuAt(event.currentTarget, menuItems(), { onRun: (item) => item.run?.() })
  );
  $("#tab-menu").addEventListener("click", (event) =>
    openMenuBelow(event.currentTarget, tabMenuItems(), { onRun: (item) => item.run?.() })
  );
  for (const button of $$(".activity[data-view]")) {
    button.addEventListener("click", () => selectLeft(button.dataset.view));
  }
  for (const button of $$(".activity[data-opens]")) {
    button.addEventListener("click", () => {
      if (button.dataset.opens === "project-settings") openProjectSettings();
      else openUserSettings();
    });
  }

  $("#theme-btn").addEventListener("click", () => {
    const order = ["light", "dark", "system"];
    const current = localStorage.getItem("kiwi-theme") || "system";
    setTheme(order[(order.indexOf(current) + 1) % order.length]);
  });
  $("#search-btn").addEventListener("click", () => keys.openPalette(documentCommands));
  $("#project-name").addEventListener("click", closeProject);

  const input = $("#paper-file-input");
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    addPapers(files);
  });

  const pages = $("#page-file-input");
  pages.addEventListener("change", () => {
    const files = Array.from(pages.files || []);
    pages.value = "";
    receivePages(files);
  });
});

// Switching away from a file writes it, so the only way to lose text is to
// lose the process.
function onTabChange(tab) {
  saveAll();
  if (tab?.id?.startsWith("draft:")) refreshAI();
  paintIcons();
}

export { refresh, registerLeft, applyLayout };
