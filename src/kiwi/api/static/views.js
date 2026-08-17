// Contents of the centre panel. Every one of these is a tab: it renders
// into a host element it is given and keeps that element when the reader
// switches away, so scroll position and unsaved text survive.

import {
  $,
  $$,
  api,
  el,
  escapeHtml,
  guard,
  notice,
  progress,
  projectQuery,
  setStatus,
  state,
} from "./core.js";
import { lineIndexOf, proseEditor } from "./editor.js";
import { chooseDialog, confirmDialog, confirmInline, openDialog, promptDialog } from "./keyboard.js";
import {
  claimSignals,
  mark,
  needsAttention,
  notesOf,
  paperRank,
  paperSignal,
  verdictLabel,
  verdictOf,
} from "./signals.js";
import {
  centre,
  iconEl,
  onContextMenu,
  openMenuAtPoint,
  renderLeft,
  toggleRight,
} from "./shell.js";

export const nav = {
  openProject: null,
  closeProject: null,
  refresh: null,
  setTheme: null,
  setDensity: null,
  aiRefresh: null,
};

/* --- Shared helpers -------------------------------------------------------- */

export function paperTitle(documentId) {
  const paper = state.papers.find((p) => p.document_id === documentId);
  return paper ? paper.title : documentId;
}

// How a cited work is named to a reader. The marker in the draft carries
// the document id, because that is what survives a rename and a
// re-parse; nothing else should show a reader a hash.
export function citationOf(documentId) {
  const paper = state.papers.find((p) => p.document_id === documentId);
  if (!paper) return documentId;

  const families = (paper.authors || [])
    .map((a) => a.family || a.literal || a.given || "")
    .filter(Boolean);
  const year = paper.year ? String(paper.year) : "n.d.";
  if (!families.length) {
    const short = paper.title.split(/[:.]/)[0].trim();
    return `${short || paper.title}, ${year}`;
  }
  const who =
    families.length === 1
      ? families[0]
      : families.length === 2
        ? `${families[0]} and ${families[1]}`
        : `${families[0]} et al.`;
  return `${who}, ${year}`;
}

// The full entry, for pasting into a bibliography.
export function referenceOf(documentId) {
  const paper = state.papers.find((p) => p.document_id === documentId);
  if (!paper) return documentId;
  const names = authorNames(paper.authors);
  const year = paper.year ? ` (${paper.year}).` : "";
  return [names ? `${names}.` : "", `${year} ${paper.title}.`].join("").trim();
}

export function authorNames(authors) {
  return (authors || [])
    .map((a) => a.family || a.literal || [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

export function emptyState(heading, sentence, action) {
  return el("div", { class: "empty" }, [
    el("h2", { text: heading }),
    sentence ? el("p", { text: sentence }) : null,
    action || null,
  ]);
}

// A claim names the paper it cites. Whether that paper is retracted, and
// whether it is still in the project at all, are facts the claim record
// does not carry, so they are read from the paper list.
export function withSourceStatus(claims) {
  return claims.map((claim) => {
    const paper = state.papers.find((p) => p.document_id === claim.citation);
    return { ...claim, source_status: paper ? paper.source_status : "unresolved" };
  });
}

function count(n, noun) {
  return `<b>${n}</b> ${noun}${n === 1 ? "" : "s"}`;
}

function remembered(key, fallback) {
  return localStorage.getItem(`kiwi-${key}`) || fallback;
}

function remember(key, value) {
  localStorage.setItem(`kiwi-${key}`, value);
}

/* --- Saving ---------------------------------------------------------------- */

// Every editable tab registers here. Typing schedules a save; leaving,
// closing, and Ctrl+S all force one, so a manual save is a guarantee
// rather than the only way text reaches disk.
const AUTOSAVE = 1200;
const SWEEP = 15000;

const editable = new Map();

export function registerEditable(tabId, { read, write }) {
  editable.set(tabId, { read, write, saved: read(), timer: null });
}

export function forgetEditable(tabId) {
  const entry = editable.get(tabId);
  if (entry) clearTimeout(entry.timer);
  editable.delete(tabId);
}

export function touch(tabId) {
  const entry = editable.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  centre.markDirty(tabId, entry.read() !== entry.saved);
  entry.timer = setTimeout(() => saveTab(tabId), AUTOSAVE);
}

export const saveTab = guard(async function saveTab(tabId) {
  const entry = editable.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  const content = entry.read();
  if (content === entry.saved) {
    centre.markDirty(tabId, false);
    return;
  }
  await entry.write(content);
  entry.saved = content;
  centre.markDirty(tabId, false);
  setStatus(undefined, "Saved");
});

export async function saveAll() {
  for (const tabId of [...editable.keys()]) await saveTab(tabId);
}

export function isDirty(tabId) {
  const entry = editable.get(tabId);
  return Boolean(entry && entry.read() !== entry.saved);
}

export function saveCurrent() {
  const tab = centre.active();
  return tab ? saveTab(tab.id) : Promise.resolve();
}

setInterval(() => {
  for (const [tabId, entry] of editable) {
    if (entry.read() !== entry.saved) saveTab(tabId);
  }
}, SWEEP);

window.addEventListener("beforeunload", (event) => {
  const unsaved = [...editable.keys()].some(isDirty);
  if (!unsaved) return;
  saveAll();
  event.preventDefault();
  event.returnValue = "";
});

/* --- Rows ------------------------------------------------------------------ */

export function row(props, children) {
  const node = el("div", { class: "row", tabindex: "0", ...props }, children);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      node.click();
    }
  });
  return node;
}

export function removeControl(label, run) {
  return el("button", {
    class: "btn-quiet row__remove",
    text: label,
    title: "Remove",
    onclick: (event) => {
      event.stopPropagation();
      run(event.currentTarget);
    },
  });
}

function focusedRow() {
  const node = document.activeElement;
  return node?.classList?.contains("row") || node?.classList?.contains("tree__item") ? node : null;
}

export function rowFocused() {
  return Boolean(focusedRow());
}

