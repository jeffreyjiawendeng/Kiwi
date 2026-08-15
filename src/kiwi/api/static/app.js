"use strict";

// Frontend for Kiwi's local HTTP API. No build step, no framework.

const state = {
  project: null, // absolute path string, or null
  actor: "", // who review actions are recorded against
  papers: [],
  notes: [],
  drafts: [],
  busy: false, // a parse or an index is running
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      /* response had no JSON body */
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function setStatus(left, right) {
  $("#status-left").textContent = left || "";
  $("#status-right").textContent = right || "";
}

function showView(name) {
  $$(".view").forEach((el) => (el.hidden = true));
  const el = $(`#view-${name}`);
  if (el) el.hidden = false;
}

function setActiveNavItem(el) {
  $$(".nav-list li, .nav-item").forEach((n) => n.classList.remove("active"));
  if (el) el.classList.add("active");
}

// ---------------------------------------------------------------- project

async function suggestProjectPath() {
  // Typing an absolute path from nothing is the worst part of a first
  // run, and a browser cannot supply one. The server can.
  const input = $("#open-project-path");
  if (input.value.trim()) return;
  try {
    const { path } = await api("/projects/default");
    input.value = path;
  } catch {
    /* the placeholder still shows the shape of an answer */
  }
}

async function refreshRecentProjects() {
  const { projects } = await api("/projects");
  const list = $("#recent-projects");
  list.innerHTML = "";
  for (const p of projects) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="path">${escapeHtml(p.path)}</span>`;
    li.addEventListener("click", () => openProject(p.path, p.name));
    list.appendChild(li);
  }
}

async function openProject(path, name) {
  await api("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  state.project = path;
  $("#project-name").textContent = name || path;
  $("#sidebar").hidden = false;
  setStatus(path, "");
  await refreshProjectSummary();
  // Asking a project with nothing in it returns nothing, which reads as a
  // broken search rather than an empty library.
  showEmptyOrAsk();
}

function showEmptyProject() {
  $("#view-empty").innerHTML = `
    <h1>Nothing in this project yet</h1>
    <p class="muted">Kiwi answers questions about papers you have added, and every answer points back at the passage it came from.</p>
    <p><button id="empty-add-paper-btn">Add PDFs</button></p>
    <p class="muted">Papers are parsed by GROBID into sections and a reference list. Without it running, Kiwi reads the text layer alone and finds neither, and re-reading them later replaces them in place.</p>
  `;
  $("#empty-add-paper-btn").addEventListener("click", () => $("#paper-file-input").click());
  showView("empty");
}

async function refreshProjectSummary() {
  const summary = await api(`/projects/summary?project=${encodeURIComponent(state.project)}`);
  state.papers = summary.papers;
  state.notes = summary.notes;
  state.drafts = summary.drafts;
  renderSidebarLists();
}

// ------------------------------------------------------------ add papers

// GROBID recovers the section tree and the reference list. Without it a
// paper can still be read through its own text layer, which finds
// neither. The choice is offered rather than made silently, because the
// two produce different documents from the same file.
async function addPapers(files) {
  if (!files.length || state.busy) return;

  let textOnly = false;
  const ingestor = await api("/health/ingestor");
  if (!ingestor.ok) {
    const proceed = confirm(
      `GROBID is not running, so sections and references cannot be extracted.\n\n` +
        `${ingestor.detail}\n\n` +
        `Read the text layer alone instead? The papers keep their identity, ` +
        `so parsing them again through GROBID later replaces them in place.`
    );
    if (!proceed) {
      setStatus("Start GROBID, then add the papers again.");
      return;
    }
    textOnly = true;
  }

  // Parsing a paper takes seconds and indexing takes longer. Without a
  // guard the button invites a second run over the same files.
  setBusy(true);
  const added = [];
  const failed = [];
  try {
    for (const [i, file] of files.entries()) {
      setStatus(`Reading ${file.name} (${i + 1} of ${files.length}) ...`);
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
      setStatus(`Indexing ${added.length} paper(s) ...`);
      await api("/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project }),
      });
      await refreshProjectSummary();
    }
  } finally {
    setBusy(false);
  }

  const summary = `${added.length} paper(s) added${textOnly ? ", text layer only" : ""}`;
  setStatus(failed.length ? `${summary}, ${failed.length} failed` : summary);
  if (failed.length) reportError(new Error(failed.join("\n")));
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  const button = $("#add-paper-btn");
  if (button) button.disabled = busy;
}

// ---------------------------------------------------------------- remove

// What an object owns goes with it. What merely cites it does not, so a
// draft's sentence is never edited on its author's behalf.
const OWNED = {
  paper: "its annotations, its verification results, and its chunks",
  draft: "its scored claims and the review decisions recorded on it",
  note: "nothing else",
};

async function removeObject(kind, path, label) {
  if (!confirm(`Delete ${label}?\n\nThis also deletes ${OWNED[kind]}.`)) return;
  const query = `project=${encodeURIComponent(state.project)}${state.actor ? `&actor=${encodeURIComponent(state.actor)}` : ""}`;
  const result = await api(`${path}?${query}`, { method: "DELETE" });
  await refreshProjectSummary();
  showEmptyOrAsk();
  setStatus(state.project, `Deleted ${label}`);
  if (result.citing_drafts && result.citing_drafts.length) {
    reportError(
      new Error(
        `These drafts cite it and were left unchanged: ${result.citing_drafts.join(", ")}`
      )
    );
  }
}

function showEmptyOrAsk() {
  if (state.papers.length) showAsk();
  else showEmptyProject();
}

function paperTitle(documentId) {
  const paper = state.papers.find((p) => p.document_id === documentId);
  return paper ? paper.title : documentId;
}

// An empty list says what fills it. A blank one reads as a failure.
function renderEmptyHint(list, text) {
  const li = document.createElement("li");
  li.className = "nav-empty";
  li.textContent = text;
  list.appendChild(li);
}

// A delete control sits on the row it deletes, and stops the click from
// also opening what it just removed.
function addRemoveControl(li, kind, path, label) {
  const button = document.createElement("button");
  button.className = "btn-remove";
  button.title = `Delete ${label}`;
  button.textContent = "×";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    wrapAsync(removeObject)(kind, path, label);
  });
  li.appendChild(button);
}

function renderSidebarLists() {
  const papersList = $("#papers-list");
  papersList.innerHTML = "";
  if (!state.papers.length) renderEmptyHint(papersList, "No papers. Use + to add PDFs.");
  for (const paper of state.papers) {
    const li = document.createElement("li");
    const badgeClass = paper.verification === "resolved" ? "resolved" : paper.verification === "issues" ? "issues" : "";
    li.innerHTML = `${escapeHtml(paper.title)}${badgeClass ? `<span class="badge ${badgeClass}">${paper.verification}</span>` : ""}`;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showPaper(paper.document_id);
    });
    addRemoveControl(li, "paper", `/papers/${paper.document_id}`, paper.title);
    papersList.appendChild(li);
  }

  const notesList = $("#notes-list");
  notesList.innerHTML = "";
  if (!state.notes.length) renderEmptyHint(notesList, "No notes yet.");
  for (const relpath of state.notes) {
    const li = document.createElement("li");
    li.textContent = relpath;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showNote(relpath);
    });
    addRemoveControl(li, "note", `/notes/${relpath}`, relpath);
    notesList.appendChild(li);
  }

  const draftsList = $("#drafts-list");
  draftsList.innerHTML = "";
  if (!state.drafts.length) renderEmptyHint(draftsList, "No drafts yet.");
  for (const relpath of state.drafts) {
    const li = document.createElement("li");
    li.textContent = relpath;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showDraft(relpath);
    });
    addRemoveControl(li, "draft", `/drafts/${relpath}`, relpath);
    draftsList.appendChild(li);
  }
}

// ------------------------------------------------------------------ paper

async function showPaper(documentId) {
  const paper = await api(`/papers/${documentId}?project=${encodeURIComponent(state.project)}`);
  let verification = { results: [] };
  try {
    verification = await api(
      `/papers/${documentId}/verification?project=${encodeURIComponent(state.project)}`
    );
  } catch {
    /* never verified */
  }

  const refRows = paper.references
    .map((ref, i) => {
      const match = verification.results[i];
      const status = match ? match.status : "unchecked";
      // A retraction is the one status a reader has to act on, so the
      // notice is shown rather than left behind the status alone.
      const notice = match && match.retraction_notice
        ? `<tr class="notice-row"><td colspan="4">${escapeHtml(match.retraction_notice)}</td></tr>`
        : "";
      return `<tr>
        <td>${escapeHtml(ref.title || ref.raw)}</td>
        <td>${ref.year ?? ""}</td>
        <td>${escapeHtml(ref.doi || "")}</td>
        <td><span class="status-pill ${status}">${status}</span></td>
      </tr>${notice}`;
    })
    .join("");

  const authorNames = (paper.metadata.author || [])
    .map((a) => [a.given, a.family].filter(Boolean).join(" "))
    .join(", ");

  $("#view-paper").innerHTML = `
    <h1>${escapeHtml(paper.metadata.title || "(untitled)")}</h1>
    <p class="muted">${escapeHtml(authorNames)}</p>
    <p>
      <button class="btn-secondary" id="copy-citation-btn">Copy citation marker [@${documentId}]</button>
      <button class="btn-secondary" id="verify-refs-btn">Verify references</button>
    </p>
    <h2>Sections</h2>
    <ul>${paper.sections.map((s) => `<li>${"&nbsp;&nbsp;".repeat(s.level - 1)}${escapeHtml(s.title || s.path)}</li>`).join("")}</ul>
    <h2>Text</h2>
    <p class="muted">Select a passage to highlight it, note it, or cite it in a draft.</p>
    <div id="selection-actions" hidden></div>
    <div id="paper-text" class="paper-text"></div>
    <h2>Annotations</h2>
    <div id="annotation-filter"></div>
    <div id="paper-annotations"></div>
    <h2>References</h2>
    <table>
      <thead><tr><th>Title</th><th>Year</th><th>DOI</th><th>Status</th></tr></thead>
      <tbody>${refRows || '<tr><td colspan="4" class="muted">No references extracted.</td></tr>'}</tbody>
    </table>
  `;
  $("#copy-citation-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(`[@${documentId}]`);
    setStatus(state.project, "Citation marker copied");
  });
  $("#verify-refs-btn").addEventListener(
    "click",
    wrapAsync(async () => {
      setStatus(`Resolving ${paper.references.length} reference(s) against Crossref ...`);
      await api("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, document_id: documentId }),
      });
      await refreshProjectSummary();
      await showPaper(documentId);
      setStatus(state.project, "References verified");
    })
  );

  await setUpAnnotating(documentId, paper.text);
  showView("paper");
}

// ---------------------------------------------------------- annotations

// Annotation offsets index the paper's normalised text, which is what the
// reading surface renders, so a stored span maps onto it directly.
function renderPaperText(text, annotations) {
  const marks = [...annotations].sort((a, b) => a.target.selector.start - b.target.selector.start);
  let html = "";
  let cursor = 0;
  for (const annotation of marks) {
    const { start, end } = annotation.target.selector;
    if (start < cursor || end > text.length) continue; // overlapping or stale
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark class="annotation-mark ${escapeHtml(annotation.kind)}" title="${escapeHtml(annotation.body || annotation.author)}">${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function renderAnnotation(annotation) {
  const body = annotation.body
    ? `<div class="annotation-body">${escapeHtml(annotation.body)}</div>`
    : "";
  return `<div class="annotation" data-id="${escapeHtml(annotation.id)}">
    <div class="claim-depths">${escapeHtml(annotation.kind)} · ${escapeHtml(annotation.author)} · ${escapeHtml(annotation.created)}</div>
    <div class="annotation-quote">${escapeHtml(annotation.target.selector.exact)}</div>
    ${body}
    <div class="suggestion-actions"><button class="btn-secondary annotation-delete">Delete</button></div>
  </div>`;
}

async function setUpAnnotating(documentId, text) {
  const surface = $("#paper-text");
  const panel = $("#paper-annotations");
  const filter = $("#annotation-filter");
  const actions = $("#selection-actions");
  let author = null;

  const load = async () => {
    const query = author ? `&author=${encodeURIComponent(author)}` : "";
    const body = await api(
      `/annotations/${documentId}?project=${encodeURIComponent(state.project)}${query}`
    );
    surface.innerHTML = renderPaperText(text, body.annotations);
    panel.innerHTML = body.annotations.length
      ? body.annotations.map(renderAnnotation).join("")
      : '<p class="muted">Nothing annotated yet.</p>';

    const options = body.authors
      .map((name) => `<option value="${escapeHtml(name)}"${name === author ? " selected" : ""}>${escapeHtml(name)}</option>`)
      .join("");
    filter.innerHTML = body.authors.length
      ? `<label>Author <select id="author-filter"><option value="">everyone</option>${options}</select></label>`
      : "";
    const select = $("#author-filter");
    if (select) {
      select.addEventListener(
        "change",
        wrapAsync(async (event) => {
          author = event.target.value || null;
          await load();
        })
      );
    }

    $$(".annotation-delete", panel).forEach((button) =>
      button.addEventListener(
        "click",
        wrapAsync(async (event) => {
          const id = event.target.closest(".annotation").dataset.id;
          await api(
            `/annotations/${documentId}/${id}?project=${encodeURIComponent(state.project)}`,
            { method: "DELETE" }
          );
          await load();
          setStatus(state.project, "Annotation deleted");
        })
      )
    );
  };

  const record = (kind, body) =>
    api("/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.project,
        document_id: documentId,
        exact: selected(),
        kind,
        body: body || "",
      }),
    });

  const selected = () => (window.getSelection() || "").toString().trim();

  const draftOptions = state.drafts
    .map((relpath) => `<option value="${escapeHtml(relpath)}">${escapeHtml(relpath)}</option>`)
    .join("");

  actions.innerHTML = `
    <button class="btn-secondary" id="annotate-highlight">Highlight</button>
    <button class="btn-secondary" id="annotate-note">Note</button>
    <button class="btn-secondary" id="annotate-copy">Copy</button>
    <button class="btn-secondary" id="annotate-copy-citation">Copy citation</button>
    ${state.drafts.length ? `<label>Cite in draft <select id="cite-in-draft"><option value="">choose</option>${draftOptions}</select></label>` : ""}
  `;

  surface.addEventListener("mouseup", () => {
    actions.hidden = !selected();
  });

  $("#annotate-highlight").addEventListener(
    "click",
    wrapAsync(async () => {
      if (!selected()) return;
      await record("highlight");
      await load();
      setStatus(state.project, "Highlighted");
    })
  );

  $("#annotate-note").addEventListener(
    "click",
    wrapAsync(async () => {
      if (!selected()) return;
      const body = window.prompt("Note on this passage:");
      if (body === null) return;
      await record("note", body);
      await load();
      setStatus(state.project, "Note added");
    })
  );

  $("#annotate-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(selected());
    setStatus(state.project, "Passage copied");
  });

  $("#annotate-copy-citation").addEventListener("click", () => {
    navigator.clipboard.writeText(`${selected()} [@${documentId}]`);
    setStatus(state.project, "Passage and citation copied");
  });

  const citeSelect = $("#cite-in-draft");
  if (citeSelect) {
    citeSelect.addEventListener(
      "change",
      wrapAsync(async (event) => {
        const relpath = event.target.value;
        if (!relpath) return;
        await api("/drafts/cite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: state.project,
            draft: relpath,
            document_id: documentId,
            quoted: selected(),
          }),
        });
        event.target.value = "";
        setStatus(state.project, `Cited in ${relpath}`);
      })
    );
  }

  await load();
}

// ------------------------------------------------------------- review

const DECISIONS = ["approved", "changes_requested", "resolved"];

// A score is an input to a judgement rather than a verdict, so the
// evidence passage and the state of the cited work sit beside it.
function renderReviewItem(item) {
  const score = item.score === null ? "not scored" : `score ${item.score}`;
  const stale = item.stale ? '<span class="badge issues">stale</span>' : "";
  const evidence = item.evidence
    ? `<div class="claim-evidence">${escapeHtml(item.evidence)}</div>`
    : '<div class="claim-evidence muted">No passage was read for this claim.</div>';
  const options = DECISIONS.map((d) => `<option value="${d}">${d.replace("_", " ")}</option>`).join("");

  return `<div class="claim ${item.score === null ? "score-none" : `score-${item.score}`}"
      data-claim="${escapeHtml(item.claim)}" data-citation="${escapeHtml(item.citation)}">
    <div class="claim-text">${escapeHtml(item.claim)}</div>
    <div class="claim-meta">
      <strong>${escapeHtml(item.source_title)}</strong>
      <span>${escapeHtml(item.intent)}</span>
      <span>${escapeHtml(score)}</span>
      <span class="status-pill ${escapeHtml(item.source_status)}">${escapeHtml(item.source_status)}</span>
      ${stale}
    </div>
    ${evidence}
    <div class="suggestion-actions">
      <select class="review-decision">${options}</select>
      <input class="review-comment" placeholder="Reasoning to record" />
      <button class="btn-secondary review-record">Record</button>
      <button class="btn-secondary review-propose">Propose wording</button>
    </div>
  </div>`;
}

async function showReview(relpath) {
  const who = state.actor || "";
  const query = `project=${encodeURIComponent(state.project)}${who ? `&actor=${encodeURIComponent(who)}` : ""}`;
  const body = await api(`/review/${relpath}?${query}`);

  const blocking = body.blocking.length
    ? `<p class="badge issues">Awaiting review from: ${escapeHtml(body.blocking.join(", "))}</p>`
    : '<p class="muted">No review is required before this draft moves on.</p>';
  const history = body.decisions
    .map((d) => `<li>${escapeHtml(d.decision)} by ${escapeHtml(d.reviewer)} ${escapeHtml(d.comment)}</li>`)
    .join("");

  $("#view-review").innerHTML = `
    <h1>Review: ${escapeHtml(relpath)}</h1>
    <p class="muted">The decision stays with the reader. Open each citation and check the passage.</p>
    ${blocking}
    <label>Reviewing as <input id="review-actor" value="${escapeHtml(who)}" placeholder="your name" /></label>
    <div id="review-items">${body.items.map(renderReviewItem).join("")}</div>
    <h2>Decisions recorded</h2>
    <ul>${history || '<li class="muted">None yet.</li>'}</ul>
    <p>
      <button class="btn-secondary" id="back-to-draft">Back to draft</button>
      <button class="btn-secondary" id="process-record-btn">Process record</button>
    </p>
  `;

  $("#review-actor").addEventListener("change", (event) => {
    state.actor = event.target.value.trim();
  });
  $("#back-to-draft").addEventListener("click", wrapAsync(() => showDraft(relpath)));
  $("#process-record-btn").addEventListener("click", wrapAsync(() => showProcessRecord(relpath)));

  $$(".review-record", $("#view-review")).forEach((button) =>
    button.addEventListener(
      "click",
      wrapAsync(async (event) => {
        const card = event.target.closest(".claim");
        await api("/review/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: state.project,
            draft: relpath,
            claim: card.dataset.claim,
            citation: card.dataset.citation,
            decision: $(".review-decision", card).value,
            reviewer: state.actor || "local",
            comment: $(".review-comment", card).value,
          }),
        });
        setStatus(state.project, "Decision recorded");
        await showReview(relpath);
      })
    )
  );

  $$(".review-propose", $("#view-review")).forEach((button) =>
    button.addEventListener(
      "click",
      wrapAsync(async (event) => {
        const card = event.target.closest(".claim");
        const proposed = window.prompt("Proposed wording:", card.dataset.claim);
        if (proposed === null) return;
        await api("/review/propose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: state.project,
            draft: relpath,
            claim: card.dataset.claim,
            proposed,
            author: state.actor || "local",
          }),
        });
        setStatus(state.project, "Wording proposed");
      })
    )
  );

  showView("review");
}

// -------------------------------------------------------------- notes

async function showNote(relpath) {
  const note = await api(`/notes/${relpath}?project=${encodeURIComponent(state.project)}`);
  $("#view-note").innerHTML = `
    <h1>${escapeHtml(relpath)}</h1>
    <label>Visibility
      <select id="note-visibility">
        <option value="private" ${note.visibility === "private" ? "selected" : ""}>Private</option>
        <option value="shared" ${note.visibility === "shared" ? "selected" : ""}>Shared</option>
      </select>
    </label>
    <textarea id="note-content">${escapeHtml(note.content)}</textarea>
    <p><button class="btn-primary" id="save-note-btn">Save</button></p>
  `;
  $("#save-note-btn").addEventListener("click", async () => {
    await api(`/notes/${relpath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.project,
        content: $("#note-content").value,
        visibility: $("#note-visibility").value,
      }),
    });
    setStatus(state.project, "Note saved");
  });
  showView("note");
}

