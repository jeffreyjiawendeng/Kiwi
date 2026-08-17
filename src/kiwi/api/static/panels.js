// The left panel and the right panel.
//
// The left panel holds one project view at a time, chosen from the
// activity bar. The right panel holds what the models say: an answer, the
// claims in the open draft, and the revisions proposed for it.

import { $, api, el, escapeHtml, guard, notice, progress, projectQuery, setStatus, state } from "./core.js";
import { fromClaim, inspector, signalsOf } from "./inspector.js";
import { confirmInline, promptDialog } from "./keyboard.js";
import {
  compareReferenceStatus,
  mark,
  needsAttention,
  paperSignal,
  referenceSignal,
} from "./signals.js";
import {
  ai,
  centre,
  iconEl,
  onContextMenu,
  openMenuAtPoint,
  registerLeft,
  renderLeft,
  showLeft,
  toggleRight,
} from "./shell.js";
import {
  activeDraft,
  activePaper,
  authorNames,
  citationOf,
  createDraft,
  createFolder,
  createNote,
  deleteDraft,
  deleteFolder,
  deleteNote,
  deletePaper,
  emptyState,
  markChecked,
  moveClaim,
  openCurrentSource,
  openDraft,
  openNote,
  openPaper,
  openPapers,
  panelHandles,
  paperMode,
  paperTitle,
  referenceOf,
  reloadPaper,
  renamePage,
  resolveSuggestion,
  scoreDraft,
  selectClaim,
  setPaperMode,
  showProcessRecord,
  uploadPages,
  verifyPaper,
  withSourceStatus,
} from "./views.js";

/* --- Explorer -------------------------------------------------------------- */

const collapsed = new Set(JSON.parse(localStorage.getItem("kiwi-tree-collapsed") || "[]"));

function toggleGroup(name) {
  if (collapsed.has(name)) collapsed.delete(name);
  else collapsed.add(name);
  localStorage.setItem("kiwi-tree-collapsed", JSON.stringify([...collapsed]));
  renderLeft();
}

function treeItem({ label, icon, signal, onOpen, onRemove, menu = null, depth = 1 }) {
  const node = el(
    "div",
    {
      class: "tree__item",
      tabindex: "0",
      title: label,
      style: `padding-left:${depth * 12}px`,
      onclick: onOpen,
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      },
    },
    [
      signal ? mark(signal, 13) : icon ? iconEl(icon, 13) : null,
      el("span", { class: "tree__label", text: label }),
    ]
  );
  if (onRemove) {
    node.append(
      el("button", {
        class: "btn-quiet row__remove",
        text: "Delete",
        title: "Remove",
        onclick: (event) => {
          event.stopPropagation();
          onRemove(event.currentTarget);
        },
      })
    );
  }
  return menu ? onContextMenu(node, menu) : node;
}

function group(name, count, children, { action = null, menu = null } = {}) {
  const open = !collapsed.has(name);
  const head = el("div", { class: "tree__group", onclick: () => toggleGroup(name) }, [
    el("span", { class: `tree__twist${open ? " open" : ""}` }, iconEl("chevron", 12)),
    el("span", { class: "tree__name", text: name }),
    el("span", { class: "tree__count", text: String(count) }),
  ]);
  if (action) {
    head.append(
      el("button", {
        class: "btn-quiet row__remove",
        text: action.label,
        title: action.label,
        onclick: (event) => {
          event.stopPropagation();
          action.run();
        },
      })
    );
  }
  if (menu) onContextMenu(head, menu);
  return el("div", { class: "tree__section" }, [head, open ? el("div", {}, children) : null]);
}

// A relpath carries its folders in it, and an empty folder is reported on
// its own, so both are folded into one shape before anything is drawn.
function folderTree(paths, folders) {
  const root = { children: new Map(), files: [] };

  const reach = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: [] });
      node = node.children.get(part);
    }
    return node;
  };

  for (const folder of folders) reach(folder.split("/"));
  for (const relpath of paths) {
    const parts = relpath.split("/");
    reach(parts.slice(0, -1)).files.push(relpath);
  }
  return root;
}