export function rowMove(delta) {
  const current = focusedRow();
  if (!current) return;
  const scope = current.closest("#left-body, .tabbody:not([hidden])") || document;
  const rows = $$(".row, .tree__item", scope);
  if (!rows.length) return;
  const next = rows[Math.min(Math.max(rows.indexOf(current) + delta, 0), rows.length - 1)];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

export function rowRemove() {
  focusedRow()?.querySelector(".row__remove")?.click();
}

export function focusFilter() {
  const field =
    $("#left-body input[type='search']") || $(".tabbody:not([hidden]) input[type='search']");
  if (field) field.focus();
}

/* --- The empty centre ------------------------------------------------------ */

// Not a tab of its own. With every file closed the centre shows this: the
// two commands that start a project when none is open, and what the open
// project holds when one is.
export function emptyCentre(host) {
  host.className = "tabbody";
  renderHome(host);
}

export function refreshHome() {
  centre.drawEmpty();
}

const renderHome = guard(async function renderHome(host) {
  if (!state.project) {
    const [{ projects }, suggested] = await Promise.all([
      api("/projects"),
      api("/projects/default").catch(() => ({ path: "" })),
    ]);

    host.replaceChildren(
      el("div", { class: "home" }, [
        el("h1", { class: "home__title", text: "Kiwi" }),
        el("p", {
          class: "home__sub",
          text: "A project holds papers, notes, and drafts in one folder on this machine.",
        }),
        el("div", { class: "home__actions" }, [
          el(
            "button",
            {
              class: "shortcut",
              id: "home-new",
              onclick: guard(() => createProject(suggested.path)),
            },
            [
              el("span", { class: "shortcut__label", text: "Create New Project" }),
              el("span", { class: "kbd", text: "Ctrl+Shift+N" }),
            ]
          ),
          el(
            "button",
            { class: "shortcut", id: "home-open", onclick: guard(() => openProjectDialog(projects)) },
            [
              el("span", { class: "shortcut__label", text: "Go To Project" }),
              el("span", { class: "kbd", text: "Ctrl+O" }),
            ]
          ),
        ]),
        projects.length
          ? el("div", { class: "home__recent" }, [
              el("h2", { class: "section-title", text: "Projects" }),
              ...projects.map((entry) => projectRow(entry)),
            ])
          : null,
      ])
    );
    return;
  }

  const retracted = state.papers.filter((p) => p.source_status === "retracted");
  const issues = state.papers.filter((p) => p.verification === "issues");
  const failed = state.papers.filter((p) => p.parse_status && p.parse_status !== "ok");
  const unchecked = state.papers.length
    ? state.papers.every((p) => p.source_status === "unverified")
    : false;

  let flagged = 0;
  let flaggedDrafts = 0;
  for (const relpath of state.drafts) {
    const { claims } = await api(`/align/${relpath}` + projectQuery()).catch(() => ({ claims: [] }));
    const count = withSourceStatus(claims).filter(needsAttention).length;
    if (count) {
      flagged += count;
      flaggedDrafts += 1;
    }
  }

  const attention = [];
  if (retracted.length) {
    attention.push([
      "danger",
      "retracted",
      `${retracted.length} paper${retracted.length === 1 ? " is" : "s are"} retracted`,
      () => openPapers(),
    ]);
  }
  if (flagged) {
    attention.push([
      "caution",
      "score1",
      `${flagged} claim${flagged === 1 ? "" : "s"} across ${flaggedDrafts} draft${flaggedDrafts === 1 ? "" : "s"} need checking`,
      () => showReviewPanel(),
    ]);
  }
  if (issues.length) {
    attention.push([
      "caution",
      "unresolved",
      `${issues.length} paper${issues.length === 1 ? " has" : "s have"} references that do not resolve`,
      () => showReferencesPanel(),
    ]);
  }
  if (failed.length) {
    attention.push([
      "caution",
      "score1",
      `${failed.length} paper${failed.length === 1 ? "" : "s"} failed to parse`,
      () => openPapers(),
    ]);
  }
  if (unchecked) {
    attention.push([
      "neutral",
      "stale",
      "No paper has been checked against its record",
      () => openPapers(),
    ]);
  }

  const indexed = state.papers.filter((p) => (p.chunks ?? 0) > 0).length;

  host.replaceChildren(
    el("div", { class: "home home--project" }, [
      el("h1", { class: "home__title", text: state.projectName }),
      el("div", { class: "state-line" }, [
        el("span", { html: count(state.papers.length, "paper") }),
        el("span", { html: count(state.notes.length, "note") }),
        el("span", { html: count(state.drafts.length, "draft") }),
        indexed ? el("span", { html: `<b>${indexed}</b> indexed` }) : null,
      ]),
      attention.length
        ? el(
            "div",
            { class: "home__attention", style: "margin-top:var(--space-5)" },
            attention.map(([tone, icon, text, run]) =>
              el("button", { class: `attention attention--${tone}`, onclick: run }, [
                mark({ tone, icon, label: text }),
                el("span", { class: "attention__count", text }),
                el("span", { class: "attention__go", text: "→" }),
              ])
            )
          )
        : el("p", {
            class: "muted",
            style: "margin-top:var(--space-5)",
            text: "Nothing needs attention.",
          }),
    ])
  );
});

export function projectName(entry) {
  return entry.name || entry.path.replace(/[\/]+$/, "").split(/[\/]/).pop();
}

// One place defines what can be done to a project, so the row control and
// the right-click menu cannot drift apart.
export function projectActions(entry) {
  const name = projectName(entry);
  return [
    { name: "Open", run: () => nav.openProject(entry.path, name) },
    { name: "Rename…", run: () => renameProject(entry) },
    "-",
    { name: "Remove from this list", run: () => forgetProject(entry) },
    { name: "Delete from disk…", run: () => deleteProject(entry) },
  ];
}

function projectRow(entry) {
  const name = projectName(entry);
  const node = row({ onclick: () => nav.openProject(entry.path, name) }, [
    el("span", { class: "row__title", text: name }),
    el("span", { class: "row__meta mono", text: entry.path }),
    el("button", {
      class: "btn-quiet row__remove",
      text: "⋯",
      title: "Actions",
      onclick: (event) => {
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        openMenuAtPoint(box.left, box.bottom + 2, projectActions(entry), {
          onRun: (item) => item.run?.(),
        });
      },
    }),
  ]);
  return onContextMenu(node, () => projectActions(entry));
}

const renameProject = guard(async function renameProject(entry) {
  const name = await promptDialog({
    title: "Rename project",
    label: "Name",
    value: projectName(entry),
    confirmLabel: "Rename",
    body: "The folder keeps its name on disk. This is what Kiwi calls it.",
  });
  if (!name) return;
  await api("/projects/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, name }),
  });
  if (state.project === entry.path) {
    state.projectName = name;
    $("#project-name").textContent = name;
  }
  refreshHome();
  setStatus(undefined, `Renamed to ${name}`);
});

// Forgetting is not deleting. The row goes; every file stays.
const forgetProject = guard(async function forgetProject(entry) {
  await api("/projects", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, delete_files: false }),
  });
  if (state.project === entry.path) await nav.closeProject();
  refreshHome();
  setStatus(undefined, `Removed ${projectName(entry)} from the list`);
});

const deleteProject = guard(async function deleteProject(entry) {
  const confirmed = await confirmDialog({
    title: `Delete ${projectName(entry)} from disk?`,
    body: [
      entry.path,
      "Every paper, note, draft, and source PDF in that folder is removed.",
      "Nothing in Kiwi can undo this.",
    ],
    confirmLabel: "Delete everything",
  });
  if (!confirmed) return;
  await api("/projects", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, delete_files: true }),
  });
  if (state.project === entry.path) await nav.closeProject();
  refreshHome();
  setStatus(undefined, `Deleted ${projectName(entry)}`);
});

const createProject = guard(async function createProject(suggested) {
  const path = await promptDialog({
    title: "Create New Project",
    label: "Folder",
    value: suggested || "",
    confirmLabel: "Create",
    body: "A project is a folder. Naming it with a .kiwi suffix keeps it recognisable.",
  });
  if (path) await nav.openProject(path);
});

const openProjectDialog = guard(async function openProjectDialog(projects) {
  const known = projects || (await api("/projects")).projects;
  const chosen = await chooseDialog({
    title: "Go To Project",
    placeholder: "Filter projects, or type a path…",
    freeText: (typed) => `Open ${typed}`,
    options: known.map((p) => ({
      label: p.name || p.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop(),
      value: p.path,
    })),
  });
  if (chosen) await nav.openProject(chosen);
});

export { createProject, openProjectDialog };

/* --- Papers table ---------------------------------------------------------- */

const PAGE = 60;
let papersShown = PAGE;
let papersFilter = "";
let papersSort = { key: "title", dir: 1 };

export function openPapers() {
  centre.open({
    id: "papers",
    title: "Papers",
    icon: "paper",
    render: (host) => renderPapersTab(host),
    refresh: (host) => renderPapersTab(host),
  });
}