async function createNote() {
  const name = window.prompt("New note filename (e.g. reading-log.md):");
  if (!name) return;
  const relpath = name.endsWith(".md") ? name : `${name}.md`;
  await api(`/notes/${relpath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, content: "", visibility: "private" }),
  });
  await refreshProjectSummary();
  showNote(relpath);
}

// ------------------------------------------------------------- drafts

function renderCitations(content) {
  return escapeHtml(content).replace(
    /\[@([\w-]+)\]/g,
    (_match, docId) => `<span class="citation-chip" data-doc-id="${docId}">@${escapeHtml(paperTitle(docId))}</span>`
  );
}

// Evidence scores run 0 to 2; attribution is binary and its 1 means the
// cited work is the origin, not that it half supports something.
const SCORE_LABEL = {
  evidence: {
    0: "does not support this claim",
    1: "relevant, does not establish this claim",
    2: "supports this claim",
  },
  attribution: {
    0: "is not the origin of this",
    1: "is the origin of this, on a reading to check",
  },
};

function scoreLabel(intent, score) {
  const scale = SCORE_LABEL[intent] || SCORE_LABEL.evidence;
  return scale[score] ?? "scored";
}

// The class sets the emphasis: flagged, plain, or silent. Attribution
// credits the wrong work often enough that a credit is never silent: it
// is marked for reading, the way a claim the evidence does not establish
// is. See eval/README.md.
function scoreClass(intent, score) {
  if (intent === "attribution") return score === 1 ? "score-1" : "score-0";
  return `score-${score}`;
}
const INTENTS = ["evidence", "attribution", "background", "methods", "contrast"];
const APPROXIMATE_INTENTS = new Set(["attribution"]);

function renderClaim(claim) {
  // A supporting score is reported without emphasis, a claim the work
  // does not establish is stated plainly, and an unsupported claim is
  // flagged.
  const shown = claim.deep_alignment || claim.alignment;
  const cls = shown ? scoreClass(claim.intent, shown.score) : "score-none";
  const intentOptions = INTENTS.map(
    (i) => `<option value="${i}"${claim.intent === i ? " selected" : ""}>${i}</option>`
  ).join("");

  let depths = "";
  if (claim.alignment && claim.deep_alignment && claim.alignment.score !== claim.deep_alignment.score) {
    depths = `<div class="claim-depths">quick ${claim.alignment.score} · deep ${claim.deep_alignment.score}</div>`;
  } else if (shown) {
    depths = `<div class="claim-depths">${shown.depth}</div>`;
  }

  const stale = claim.deep_alignment && claim.deep_alignment.stale
    ? '<span class="badge issues">stale</span>'
    : "";

  const approximate = APPROXIMATE_INTENTS.has(claim.intent)
    ? '<span class="badge issues" title="Attribution can credit the wrong work. Read the passage before relying on this score.">approximate</span>'
    : "";

  const evidence = shown && shown.evidence
    ? `<div class="claim-evidence">${escapeHtml(shown.evidence.exact)}</div>`
    : '<div class="claim-evidence muted">No passage was read for this claim.</div>';

  return `<div class="claim ${cls}" data-claim="${escapeHtml(claim.anchor.exact)}" data-citation="${escapeHtml(claim.citation)}">
    <div class="claim-text">${escapeHtml(claim.anchor.exact)}</div>
    <div class="claim-meta">
      ${shown ? `<strong>${escapeHtml(paperTitle(claim.citation))}</strong> ${escapeHtml(scoreLabel(claim.intent, shown.score))}` : `<strong>${escapeHtml(paperTitle(claim.citation))}</strong> not scored`}
      ${stale}
      ${approximate}
      <label>intent
        <select class="claim-intent">${intentOptions}</select>
      </label>
    </div>
    ${depths}
    ${evidence}
  </div>`;
}

function renderClaims(container, relpath, claims) {
  if (!claims.length) {
    container.innerHTML = '<p class="muted">No cited sentences found. Citations are written as <code>[@doc_id]</code>.</p>';
    return;
  }
  container.innerHTML = claims.map(renderClaim).join("");
  $$(".claim-intent", container).forEach((select) =>
    select.addEventListener(
      "change",
      wrapAsync(async (event) => {
        const claim = event.target.closest(".claim");
        const body = await api("/align/intent", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: state.project,
            draft: relpath,
            claim: claim.dataset.claim,
            citation: claim.dataset.citation,
            intent: event.target.value,
          }),
        });
        renderClaims(container, relpath, body.claims);
        setStatus(state.project, "Intent set");
      })
    )
  );
}

// Origin is stated on every suggestion: a reader has to be able to tell
// whether a machine or a person proposed the change.
const SUGGESTION_ORIGIN = {
  generated: "generated",
  alignment: "from an alignment score",
};

function renderSuggestion(suggestion) {
  const origin = SUGGESTION_ORIGIN[suggestion.origin] || suggestion.origin;
  const controls =
    suggestion.state === "pending"
      ? `<div class="suggestion-actions">
           <button class="btn-secondary suggestion-accept">Accept</button>
           <button class="btn-secondary suggestion-reject">Reject</button>
         </div>`
      : `<div class="claim-depths">${escapeHtml(suggestion.state)}</div>`;

  return `<div class="suggestion ${suggestion.state}" data-id="${escapeHtml(suggestion.suggestion_id)}">
    <div class="claim-depths">${escapeHtml(origin)}</div>
    <div class="suggestion-current">${escapeHtml(suggestion.anchor.exact)}</div>
    <div class="suggestion-proposed">${escapeHtml(suggestion.proposed)}</div>
    ${controls}
  </div>`;
}

function renderSuggestions(container, relpath, suggestions, onApplied) {
  if (!suggestions.length) {
    container.innerHTML = '<p class="muted">No suggestions. Check claims first: a claim its citation does not support is what produces one.</p>';
    return;
  }
  container.innerHTML = suggestions.map(renderSuggestion).join("");

  const resolve = (path, message) =>
    wrapAsync(async (event) => {
      const card = event.target.closest(".suggestion");
      const body = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.project,
          draft: relpath,
          suggestion_id: card.dataset.id,
        }),
      });
      renderSuggestions(container, relpath, body.suggestions, onApplied);
      await onApplied();
      setStatus(state.project, message);
    });

  $$(".suggestion-accept", container).forEach((button) =>
    button.addEventListener("click", resolve("/suggestions/accept", "Suggestion accepted"))
  );
  $$(".suggestion-reject", container).forEach((button) =>
    button.addEventListener("click", resolve("/suggestions/reject", "Suggestion rejected"))
  );
}

async function showDraft(relpath) {
  const draft = await api(`/drafts/${relpath}?project=${encodeURIComponent(state.project)}`);
  $("#view-draft").innerHTML = `
    <h1>${escapeHtml(relpath)}</h1>
    <p class="muted">Citations are written inline as <code>[@doc_id]</code>. Copy one from a paper's page.</p>
    <div class="editor-layout">
      <textarea id="draft-content">${escapeHtml(draft.content)}</textarea>
      <div class="preview" id="draft-preview"></div>
    </div>
    <p>
      <button class="btn-primary" id="save-draft-btn">Save</button>
      <button class="btn-secondary" id="check-claims-btn">Check claims</button>
      <button class="btn-secondary" id="check-claims-deep-btn">Check in depth</button>
      <button class="btn-secondary" id="suggest-edits-btn">Suggest edits</button>
      <button class="btn-secondary" id="review-btn">Review</button>
    </p>
    <div id="draft-claims"></div>
    <h2>Suggestions</h2>
    <div id="draft-suggestions"></div>
  `;
  const textarea = $("#draft-content");
  const preview = $("#draft-preview");
  const claimsPanel = $("#draft-claims");
  const suggestionsPanel = $("#draft-suggestions");

  const updatePreview = () => {
    preview.innerHTML = renderCitations(textarea.value) || '<span class="muted">Nothing written yet.</span>';
    $$(".citation-chip", preview).forEach((chip) =>
      chip.addEventListener("click", () => showPaper(chip.dataset.docId))
    );
  };
  updatePreview();
  textarea.addEventListener("input", updatePreview);

  const save = async () => {
    await api(`/drafts/${relpath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.project, content: textarea.value }),
    });
  };

  $("#save-draft-btn").addEventListener(
    "click",
    wrapAsync(async () => {
      await save();
      setStatus(state.project, "Draft saved");
    })
  );

  const check = (depth) =>
    wrapAsync(async () => {
      await save();
      claimsPanel.innerHTML = '<p class="muted">Checking claims…</p>';
      const body = await api("/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, draft: relpath, depth }),
      });
      renderClaims(claimsPanel, relpath, body.claims);
      setStatus(state.project, `Claims checked (${depth})`);
    });

  $("#check-claims-btn").addEventListener("click", check("quick"));
  $("#check-claims-deep-btn").addEventListener("click", check("deep"));

  // Accepting a suggestion rewrites the draft, so the editor is reloaded
  // from disk rather than left showing the text before the change.
  const reloadDraft = async () => {
    const current = await api(`/drafts/${relpath}?project=${encodeURIComponent(state.project)}`);
    textarea.value = current.content;
    updatePreview();
  };

  const loadSuggestions = async () => {
    const body = await api(`/suggestions/${relpath}?project=${encodeURIComponent(state.project)}`);
    renderSuggestions(suggestionsPanel, relpath, body.suggestions, reloadDraft);
  };

  $("#suggest-edits-btn").addEventListener(
    "click",
    wrapAsync(async () => {
      await save();
      suggestionsPanel.innerHTML = '<p class="muted">Proposing revisions…</p>';
      const body = await api("/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: state.project, draft: relpath }),
      });
      await loadSuggestions();
      setStatus(state.project, `${body.suggestions.length} suggestion(s) proposed`);
    })
  );

  $("#review-btn").addEventListener(
    "click",
    wrapAsync(async () => {
      await save();
      await showReview(relpath);
    })
  );

  const existing = await api(`/align/${relpath}?project=${encodeURIComponent(state.project)}`);
  if (existing.claims.length) renderClaims(claimsPanel, relpath, existing.claims);
  await loadSuggestions();

  showView("draft");
}

