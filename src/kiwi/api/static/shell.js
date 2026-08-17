// The frame: an activity bar, three panels, and the tab model the centre
// and the right panel share.
//
// A panel is a header and a body. A tabbed panel is the same with a strip
// of tabs for its header, so the centre and the right panel are one
// component with different contents. The left panel holds one thing at a
// time, chosen from the activity bar, and so needs no strip.

import { $, $$, el, state } from "./core.js";

/* --- Icons ---------------------------------------------------------------- */

// 16px grid, currentColor, hollow unless the shape needs a fill to read.
const ICONS = {
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  explorer:
    '<path d="M2.5 3.5h4l1.2 1.6h5.8v7.4h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  search:
    '<circle cx="7.2" cy="7.2" r="4.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.4 10.4 13.3 13.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  review:
    '<path d="M3 8.2 6.3 11.5 13 4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  references:
    '<path d="M6.6 9.4 9.4 6.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M7.4 4.6 8.8 3.2a2.6 2.6 0 0 1 3.7 3.7L11.1 8.3M8.6 11.4 7.2 12.8a2.6 2.6 0 0 1-3.7-3.7L4.9 7.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  gear: '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.2v1.9M8 11.9v1.9M13.8 8h-1.9M4.1 8H2.2M12.1 3.9l-1.3 1.3M5.2 10.8l-1.3 1.3M12.1 12.1l-1.3-1.3M5.2 5.2 3.9 3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  person:
    '<circle cx="8" cy="5.8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.2 13.4a4.8 4.8 0 0 1 9.6 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  left: '<path d="M9.6 3.6 5.2 8l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  right: '<path d="M6.4 3.6 10.8 8l-4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  dots: '<circle cx="3.4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.6" cy="8" r="1.2" fill="currentColor"/>',
  close:
    '<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  chevron:
    '<path d="M5.4 6.6 8 9.2l2.6-2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  paper:
    '<path d="M3.5 2.5h6l3 3v8h-9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.3 2.6v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  note: '<path d="M3.5 3.5h9v9h-9z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 6.3h4.8M5.6 8.6h4.8M5.6 10.4h2.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  draft:
    '<path d="M3.4 12.6h9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4.6 10.2 10.7 4.1l1.6 1.6-6.1 6.1-2.1.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  home: '<path d="M2.6 7.6 8 3l5.4 4.6M4.4 8.8v4.6h7.2V8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
};

export function svg(name, size = 16) {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

export function iconEl(name, size = 16) {
  const node = el("span", { class: "icon" });
  node.innerHTML = svg(name, size);
  return node;
}

export function paintIcons(root = document) {
  for (const holder of $$("[data-icon]", root)) {
    if (!holder.dataset.painted) {
      holder.innerHTML = svg(holder.dataset.icon);
      holder.dataset.painted = "yes";
    }
  }
}

/* --- Layout --------------------------------------------------------------- */

const LIMITS = { left: [180, 520], right: [260, 640] };

export const layout = {
  leftOpen: true,
  leftView: "explorer",
  rightOpen: false,
  leftWidth: 260,
  rightWidth: 360,
};

export function restoreLayout() {
  try {
    Object.assign(layout, JSON.parse(localStorage.getItem("kiwi-layout") || "{}"));
  } catch {
    /* first run, or a layout written by an older build */
  }
  applyLayout();
}

function saveLayout() {
  localStorage.setItem("kiwi-layout", JSON.stringify(layout));
}

export function applyLayout() {
  const left = $("#panel-left");
  const right = $("#panel-right");
  left.hidden = !layout.leftOpen;
  $("#resize-left").hidden = !layout.leftOpen;
  right.hidden = !layout.rightOpen;
  $("#resize-right").hidden = !layout.rightOpen;
  left.style.width = `${layout.leftWidth}px`;
  right.style.width = `${layout.rightWidth}px`;
  for (const button of $$(".activity[data-view]")) {
    button.classList.toggle(
      "active",
      layout.leftOpen && button.dataset.view === layout.leftView
    );
  }
  saveLayout();
}

// Clicking the selected item collapses the panel; clicking another swaps
// what it holds. The panel never shows two things at once.
export function selectLeft(name) {
  if (layout.leftOpen && layout.leftView === name) {
    layout.leftOpen = false;
  } else {
    layout.leftView = name;
    layout.leftOpen = true;
  }
  applyLayout();
  if (layout.leftOpen) renderLeft();
}

export function showLeft(name) {
  layout.leftView = name;
  layout.leftOpen = true;
  applyLayout();
  renderLeft();
}

export function toggleLeft() {
  layout.leftOpen = !layout.leftOpen;
  applyLayout();
  if (layout.leftOpen) renderLeft();
}

export function toggleRight(open = null) {
  layout.rightOpen = open === null ? !layout.rightOpen : open;
  applyLayout();
  if (layout.rightOpen) ai.draw();
}

const leftViews = new Map();

export function registerLeft(name, { title, render, actions = null }) {
  leftViews.set(name, { title, render, actions });
}

export function renderLeft() {
  const view = leftViews.get(layout.leftView);
  if (!view) return;
  $("#left-title").textContent = view.title;
  $("#left-actions").replaceChildren(...(view.actions ? view.actions() : []));
  const body = $("#left-body");
  body.replaceChildren();
  view.render(body);
}

function wireResizer(id, side) {
  const bar = $(id);
  const [min, max] = LIMITS[side];
  bar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    bar.setPointerCapture(event.pointerId);
    const move = (moved) => {
      const panel = $(side === "left" ? "#panel-left" : "#panel-right");
      const box = panel.getBoundingClientRect();
      const width = side === "left" ? moved.clientX - box.left : box.right - moved.clientX;
      const clamped = Math.min(Math.max(Math.round(width), min), max);
      layout[side === "left" ? "leftWidth" : "rightWidth"] = clamped;
      panel.style.width = `${clamped}px`;
    };
    const stop = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", stop);
      saveLayout();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", stop);
  });
}