function renderPapersTab(host) {
  const filter = el("input", {
    class: "input",
    id: "papers-filter",
    type: "search",
    placeholder: "Filter by title or author…",
    value: papersFilter,
    oninput: (event) => {
      papersFilter = event.target.value;
      papersShown = PAGE;
      renderPaperRows();
    },
  });

  host.className = "tabbody tabbody--flush";
  host.replaceChildren(
    el("div", { class: "toolbar" }, [
      filter,
      el("div", { class: "toolbar-spacer" }),
      el("button", { class: "btn", text: "Import", onclick: () => $("#paper-file-input").click() }),
    ]),
    // The header scrolls with the rows rather than sitting beside them:
    // a list with a scrollbar is narrower than its own heading otherwise,
    // and every column below drifts by the width of the bar.
    el("div", { class: "rows", id: "papers-scroll", onscroll: onPapersScroll }, [
      el("div", { class: "rows-head" }, [
        el("span", { class: "col-status" }),
        el("button", { class: "col-title", text: "Title", onclick: () => sortPapers("title") }),
        el("button", { class: "col-author", text: "Author", onclick: () => sortPapers("author") }),
        el("button", { class: "col-num", text: "Year", onclick: () => sortPapers("year") }),
        el("button", { class: "col-num", text: "Sections", onclick: () => sortPapers("sections") }),
        el("button", { class: "col-num", text: "Refs", onclick: () => sortPapers("references") }),
        el("span", { class: "col-action" }),
      ]),
      el("div", { id: "papers-rows" }),
    ])
  );
  renderPaperRows();
}

function sortPapers(key) {
  papersSort = { key, dir: papersSort.key === key ? -papersSort.dir : 1 };
  renderPaperRows();
}

function onPapersScroll(event) {
  const box = event.target;
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 40) {
    if (papersShown < filteredPapers().length) {
      papersShown += PAGE;
      renderPaperRows();
    }
  }
}

function filteredPapers() {
  const needle = papersFilter.trim().toLowerCase();
  let rows = state.papers;
  if (needle) {
    rows = rows.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        authorNames(p.authors).toLowerCase().includes(needle)
    );
  }
  const { key, dir } = papersSort;
  return rows.slice().sort((a, b) => {
    const byStatus = paperRank(a) - paperRank(b);
    if (byStatus && (paperRank(a) === 0 || paperRank(b) === 0)) return byStatus;
    // Numbers sort as numbers; a paper with none sorts last either way.
    if (key === "year" || key === "sections" || key === "references") {
      const na = a[key];
      const nb = b[key];
      if (na == null && nb == null) return 0;
      if (na == null) return 1;
      if (nb == null) return -1;
      return (na - nb) * dir;
    }
    const va = key === "author" ? authorNames(a.authors) : a.title;
    const vb = key === "author" ? authorNames(b.authors) : b.title;
    return va.localeCompare(vb) * dir;
  });
}

function renderPaperRows() {
  const host = $("#papers-rows");
  if (!host) return;
  const rows = filteredPapers();

  if (!rows.length) {
    host.replaceChildren(
      papersFilter
        ? emptyState(
            "No matches",
            null,
            el("button", {
              class: "btn",
              text: "Clear filter",
              onclick: () => {
                papersFilter = "";
                openPapers();
                renderPapersTab(centre.find("papers").host);
              },
            })
          )
        : emptyState(
            "No papers yet",
            "Drop PDFs anywhere in this window, or import them.",
            el("button", {
              class: "btn btn--primary",
              text: "Import",
              onclick: () => $("#paper-file-input").click(),
            })
          )
    );
    return;
  }

  const visible = rows.slice(0, papersShown);
  host.replaceChildren(
    ...visible.map((paper) => {
      const signal = paperSignal(paper);
      return row({ onclick: () => openPaper(paper.document_id) }, [
        el("span", { class: "col-status" }, signal ? mark(signal, 14) : null),
        el("span", { class: "col-title", text: paper.title }),
        el("span", { class: "col-author", text: authorNames(paper.authors) }),
        el("span", { class: "col-num", text: paper.year ?? "" }),
        el("span", { class: "col-num", text: paper.sections ?? "" }),
        el("span", { class: "col-num", text: paper.references ?? "" }),
        el("span", { class: "col-action" }, removeControl("Delete", () => deletePaper(paper))),
      ]);
    }),
    visible.length < rows.length
      ? el("div", { class: "row muted", text: `${visible.length} of ${rows.length}` })
      : null
  );
}

// Deleting a paper reaches past the paper itself, so it takes a dialog
// that states what happens to the drafts citing it.
export const deletePaper = guard(async function deletePaper(paper) {
  const confirmed = await confirmDialog({
    title: `Delete ${paper.title}?`,
    body: [
      "Its parsed text, annotations, verification results, and chunks in the index go with it.",
      "Drafts citing it keep their prose. Their citations are reported as unresolved, and are not rewritten.",
      "The source PDF is removed from the project folder.",
    ],
  });
  if (!confirmed) return;

  const result = await api(`/papers/${paper.document_id}` + projectQuery({ actor: state.actor }), {
    method: "DELETE",
  });
  await centre.close(`paper:${paper.document_id}`);
  await nav.refresh();
  setStatus(undefined, `Deleted ${paper.title}`);
  if (result.citing_drafts?.length) {
    notice(`Still cited by: ${result.citing_drafts.join(", ")}`, {
      title: "Citations now unresolved",
    });
  }
});

/* --- Paper ----------------------------------------------------------------- */

// What the tab holds is the document. Its title, its authors, its
// references, and the notes taken on it are the right panel's, so the
// reading surface is the full width of the centre.
export const activePaper = {
  documentId: null,
  paper: null,
  verification: { results: [] },
  annotations: [],
  tabId: null,
};

export function openPaper(documentId, jumpTo = null) {
  const tab = centre.open({
    id: `paper:${documentId}`,
    title: paperTitle(documentId),
    tooltip: documentId,
    icon: "paper",
    render: (host, opened) => renderPaper(host, documentId, opened, jumpTo),
    refresh: (host, opened) => adoptPaper(host, documentId, opened),
    dispose: (closed) => {
      if (activePaper.tabId === closed.id) {
        activePaper.documentId = null;
        activePaper.paper = null;
        panelHandles.paperChanged?.();
      }
    },
  });
  if (jumpTo !== null && tab.rendered) scrollToSection(tab.host, jumpTo);
  return tab;
}

// Switching back to a paper already read does not fetch it again; it
// points the right panel at what this tab holds.
function adoptPaper(host, documentId, tab) {
  if (activePaper.tabId === tab.id && activePaper.paper) {
    panelHandles.paperChanged?.();
    return;
  }
  renderPaper(host, documentId, tab, null);
}

export const renderPaper = guard(async function renderPaper(host, documentId, tab, jumpTo) {
  const paper = await api(`/papers/${documentId}` + projectQuery());
  let verification = { results: [] };
  try {
    verification = await api(`/papers/${documentId}/verification` + projectQuery());
  } catch {
    /* never verified */
  }
  const { annotations } = await api(`/annotations/${documentId}` + projectQuery()).catch(() => ({
    annotations: [],
  }));

  activePaper.documentId = documentId;
  activePaper.paper = paper;
  activePaper.verification = verification;
  activePaper.annotations = annotations;
  activePaper.tabId = tab.id;

  drawPaperBody(host, documentId);
  panelHandles.paperChanged?.();
  if (jumpTo !== null && jumpTo !== undefined) scrollToSection(host, jumpTo);
});

// Reading it again after something about it changed: a verification, an
// annotation, a re-parse.
export function reloadPaper(documentId) {
  const tab = centre.find(`paper:${documentId}`);
  if (tab?.rendered) renderPaper(tab.host, documentId, tab, null);
}

export function paperMode() {
  return remembered("paper-mode", "pdf");
}

