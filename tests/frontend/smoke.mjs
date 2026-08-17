// Loads every module with the smallest browser stub that lets them
// evaluate, then exercises the logic that does not touch the DOM.
globalThis.document = {
  addEventListener() {},
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, toggle() {} },
    append() {}, addEventListener() {}, set textContent(v) { this._t = v; },
    get textContent() { return this._t ?? ""; }, get innerHTML() { return this._t ?? ""; } }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = { addEventListener() {}, innerWidth: 1400, innerHeight: 900 };
globalThis.requestAnimationFrame = () => 0;
globalThis.getSelection = () => null;

const editor = await import("../../src/kiwi/api/static/editor.js");
const signals = await import("../../src/kiwi/api/static/signals.js");
const inspector = await import("../../src/kiwi/api/static/inspector.js");
await import("../../src/kiwi/api/static/core.js");
await import("../../src/kiwi/api/static/keyboard.js");
await import("../../src/kiwi/api/static/views.js");
await import("../../src/kiwi/api/static/app.js");

let failed = 0;
const is = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log("FAIL", label, got, "!=", want); failed++; }
};

const source = "# Heading\n\nA claim about X [@doc_00000000000000ab].\n\nAnother line.";
is("line from offset", editor.lineIndexOf(source, "A claim about X [@doc_00000000000000ab].", 11), 2);
is("line by search when the offset moved", editor.lineIndexOf(source, "Another line.", 999), 4);
is("missing sentence", editor.lineIndexOf(source, "not here", 0), -1);

is("score 0 is danger", signals.signalsFrom({ score: 0, intent: "evidence" }).map(s => s.id), ["score0"]);
is("score 2 is silent", signals.signalsFrom({ score: 2, intent: "evidence" }).map(s => s.id), []);
is("retraction outranks the score",
   signals.signalsFrom({ score: 1, intent: "evidence", sourceStatus: "retracted" })[0].id, "retracted");
is("attribution 1 is approximate",
   signals.signalsFrom({ score: 1, intent: "attribution" }).map(s => s.id), ["approximate"]);

// A preprint absent from Crossref is the common case, not a defect in
// the citation. The mark is drawn; the author is not sent to it.
is("an unconfirmed source is marked",
   signals.signalsFrom({ score: 2, intent: "evidence", sourceStatus: "unresolved" })
     .map(s => s.id), ["unresolved"]);
is("an unconfirmed source does not need attention",
   signals.needsAttention({ intent: "evidence", source_status: "unresolved",
                            alignment: { score: 2 } }), false);
is("a contradicted claim needs attention",
   signals.needsAttention({ intent: "evidence", source_status: "unresolved",
                            alignment: { score: 0 } }), true);
is("a retraction needs attention",
   signals.needsAttention({ intent: "evidence", source_status: "retracted",
                            alignment: { score: 2 } }), true);

const claim = {
  anchor: { exact: "A claim.", start: 4 }, citation: "doc_00000000000000ab", intent: "evidence",
  alignment: { score: 1, depth: "quick", model: "m", computed: "t",
               evidence: { exact: "passage", section_path: "1.2" } },
};
const item = inspector.fromClaim(claim, "Paper");
is("claim reduces to the shared shape", [item.sentence, item.score, item.evidence.exact], ["A claim.", 1, "passage"]);
const reviewItem = inspector.fromReviewItem({
  claim: "A claim.", citation: "doc_00000000000000ab", source_title: "Paper",
  intent: "evidence", score: 1, depth: "quick", evidence: "passage", stale: false,
});
is("review item reduces to the same shape",
   Object.keys(item).sort().join(), Object.keys(reviewItem).sort().join());
is("both score the same", inspector.signalsOf(item).map(s => s.id), inspector.signalsOf(reviewItem).map(s => s.id));

// The verdict is what the cited work says about the sentence. A note
// about the record behind that work is said after it, never instead.
{
  const supported = { intent: "evidence", source_status: "unresolved",
                      alignment: { score: 2 } };
  is("an unconfirmed record does not become the verdict",
     signals.verdictLabel(supported, true), "Supported by the cited work");
  is("the note survives as a note",
     signals.notesOf(signals.claimSignals(supported)).map(s => s.id), ["unresolved"]);
  is("a contradiction is still the verdict",
     signals.verdictOf(signals.claimSignals(
       { intent: "evidence", source_status: "unresolved", alignment: { score: 0 } })).id,
     "score0");
  is("a retraction outranks the score as the verdict",
     signals.verdictOf(signals.claimSignals(
       { intent: "evidence", source_status: "retracted", alignment: { score: 2 } })).id,
     "retracted");
}

console.log(failed ? `${failed} failed` : "every module loads and the shared logic agrees");
process.exit(failed ? 1 : 0);