async function createDraft() {
  const name = window.prompt("New draft filename (e.g. intro.md):");
  if (!name) return;
  const relpath = name.endsWith(".md") ? name : `${name}.md`;
  await api(`/drafts/${relpath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, content: "" }),
  });
  await refreshProjectSummary();
  showDraft(relpath);
}

// ---------------------------------------------------------------- ask

function showAsk() {
  $("#view-ask").innerHTML = `
    <h1>Ask</h1>
    <form id="ask-form">
      <label>Question
        <input type="text" id="ask-question" placeholder="What did the results section find?" required />
      </label>
      <label>Scope to one paper (optional)
        <select id="ask-doc">
          <option value="">Whole project</option>
          ${state.papers.map((p) => `<option value="${p.document_id}">${escapeHtml(p.title)}</option>`).join("")}
        </select>
      </label>
      <label>Passages
        <input type="number" id="ask-k" value="5" min="1" max="20" style="max-width:100px" />
      </label>
      <button type="submit">Ask</button>
    </form>
    <div id="ask-results"></div>
  `;
  $("#ask-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const results = $("#ask-results");
    results.innerHTML = '<p class="muted">Searching…</p>';
    const body = await api("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.project,
        question: $("#ask-question").value,
        document_id: $("#ask-doc").value || null,
        k: Number($("#ask-k").value) || 5,
      }),
    });
    renderAskResults(body);
  });
  setActiveNavItem($('.nav-item[data-view="ask"]'));
  showView("ask");
}

function renderAskResults(body) {
  const results = $("#ask-results");
  let html = "";
  if (body.answer) {
    html += `<h2>Answer</h2><p>${escapeHtml(body.answer)}</p>`;
  } else if (body.passages.length) {
    html += `<p class="muted">No Generator configured. Showing ranked passages.</p>`;
  }
  if (!body.passages.length) {
    html += `<p class="muted">No results. Index the project before searching it.</p>`;
  } else {
    html += "<h2>Passages</h2>";
    for (const passage of body.passages) {
      html += `<div class="passage">
        <div class="meta">${(passage.score).toFixed(3)} · ${escapeHtml(passage.section_path || "(unsectioned)")} · ${escapeHtml(paperTitle(passage.document_id))}</div>
        <div>${escapeHtml(passage.text)}</div>
      </div>`;
    }
  }
  results.innerHTML = html;
}

// --------------------------------------------------------------- wiring

function reportError(err) {
  console.error(err);
  setStatus("", "");
  const main = $("#main");
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = err.message || String(err);
  main.prepend(banner);
  setTimeout(() => banner.remove(), 6000);
}

// ------------------------------------------------------- process record

// What was proposed, what was declined, and what was decided. The
// declined half is gated on a separate permission, so a reader without it
// sees an empty list rather than an error.
async function showProcessRecord(relpath) {
  const who = state.actor || "";
  const query = `project=${encodeURIComponent(state.project)}${who ? `&actor=${encodeURIComponent(who)}` : ""}`;
  const record = await api(`/process-record/${relpath}?${query}`);

  const decisions = record.decisions
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.claim)}</td>
        <td>${escapeHtml(paperTitle(d.citation))}</td>
        <td>${escapeHtml(d.decision)}</td>
        <td>${escapeHtml(d.reviewer)}</td>
        <td>${escapeHtml(d.recorded || "")}</td>
      </tr>`
    )
    .join("");

  const suggestions = (entries, empty) =>
    entries.length
      ? `<ul>${entries
          .map(
            (s) =>
              `<li><span class="muted">${escapeHtml(s.current || "")}</span><br />${escapeHtml(s.proposed || "")}</li>`
          )
          .join("")}</ul>`
      : `<p class="muted">${empty}</p>`;

  $("#view-review").innerHTML = `
    <h1>Process record: ${escapeHtml(relpath)}</h1>
    <p class="muted">Every decision recorded against this draft, and every revision proposed for it.</p>
    <h2>Decisions</h2>
    <table>
      <thead><tr><th>Claim</th><th>Cites</th><th>Decision</th><th>Reviewer</th><th>Recorded</th></tr></thead>
      <tbody>${decisions || '<tr><td colspan="5" class="muted">None recorded.</td></tr>'}</tbody>
    </table>
    <h2>Revisions accepted</h2>
    ${suggestions(record.accepted, "None accepted.")}
    <h2>Revisions declined</h2>
    ${suggestions(record.rejected, "None declined, or not visible to you.")}
    <p><button class="btn-secondary" id="back-to-review">Back to review</button></p>
  `;
  $("#back-to-review").addEventListener("click", wrapAsync(() => showReview(relpath)));
  showView("review");
}

