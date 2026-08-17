// One table defines every binding, so a remapping layer can be added
// without rewriting handlers.

import { $, el, state } from "./core.js";

const commands = [];
let paletteOpen = false;

export function register(list) {
  commands.push(...list);
}

export function allCommands() {
  return commands.slice();
}

function typing(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
}

function combo(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join("+");
}

export function attach() {
  document.addEventListener("keydown", (event) => {
    if (paletteOpen) return;
    const pressed = combo(event);

    // Modifiers when text can be typed; bare letters only when it cannot.
    const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (bare && typing(event.target)) return;

    // Several commands share a key and are told apart by where focus is,
    // so the first match that also applies wins, not the first match.
    const command = commands.find(
      (c) => (c.keys || []).includes(pressed) && (!c.when || c.when())
    );
    if (!command) return;
    event.preventDefault();
    command.run();
  });
}

/* --- Command palette ------------------------------------------------------ */

export function openPalette(filterTo = null) {
  if (paletteOpen) return;
  paletteOpen = true;

  const pool = filterTo ? filterTo() : commands.filter((c) => !c.hidden);
  let matches = pool;
  let active = 0;

  const list = el("div", { class: "palette__list" });
  const input = el("input", {
    class: "palette__input",
    type: "text",
    placeholder: filterTo ? "Go to…" : "Run a command…",
    oninput: () => {
      const needle = input.value.trim().toLowerCase();
      matches = pool.filter((c) => c.name.toLowerCase().includes(needle));
      active = 0;
      draw();
    },
  });

  function draw() {
    list.replaceChildren(
      ...matches.slice(0, 40).map((command, i) =>
        el(
          "button",
          {
            class: `palette__item${i === active ? " active" : ""}`,
            onclick: () => {
              close();
              command.run();
            },
          },
          [
            el("span", { text: command.name }),
            command.keys?.length ? el("span", { class: "kbd", text: command.keys[0] }) : null,
          ]
        )
      )
    );
    if (!matches.length) {
      list.replaceChildren(el("div", { class: "palette__group", text: "No matches" }));
    }
  }

  const panel = el("div", { class: "palette", role: "dialog", "aria-modal": "true" }, [input, list]);
  const overlay = $("#overlay");
  overlay.replaceChildren(panel);
  overlay.hidden = false;

  function close() {
    paletteOpen = false;
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      draw();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[active];
      if (command) {
        close();
        command.run();
      }
    }
  });

  overlay.addEventListener("mousedown", function once(event) {
    if (event.target === overlay) {
      close();
      overlay.removeEventListener("mousedown", once);
    }
  });

  draw();
  input.focus();
}

/* --- Shortcut reference --------------------------------------------------- */

export function showShortcuts() {
  const rows = commands
    .filter((c) => c.keys?.length && !c.hidden)
    .map((c) =>
      el("tr", {}, [
        el("td", { text: c.name }),
        el("td", { style: "width:14ch" }, el("span", { class: "kbd", text: c.keys[0] })),
      ])
    );

  const panel = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" }, [
    el("h2", { text: "Keyboard" }),
    el("table", {}, el("tbody", {}, rows)),
    el("div", { class: "dialog__actions" }, [
      el("button", { class: "btn btn--primary", text: "Close", onclick: closeOverlay }),
    ]),
  ]);
  const overlay = $("#overlay");
  overlay.replaceChildren(panel);
  overlay.hidden = false;
}

export function closeOverlay() {
  const overlay = $("#overlay");
  overlay.hidden = true;
  overlay.replaceChildren();
  paletteOpen = false;
}

/* --- Dialogs -------------------------------------------------------------- */

const FOCUSABLE = "button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

// Focus is trapped, Esc cancels, and focus returns where it was. Every
// dialog in the interface is built from this one.
export function openDialog(build, { cancelWith = null } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const panel = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" });
    const initial = build(panel, finish);

    const overlay = $("#overlay");
    overlay.replaceChildren(panel);
    overlay.hidden = false;
    (initial || panel.querySelector(FOCUSABLE))?.focus();

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(cancelWith);
      } else if (event.key === "Tab") {
        const focusable = Array.from(panel.querySelectorAll(FOCUSABLE));
        if (!focusable.length) return;
        const i = focusable.indexOf(document.activeElement);
        event.preventDefault();
        focusable[(i + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
      }
    }
    document.addEventListener("keydown", onKey, true);

    function finish(result) {
      document.removeEventListener("keydown", onKey, true);
      closeOverlay();
      if (previous?.isConnected) previous.focus();
      resolve(result);
    }
  });
}