export function wireResizers() {
  wireResizer("#resize-left", "left");
  wireResizer("#resize-right", "right");
}

/* --- Tabs ----------------------------------------------------------------- */

// One implementation, two instances. A tab owns its body element, so
// switching away keeps its scroll position and its unsaved text.
class TabbedPanel {
  constructor({ strip, body, onChange = null, empty = null }) {
    this.strip = strip;
    this.body = body;
    this.onChange = onChange;
    // Closing the last tab leaves the panel empty rather than reopening
    // something the reader just dismissed.
    this.empty = empty;
    this.placeholder = null;
    this.tabs = [];
    this.activeId = null;
  }

  drawEmpty() {
    if (!this.empty) return;
    if (!this.placeholder) {
      this.placeholder = el("div", { class: "tabbody" });
      this.body.append(this.placeholder);
    }
    this.placeholder.hidden = this.tabs.length > 0;
    if (!this.tabs.length) {
      this.placeholder.replaceChildren();
      this.empty(this.placeholder);
    }
  }

  find(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  open(spec) {
    const existing = this.find(spec.id);
    if (existing) {
      this.activate(existing.id);
      return existing;
    }
    const tab = {
      dirty: false,
      closable: true,
      icon: null,
      ...spec,
      host: el("div", { class: "tabbody" }),
      rendered: false,
    };
    this.tabs.push(tab);
    this.body.append(tab.host);
    this.activate(tab.id);
    this.drawEmpty();
    return tab;
  }

  activate(id) {
    const tab = this.find(id);
    if (!tab) return;
    this.activeId = id;
    for (const other of this.tabs) other.host.hidden = other.id !== id;
    if (!tab.rendered) {
      tab.rendered = true;
      tab.render(tab.host, tab);
    } else if (tab.refresh) {
      tab.refresh(tab.host, tab);
    }
    this.draw();
    if (this.onChange) this.onChange(tab);
  }

  active() {
    return this.find(this.activeId);
  }

  async close(id) {
    const tab = this.find(id);
    if (!tab || tab.closable === false) return;
    if (tab.beforeClose && (await tab.beforeClose(tab)) === false) return;
    if (tab.dispose) tab.dispose(tab);
    tab.host.remove();
    const at = this.tabs.indexOf(tab);
    this.tabs.splice(at, 1);
    if (this.activeId === id) {
      const next = this.tabs[Math.min(at, this.tabs.length - 1)];
      this.activeId = null;
      if (next) this.activate(next.id);
      else if (this.onChange) this.onChange(null);
    }
    this.draw();
    this.drawEmpty();
  }

  async closeAll({ keep = () => false } = {}) {
    for (const tab of this.tabs.slice()) {
      if (tab.closable === false || keep(tab)) continue;
      await this.close(tab.id);
    }
  }

  step(delta) {
    if (this.tabs.length < 2) return;
    const at = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (at + delta + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  // Dragging a tab moves it. The order is the reader's, not the order
  // they happened to open things in.
  move(id, to) {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0 || to < 0 || from === to) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.draw();
  }

  markDirty(id, dirty) {
    const tab = this.find(id);
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.draw();
  }

  draw() {
    this.strip.replaceChildren(
      ...this.tabs.map((tab) => {
        const node = el(
          "div",
          {
            class: `tab${tab.id === this.activeId ? " active" : ""}${tab.dirty ? " dirty" : ""}`,
            role: "tab",
            tabindex: "0",
            title: tab.tooltip || tab.title,
            onclick: () => this.activate(tab.id),
            onkeydown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                this.activate(tab.id);
              }
            },
            onauxclick: (event) => {
              if (event.button === 1) this.close(tab.id);
            },
            oncontextmenu: (event) => {
              event.preventDefault();
              openMenuAtPoint(
                event.clientX,
                event.clientY,
                [
                  { name: "Close", when: () => tab.closable !== false, run: () => this.close(tab.id) },
                  {
                    name: "Close others",
                    run: () => this.closeAll({ keep: (other) => other.id === tab.id }),
                  },
                  { name: "Close all", run: () => this.closeAll() },
                ],
                { onRun: (item) => item.run?.() }
              );
            },
          },
          [
            tab.icon ? iconEl(tab.icon, 14) : null,
            el("span", { class: "tab__title", text: tab.title }),
          ]
        );
        node.draggable = true;
        node.addEventListener("dragstart", (event) => {
          event.dataTransfer.setData("text/plain", tab.id);
          event.dataTransfer.effectAllowed = "move";
          node.classList.add("tab--dragging");
        });
        node.addEventListener("dragend", () => node.classList.remove("tab--dragging"));
        node.addEventListener("dragover", (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          node.classList.add("tab--drop");
        });
        node.addEventListener("dragleave", () => node.classList.remove("tab--drop"));
        node.addEventListener("drop", (event) => {
          event.preventDefault();
          node.classList.remove("tab--drop");
          this.move(event.dataTransfer.getData("text/plain"), this.tabs.indexOf(tab));
        });

        if (tab.closable !== false) {
          const close = el("button", {
            class: "tab__close",
            title: "Close",
            onclick: (event) => {
              event.stopPropagation();
              this.close(tab.id);
            },
          });
          close.innerHTML = svg("close", 12);
          node.append(close);
        }
        // The dot replaces the close control until the pointer is over
        // the tab, so an unsaved file is visible without hunting.
        if (tab.dirty) node.append(el("span", { class: "tab__dot", title: "Unsaved" }));
        return node;
      })
    );

    // A strip narrower than its tabs can leave the selected one off the
    // end, so the panel shows one thing and its header names another.
    //
    // Scrolled by hand rather than through scrollIntoView, which walks
    // every scrollable ancestor. draw() runs on each save, so anything
    // that moves an ancestor here jitters the page while typing.
    const active = this.strip.querySelector(".tab.active");
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < this.strip.scrollLeft) {
      this.strip.scrollLeft = left;
    } else if (right > this.strip.scrollLeft + this.strip.clientWidth) {
      this.strip.scrollLeft = right - this.strip.clientWidth;
    }
  }
}