function folderNodes(kind, node, prefix, depth, drawFile) {
  const out = [];
  for (const [name, child] of [...node.children].sort((a, b) => a[0].localeCompare(b[0]))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const key = `${kind}/${path}`;
    const open = !collapsed.has(key);
    const head = el(
      "div",
      {
        class: "tree__item tree__item--folder",
        tabindex: "0",
        title: path,
        style: `padding-left:${depth * 12}px`,
        onclick: () => toggleGroup(key),
        onkeydown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            toggleGroup(key);
          }
        },
      },
      [
        el("span", { class: `tree__twist${open ? " open" : ""}` }, iconEl("chevron", 12)),
        el("span", { class: "tree__label", text: name }),
      ]
    );
    onContextMenu(head, () => [
      ...addMenu(kind, path),
      "-",
      { name: "Delete folder…", run: () => deleteFolder(kind, path) },
    ]);
    out.push(head);
    if (open) out.push(...folderNodes(kind, child, path, depth + 1, drawFile));
  }
  for (const relpath of node.files.slice().sort()) out.push(drawFile(relpath, depth));
  return out;
}

// The three commands that add to a folder. One definition, so a group
// header and a folder inside it cannot drift apart.
function addMenu(kind, folder = "") {
  return [
    { name: "New File", run: () => (kind === "notes" ? createNote(folder) : createDraft(folder)) },
    { name: "New Folder", run: () => createFolder(kind, folder) },
    { name: "Upload File", run: () => pickPages(kind, folder) },
  ];
}

// One hidden input serves every upload; what to do with the files is set
// on it just before it opens.
let pendingUpload = null;

export function pickPages(kind, folder) {
  pendingUpload = { kind, folder };
  $("#page-file-input").click();
}

export function receivePages(files) {
  const target = pendingUpload;
  pendingUpload = null;
  if (target && files.length) uploadPages(target.kind, target.folder, files);
}

function pageGroup(kind, name, paths, drawFile) {
  const tree = folderTree(paths, state.folders?.[kind] || []);
  return group(name, paths.length, folderNodes(kind, tree, "", 1, drawFile), {
    action: { label: "New", run: () => (kind === "notes" ? createNote() : createDraft()) },
    menu: () => addMenu(kind, ""),
  });
}

function explorer(host) {
  if (!state.project) {
    host.append(
      el("div", { class: "panel__empty" }, [
        el("p", { class: "muted small", text: "No project open." }),
        el("button", {
          class: "btn btn--primary",
          text: "Go To Project",
          onclick: () => panelHandles.openProject?.(),
        }),
      ])
    );
    return;
  }

  host.append(
    el("div", { class: "tree" }, [
      group(
        "Papers",
        state.papers.length,
        state.papers.map((paper) =>
          treeItem({
            label: paper.title,
            signal: paperSignal(paper),
            icon: "paper",
            onOpen: () => openPaper(paper.document_id),
            menu: () => [
              { name: "Open", run: () => openPaper(paper.document_id) },
              {
                name: "Copy marker",
                run: () => {
                  navigator.clipboard.writeText(`[@${paper.document_id}]`);
                  setStatus(undefined, "Citation marker copied");
                },
              },
              {
                name: "Copy reference",
                run: () => {
                  navigator.clipboard.writeText(referenceOf(paper.document_id));
                  setStatus(undefined, "Reference copied");
                },
              },
              { name: "Verify references", run: () => verifyPaper(paper.document_id) },
              "-",
              { name: "Delete…", run: () => deletePaper(paper) },
            ],
          })
        ),
        {
          action: { label: "All", run: () => openPapers() },
          // A paper is written by parsing a PDF, so there is nothing blank
          // to make and nothing to type into.
          menu: () => [{ name: "Upload File", run: () => $("#paper-file-input").click() }],
        }
      ),
      pageGroup("notes", "Notes", state.notes, (relpath, depth) =>
        treeItem({
          label: relpath.split("/").pop(),
          icon: "note",
          depth,
          onOpen: () => openNote(relpath),
          onRemove: (button) => deleteNote(relpath, button),
          menu: () => [
            { name: "Open", run: () => openNote(relpath) },
            { name: "Rename…", run: () => renamePage("notes", relpath) },
            "-",
            { name: "Delete", run: () => deleteNote(relpath, null) },
          ],
        })
      ),
      pageGroup("drafts", "Drafts", state.drafts, (relpath, depth) =>
        treeItem({
          label: relpath.split("/").pop(),
          icon: "draft",
          depth,
          onOpen: () => openDraft(relpath),
          onRemove: () => deleteDraft(relpath),
          menu: () => [
            { name: "Open", run: () => openDraft(relpath) },
            { name: "Rename…", run: () => renamePage("drafts", relpath) },
            { name: "Score claims", run: () => openDraft(relpath) && scoreDraft(relpath) },
            "-",
            { name: "Delete…", run: () => deleteDraft(relpath) },
          ],
        })
      ),
    ])
  );
}

