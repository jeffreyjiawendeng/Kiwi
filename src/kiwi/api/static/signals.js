// Scores and statuses. Solid means definite, hollow means qualified, and
// that distinction is readable with no colour at all.

import { el } from "./core.js";

const SVG = {
  retracted:
    '<path d="M5.2 1.5h5.6L14.5 5.2v5.6L10.8 14.5H5.2L1.5 10.8V5.2Z" fill="currentColor"/>' +
    '<rect x="4.3" y="7.15" width="7.4" height="1.7" fill="var(--bg-raised)"/>',
  score0:
    '<circle cx="8" cy="8" r="6.5" fill="currentColor"/>' +
    '<rect x="4.5" y="7.15" width="7" height="1.7" fill="var(--bg-raised)"/>',
  score1:
    '<path d="M8 2.5 L14.5 13.5 L1.5 13.5 Z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linejoin="round"/>',
  approximate:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M4.8 7.1c.8-1 1.6-1 2.4 0s1.6 1 2.4 0M4.8 9.9c.8-1 1.6-1 2.4 0s1.6 1 2.4 0" ' +
    'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  unresolved:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M6.3 6.1c0-1 .8-1.7 1.7-1.7s1.7.7 1.7 1.6c0 1.3-1.6 1.4-1.7 2.7" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.4" r=".85" fill="currentColor"/>',
  stale:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linecap="round"/>',
  checked:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M5.2 8.2 7.1 10.1 10.9 6.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};

export function icon(name, size = 16) {
  const body = SVG[name];
  if (!body) return null;
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

// Highest first. A sentence citing a retracted paper with score 1 shows
// the retraction only; the inspector lists both.
const LADDER = [
  {
    id: "retracted",
    tone: "danger",
    icon: "retracted",
    label: "The cited work is retracted",
    test: (c) => c.sourceStatus === "retracted",
  },
  {
    id: "score0",
    tone: "danger",
    icon: "score0",
    label: "The cited work is inconsistent with this claim",
    test: (c) => c.intent !== "attribution" && c.score === 0,
  },
  {
    id: "score1",
    tone: "caution",
    icon: "score1",
    label: "Relevant, but does not establish this claim",
    test: (c) => c.intent !== "attribution" && c.score === 1,
  },
  {
    id: "approximate",
    tone: "caution",
    icon: "approximate",
    label: "Credited as the origin — approximate",
    test: (c) => c.intent === "attribution" && c.score === 1,
  },
  // Not finding a work in a reference database says something about the
  // database, not about the claim. Preprints are routinely absent. The
  // mark is shown, because a citation nobody could confirm is worth
  // seeing, but it is not something the author can act on and so does
  // not join the count they work through.
  {
    id: "unresolved",
    tone: "neutral",
    icon: "unresolved",
    label: "The cited work could not be confirmed against a record",
    test: (c) => c.sourceStatus === "unresolved" || c.sourceStatus === "mismatch",
  },
  {
    id: "stale",
    tone: "neutral",
    icon: "stale",
    label: "Computed before this sentence was edited",
    test: (c) => c.stale === true,
  },
];

// The ladder reads four fields. Anything carrying them can be scored,
// which is what lets a draft claim and a review item share one inspector.
export function signalsFrom(context) {
  return LADDER.filter((signal) => signal.test(context));
}

// A claim, reduced to the fields the ladder reads.
export function claimSignals(claim) {
  const shown = claim.deep_alignment || claim.alignment || null;
  return signalsFrom({
    score: shown ? shown.score : null,
    intent: claim.intent,
    sourceStatus: claim.source_status || claim.sourceStatus || null,
    stale: Boolean(claim.deep_alignment && claim.deep_alignment.stale),
  });
}

export function primarySignal(claim) {
  return claimSignals(claim)[0] || null;
}

// Two different questions get two different answers. The verdict is what
// the cited work says about the sentence; a note is a condition around
// it. Led by a note, a supported claim reads as though it had not been
// scored at all, which is how "could not be confirmed against a record"
// came to stand where "supported" belonged.
const NOTE_IDS = new Set(["unresolved", "stale"]);

export function verdictOf(signals) {
  return signals.find((signal) => !NOTE_IDS.has(signal.id)) || null;
}

export function notesOf(signals) {
  return signals.filter((signal) => NOTE_IDS.has(signal.id));
}

// The headline for a claim, in words, whether or not it carries a mark.
export function verdictLabel(claim, scored = true) {
  const verdict = verdictOf(claimSignals(claim));
  if (verdict) return verdict.label;
  return scored ? "Supported by the cited work" : "Not scored yet";
}

// Score 2 is silent. That silence is what makes a mark mean something.
//
// Attention is what the author is asked to work through, so it counts
// only what they can act on. A neutral mark reports a condition rather
// than asking for a decision, and walking the author to one wastes the
// move.
export function needsAttention(claim) {
  const signal = primarySignal(claim);
  return signal !== null && signal.tone !== "neutral";
}

// One element per mark: the glyph is drawn into the toned wrapper rather
// than nested in a second one.
export function mark(signal, size = 16) {
  if (!signal) return null;
  const wrap = el("span", { class: `sig sig--${signal.tone}` });
  wrap.innerHTML = icon(signal.icon, size) || "";
  wrap.append(el("span", { class: "visually-hidden", text: signal.label }));
  return wrap;
}

const REFERENCE_SIGNAL = {
  retracted: { tone: "danger", icon: "retracted", label: "Retracted" },
  unresolved: { tone: "caution", icon: "unresolved", label: "Could not be resolved" },
  mismatch: { tone: "caution", icon: "unresolved", label: "Metadata does not match" },
  // Looked for and not found is a result. A request that failed is not,
  // and is worth telling apart: it can be run again.
  unchecked: { tone: "neutral", icon: "stale", label: "Not checked yet" },
};

// One reference inside a paper.
export function referenceSignal(status) {
  return REFERENCE_SIGNAL[status] || null;
}

// A paper carries two states that are easy to confuse. source_status is
// its own record, which is where a retraction is recorded. verification
// is the state of the references inside it, and rolls up to "issues".
// Neither is the same as never having been checked, which is the state
// every paper starts in and is not worth a mark.
const PAPER_SIGNAL = {
  retracted: { tone: "danger", icon: "retracted", label: "This paper is retracted" },
  issues: {
    tone: "caution",
    icon: "unresolved",
    label: "A reference does not resolve to its record",
  },
};

export function paperSignal(paper) {
  if (paper.source_status === "retracted") return PAPER_SIGNAL.retracted;
  if (paper.verification === "issues") return PAPER_SIGNAL.issues;
  return null;
}

// Retracted sorts first whatever the column is sorted by.
export function paperRank(paper) {
  if (paper.source_status === "retracted") return 0;
  if (paper.verification === "issues") return 1;
  return 2;
}

// Retracted sorts first in every list and is never collapsed by default.
export const REFERENCE_ORDER = ["retracted", "mismatch", "unresolved", "unchecked", "resolved"];

export function compareReferenceStatus(a, b) {
  const rank = (s) => {
    const i = REFERENCE_ORDER.indexOf(s);
    return i === -1 ? REFERENCE_ORDER.length : i;
  };
  return rank(a) - rank(b);
}