export const centre = new TabbedPanel({
  strip: null,
  body: null,
});

export const ai = new TabbedPanel({ strip: null, body: null });

export function wirePanels({ onCentreChange = null, onCentreEmpty = null } = {}) {
  centre.strip = $("#tabs");
  centre.body = $("#center-body");
  centre.onChange = onCentreChange;
  centre.empty = onCentreEmpty;
  ai.strip = $("#ai-tabs");
  ai.body = $("#ai-body");
  $("#tab-prev").addEventListener("click", () => centre.step(-1));
  $("#tab-next").addEventListener("click", () => centre.step(1));
  $("#ai-close").addEventListener("click", () => toggleRight(false));
}

/* --- Menus ---------------------------------------------------------------- */

// A menu is a list of items; an item with a submenu opens it to the right
// on hover. One layer holds whichever menu is open, so opening a second
// closes the first.
let openMenu = null;

export function closeMenus() {
  const layer = $("#menu-layer");
  layer.hidden = true;
  layer.replaceChildren();
  openMenu = null;
}

export function isMenuOpen() {
  return Boolean(openMenu);
}

function buildMenu(items, { onRun }) {
  const list = el("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      list.append(el("div", { class: "menu__sep" }));
      continue;
    }
    const enabled = item.when ? item.when() : true;
    const node = el(
      "div",
      {
        class: `menu__item${item.items ? " menu__item--parent" : ""}${enabled ? "" : " disabled"}`,
        role: "menuitem",
        tabindex: enabled ? "0" : null,
      },
      [
        el("span", { class: "menu__label", text: item.name }),
        item.keys?.length ? el("span", { class: "kbd", text: item.keys[0] }) : null,
        item.items ? iconEl("right", 12) : null,
      ]
    );

    if (item.items) {
      let child = null;
      const openChild = () => {
        if (child) return;
        // One submenu at a time: opening this one closes whichever
        // sibling was open.
        for (const open of list.querySelectorAll(".menu--child")) open.remove();
        child = buildMenu(item.items, { onRun });
        child.classList.add("menu--child");
        node.append(child);
        const box = node.getBoundingClientRect();
        // Flip to the left when the submenu would leave the window.
        if (box.right + 220 > window.innerWidth) child.classList.add("menu--flip");
      };
      const closeChild = () => {
        child?.remove();
        child = null;
      };
      // Hover and an explicit key open the submenu. Focus alone does not:
      // the first item takes focus when the menu opens, and a submenu
      // that comes with it hides the list the reader is choosing from.
      node.addEventListener("mouseenter", openChild);
      node.addEventListener("mouseleave", closeChild);
      node.addEventListener("click", openChild);
      node.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "Enter") {
          event.preventDefault();
          openChild();
          child?.querySelector(".menu__item")?.focus();
        } else if (event.key === "ArrowLeft") {
          closeChild();
        }
      });
    } else if (enabled) {
      const run = () => {
        closeMenus();
        onRun(item);
      };
      node.addEventListener("click", run);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter") run();
      });
    }
    list.append(node);
  }
  return list;
}