/* --- Search ---------------------------------------------------------------- */

let lastQuery = "";
let lastHits = [];

function search(host) {
  const field = el("input", {
    class: "input",
    id: "search-input",
    type: "search",
    placeholder: "Search passages…",
    value: lastQuery,
  });
  field.style.width = "100%";

  const results = el("div", { class: "hits", id: "search-hits" });

  const run = guard(async () => {
    const question = field.value.trim();
    if (!question) return;
    lastQuery = question;
    progress("Searching");
    try {
      const body = await api("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, question, k: 10 }),
      });
      lastHits = body.passages || [];
      draw();
    } finally {
      progress(null);
    }
  });

  function draw() {
    if (!lastHits.length) {
      results.replaceChildren(
        el("p", { class: "muted small", text: lastQuery ? "No passages matched." : "" })
      );
      return;
    }
    results.replaceChildren(
      el("div", { class: "hits__count small muted", text: `${lastHits.length} passages` }),
      ...lastHits.map((hit) =>
        el(
          "button",
          {
            class: "hit",
            onclick: () => openPaper(hit.document_id),
          },
          [
            el("div", { class: "hit__source small", text: paperTitle(hit.document_id) }),
            el("div", { class: "hit__text small muted", text: hit.text }),
          ]
        )
      )
    );
  }

  const form = el(
    "form",
    { class: "panel__form", onsubmit: (event) => (event.preventDefault(), run()) },
    [field]
  );
  host.append(form, results);
  draw();
  field.focus();
}

/* --- Review ---------------------------------------------------------------- */

let reviewEntries = [];
let reviewCurrent = 0;

const loadReview = guard(async function loadReview(host) {
  const targets = state.drafts;
  const bodies = await Promise.all(
    targets.map((target) =>
      api(`/review/${target}` + projectQuery({ actor: state.actor }))
        .then((body) => ({ target, body }))
        .catch(() => null)
    )
  );

  reviewEntries = [];
  for (const entry of bodies.filter(Boolean)) {
    for (const item of entry.body.items) {
      reviewEntries.push({ draft: entry.target, item, blocking: entry.body.blocking });
    }
  }
  reviewEntries.sort(
    (a, b) => a.draft.localeCompare(b.draft) || severity(b.item) - severity(a.item)
  );
  drawReview(host);
});

function severity(item) {
  const signals = signalsOf({
    score: item.score,
    intent: item.intent,
    sourceStatus: item.source_status,
    stale: item.stale,
  });
  if (!signals.length) return 0;
  return signals[0].tone === "danger" ? 3 : signals[0].tone === "caution" ? 2 : 1;
}

function drawReview(host) {
  host.replaceChildren();
  if (!reviewEntries.length) {
    host.append(
      el("div", { class: "panel__empty" }, [
        el("p", { class: "muted small", text: "Nothing to review." }),
      ])
    );
    return;
  }

  let lastDraft = null;
  const list = el("div", {});
  reviewEntries.forEach((entry, index) => {
    if (entry.draft !== lastDraft) {
      lastDraft = entry.draft;
      list.append(
        el("div", { class: "tree__group tree__group--static" }, [
          el("span", { class: "tree__name", text: entry.draft }),
          el("button", {
            class: "btn-quiet row__remove",
            text: "Record",
            title: "Process record",
            onclick: (event) => {
              event.stopPropagation();
              showProcessRecord(entry.draft);
            },
          }),
        ])
      );
    }
    const signal = signalsOf({
      score: entry.item.score,
      intent: entry.item.intent,
      sourceStatus: entry.item.source_status,
      stale: entry.item.stale,
    })[0];
    list.append(
      el(
        "button",
        {
          class: `hit${index === reviewCurrent ? " active" : ""}`,
          onclick: () => {
            reviewCurrent = index;
            openReviewClaim(entry);
            drawReview(host);
          },
        },
        [
          el("div", { class: "rowline" }, [
            signal ? mark(signal, 13) : null,
            el("span", { class: "hit__source small", text: entry.item.source_title }),
          ]),
          el("div", { class: "hit__text small muted", text: entry.item.claim }),
        ]
      )
    );
  });
  host.append(list);
}