// The PDF is what the paper looks like; the parsed text is what Kiwi can
// anchor to. Selecting, citing, and annotating need the second, so the
// two are one press apart.
export function setPaperMode(mode) {
  remember("paper-mode", mode);
  const tab = activePaper.tabId ? centre.find(activePaper.tabId) : null;
  if (tab) drawPaperBody(tab.host, activePaper.documentId);
  panelHandles.paperChanged?.();
}

function drawPaperBody(host, documentId) {
  const mode = paperMode();
  host.className = "tabbody tabbody--flush";
  host.replaceChildren(
    el(
      "div",
      { class: `paper-source paper-source--${mode}`, id: "paper-source" },
      renderSource(activePaper.paper, documentId)
    ),
    el("div", { class: "floating selection-toolbar", hidden: true })
  );
  if (mode === "text") wireSelection(documentId, host);
}

function renderSource(paper, documentId) {
  if (paperMode() === "pdf") {
    return [
      el("iframe", {
        class: "paper-pdf",
        title: "Source PDF",
        src: `/papers/${documentId}/source.pdf` + projectQuery() + "#view=FitH",
      }),
    ];
  }
  const sections = paper.sections || [];
  if (!sections.length) {
    return [
      el("div", { class: "prose", html: annotatedHtml(paper.text, 0, paper.text.length) }),
    ];
  }
  return sections.map((section, i) =>
    el("section", { class: "paper-section", id: `section-${i}` }, [
      section.title ? el("h2", { class: "section-title", text: section.title }) : null,
      el("div", {
        class: "prose",
        html: annotatedHtml(paper.text, section.start, section.end),
      }),
    ])
  );
}

// Annotations carry offsets into the same normalised text the sections
// are sliced from, so a highlight taken earlier is visible where it was
// made rather than only in a list beside the paper.
function annotatedHtml(text, start, end) {
  const spans = activePaper.annotations
    .map((a) => a.target?.selector)
    .filter((s) => s && s.start < end && s.end > start)
    .sort((a, b) => a.start - b.start);

  let html = "";
  let at = start;
  for (const span of spans) {
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    // Overlapping annotations: the first one drawn holds the range.
    if (from < at || to <= from) continue;
    html += escapeHtml(text.slice(at, from));
    html += `<mark class="annot">${escapeHtml(text.slice(from, to))}</mark>`;
    at = to;
  }
  return html + escapeHtml(text.slice(at, end));
}

function scrollToSection(host, index) {
  $(`#section-${index}`, host)?.scrollIntoView({ block: "start" });
}

// The path from reading a paper to writing about it.
function wireSelection(documentId, host) {
  const source = $("#paper-source", host);
  const actions = $(".selection-toolbar", host);
  if (!source || !actions) return;

  const annotate = (exact, kind, body = "") =>
    guard(async () => {
      await api("/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.project,
          document_id: documentId,
          exact,
          kind,
          body,
          author: state.actor || "local",
        }),
      });
      actions.hidden = true;
      reloadPaper(documentId);
      setStatus(undefined, `${kind} saved`);
    });

  source.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    const exact = String(selection || "").trim();
    actions.hidden = exact.length < 4;
    if (actions.hidden) return;

    const box = selection.getRangeAt(0).getBoundingClientRect();
    actions.style.top = `${box.bottom + 6}px`;
    actions.style.left = `${box.left}px`;

    actions.replaceChildren(
      el("button", {
        class: "btn btn--primary",
        text: "Cite in draft",
        onclick: guard(async () => {
          if (!state.drafts.length) {
            notice("Create a draft first, then cite into it.");
            return;
          }
          const draft =
            state.drafts.length === 1
              ? state.drafts[0]
              : await chooseDialog({
                  title: "Cite into which draft?",
                  options: state.drafts.map((d) => ({ label: d, value: d })),
                });
          if (!draft) return;
          await api("/drafts/cite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project: state.project,
              draft,
              document_id: documentId,
              quoted: exact,
            }),
          });
          actions.hidden = true;
          setStatus(undefined, `Cited into ${draft}`);
          const open = centre.find(`draft:${draft}`);
          if (open) renderDraft(open.host, draft, open);
        }),
      }),
      el("button", { class: "btn", text: "Highlight", onclick: annotate(exact, "highlight") }),
      el("button", {
        class: "btn",
        text: "Note",
        onclick: guard(async () => {
          const body = await promptDialog({
            title: "Note on this passage",
            label: "Note",
            confirmLabel: "Save",
          });
          if (body) annotate(exact, "note", body)();
        }),
      }),
      el("button", {
        class: "btn",
        text: "Copy",
        onclick: () => {
          navigator.clipboard.writeText(exact);
          actions.hidden = true;
          setStatus(undefined, "Passage copied");
        },
      })
    );
  });

  source.addEventListener("scroll", () => (actions.hidden = true), { passive: true });
}

// Every open paper carries its own toolbar, so this dismisses whichever
// one is showing rather than a single element by id.
document.addEventListener("mousedown", (event) => {
  for (const actions of $$(".selection-toolbar")) {
    if (actions.hidden) continue;
    if (!actions.contains(event.target) && !event.target.closest(".paper-source")) {
      actions.hidden = true;
    }
  }
});

/* --- Note ------------------------------------------------------------------ */

export function openNote(relpath) {
  return centre.open({
    id: `note:${relpath}`,
    title: relpath.split("/").pop(),
    tooltip: relpath,
    icon: "note",
    render: (host, tab) => renderNote(host, relpath, tab),
    dispose: (tab) => forgetEditable(tab.id),
  });
}

// A note is written on the same surface a draft is, so a citation reads
// as a citation here too. What a note does not get is a score: it is
// where reading is recorded, not where claims are made.
const renderNote = guard(async function renderNote(host, relpath, tab) {
  const note = await api(`/notes/${relpath}` + projectQuery());
  let visibility = note.visibility;

  const editor = proseEditor({
    id: "note-editor",
    value: note.content || "",
    labelFor: (documentId) => citationOf(documentId),
    onChange: () => touch(tab.id),
  });

  registerEditable(tab.id, {
    read: () => editor.get(),
    write: (content) =>
      api(`/notes/${relpath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.project,
          content,
          visibility,
          author: state.actor,
        }),
      }),
  });

  // Visibility is the whole of what makes a note different from a draft,
  // so it is a stated choice rather than a button whose label is its
  // current value.
  const setVisibility = guard(async (next) => {
    if (next === visibility) return;
    visibility = next;
    await api(`/notes/${relpath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.project,
        content: editor.get(),
        visibility,
        author: state.actor,
      }),
    });
    renderNote(host, relpath, tab);
  });

  const shared = visibility === "shared";
  host.className = "tabbody tabbody--flush";
  host.replaceChildren(
    el("div", { class: "toolbar" }, [
      el("div", { class: "segmented", id: "note-visibility" }, [
        el("button", {
          class: `segmented__item${shared ? "" : " active"}`,
          text: "Private",
          onclick: () => setVisibility("private"),
        }),
        el("button", {
          class: `segmented__item${shared ? " active" : ""}`,
          text: "Shared",
          onclick: () => setVisibility("shared"),
        }),
      ]),
      el("span", {
        class: "muted small",
        text: shared
          ? "Everyone with this project can read this note."
          : "Not visible to anyone, including the project owner.",
      }),
      el("span", { class: "toolbar-spacer" }),
      note.author ? el("span", { class: "muted small", text: `by ${note.author}` }) : null,
      el("span", { class: "muted small", html: 'Save <span class="kbd">Ctrl+S</span>' }),
    ]),
    el("div", { class: "draft-body" }, [
      el("div", { class: "editor-scroll" }, [el("div", { class: "editor-hold" }, editor.root)]),
    ])
  );
});

/* --- Draft ----------------------------------------------------------------- */