export function openMenuAt(anchor, items, { onRun }) {
  if (openMenu === anchor) {
    closeMenus();
    return;
  }
  closeMenus();
  const layer = $("#menu-layer");
  const menu = buildMenu(items, { onRun });
  menu.classList.add("menu--root");
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(box.right + 2)}px`;
  menu.style.top = `${Math.round(box.top)}px`;
  layer.replaceChildren(menu);
  layer.hidden = false;
  openMenu = anchor;

  // Placed, then measured: a menu near the bottom is lifted rather than
  // clipped.
  const menuBox = menu.getBoundingClientRect();
  if (menuBox.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, window.innerHeight - menuBox.height - 8)}px`;
  }
  menu.querySelector(".menu__item")?.focus();
}

// A menu at the pointer. Same component, so a right-click and the ☰ bar
// present the same list in the same shape.
export function openMenuAtPoint(x, y, items, { onRun }) {
  closeMenus();
  const layer = $("#menu-layer");
  const menu = buildMenu(items, { onRun });
  menu.classList.add("menu--root");
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  layer.replaceChildren(menu);
  layer.hidden = false;
  openMenu = menu;

  const box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - box.width - 8)}px`;
  }
  if (box.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, window.innerHeight - box.height - 8)}px`;
  }
  menu.querySelector(".menu__item")?.focus();
}

// Right-click anywhere that names its own actions. The browser menu is
// left alone everywhere else, including inside the editor and the PDF.
export function onContextMenu(element, items) {
  element.addEventListener("contextmenu", (event) => {
    const list = typeof items === "function" ? items() : items;
    if (!list || !list.length) return;
    event.preventDefault();
    event.stopPropagation();
    openMenuAtPoint(event.clientX, event.clientY, list, {
      onRun: (item) => item.run?.(),
    });
  });
  return element;
}

export function openMenuBelow(anchor, items, { onRun }) {
  openMenuAt(anchor, items, { onRun });
  const menu = $(".menu--root");
  if (!menu) return;
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.min(box.left, window.innerWidth - 240))}px`;
  menu.style.top = `${Math.round(box.bottom + 2)}px`;
}

document.addEventListener("mousedown", (event) => {
  if (!openMenu) return;
  if (!event.target.closest(".menu") && !event.target.closest(".activity")) closeMenus();
});

export { state };