// Reviewing a claim opens the draft it belongs to and puts the claim in
// the inspector, so an author and a reviewer look at the same thing.
function openReviewClaim(entry) {
  openDraft(entry.draft);
  toggleRight(true);
  setTimeout(() => {
    const index = activeDraft.claims.findIndex((claim) => claim.anchor.exact === entry.item.claim);
    if (index >= 0) selectClaim(index, { focusText: false });
  }, 200);
}

function review(host) {
  host.append(el("div", { class: "panel__loading small muted", text: "Reading drafts…" }));
  loadReview(host);
}

/* --- References ------------------------------------------------------------ */

function references(host) {
  if (!state.papers.length) {
    host.append(el("div", { class: "panel__empty" }, [el("p", { class: "muted small", text: "No papers yet." })]));
    return;
  }

  const ranked = state.papers.slice().sort((a, b) => {
    const rank = (p) =>
      p.source_status === "retracted" ? 0 : p.verification === "issues" ? 1 : 2;
    return rank(a) - rank(b) || a.title.localeCompare(b.title);
  });

  host.append(
    el("div", { class: "panel__form" }, [
      el("button", {
        class: "btn",
        text: "Verify all",
        onclick: guard(async () => {
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
          await panelHandles.refresh?.();
          renderLeft();
          setStatus(undefined, "Verification finished");
        }),
      }),
    ]),
    el(
      "div",
      { class: "tree" },
      ranked.map((paper) => {
        const signal = paperSignal(paper);
        return treeItem({
          label: paper.title,
          signal,
          icon: "paper",
          onOpen: () => openPaper(paper.document_id),
        });
      })
    )
  );
}

/* --- AI panel -------------------------------------------------------------- */

let lastAnswer = null;
let lastAsked = "";

function askTab(host) {
  const field = el("input", {
    class: "input",
    id: "ask-input",
    type: "search",
    placeholder: "Ask a question about these papers…",
    value: lastAsked,
  });
  field.style.width = "100%";

  const answer = el("div", { class: "ai__answer", id: "ask-answer" });

  const run = guard(async () => {
    const question = field.value.trim();
    if (!question) return;
    lastAsked = question;
    progress("Searching");
    try {
      lastAnswer = await api("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, question, k: 5 }),
      });
      drawAnswer(answer);
    } finally {
      progress(null);
    }
  });

  host.replaceChildren(
    el("form", { class: "panel__form", onsubmit: (event) => (event.preventDefault(), run()) }, [
      field,
      el("button", { class: "btn btn--primary", type: "submit", text: "Ask" }),
    ]),
    answer
  );
  drawAnswer(answer);
}

export function askAgain() {
  $("#ask-input")?.form?.requestSubmit();
}