// For consequences beyond the object itself. The destructive action is
// never the initial focus.
export function confirmDialog({ title, body, confirmLabel = "Delete", danger = true }) {
  return openDialog((panel, finish) => {
    const cancel = el("button", { class: "btn", text: "Cancel", onclick: () => finish(false) });
    panel.append(
      el("h2", { text: title }),
      ...[].concat(body).map((line) => el("p", { text: line })),
      el("div", { class: "dialog__actions" }, [
        cancel,
        el("button", {
          class: `btn ${danger ? "btn--danger" : "btn--primary"}`,
          text: confirmLabel,
          onclick: () => finish(true),
        }),
      ])
    );
    return cancel;
  }, { cancelWith: false });
}

// Replaces prompt(), which cannot be styled and reads as a browser fault
// rather than part of the application.
export function promptDialog({ title, label, value = "", confirmLabel = "Create", body = null }) {
  return openDialog((panel, finish) => {
    const field = el("input", { class: "input", type: "text", value });
    field.style.width = "100%";
    const form = el("form", {
      onsubmit: (event) => {
        event.preventDefault();
        finish(field.value.trim() || null);
      },
    });
    // append() writes a null child as the text "null". The DOM helper
    // drops them; this call has to do it itself.
    form.append(
      ...[
        el("h2", { text: title }),
        body ? el("p", { text: body }) : null,
        el("label", { class: "small muted", text: label }),
        field,
      ].filter(Boolean),
      el("div", { class: "dialog__actions" }, [
        el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => finish(null) }),
        el("button", { class: "btn btn--primary", type: "submit", text: confirmLabel }),
      ])
    );
    panel.append(form);
    return field;
  }, { cancelWith: null });
}

// One choice from a list, filtered by typing. Used where a control would
// otherwise carry every paper in the project.
export function chooseDialog({ title, options, placeholder = "Filter…", freeText = null }) {
  return openDialog((panel, finish) => {
    const list = el("div", { class: "palette__list" });
    let matches = options;
    let active = 0;

    // Where the list cannot hold every valid answer, such as a project
    // path that has never been opened, what was typed is itself an option.
    const withTyped = (needle) => {
      const found = options.filter((o) => o.label.toLowerCase().includes(needle));
      if (!freeText || !needle) return found;
      return [{ label: freeText(needle), value: needle }, ...found];
    };

    const draw = () => {
      list.replaceChildren(
        ...matches.slice(0, 60).map((option, i) =>
          el("button", {
            class: `palette__item${i === active ? " active" : ""}`,
            type: "button",
            text: option.label,
            onclick: () => finish(option.value),
          })
        )
      );
      if (!matches.length) {
        list.replaceChildren(el("div", { class: "palette__group", text: "No matches" }));
      }
    };

    const field = el("input", {
      class: "input",
      type: "text",
      placeholder,
      oninput: () => {
        matches = withTyped(field.value.trim().toLowerCase());
        active = 0;
        draw();
      },
      onkeydown: (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          active = Math.min(Math.max(active + (event.key === "ArrowDown" ? 1 : -1), 0), matches.length - 1);
          draw();
        } else if (event.key === "Enter") {
          event.preventDefault();
          const chosen = matches[active] || (freeText && field.value.trim()
            ? { value: field.value.trim() }
            : null);
          if (chosen) finish(chosen.value);
        }
      },
    });
    field.style.width = "100%";

    panel.append(el("h2", { text: title }), field, list);
    draw();
    return field;
  }, { cancelWith: null });
}

/* --- Inline confirmation -------------------------------------------------- */

// For reversible or low-cost actions. The control becomes Confirm for
// three seconds and reverts. No dialog, no focus move.
const CONFIRM_WINDOW = 3000;

export function confirmInline(button, run, { label = "Confirm" } = {}) {
  if (button.dataset.confirming === "yes") {
    clearTimeout(Number(button.dataset.timer));
    revert(button);
    run();
    return;
  }
  button.dataset.original = button.textContent;
  button.dataset.confirming = "yes";
  button.textContent = label;
  button.classList.add("btn--confirming");
  button.dataset.timer = String(setTimeout(() => revert(button), CONFIRM_WINDOW));
}

function revert(button) {
  if (button.dataset.confirming !== "yes") return;
  button.textContent = button.dataset.original || "Delete";
  button.classList.remove("btn--confirming");
  delete button.dataset.confirming;
}

export function isOverlayOpen() {
  return !$("#overlay").hidden;
}

export { state };
