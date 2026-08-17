// Shared state, DOM helpers, and the API client.

export const state = {
  project: null,
  projectName: "",
  actor: "",
  view: "launcher",
  papers: [],
  notes: [],
  drafts: [],
  // Folders are carried separately from pages: an empty one holds no page
  // to find it by.
  folders: { notes: [], drafts: [] },
  busy: false,
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function projectQuery(extra = {}) {
  return query({ project: state.project, ...extra });
}

export async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      /* response carried no JSON body */
    }
    const error = new Error(detail);
    error.status = response.status;
    error.path = path;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

/* --- Status bar ---------------------------------------------------------- */

export function setStatus(left, right) {
  if (left !== undefined) $("#status-left").textContent = left ?? "";
  if (right !== undefined) $("#status-right").textContent = right ?? "";
}

// Nothing under 150ms: retrieval takes 38ms, and a spinner for one frame
// makes a fast operation feel unreliable.
const PROGRESS_DELAY = 150;

export function progress(label, { done = null, total = null } = {}) {
  const host = $("#status-progress");
  clearTimeout(host._timer);
  if (label === null) {
    host.replaceChildren();
    return;
  }
  const render = () => {
    const parts = [];
    if (total === null) {
      parts.push(el("span", { class: "spinner" }));
    } else {
      const fill = el("div", { class: "bar__fill" });
      fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      parts.push(el("div", { class: "bar" }, fill));
      parts.push(el("span", { class: "small", text: `${done} of ${total}` }));
    }
    if (label) parts.push(el("span", { class: "small", text: label }));
    host.replaceChildren(...parts);
  };
  if (host.childElementCount) render();
  else host._timer = setTimeout(render, PROGRESS_DELAY);
}

export function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
}

/* --- Errors -------------------------------------------------------------- */

// Errors persist until dismissed. A message that vanishes is one the
// reader is not permitted to re-read.
const log = [];

export function errorLog() {
  return log.slice();
}

export function reportError(error, { title = null, action = null } = {}) {
  const text = error?.message ?? String(error);
  log.push({ text, at: new Date().toISOString() });

  const banner = el("div", { class: "banner", role: "alert" }, [
    el("div", { class: "banner__body" }, [
      el("div", { class: "banner__title", text: title || "Something failed" }),
      el("div", { class: "banner__detail", text }),
    ]),
  ]);
  if (action) {
    banner.append(el("button", { class: "btn", onclick: action.run, text: action.label }));
  }
  banner.append(
    el("button", {
      class: "btn-quiet",
      title: "Dismiss",
      text: "✕",
      onclick: () => banner.remove(),
    })
  );
  $("#error-stack").append(banner);
}

export function notice(message, { title = "Note" } = {}) {
  const banner = el("div", { class: "banner banner--caution" }, [
    el("div", { class: "banner__body" }, [
      el("div", { class: "banner__title", text: title }),
      el("div", { class: "banner__detail", text: message }),
    ]),
    el("button", {
      class: "btn-quiet",
      title: "Dismiss",
      text: "✕",
      onclick: (event) => event.target.closest(".banner").remove(),
    }),
  ]);
  $("#error-stack").append(banner);
}

export function guard(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((error) => reportError(error));
}