// ------------------------------------------------------------- settings

// Roles are a strictly nested ladder: each rank holds every permission of
// the rank below it and at least one more. The count is shown rather than
// the list, which runs to dozens.
async function showSettings() {
  const settings = await api(
    `/projects/settings?project=${encodeURIComponent(state.project)}`
  );
  const roleOptions = settings.roles
    .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`)
    .join("");

  const roleRows = settings.roles
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${r.rank}</td>
        <td>${r.permissions.length}</td>
      </tr>`
    )
    .join("");

  const memberRows = settings.members.length
    ? settings.members
        .map(
          (m) => `<tr>
            <td>${escapeHtml(m.name)}</td>
            <td>
              <select class="member-role" data-name="${escapeHtml(m.name)}">
                ${roleOptions.replace(`value="${escapeHtml(m.role)}"`, `value="${escapeHtml(m.role)}" selected`)}
              </select>
            </td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="2" class="muted">No members yet.</td></tr>';

  $("#view-settings").innerHTML = `
    <h1>Settings</h1>
    <h2>Ownership</h2>
    <p>Owner: <strong>${escapeHtml(settings.owner || "(unset)")}</strong></p>
    <p class="muted">Successors, in order: ${escapeHtml(settings.successors.join(", ") || "none")}</p>
    <h2>Acting as</h2>
    <p class="muted">Review decisions and annotations are recorded against this name.</p>
    <p><input type="text" id="actor-input" value="${escapeHtml(state.actor)}" placeholder="your name" /></p>
    <h2>Roles</h2>
    <table>
      <thead><tr><th>Role</th><th>Rank</th><th>Permissions</th></tr></thead>
      <tbody>${roleRows}</tbody>
    </table>
    <h2>Members</h2>
    <table>
      <thead><tr><th>Name</th><th>Role</th></tr></thead>
      <tbody>${memberRows}</tbody>
    </table>
    <form id="add-member-form">
      <input type="text" id="member-name" placeholder="name" required />
      <select id="member-role">${roleOptions}</select>
      <button type="submit">Add or update</button>
    </form>
    <h2>Required reviews</h2>
    <p class="muted">${escapeHtml(settings.required_reviews.join(", ") || "none")}</p>
  `;

  $("#actor-input").addEventListener("change", (event) => {
    state.actor = event.target.value.trim();
    setStatus(state.project, state.actor ? `Acting as ${state.actor}` : "");
  });

  $("#add-member-form").addEventListener(
    "submit",
    wrapAsync(async (event) => {
      event.preventDefault();
      await setMemberRole($("#member-name").value.trim(), $("#member-role").value);
    })
  );

  $$(".member-role").forEach((select) =>
    select.addEventListener(
      "change",
      wrapAsync(() => setMemberRole(select.dataset.name, select.value))
    )
  );

  showView("settings");
}

async function setMemberRole(name, role) {
  if (!name) return;
  await api("/projects/members", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: state.project, name, role }),
  });
  setStatus(state.project, `${name} is now ${role}`);
  await showSettings();
}

function wrapAsync(fn) {
  return (...args) => Promise.resolve(fn(...args)).catch(reportError);
}

document.addEventListener("DOMContentLoaded", () => {
  $("#open-project-form").addEventListener(
    "submit",
    wrapAsync(async (event) => {
      event.preventDefault();
      const path = $("#open-project-path").value.trim();
      const name = $("#open-project-name").value.trim();
      await openProject(path, name || undefined);
    })
  );

  $("#switch-project-btn").addEventListener(
    "click",
    wrapAsync(async () => {
      state.project = null;
      $("#sidebar").hidden = true;
      $("#project-name").textContent = "No project open";
      setStatus("", "");
      showView("launcher");
      await refreshRecentProjects();
      await suggestProjectPath();
    })
  );

  $('.nav-item[data-view="ask"]').addEventListener("click", () => showAsk());
  $("#new-note-btn").addEventListener("click", wrapAsync(createNote));
  $("#new-draft-btn").addEventListener("click", wrapAsync(createDraft));

  $("#settings-nav-btn").addEventListener(
    "click",
    wrapAsync(async (event) => {
      setActiveNavItem(event.target);
      await showSettings();
    })
  );

  // Dropping PDFs anywhere in the window adds them. A dropped folder
  // cannot be read this way, so only files are taken.
  const dropZone = $("#app");
  dropZone.addEventListener("dragover", (event) => {
    if (!state.project) return;
    event.preventDefault();
    dropZone.classList.add("dropping");
  });
  ["dragleave", "dragend", "drop"].forEach((name) =>
    dropZone.addEventListener(name, () => dropZone.classList.remove("dropping"))
  );
  dropZone.addEventListener(
    "drop",
    wrapAsync(async (event) => {
      if (!state.project) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
        f.name.toLowerCase().endsWith(".pdf")
      );
      if (!files.length) {
        setStatus(state.project, "Only PDFs can be added by dropping them.");
        return;
      }
      await addPapers(files);
    })
  );

  const paperInput = $("#paper-file-input");
  $("#add-paper-btn").addEventListener("click", () => paperInput.click());
  paperInput.addEventListener(
    "change",
    wrapAsync(async () => {
      const files = Array.from(paperInput.files || []);
      // Cleared before the upload so that choosing the same file again
      // still raises a change event.
      paperInput.value = "";
      await addPapers(files);
    })
  );

  wrapAsync(async () => {
    await refreshRecentProjects();
    await suggestProjectPath();
  })();
});
