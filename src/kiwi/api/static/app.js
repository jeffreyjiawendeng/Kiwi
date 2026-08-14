"use strict";

// Frontend for Kiwi's local HTTP API. No build step, no framework.

const state = {
  project: null, // absolute path string, or null
  papers: [],
  notes: [],
  drafts: [],
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
  showAsk();
}

async function refreshProjectSummary() {
  const summary = await api(`/projects/summary?project=${encodeURIComponent(state.project)}`);
  state.papers = summary.papers;
  state.notes = summary.notes;
  state.drafts = summary.drafts;
  renderSidebarLists();
}

function paperTitle(documentId) {
  const paper = state.papers.find((p) => p.document_id === documentId);
  return paper ? paper.title : documentId;
}

function renderSidebarLists() {
  const papersList = $("#papers-list");
  papersList.innerHTML = "";
  for (const paper of state.papers) {
    const li = document.createElement("li");
    const badgeClass = paper.verification === "resolved" ? "resolved" : paper.verification === "issues" ? "issues" : "";
    li.innerHTML = `${escapeHtml(paper.title)}${badgeClass ? `<span class="badge ${badgeClass}">${paper.verification}</span>` : ""}`;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showPaper(paper.document_id);
    });
    papersList.appendChild(li);
  }

  const notesList = $("#notes-list");
  notesList.innerHTML = "";
  for (const relpath of state.notes) {
    const li = document.createElement("li");
    li.textContent = relpath;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showNote(relpath);
    });
    notesList.appendChild(li);
  }

  const draftsList = $("#drafts-list");
  draftsList.innerHTML = "";
  for (const relpath of state.drafts) {
    const li = document.createElement("li");
    li.textContent = relpath;
    li.addEventListener("click", () => {
      setActiveNavItem(li);
      showDraft(relpath);
    });
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
      const status = match ? match.status : "unresolved";
      return `<tr>
        <td>${escapeHtml(ref.title || ref.raw)}</td>
        <td>${ref.year ?? ""}</td>
        <td>${escapeHtml(ref.doi || "")}</td>
        <td><span class="status-pill ${status}">${status}</span></td>
      </tr>`;
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
    </p>
    <h2>Sections</h2>
    <ul>${paper.sections.map((s) => `<li>${"&nbsp;&nbsp;".repeat(s.level - 1)}${escapeHtml(s.title || s.path)}</li>`).join("")}</ul>
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
  showView("paper");
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
    1: "is the origin of this",
  },
};

function scoreLabel(intent, score) {
  const scale = SCORE_LABEL[intent] || SCORE_LABEL.evidence;
  return scale[score] ?? "scored";
}

// The class sets the emphasis: flagged, plain, or silent.
function scoreClass(intent, score) {
  if (intent === "attribution") return score === 1 ? "score-2" : "score-0";
  return `score-${score}`;
}
const INTENTS = ["evidence", "attribution", "background", "methods", "contrast"];

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

  const evidence = shown && shown.evidence
    ? `<div class="claim-evidence">${escapeHtml(shown.evidence.exact)}</div>`
    : '<div class="claim-evidence muted">No passage was read for this claim.</div>';

  return `<div class="claim ${cls}" data-claim="${escapeHtml(claim.anchor.exact)}" data-citation="${escapeHtml(claim.citation)}">
    <div class="claim-text">${escapeHtml(claim.anchor.exact)}</div>
    <div class="claim-meta">
      ${shown ? `<strong>${escapeHtml(paperTitle(claim.citation))}</strong> ${escapeHtml(scoreLabel(claim.intent, shown.score))}` : `<strong>${escapeHtml(paperTitle(claim.citation))}</strong> not scored`}
      ${stale}
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
    </p>
    <div id="draft-claims"></div>
  `;
  const textarea = $("#draft-content");
  const preview = $("#draft-preview");
  const claimsPanel = $("#draft-claims");

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

  const existing = await api(`/align/${relpath}?project=${encodeURIComponent(state.project)}`);
  if (existing.claims.length) renderClaims(claimsPanel, relpath, existing.claims);

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
    })
  );

  $('.nav-item[data-view="ask"]').addEventListener("click", () => showAsk());
  $("#new-note-btn").addEventListener("click", wrapAsync(createNote));
  $("#new-draft-btn").addEventListener("click", wrapAsync(createDraft));

  wrapAsync(refreshRecentProjects)();
});