// The centre holds the prose and its gutter. The claims live in the AI
// panel, which reads this.
export const activeDraft = {
  relpath: null,
  editor: null,
  claims: [],
  suggestions: [],
  current: 0,
  tabId: null,
};

export function openDraft(relpath) {
  return centre.open({
    id: `draft:${relpath}`,
    title: relpath.split("/").pop(),
    tooltip: relpath,
    icon: "draft",
    render: (host, tab) => renderDraft(host, relpath, tab),
    refresh: (host, tab) => adoptDraft(relpath, tab),
    dispose: (tab) => {
      forgetEditable(tab.id);
      if (activeDraft.tabId === tab.id) activeDraft.relpath = null;
    },
  });
}

function adoptDraft(relpath, tab) {
  if (activeDraft.tabId === tab.id) {
    nav.aiRefresh?.();
    return;
  }
  renderDraft(tab.host, relpath, tab);
}

const renderDraft = guard(async function renderDraft(host, relpath, tab) {
  const page = await api(`/drafts/${relpath}` + projectQuery());
  const [{ claims }, { suggestions }] = await Promise.all([
    api(`/align/${relpath}` + projectQuery()).catch(() => ({ claims: [] })),
    api(`/suggestions/${relpath}` + projectQuery({ state: "pending" })).catch(() => ({
      suggestions: [],
    })),
  ]);

  const editor = proseEditor({
    id: "draft-editor",
    value: page.content || "",
    labelFor: (documentId) => citationOf(documentId),
    onChange: () => {
      touch(tab.id);
      scheduleGutter();
    },
    onCaret: (line) => selectClaimAtLine(line),
  });

  activeDraft.relpath = relpath;
  activeDraft.tabId = tab.id;
  activeDraft.editor = editor;
  activeDraft.claims = withSourceStatus(claims);
  activeDraft.suggestions = suggestions || [];
  activeDraft.current = Math.max(activeDraft.claims.findIndex(needsAttention), 0);

  registerEditable(tab.id, {
    read: () => editor.get(),
    write: (content) =>
      api(`/drafts/${relpath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, content }),
      }),
  });

  host.className = "tabbody tabbody--flush";
  host.replaceChildren(
    el("div", { class: "toolbar" }, [
      el("button", {
        class: "btn btn--primary",
        id: "score-btn",
        text: "Score claims",
        onclick: guard(() => scoreDraft(relpath)),
      }),
      el("button", {
        class: "btn",
        text: "Suggest revisions",
        onclick: guard(() => suggestRevisions(relpath)),
      }),
      el("span", { class: "muted small", id: "draft-count" }),
      el("span", { class: "toolbar-spacer" }),
      el("span", {
        class: "muted small",
        html: 'Next flagged <span class="kbd">Alt+↓</span> <span class="kbd">Alt+↑</span>',
      }),
    ]),
    el("div", { class: "draft-body" }, [
      el("div", { class: "editor-scroll", id: "draft-scroll" }, [
        el("div", { class: "gutter", id: "draft-gutter" }),
        // The marks are drawn behind the text rather than into it. A
        // decorated sentence would mean rewriting the line, which costs
        // the browser's own undo and turns prose into a widget.
        //
        // They share this box with the editor so that a rect measured
        // against the editor's own top-left can be used unchanged. The
        // scroller is not that box: it carries the gutter and its own
        // padding.
        el("div", { class: "editor-hold", id: "draft-hold" }, [
          el("div", { class: "sentence-marks", id: "draft-marks" }),
          editor.root,
        ]),
      ]),
      el("div", { class: "strip", id: "draft-strip", title: "Every claim in the draft" }),
    ])
  );

  wireSentenceHover(host);
  updateCount();
  renderGutter();
  nav.aiRefresh?.();
});

// Every open draft has a tab body carrying the same element ids, so a
// document-wide lookup finds the first one opened rather than the one
// being edited. Everything here reads through the active draft's own
// host.
function draftHost() {
  const tab = activeDraft.tabId ? centre.find(activeDraft.tabId) : null;
  return tab ? tab.host : null;
}

function updateCount() {
  const scope = draftHost();
  const host = scope ? $("#draft-count", scope) : null;
  if (!host) return;
  const flagged = activeDraft.claims.filter(needsAttention).length;
  host.textContent = activeDraft.claims.length
    ? `${flagged} of ${activeDraft.claims.length} need attention`
    : "not scored";
}

// Where each claim's sentence sits in the source as it stands now. A
// claim records the offset it was scored at; the draft may have been
// edited since, so that offset is trusted only while the text still
// matches, and the sentence is searched for otherwise.
export function claimRanges() {
  const source = activeDraft.editor ? activeDraft.editor.get() : "";
  return activeDraft.claims.map((claim) => {
    const exact = claim.anchor.exact;
    if (!exact) return null;
    const recorded = claim.anchor.start;
    let at = -1;
    if (typeof recorded === "number" && source.slice(recorded, recorded + exact.length) === exact) {
      at = recorded;
    } else {
      at = source.indexOf(exact);
    }
    return at < 0 ? null : { start: at, end: at + exact.length };
  });
}

export function claimLines() {
  const source = activeDraft.editor ? activeDraft.editor.get() : "";
  return activeDraft.claims.map((claim) =>
    lineIndexOf(source, claim.anchor.exact, claim.anchor.start)
  );
}

let gutterPending = false;

function scheduleGutter() {
  if (gutterPending) return;
  gutterPending = true;
  requestAnimationFrame(() => {
    gutterPending = false;
    renderGutter();
  });
}

// A signal the author can act on. Neutral marks report a condition and
// carry no action, and a paragraph wearing one over every other sentence
// says nothing at all.
function actionable(signal) {
  return signal !== null && signal.tone !== "neutral";
}

// What the gutter marks: the verdict on the sentence, never a note about
// the record behind it.
function gutterSignal(claim) {
  return verdictOf(claimSignals(claim));
}

export function renderGutter() {
  const scope = draftHost();
  const gutter = scope ? $("#draft-gutter", scope) : null;
  const strip = scope ? $("#draft-strip", scope) : null;
  const marks = scope ? $("#draft-marks", scope) : null;
  if (!gutter || !activeDraft.editor) return;

  const ranges = claimRanges();
  const height = activeDraft.editor.height() || 1;

  // Sentence geometry, measured once and shared by all three surfaces.
  const boxes = activeDraft.claims.map((claim, index) => {
    const range = ranges[index];
    if (!range) return null;
    const rects = activeDraft.editor.rectsFor(range.start, range.end);
    return rects.length ? rects : null;
  });

  gutter.replaceChildren(
    ...activeDraft.claims
      .map((claim, index) => {
        const signal = gutterSignal(claim);
        if (!actionable(signal) || !boxes[index]) return null;
        const holder = el("button", {
          class: `gutter__mark${index === activeDraft.current ? " active" : ""}`,
          title: signal.label,
          onclick: () => selectClaim(index),
        });
        holder.style.top = `${boxes[index][0].top}px`;
        holder.append(mark(signal, 14));
        return holder;
      })
      .filter(Boolean)
  );

  // The underline is the whole of the permanent decoration: enough to
  // find a flagged sentence, not enough to stop it reading as prose.
  if (marks) {
    const drawn = [];
    activeDraft.claims.forEach((claim, index) => {
      const signal = gutterSignal(claim);
      const rects = boxes[index];
      if (!rects) return;
      const current = index === activeDraft.current;
      if (!actionable(signal) && !current) return;
      for (const rect of rects) {
        const tone = signal ? signal.tone : "supported";
        const node = el("div", {
          class: `sentence-mark sentence-mark--${tone}${current ? " current" : ""}`,
        });
        node.style.cssText =
          `top:${rect.top}px;left:${rect.left}px;` +
          `width:${rect.width}px;height:${rect.height}px`;
        drawn.push(node);
      }
    });
    marks.replaceChildren(...drawn);
  }

  if (!strip) return;
  strip.replaceChildren(
    ...activeDraft.claims
      .map((claim, index) => {
        const signal = gutterSignal(claim);
        if (!boxes[index] || !actionable(signal)) return null;
        const tick = el("button", {
          class: `strip__tick strip__tick--${signal.tone}`,
          title: signal.label,
          onclick: () => selectClaim(index),
        });
        tick.style.top = `${(boxes[index][0].top / height) * 100}%`;
        return tick;
      })
      .filter(Boolean)
  );
}

/* --- Hovering a sentence --------------------------------------------------- */

// Reading the draft has to stay reading. What is known about a sentence
// appears when the pointer is on it and goes when it leaves, so the page
// is prose until it is asked a question.
let hoveredClaim = -1;

function wireSentenceHover(host) {
  const scroll = $("#draft-scroll", host);
  const marks = $("#draft-marks", host);
  const hold = $("#draft-hold", host);
  if (!scroll || !marks || !hold) return;

  const clear = () => {
    if (hoveredClaim < 0) return;
    hoveredClaim = -1;
    $$(".sentence-mark--hover", marks).forEach((node) => node.remove());
    closeSentenceCard();
  };

  scroll.addEventListener("mousemove", (event) => {
    if (!activeDraft.editor || !activeDraft.claims.length) return;
    const offset = activeDraft.editor.offsetAt(event.clientX, event.clientY);
    if (offset === null) return clear();

    const ranges = claimRanges();
    const index = ranges.findIndex((r) => r && offset >= r.start && offset <= r.end);
    if (index === hoveredClaim) return;
    clear();
    if (index < 0) return;

    hoveredClaim = index;
    const rects = activeDraft.editor.rectsFor(ranges[index].start, ranges[index].end);
    for (const rect of rects) {
      const node = el("div", { class: "sentence-mark sentence-mark--hover" });
      node.style.cssText =
        `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;
      marks.append(node);
    }
    if (rects.length) openSentenceCard(index, rects[rects.length - 1], hold, scroll);
  });

  scroll.addEventListener("mouseleave", clear);
  scroll.addEventListener("scroll", clear, { passive: true });
}

function closeSentenceCard() {
  $("#sentence-card")?.remove();
}

// Small, and only what cannot be inferred from the sentence itself. The
// full evidence stays in the panel, one press away.
function openSentenceCard(index, rect, hold, scroll) {
  closeSentenceCard();
  const claim = activeDraft.claims[index];
  if (!claim) return;

  const signals = claimSignals(claim);
  const verdict = verdictOf(signals);
  const notes = notesOf(signals);
  const alignment = claim.deep_alignment || claim.alignment || null;
  const scale = claim.intent === "attribution" ? 1 : 2;

  // The mark repeats the verdict beside it, so it is decoration here and
  // is kept out of the accessibility tree rather than read out twice.
  const glyph = verdict ? mark(verdict, 14) : null;
  glyph?.setAttribute("aria-hidden", "true");

  const card = el("div", { class: "sentence-card", id: "sentence-card" }, [
    el("div", { class: "sentence-card__head" }, [
      glyph,
      el("span", {
        class: "sentence-card__verdict",
        text: verdictLabel(claim, Boolean(alignment)),
      }),
    ]),
    el("div", { class: "sentence-card__source small muted", text: citationOf(claim.citation) }),
    alignment
      ? el("div", { class: "sentence-card__score small muted" }, [
          el("span", { text: `${claim.intent} ${alignment.score}/${scale}` }),
          el("span", { class: "kbd", text: "click to open" }),
        ])
      : el("div", { class: "sentence-card__score small muted", text: "not scored" }),
    // Conditions around the claim, said after the verdict rather than
    // instead of it.
    notes.length
      ? el("div", {
          class: "sentence-card__note small faint",
          text: notes.map((n) => n.label).join(". "),
        })
      : null,
  ]);

  card.addEventListener("mousedown", (event) => {
    event.preventDefault();
    selectClaim(index, { focusText: false });
  });

  hold.append(card);
  // Placed under the sentence, lifted above it when that would run off
  // the bottom of what is on screen.
  const below = rect.top + rect.height + 6;
  const visibleBottom = scroll.scrollTop + scroll.clientHeight - hold.offsetTop;
  card.style.left = `${Math.max(0, Math.min(rect.left, hold.clientWidth - card.offsetWidth))}px`;
  card.style.top =
    below + card.offsetHeight > visibleBottom
      ? `${Math.max(0, rect.top - card.offsetHeight - 6)}px`
      : `${below}px`;
}

export function selectClaim(index, { focusText = true } = {}) {
  if (!activeDraft.claims.length) return;
  activeDraft.current = Math.min(Math.max(index, 0), activeDraft.claims.length - 1);
  renderGutter();
  // Choosing a claim is a request to see it, so the panel goes to where
  // the claim is rather than leaving the reader to find the tab.
  toggleRight(true);
  panelHandles.showClaims?.();
  nav.aiRefresh?.();
  if (focusText) {
    const line = claimLines()[activeDraft.current];
    if (line >= 0) activeDraft.editor.focusLine(line);
  }
}

function selectClaimAtLine(line) {
  const index = claimLines().indexOf(line);
  if (index < 0 || index === activeDraft.current) return;
  activeDraft.current = index;
  renderGutter();
  nav.aiRefresh?.();
}

export function moveClaim(delta, includeSupported = false) {
  if (!activeDraft.claims.length) return;
  const eligible = activeDraft.claims
    .map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => includeSupported || needsAttention(claim));
  if (!eligible.length) return;

  const forward = delta > 0;
  const after = eligible.filter(({ index }) =>
    forward ? index > activeDraft.current : index < activeDraft.current
  );
  const next = after.length
    ? forward
      ? after[0]
      : after[after.length - 1]
    : eligible[forward ? 0 : eligible.length - 1];
  selectClaim(next.index);
}

