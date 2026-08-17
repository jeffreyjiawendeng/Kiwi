// One claim, shown the same way to the author and to the reviewer. Only
// the actions differ, so both move through the loop with the same keys.

import { el, escapeHtml } from "./core.js";
import { mark, notesOf, signalsFrom, verdictOf } from "./signals.js";

const CITATION = /\[@doc_[0-9a-f]{16}\]/g;

// A draft claim and a review item carry the same facts under different
// names. Both are reduced here so nothing downstream reads two shapes.
export function fromClaim(claim, title) {
  const shown = claim.deep_alignment || claim.alignment || null;
  return {
    sentence: claim.anchor.exact,
    citation: claim.citation,
    sourceTitle: title,
    intent: claim.intent,
    score: shown ? shown.score : null,
    depth: shown ? shown.depth : null,
    model: shown ? shown.model : null,
    computed: shown ? shown.computed : null,
    evidence: shown?.evidence?.exact ? shown.evidence : null,
    scored: Boolean(shown),
    sourceStatus: claim.source_status || null,
    stale: Boolean(claim.deep_alignment && claim.deep_alignment.stale),
    start: claim.anchor.start,
  };
}

export function fromReviewItem(item) {
  return {
    sentence: item.claim,
    citation: item.citation,
    sourceTitle: item.source_title,
    intent: item.intent,
    score: item.score,
    depth: item.depth,
    model: null,
    computed: null,
    evidence: item.evidence ? { exact: item.evidence, section_path: "" } : null,
    scored: item.score !== null && item.score !== undefined,
    sourceStatus: item.source_status || null,
    stale: Boolean(item.stale),
    start: null,
  };
}

export function signalsOf(item) {
  return signalsFrom({
    score: item.score,
    intent: item.intent,
    sourceStatus: item.sourceStatus,
    stale: item.stale,
  });
}

/* --- Mounted inspector ---------------------------------------------------- */

// Bare letters are bound in the one keymap table and dispatched here, so
// the table does not have to know what is on screen.
let mounted = null;

// The panel itself, not a control inside it. A button that has focus must
// keep Enter and the letters the browser gives it.
export function inspectorFocused() {
  return Boolean(mounted && document.activeElement?.classList?.contains("inspector"));
}

export function runAction(key) {
  const action = (mounted?.actions || []).find((a) => a.key === key);
  if (action) action.run();
}

export function moveCurrent(delta) {
  if (mounted?.onMove) mounted.onMove(delta);
}

export function toggleDetail() {
  const detail = mounted?.node.querySelector("details");
  if (detail) detail.open = !detail.open;
}

/* --- Render --------------------------------------------------------------- */

const INTENT_NOTE = {
  attribution:
    "Credited as the origin of this idea. Approximate: about 1 in 13 credits is wrong. " +
    "Recall is 0.534, so genuine originations are also missed.",
};

export function inspector({ item, position = null, actions = [], onMove = null, footer = null }) {
  const signals = signalsOf(item);
  // The verdict leads. A note about the record behind the work is said
  // after it, never in place of it.
  const primary = verdictOf(signals);
  const notes = notesOf(signals);

  const node = el("section", {
    class: "inspector",
    tabindex: "0",
    "aria-label": "Claim inspector",
  });

  const heading = el("div", { class: "inspector__head" }, [
    primary ? mark(primary) : null,
    el("span", {
      class: "inspector__label",
      text: primary
        ? primary.label
        : item.scored
          ? "Supported by the cited work"
          : "Not scored yet",
    }),
  ]);
  if (position) {
    heading.append(
      el("span", {
        class: "inspector__position mono",
        text: `${position.index + 1}/${position.total}`,
      })
    );
  }
  node.append(heading);

  // The sentence, verbatim, with the citation marked.
  const sentence = el("p", { class: "inspector__sentence" });
  sentence.innerHTML = escapeHtml(item.sentence).replace(
    CITATION,
    (m) => `<span class="citation">${m}</span>`
  );
  node.append(sentence);

  // Not collapsed, not truncated, not behind a tab. A score whose evidence
  // is not visible cannot be checked. It is labelled, because a passage
  // sitting under a sentence with nothing said about it reads as a quote
  // rather than as the thing the sentence was judged against.
  if (item.evidence) {
    node.append(
      el("div", { class: "inspector__against" }, [
        el("span", { class: "inspector__against-label", text: "Judged against" }),
        el("span", {
          class: "inspector__against-source",
          text: item.sourceTitle || item.citation,
        }),
      ]),
      el("div", { class: "evidence" }, [
        item.evidence.section_path
          ? el("div", { class: "mono small muted", text: item.evidence.section_path })
          : null,
        el("div", { text: item.evidence.exact }),
      ])
    );
  } else {
    node.append(
      el("div", { class: "inspector__against" }, [
        el("span", { class: "inspector__against-label", text: "Cites" }),
        el("span", {
          class: "inspector__against-source",
          text: item.sourceTitle || item.citation,
        }),
      ])
    );
    if (item.scored) {
      node.append(
        el("div", {
          class: "evidence evidence--detached",
          text: "No passage was read for this claim.",
        })
      );
    }
  }

  const note = INTENT_NOTE[item.intent];
  if (note && item.score === 1) {
    node.append(el("div", { class: "inspector__note small", text: note }));
  }

  if (actions.length) {
    node.append(
      el(
        "div",
        { class: "inspector__actions" },
        actions.map((action) =>
          el(
            "button",
            {
              class: `btn${action.primary ? " btn--primary" : ""}`,
              onclick: action.run,
              title: action.key ? `Shortcut: ${action.key}` : null,
            },
            [
              el("span", { text: action.label }),
              action.key ? el("span", { class: "kbd", text: action.key }) : null,
            ]
          )
        )
      )
    );
  }

  const rows = [
    ["Scale", item.intent],
    ["Depth", item.depth],
    ["Model", item.model],
    ["Computed", item.computed],
  ].filter(([, value]) => value);
  if (notes.length) {
    rows.push(["Also", notes.map((s) => s.label).join("; ")]);
  }

  if (rows.length) {
    node.append(
      el("details", { class: "inspector__detail" }, [
        el("summary", {}, [
          el("span", { text: "Detail" }),
          el("span", { class: "kbd", text: "d" }),
        ]),
        el(
          "table",
          {},
          el(
            "tbody",
            {},
            rows.map(([label, value]) =>
              el("tr", {}, [
                el("td", { class: "muted", style: "width:10ch", text: label }),
                el("td", { class: "mono small", text: String(value) }),
              ])
            )
          )
        ),
      ])
    );
  }

  if (footer) node.append(footer);

  mounted = { node, actions, onMove };
  return node;
}

export function clearInspector() {
  mounted = null;
}