function drawAnswer(host) {
  if (!lastAnswer) {
    host.replaceChildren(
      el("p", { class: "muted small", text: "Answers cite the passages they came from." })
    );
    generatorNote(host);
    return;
  }
  const passages = lastAnswer.passages || [];

  const retrieved = el("details", { class: "retrieved" }, [
    el("summary", { text: `Passages retrieved (${passages.length})` }),
    ...passages.map((hit, i) =>
      el("div", { class: "evidence", style: "margin-bottom:var(--space-2)" }, [
        el("div", { class: "mono small muted", text: `[${i + 1}] ${paperTitle(hit.document_id)}` }),
        el("div", { text: hit.text }),
      ])
    ),
  ]);

  if (!lastAnswer.answer) {
    // A missing optional component is a configuration, not a fault.
    retrieved.open = true;
    host.replaceChildren(
      el("p", {
        class: "notice",
        text: "No generator configured. These are the passages that match, ranked.",
      }),
      retrieved
    );
    return;
  }

  const sentences = lastAnswer.answer.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const uncited = sentences.filter((s) => s.split(/\s+/).length >= 5 && !/\[\d+\]/.test(s)).length;

  const prose = el("div", { class: "prose" });
  prose.innerHTML = sentences
    .map((sentence) => {
      const cited = /\[\d+\]/.test(sentence);
      const html = escapeHtml(sentence).replace(/\[(\d+)\]/g, '<span class="citation">[$1]</span>');
      return cited ? `${html} ` : `<span class="uncited">${html}</span> `;
    })
    .join("");

  host.replaceChildren(
    el("div", { class: "banner banner--caution" }, [
      el("div", { class: "banner__body" }, [
        el("div", {
          class: "banner__title",
          text: `${uncited} of ${sentences.length} sentences carry no citation.`,
        }),
        el("div", {
          class: "banner__detail",
          text: "Nothing here contradicts a cited passage, but uncited statements are unverified.",
        }),
      ]),
    ]),
    prose,
    el("div", { class: "rowline", style: "margin-top:var(--space-3)" }, [
      el("button", {
        class: "btn",
        text: "Save to note",
        onclick: guard(async () => {
          const name = await promptDialog({
            title: "Save this answer",
            label: "File name",
            value: "answers.md",
            confirmLabel: "Save",
          });
          if (!name) return;
          const existing = await api(`/notes/${name}` + projectQuery()).catch(() => ({
            content: "",
          }));
          const body = [existing.content, `## ${lastAsked}`, lastAnswer.answer]
            .filter(Boolean)
            .join("\n\n");
          await api(`/notes/${name}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: state.project, content: body, visibility: "private" }),
          });
          await panelHandles.refresh?.();
          setStatus(undefined, `Saved to ${name}`);
        }),
      }),
    ]),
    retrieved
  );
}

/* --- Paper: what the open document says about itself ----------------------- */

// A collapsible section with its count in the heading, so the panel opens
// on the paper rather than on a wall of references.
function section(name, count, build, { open = false } = {}) {
  const box = el("details", { class: "railsection" }, [
    el("summary", {}, [
      el("span", { class: "railsection__name", text: name }),
      el("span", { class: "railsection__count", text: String(count) }),
    ]),
  ]);
  box.open = open;
  // Built on first opening: a paper with 300 references costs nothing
  // until its references are asked for.
  let built = false;
  const fill = () => {
    if (built) return;
    built = true;
    box.append(build());
  };
  box.addEventListener("toggle", () => box.open && fill());
  if (open) fill();
  return box;
}

function referenceEntries() {
  const paper = activePaper.paper;
  const results = activePaper.verification.results || [];
  const refs = paper.references.map((ref, i) => ({ ref, result: results[i] || null }));
  refs.sort((a, b) =>
    compareReferenceStatus(a.result?.status || "unchecked", b.result?.status || "unchecked")
  );

  if (!refs.length) {
    return el("p", { class: "muted small", text: "No references were extracted from this paper." });
  }
  return el(
    "div",
    {},
    refs.map(({ ref, result }) => {
      const signal = referenceSignal(result?.status || "unchecked");
      // A reference whose title the parser did not find reads as a run of
      // author names. Naming the state is more use than showing the raw
      // string as though it were a title.
      const names = (ref.authors || []).slice(0, 3).join(", ");
      const trailer = [names, ref.year].filter(Boolean).join(" · ");
      return el("div", { class: "rail__entry" }, [
        el("div", { class: "rowline" }, [
          signal ? mark(signal, 14) : null,
          ref.title
            ? el("span", { class: "small ref__title", text: ref.title })
            : el("span", { class: "small muted", text: "No title parsed" }),
        ]),
        trailer ? el("div", { class: "small muted", text: trailer }) : null,
        ref.title ? null : el("div", { class: "small faint ref__raw", text: ref.raw }),
        result?.retraction_notice
          ? el("div", { class: "small", style: "color:var(--danger)", text: result.retraction_notice })
          : null,
        // Why a check did not complete belongs beside the reference, but
        // quietly: it reports on the run, not on the work.
        result?.error
          ? el("div", { class: "small muted ref__raw", text: "Not checked: " + result.error })
          : null,
        ref.doi ? el("div", { class: "mono small muted", text: ref.doi }) : null,
      ]);
    })
  );
}

function annotationEntries() {
  const documentId = activePaper.documentId;
  const annotations = activePaper.annotations || [];
  if (!annotations.length) {
    return el("div", {}, [
      el("p", {
        class: "muted small",
        text: "Nothing marked yet. Select a passage in the text to highlight it or write a note on it.",
      }),
      el("button", {
        class: "btn",
        text: "Read the text",
        onclick: () => setPaperMode("text"),
      }),
    ]);
  }
  return el(
    "div",
    {},
    annotations.map((a) =>
      el("div", { class: "rail__entry" }, [
        el("div", { class: "small muted", text: `${a.kind} · ${a.author || "local"}` }),
        el("div", { class: "small", text: a.target?.selector?.exact || "" }),
        a.body ? el("div", { class: "small", text: a.body }) : null,
        el("button", {
          class: "btn-quiet small",
          text: "Remove",
          onclick: (event) =>
            confirmInline(
              event.currentTarget,
              guard(async () => {
                await api(`/annotations/${documentId}/${a.id}` + projectQuery(), {
                  method: "DELETE",
                });
                reloadPaper(documentId);
              })
            ),
        }),
      ])
    )
  );
}

// A collaboration paper carries eighty names. Listed in full they push
// everything else off the panel, so the run is cut and opened on demand.
const AUTHORS_SHOWN = 8;

function authorList(authors) {
  const names = (authors || [])
    .map((a) => a.family || a.literal || [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean);
  if (!names.length) return el("div", { class: "small muted", text: "unknown author" });

  const line = el("div", { class: "small", text: names.join(", ") });
  if (names.length <= AUTHORS_SHOWN) return line;

  const hidden = names.length - AUTHORS_SHOWN;
  line.textContent = names.slice(0, AUTHORS_SHOWN).join(", ");
  const more = el("button", {
    class: "btn-quiet small",
    text: `and ${hidden} more`,
    onclick: () => {
      line.textContent = names.join(", ");
      more.remove();
    },
  });
  return el("div", {}, [line, more]);
}

function paperTab(host) {
  host.replaceChildren();
  const paper = activePaper.paper;
  if (!paper) {
    host.append(
      emptyState("No paper open", "Open a paper to see what it says about itself.", null)
    );
    return;
  }

  const documentId = activePaper.documentId;
  const meta = paper.metadata.kiwi || {};

  // append() writes a null child as the text "null". Everything optional
  // here is filtered rather than passed through.
  const parts = [
    meta.source_status === "retracted"
      ? el("div", { class: "banner" }, [
          el("div", { class: "banner__body" }, [
            el("div", { class: "banner__title", text: "This paper is retracted." }),
            el("div", {
              class: "banner__detail",
              text:
                meta.retraction_notice ||
                "Its record carries a retraction. Claims citing it are marked in every draft.",
            }),
          ]),
        ])
      : null,
    el("h1", { class: "rail__title", text: paper.metadata.title || "(untitled)" }),
    authorList(paper.metadata.author),
    el("div", { class: "state-line small" }, [
      el("span", { class: "mono", text: documentId }),
      el("span", { text: `parsed by ${meta.parser || "unknown"}` }),
      meta.ingested ? el("span", { text: meta.ingested.slice(0, 10) }) : null,
    ]),

    el("div", { class: "rowline", style: "margin-top:var(--space-3)" }, [
      el("div", { class: "segmented" }, [
        el("button", {
          class: `segmented__item${paperMode() === "pdf" ? " active" : ""}`,
          text: "PDF",
          onclick: () => setPaperMode("pdf"),
        }),
        el("button", {
          class: `segmented__item${paperMode() === "text" ? " active" : ""}`,
          text: "Text",
          title: "Parsed text. Select a passage here to cite or annotate it.",
          onclick: () => setPaperMode("text"),
        }),
      ]),
    ]),
    el("div", { class: "rowline", style: "margin-top:var(--space-2)" }, [
      el("button", {
        class: "btn",
        title: "The marker a draft cites this work with",
        text: "Copy marker",
        onclick: () => {
          navigator.clipboard.writeText(`[@${documentId}]`);
          setStatus(undefined, "Citation marker copied");
        },
      }),
      el("button", {
        class: "btn",
        title: "The full entry, for a bibliography",
        text: "Copy reference",
        onclick: () => {
          navigator.clipboard.writeText(referenceOf(documentId));
          setStatus(undefined, "Reference copied");
        },
      }),
      el("button", {
        class: "btn",
        text: "Verify references",
        onclick: () => verifyPaper(documentId),
      }),
    ]),

    section("References", paper.references.length, referenceEntries),
    section("Notes", (activePaper.annotations || []).length, annotationEntries),
  ];
  host.append(...parts.filter(Boolean));
}

// A missing optional component is a configuration, not a fault, and is
// worth saying before a control is pressed rather than after.
let generatorState = null;

const generatorNote = guard(async function generatorNote(host) {
  if (generatorState === null) {
    generatorState = await api("/health/generator").catch(() => ({ ok: true, detail: "" }));
  }
  if (generatorState.ok || !host.isConnected) return;
  host.append(el("p", { class: "notice", text: generatorState.detail }));
});

function claimsTab(host) {
  host.replaceChildren();
  if (!activeDraft.relpath) {
    host.append(
      emptyState("No draft open", "Open a draft to see what its citations support.", null)
    );
    return;
  }
  if (!activeDraft.claims.length) {
    host.append(
      emptyState("No citations yet", "Cite a passage from a paper to have it checked.", null)
    );
    return;
  }

  const claim = activeDraft.claims[activeDraft.current];
  const item = fromClaim(claim, citationOf(claim.citation));
  const pending = activeDraft.suggestions.find((s) => s.anchor?.exact === claim.anchor.exact);

  const actions = [
    { label: "Open source", key: "Enter", run: () => openCurrentSource() },
    { label: "Change citation", key: "c", run: () => panelHandles.changeCitation?.() },
  ];
  if (pending) {
    actions.push(
      {
        label: "Accept suggestion",
        key: "a",
        primary: true,
        run: () => resolveSuggestion(pending, "accept"),
      },
      { label: "Reject suggestion", key: "r", run: () => resolveSuggestion(pending, "reject") }
    );
  }
  actions.push({ label: "Mark checked", key: "Alt+K", run: () => markChecked() });

  // Everything below the actions is settings and history rather than the
  // judgement, so it sits in one quiet row at the bottom instead of
  // stacking controls under the evidence.
  const footer = el("div", { class: "inspector__foot" }, [
    pending
      ? el("div", { class: "inspector__suggestion" }, [
          el("div", { class: "small muted", text: "Suggested revision" }),
          el("div", { class: "small", text: pending.proposed }),
        ])
      : null,
    el("div", { class: "rowline inspector__scale" }, [
      el("span", { class: "small muted", text: "Scored as" }),
      el("select", {
        class: "input",
        style: "width:auto",
        title: "Scale this claim is scored on",
        onchange: guard(async (event) => {
          await api("/align/intent", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project: state.project,
              draft: activeDraft.relpath,
              claim: claim.anchor.exact,
              citation: claim.citation,
              intent: event.target.value,
            }),
          });
          const { claims } = await api(`/align/${activeDraft.relpath}` + projectQuery());
          activeDraft.claims = withSourceStatus(claims);
          refreshAI();
        }),
        html: ["evidence", "attribution", "background", "methods", "contrast"]
          .map((i) => `<option value="${i}"${claim.intent === i ? " selected" : ""}>${i}</option>`)
          .join(""),
      }),
      el("span", { class: "toolbar-spacer" }),
      el("button", {
        class: "btn-quiet small",
        text: "Process record",
        onclick: () => showProcessRecord(activeDraft.relpath),
      }),
    ]),
  ]);

  host.append(
    inspector({
      item,
      position: { index: activeDraft.current, total: activeDraft.claims.length },
      actions,
      onMove: (delta) => moveClaim(delta, true),
      footer,
    })
  );
}

function suggestionsTab(host) {
  host.replaceChildren();
  const suggestions = activeDraft.suggestions || [];
  if (!activeDraft.relpath) {
    host.append(emptyState("No draft open", null, null));
    return;
  }
  if (!suggestions.length) {
    const contradicted = (activeDraft.claims || []).filter(
      (c) => (c.alignment?.score ?? 2) === 0
    ).length;
    host.append(
      emptyState(
        "No revisions proposed",
        contradicted
          ? `Suggest revisions reads the ${contradicted} contradicted claim${
              contradicted === 1 ? "" : "s"
            } and proposes wording their evidence supports.`
          : "Revisions are proposed only for a claim its own source contradicts. This draft has none.",
        contradicted
          ? el("button", {
              class: "btn btn--primary",
              text: "Suggest revisions",
              onclick: () => panelHandles.suggest?.(),
            })
          : null
      )
    );
    // Stated once, where the button is, rather than after pressing it.
    generatorNote(host);
    return;
  }

  host.append(
    ...suggestions.map((suggestion) =>
      el("div", { class: "panel-card" }, [
        el("div", { class: "small muted", text: suggestion.anchor?.exact || "" }),
        el("div", { class: "small", style: "margin-top:var(--space-2)", text: suggestion.proposed }),
        el("div", { class: "rowline", style: "margin-top:var(--space-2)" }, [
          el("button", {
            class: "btn btn--primary",
            text: "Accept",
            onclick: () => resolveSuggestion(suggestion, "accept"),
          }),
          el("button", {
            class: "btn",
            text: "Reject",
            onclick: () => resolveSuggestion(suggestion, "reject"),
          }),
        ]),
      ])
    )
  );
}

export function refreshAI() {
  const tab = ai.active();
  if (!tab || !tab.rendered) return;
  tab.render(tab.host, tab);
}

// Redraw one right-panel tab whether or not it is the one showing, so
// switching to it later does not show what was true when it was opened.
function refreshTab(id) {
  const tab = ai.find(id);
  if (tab?.rendered) tab.render(tab.host, tab);
}

/* --- Registration ---------------------------------------------------------- */

export function registerPanels() {
  registerLeft("explorer", {
    title: "Explorer",
    render: explorer,
    actions: () =>
      state.project
        ? [
            el("button", {
              class: "btn-quiet icon-btn",
              title: "Add to this project",
              text: "+",
              onclick: (event) => {
                const box = event.currentTarget.getBoundingClientRect();
                openMenuAtPoint(
                  box.left,
                  box.bottom + 2,
                  [
                    { name: "New draft", run: () => createDraft() },
                    { name: "New note", run: () => createNote() },
                    "-",
                    { name: "Import PDFs…", run: () => $("#paper-file-input").click() },
                  ],
                  { onRun: (item) => item.run?.() }
                );
              },
            }),
          ]
        : [],
  });
  registerLeft("search", { title: "Search", render: search });
  registerLeft("review", { title: "Review", render: review });
  registerLeft("references", { title: "References", render: references });

  panelHandles.review = () => showLeft("review");
  panelHandles.references = () => showLeft("references");
  panelHandles.showClaims = () => ai.activate("claims");
  panelHandles.showRevisions = () => ai.activate("suggestions");

  // A paper tab holds the document and nothing else, so opening one puts
  // what it says about itself where it can be read beside it.
  panelHandles.paperChanged = () => {
    if (!activePaper.paper) {
      refreshTab("paper");
      return;
    }
    toggleRight(true);
    // activate() redraws the tab it lands on, which is this one.
    ai.activate("paper");
  };

  // Unlike a file, a right-panel tab holds no state of its own: it reads
  // the open draft or the open paper. Switching back to one redraws it
  // rather than showing what was true when it was first opened.
  for (const [id, title, draw] of [
    ["paper", "Paper", paperTab],
    ["ask", "Ask", askTab],
    ["claims", "Claims", claimsTab],
    ["suggestions", "Revisions", suggestionsTab],
  ]) {
    ai.open({
      id,
      title,
      closable: false,
      render: (host) => draw(host),
      refresh: (host) => draw(host),
    });
  }
  ai.activate("ask");
}

export { notice, needsAttention, withSourceStatus, compareReferenceStatus, authorNames, centre };