export function openCurrentSource() {
  const claim = activeDraft.claims[activeDraft.current];
  if (claim) openPaper(claim.citation);
}

export function editCurrentSentence() {
  const line = claimLines()[activeDraft.current];
  if (line >= 0) activeDraft.editor.focusLine(line);
}

export const changeCurrentCitation = guard(async function changeCurrentCitation() {
  const claim = activeDraft.claims[activeDraft.current];
  if (!claim) return;
  const chosen = await chooseDialog({
    title: "Cite which paper?",
    options: state.papers.map((p) => ({ label: p.title, value: p.document_id })),
  });
  if (!chosen || chosen === claim.citation) return;

  const source = activeDraft.editor.get();
  const at = source.indexOf(claim.anchor.exact);
  if (at < 0) {
    notice("This sentence has changed since it was scored. Score the draft again.");
    return;
  }
  const replaced = claim.anchor.exact.replace(`[@${claim.citation}]`, `[@${chosen}]`);
  activeDraft.editor.set(
    source.slice(0, at) + replaced + source.slice(at + claim.anchor.exact.length)
  );
  await saveTab(activeDraft.tabId);
  setStatus(undefined, "Citation changed. Score the draft to check it.");
  renderGutter();
});

// The workspace records judgements, not checkmarks, so checking a claim is
// recorded as the acting person resolving it.
export const markChecked = guard(async function markChecked() {
  const claim = activeDraft.claims[activeDraft.current];
  if (!claim) return;
  await api("/review/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: state.project,
      draft: activeDraft.relpath,
      claim: claim.anchor.exact,
      citation: claim.citation,
      decision: "resolved",
      reviewer: state.actor || "local",
    }),
  });
  setStatus(undefined, "Marked checked");
  moveClaim(1);
});

export const resolveSuggestion = guard(async function resolveSuggestion(suggestion, action) {
  await api(`/suggestions/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: state.project,
      draft: activeDraft.relpath,
      suggestion_id: suggestion.suggestion_id,
    }),
  });
  const tab = centre.find(activeDraft.tabId);
  if (tab) renderDraft(tab.host, activeDraft.relpath, tab);
});

export const suggestRevisions = guard(async function suggestRevisions(relpath) {
  // Proposing wording needs a Generator. Without one the route returns
  // an empty list, which from the outside looks exactly like a button
  // that does nothing.
  const generator = await api("/health/generator").catch(() => ({ ok: false, detail: "" }));
  if (!generator.ok) {
    notice(generator.detail, { title: "No generator configured" });
    return;
  }

  progress("Proposing revisions");
  try {
    const { suggestions } = await api("/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.project, draft: relpath }),
    });
    activeDraft.suggestions = suggestions || [];
    nav.aiRefresh?.();
    toggleRight(true);
    panelHandles.showRevisions?.();
    const flagged = activeDraft.claims.filter((c) => (c.alignment?.score ?? 2) === 0).length;
    setStatus(
      undefined,
      activeDraft.suggestions.length
        ? `${activeDraft.suggestions.length} revision(s) proposed`
        : flagged
          ? "No revision could be proposed for the flagged claims"
          : "Nothing to revise: no claim is contradicted by its source"
    );
  } finally {
    progress(null);
  }
});

export const scoreDraft = guard(async function scoreDraft(relpath) {
  progress("Scoring claims");
  try {
    const { claims } = await api("/align", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.project, draft: relpath, depth: "quick" }),
    });
    activeDraft.claims = withSourceStatus(claims);
    activeDraft.current = Math.max(activeDraft.claims.findIndex(needsAttention), 0);
    updateCount();
    renderGutter();
    toggleRight(true);
    panelHandles.showClaims?.();
    nav.aiRefresh?.();
    renderLeft();
    const flagged = activeDraft.claims.filter(needsAttention).length;
    setStatus(undefined, `Scoring complete, ${flagged} need attention`);
  } finally {
    progress(null);
  }
});

/* --- Drafts and notes: creation and removal -------------------------------- */

// A folder is a prefix on the path, so creating inside one is the same
// call with the prefix already filled in.
function within(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

function ensureSuffix(name) {
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
}

// Creating writes an empty file, so a name that is already taken would
// replace what is in it. The comparison ignores case: on Windows a new
// `abstract.md` opens the existing `Abstract.md` and writes over it,
// which the file listing gives no warning of.
function taken(existing, relpath) {
  const wanted = relpath.toLowerCase();
  return existing.find((path) => path.toLowerCase() === wanted) || null;
}

export const createNote = guard(async function createNote(folder = "") {
  const name = await promptDialog({
    title: "New note",
    label: "File name",
    value: "reading-log.md",
    body: folder ? `In ${folder}` : null,
  });
  if (!name) return;
  const relpath = within(folder, ensureSuffix(name));
  const clash = taken(state.notes, relpath);
  if (clash) {
    openNote(clash);
    setStatus(undefined, `${clash} already exists`);
    return;
  }
  await api(`/notes/${relpath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: state.project,
      content: "",
      visibility: "private",
      author: state.actor,
    }),
  });
  await nav.refresh();
  openNote(relpath);
});

export const createDraft = guard(async function createDraft(folder = "") {
  const name = await promptDialog({
    title: "New draft",
    label: "File name",
    value: "chapter.md",
    body: folder ? `In ${folder}` : null,
  });
  if (!name) return;
  const relpath = within(folder, ensureSuffix(name));
  const clash = taken(state.drafts, relpath);
  if (clash) {
    openDraft(clash);
    setStatus(undefined, `${clash} already exists`);
    return;
  }
  await api(`/drafts/${relpath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, content: "" }),
  });
  await nav.refresh();
  openDraft(relpath);
});

export const createFolder = guard(async function createFolder(kind, parent = "") {
  const name = await promptDialog({
    title: "New folder",
    label: "Folder name",
    value: "",
    body: parent ? `In ${parent}` : null,
  });
  if (!name) return;
  const relpath = within(parent, name);
  await api("/pages/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, kind, relpath }),
  });
  await nav.refresh();
  setStatus(undefined, `Created ${relpath}`);
});

// Only an empty folder is removed here. Deleting a note is checked
// against who may edit it, and emptying a folder from this side would
// step around that check.
export const deleteFolder = guard(async function deleteFolder(kind, relpath) {
  const confirmed = await confirmDialog({
    title: `Delete the folder ${relpath}?`,
    body: ["A folder holding notes or drafts is refused. Delete what is in it first."],
  });
  if (!confirmed) return;
  await api("/pages/folder", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, kind, relpath }),
  });
  await nav.refresh();
  setStatus(undefined, `Deleted ${relpath}`);
});

// Uploading a page is reading the file here and writing it through the
// same route the editor saves with, so an imported file is indistinguish-
// able from one made in Kiwi.
export const uploadPages = guard(async function uploadPages(kind, folder, files) {
  const written = [];
  for (const file of files) {
    const relpath = within(folder, ensureSuffix(file.name));
    const content = await file.text();
    // Written out per kind rather than built from it, so the path this
    // requests is readable as a path.
    const request = { method: "PUT", headers: { "Content-Type": "application/json" } };
    if (kind === "notes") {
      const body = JSON.stringify({ project: state.project, content, visibility: "private" });
      await api(`/notes/${relpath}`, { ...request, body });
    } else {
      const body = JSON.stringify({ project: state.project, content });
      await api(`/drafts/${relpath}`, { ...request, body });
    }
    written.push(relpath);
  }
  await nav.refresh();
  if (written.length === 1) {
    if (kind === "notes") openNote(written[0]);
    else openDraft(written[0]);
  }
  setStatus(undefined, `${written.length} file(s) added`);
});

export const verifyPaper = guard(async function verifyPaper(documentId) {
  progress("Resolving references");
  try {
    await api("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.project, document_id: documentId }),
    });
  } finally {
    progress(null);
  }
  await nav.refresh();
  reloadPaper(documentId);
  setStatus(undefined, "References verified");
});

// Renaming a draft moves the record of judging it, which is why this goes
// through the API rather than a write followed by a delete.
export const renamePage = guard(async function renamePage(kind, relpath) {
  const name = await promptDialog({
    title: `Rename ${kind === "drafts" ? "draft" : "note"}`,
    label: "File name",
    value: relpath,
    confirmLabel: "Rename",
  });
  if (!name || name === relpath) return;
  await api("/pages/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, kind, relpath, name }),
  });
  const prefix = kind === "drafts" ? "draft" : "note";
  await centre.close(`${prefix}:${relpath}`);
  await nav.refresh();
  if (kind === "drafts") openDraft(name);
  else openNote(name);
  setStatus(undefined, `Renamed to ${name}`);
});

export function deleteNote(relpath, button) {
  const remove = guard(async () => {
    await api(`/notes/${relpath}` + projectQuery({ actor: state.actor }), { method: "DELETE" });
    await centre.close(`note:${relpath}`);
    await nav.refresh();
    setStatus(undefined, `Deleted ${relpath}`);
  });
  // From a row the control confirms in place. From a menu there is no
  // control to change, so it asks.
  if (!button) {
    confirmDialog({
      title: `Delete ${relpath}?`,
      body: ["A note owns nothing else. Only the file goes."],
    }).then((yes) => yes && remove());
    return;
  }
  confirmInline(
    button,
    guard(async () => {
      await api(`/notes/${relpath}` + projectQuery({ actor: state.actor }), { method: "DELETE" });
      await centre.close(`note:${relpath}`);
      await nav.refresh();
      setStatus(undefined, `Deleted ${relpath}`);
    })
  );
}

export const deleteDraft = guard(async function deleteDraft(relpath) {
  const confirmed = await confirmDialog({
    title: `Delete ${relpath}?`,
    body: [
      "Its scored claims, the suggestions raised against it, and the review decisions recorded on it go with it.",
    ],
  });
  if (!confirmed) return;
  await api(`/drafts/${relpath}` + projectQuery({ actor: state.actor }), { method: "DELETE" });
  await centre.close(`draft:${relpath}`);
  await nav.refresh();
  setStatus(undefined, `Deleted ${relpath}`);
});

/* --- Settings tabs --------------------------------------------------------- */

export function openProjectSettings() {
  centre.open({
    id: "project-settings",
    title: "Project Settings",
    icon: "gear",
    render: (host) => renderProjectSettings(host),
    refresh: (host) => renderProjectSettings(host),
  });
}

const renderProjectSettings = guard(async function renderProjectSettings(host) {
  if (!state.project) {
    host.replaceChildren(emptyState("No project open", "Open a project to see its settings.", null));
    return;
  }
  const settings = await api("/projects/settings" + projectQuery());
  const health = await api("/health").catch(() => ({}));
  const ingestor = await api("/health/ingestor").catch(() => ({ ok: false, detail: "unknown" }));

  host.className = "tabbody";
  host.replaceChildren(
    el("h1", { class: "view-title", text: state.projectName }),
    el("div", { class: "state-line" }, [el("span", { class: "mono", text: state.project })]),

    el("h2", { class: "section-title", text: "Components" }),
    el(
      "table",
      {},
      el("tbody", {}, [
        el("tr", {}, [
          el("td", { text: "Ingestor" }),
          el("td", { class: "muted", text: ingestor.ok ? "GROBID reachable" : ingestor.detail }),
        ]),
        el("tr", {}, [
          el("td", { text: "Version" }),
          el("td", { class: "mono muted", text: health.version || "" }),
        ]),
      ])
    ),

    el("h2", { class: "section-title", text: "Roles" }),
    el(
      "table",
      {},
      el(
        "tbody",
        {},
        settings.roles.map((r) =>
          el("tr", {}, [
            el("td", { text: r.name }),
            el("td", { class: "muted", style: "width:8ch", text: r.rank }),
            el("td", {
              class: "muted",
              style: "width:14ch",
              text: `${r.permissions.length} permissions`,
            }),
          ])
        )
      )
    ),

    el("h2", { class: "section-title", text: "Members" }),
    settings.members.length
      ? el(
          "table",
          {},
          el(
            "tbody",
            {},
            settings.members.map((m) =>
              el("tr", {}, [el("td", { text: m.name }), el("td", { class: "muted", text: m.role })])
            )
          )
        )
      : el("p", { class: "muted", text: "No members yet." }),

    el("h2", { class: "section-title", text: "Index" }),
    el("div", { class: "rowline" }, [
      el("button", {
        class: "btn",
        text: "Rebuild index",
        onclick: guard(async () => {
          progress("Indexing");
          try {
            await api("/index", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project: state.project }),
            });
          } finally {
            progress(null);
          }
          setStatus(undefined, "Index rebuilt");
        }),
      }),
    ])
  );
});

export function openUserSettings() {
  centre.open({
    id: "user-settings",
    title: "User Settings",
    icon: "person",
    render: (host) => renderUserSettings(host),
    refresh: (host) => renderUserSettings(host),
  });
}

function renderUserSettings(host) {
  const actor = el("input", {
    class: "input",
    id: "actor-input",
    type: "text",
    value: state.actor,
    placeholder: "your name",
    onchange: (event) => {
      state.actor = event.target.value.trim();
      localStorage.setItem("kiwi-actor", state.actor);
      setStatus(undefined, state.actor ? `Acting as ${state.actor}` : "");
    },
  });

  host.className = "tabbody";
  host.replaceChildren(
    el("h1", { class: "view-title", text: "User Settings" }),

    el("h2", { class: "section-title", text: "Appearance" }),
    el("div", { class: "rowline" }, [
      el("span", { class: "muted", style: "width:10ch", text: "Theme" }),
      ...["light", "dark", "system"].map((mode) =>
        el("button", { class: "btn", text: mode, onclick: () => nav.setTheme(mode) })
      ),
    ]),
    el("div", { class: "rowline", style: "margin-top:var(--space-2)" }, [
      el("span", { class: "muted", style: "width:10ch", text: "Density" }),
      ...["compact", "comfortable"].map((mode) =>
        el("button", { class: "btn", text: mode, onclick: () => nav.setDensity(mode) })
      ),
    ]),

    el("h2", { class: "section-title", text: "Acting as" }),
    el("p", {
      class: "muted small",
      text: "Review decisions and annotations are recorded against this name.",
    }),
    actor,

    el("h2", { class: "section-title", text: "Measured" }),
    el("p", { class: "muted small", text: "What Kiwi's own evaluation reports." }),
    el("pre", { class: "evidence", style: "white-space:pre-wrap", text: MEASURED })
  );
}

const MEASURED = `Evidence alignment    0.860 accuracy · 0.015 false endorsement
                      1259 expert-annotated pairs (SciFact)
Attribution           0.078 false attribution · 0.534 recall
Retrieval             Recall@1 0.824 held-out with reranking
                                0.559 without
Generated answers     0.625 of asserted content supported
                      0.000 contradicted · about a third uncited
Anchors               0.941 of quotes relocate across a parser change`;

/* --- Process record -------------------------------------------------------- */

export const showProcessRecord = guard(async function showProcessRecord(relpath) {
  const record = await api(`/process-record/${relpath}` + projectQuery({ actor: state.actor }));
  const section = (title, rows) =>
    rows.length
      ? [el("h2", { class: "section-title", text: title }), el("table", {}, el("tbody", {}, rows))]
      : [];

  await openDialog((panel, finish) => {
    panel.classList.add("dialog--wide");
    panel.append(
      el("h2", { text: `Process record: ${relpath}` }),
      ...section(
        "Decisions",
        record.decisions.map((d) =>
          el("tr", {}, [
            el("td", { text: d.claim }),
            el("td", { style: "width:16ch", text: d.decision.replace("_", " ") }),
            el("td", { style: "width:12ch", class: "muted", text: d.reviewer }),
            el("td", {
              style: "width:12ch",
              class: "mono small muted",
              text: (d.recorded || "").slice(0, 10),
            }),
          ])
        )
      ),
      ...section(
        "Accepted suggestions",
        record.accepted.map((s) => el("tr", {}, [el("td", { text: s.proposed })]))
      ),
      ...section(
        "Declined suggestions",
        record.rejected.map((s) => el("tr", {}, [el("td", { text: s.proposed })]))
      ),
      record.decisions.length || record.accepted.length || record.rejected.length
        ? null
        : el("p", { class: "muted", text: "Nothing has been proposed or decided on this draft." }),
      el("div", { class: "dialog__actions" }, [
        el("button", { class: "btn btn--primary", text: "Close", onclick: () => finish(null) }),
      ])
    );
  });
});

/* --- Left panel handles ---------------------------------------------------- */

// Defined in panels.js and wired at boot; declared here so the home view
// can send a reader to them.
export const panelHandles = {
  review: null,
  references: null,
  paperChanged: null,
  showClaims: null,
  showRevisions: null,
};

function showReviewPanel() {
  panelHandles.review?.();
}

function showReferencesPanel() {
  panelHandles.references?.();
}

export { iconEl };
