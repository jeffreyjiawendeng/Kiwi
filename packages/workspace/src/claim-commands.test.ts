import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type ClaimBody,
  type CommandEnvelope,
  type CommandResult,
} from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { claimCommands } from "./claim-commands.js";
import { objectCommands } from "./object-commands.js";
import { projectCommands } from "./project-commands.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACCOUNT_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const NOW = "2026-08-26T12:00:00.000Z";

let scratch: string;
let gateway: Gateway;
let sequence: number;
let project: string;

function nextId(): string {
  sequence += 1;
  return `0198c810-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function envelope(command: string, args: Record<string, unknown>): CommandEnvelope {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: nextId(),
    workspace_id: WORKSPACE_ID,
    command,
    args,
  };
}

async function invoke(command: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
  return gateway.invoke(envelope(command, { root: scratch, ...args }), {
    actor: { kind: "local_user", id: ACCOUNT_ID },
    origin: { surface: "ui", extension_id: null },
  });
}

interface EvidenceEntry {
  relation_id: string;
  object_id: string;
  object_type: string;
  title: string;
  stance: "supports" | "contradicts";
  attached_at: string;
}

interface ClaimEntry {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  claim: ClaimBody;
  evidence: EvidenceEntry[];
}

async function claims(args: Record<string, unknown> = {}): Promise<ClaimEntry[]> {
  const result = await invoke("kiwi.claim.list", { project_id: project, ...args });
  return (result.data as { claims: ClaimEntry[] }).claims;
}

/** The claim as it stands, which is what the page would be showing. */
async function only(): Promise<ClaimEntry> {
  const found = await claims();
  const first = found[0];
  if (first === undefined) throw new Error("The workspace has no claims.");
  return first;
}

async function writeClaim(
  statement: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const made = await invoke("kiwi.claim.create", { project_id: project, statement, ...fields });
  return (made.data as { object: { id: string } }).object.id;
}

/** Something a claim can stand on: a note, a paper, a highlight. */
async function object(type: string, title: string): Promise<string> {
  const made = await invoke("kiwi.object.create", { type, title, content: "" });
  return (made.data as { object: { id: string } }).object.id;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-claim-command-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Claim command test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of claimCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  // A claim belongs to a project, and its evidence is made the way a person makes it.
  for (const command of projectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-claim" });
  const made = await invoke("kiwi.project.create", { title: "Sleep and recall" });
  project = (made.data as { project: { id: string } }).project.id;
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("kiwi.claim.create", () => {
  it("files the claim in the project and calls it by what it says", async () => {
    await writeClaim("Sleep debt slows reaction time.");
    const found = await only();
    expect(found.title).toBe("Sleep debt slows reaction time.");
    expect(found.claim).toMatchObject({ status: "draft", confidence: "low", answers: [] });
    // Nothing stands behind it yet, and the claim says so rather than looking established.
    expect(found.evidence).toEqual([]);
  });

  it("takes where it stands, how sure it is, and what it answers", async () => {
    await writeClaim("Sleep debt slows reaction time.", {
      status: "supported",
      confidence: "high",
      answers: ["H1", "Q2"],
    });
    expect((await only()).claim).toMatchObject({
      status: "supported",
      confidence: "high",
      answers: ["H1", "Q2"],
    });
  });

  it("refuses a claim that asserts nothing", async () => {
    const result = await invoke("kiwi.claim.create", { project_id: project, statement: "   " });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(await claims()).toEqual([]);
  });

  it("refuses an answer id nothing in a protocol could carry", async () => {
    const result = await invoke("kiwi.claim.create", {
      project_id: project,
      statement: "Something.",
      answers: ["E3"],
    });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses a project that is not there, and an object that is not a project", async () => {
    const missing = await invoke("kiwi.claim.create", {
      project_id: "no-such-project",
      statement: "Something.",
    });
    expect(missing.status).toBe("failed");

    const paper = await object("source", "Smith 2024");
    const wrong = await invoke("kiwi.claim.create", { project_id: paper, statement: "Something." });
    expect(wrong.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("keeps another project's claims out of this project's list", async () => {
    const other = await invoke("kiwi.project.create", { title: "Something else" });
    await invoke("kiwi.claim.create", {
      project_id: (other.data as { project: { id: string } }).project.id,
      statement: "Not this project's.",
    });
    await writeClaim("This project's.");
    expect((await claims()).map((entry) => entry.title)).toEqual(["This project's."]);
  });
});

describe("kiwi.claim.update", () => {
  it("changes one field and leaves the rest alone", async () => {
    const id = await writeClaim("Sleep debt slows reaction time.", { answers: ["H1"] });
    const shown = await only();
    await invoke("kiwi.claim.update", {
      claim_id: id,
      expected_version: shown.version,
      expected_hash: shown.content_hash,
      status: "supported",
    });
    const after = await only();
    expect(after.claim.status).toBe("supported");
    expect(after.claim.answers).toEqual(["H1"]);
    expect(after.claim.statement).toBe("Sleep debt slows reaction time.");
  });

  it("renames the claim when the claim is reworded", async () => {
    const id = await writeClaim("Sleep debt slows reaction time.");
    const shown = await only();
    await invoke("kiwi.claim.update", {
      claim_id: id,
      expected_version: shown.version,
      expected_hash: shown.content_hash,
      statement: "Sleep debt slows reaction time in adults.",
    });
    expect((await only()).title).toBe("Sleep debt slows reaction time in adults.");
  });

  it("saving what is already saved writes no new version", async () => {
    const id = await writeClaim("Sleep debt slows reaction time.");
    const shown = await only();
    const again = await invoke("kiwi.claim.update", {
      claim_id: id,
      expected_version: shown.version,
      expected_hash: shown.content_hash,
      status: "draft",
    });
    expect(again.status).toBe("no_change");
    expect((await only()).version).toBe(1);
  });

  it("refuses a save from a page that was showing an older version", async () => {
    const id = await writeClaim("Sleep debt slows reaction time.");
    const shown = await only();
    await invoke("kiwi.claim.update", {
      claim_id: id,
      expected_version: shown.version,
      expected_hash: shown.content_hash,
      status: "supported",
    });
    const stale = await invoke("kiwi.claim.update", {
      claim_id: id,
      expected_version: shown.version,
      expected_hash: shown.content_hash,
      confidence: "high",
    });
    expect(stale.error?.code).toBe("KIWI_CONFLICT_VERSION");
    // The change that arrived first is still what the claim says.
    expect((await only()).claim.status).toBe("supported");
  });

  it("says which claim was not found", async () => {
    const result = await invoke("kiwi.claim.update", {
      claim_id: "no-such-claim",
      expected_version: 1,
      expected_hash: `sha256:${"0".repeat(64)}`,
      status: "supported",
    });
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.claim.attach-evidence", () => {
  it("points a note at a claim and shows what it is standing on", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: note,
      stance: "supports",
    });
    expect((await only()).evidence).toMatchObject([
      { object_id: note, object_type: "note", title: "Reaction times, week 3", stance: "supports" },
    ]);
  });

  it("attaching the same evidence the same way again changes nothing", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    const args = { claim_id: claim, object_id: note, stance: "supports" };
    await invoke("kiwi.claim.attach-evidence", args);
    const again = await invoke("kiwi.claim.attach-evidence", args);
    expect(again.status).toBe("no_change");
    expect((await only()).evidence).toHaveLength(1);
  });

  it("attaching it the other way round replaces the stance rather than adding a second", async () => {
    // A person who re-reads the paper and finds it says the opposite must not leave the claim
    // both supported and contradicted by the same page.
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const paper = await object("source", "Smith 2024");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: paper,
      stance: "supports",
    });
    const flipped = await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: paper,
      stance: "contradicts",
    });
    expect(flipped.status).toBe("committed");
    expect((flipped.data as { replaced: string | null }).replaced).toBe("supports");
    expect((await only()).evidence).toMatchObject([{ object_id: paper, stance: "contradicts" }]);
  });

  it("refuses a claim as evidence for a claim", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const other = await writeClaim("Reaction time predicts recall.");
    const result = await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: other,
      stance: "supports",
    });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(result.error?.details).toMatchObject({ object_type: "claim" });
  });

  it("refuses something nobody can point at", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const manuscript = await object("output", "Draft");
    const result = await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: manuscript,
      stance: "supports",
    });
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("says so when the claim or the evidence is not there", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    const noClaim = await invoke("kiwi.claim.attach-evidence", {
      claim_id: "no-such-claim",
      object_id: note,
      stance: "supports",
    });
    expect(noClaim.error?.code).toBe("KIWI_NOT_FOUND");

    const noEvidence = await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: "no-such-object",
      stance: "supports",
    });
    expect(noEvidence.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.claim.detach-evidence", () => {
  it("takes the evidence off, and taking it off twice changes nothing", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: note,
      stance: "supports",
    });
    const removed = await invoke("kiwi.claim.detach-evidence", {
      claim_id: claim,
      object_id: note,
    });
    expect(removed.status).toBe("committed");
    expect((await only()).evidence).toEqual([]);

    const again = await invoke("kiwi.claim.detach-evidence", { claim_id: claim, object_id: note });
    expect(again.status).toBe("no_change");
  });
});

describe("kiwi.claim.list", () => {
  it("lists the claims nothing supports", async () => {
    const supported = await writeClaim("Sleep debt slows reaction time.");
    await writeClaim("Recall falls with age.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: supported,
      object_id: note,
      stance: "supports",
    });
    expect((await claims({ unsupported: true })).map((entry) => entry.title)).toEqual([
      "Recall falls with age.",
    ]);
  });

  it("counts a claim only contradicted as unsupported", async () => {
    // Something arguing against a claim is not something the claim stands on.
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const paper = await object("source", "Smith 2024");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: paper,
      stance: "contradicts",
    });
    expect(await claims({ unsupported: true })).toHaveLength(1);
  });

  it("is right again the moment the supporting evidence is taken off", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: note,
      stance: "supports",
    });
    expect(await claims({ unsupported: true })).toEqual([]);
    await invoke("kiwi.claim.detach-evidence", { claim_id: claim, object_id: note });
    expect(await claims({ unsupported: true })).toHaveLength(1);
  });

  it("stops counting evidence that has been deleted", async () => {
    // A claim resting on a highlight somebody threw away is standing on nothing, whatever the
    // relation still says.
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.attach-evidence", {
      claim_id: claim,
      object_id: note,
      stance: "supports",
    });
    const stored = await invoke("kiwi.object.read", { object_id: note });
    const read = (stored.data as { object: { version: number; content_hash: string } }).object;
    const guard = {
      object_id: note,
      expected_version: read.version,
      expected_hash: read.content_hash,
    };
    const preview = await invoke("kiwi.object.validate-trash", guard);
    const relationGuards = (preview.data as { preview: { relation_guards: unknown[] } }).preview
      .relation_guards;
    const trashed = await invoke("kiwi.object.trash", {
      ...guard,
      expected_relations: relationGuards,
    });
    expect(trashed.status).toBe("committed");
    expect((await only()).evidence).toEqual([]);
    expect(await claims({ unsupported: true })).toHaveLength(1);
  });

  it("finds the claims written to answer one line of the protocol", async () => {
    await writeClaim("Sleep debt slows reaction time.", { answers: ["H1"] });
    await writeClaim("Recall falls with age.", { answers: ["Q2"] });
    expect((await claims({ answers: "H1" })).map((entry) => entry.title)).toEqual([
      "Sleep debt slows reaction time.",
    ]);
  });

  it("finds the claims that stand somewhere in particular", async () => {
    await writeClaim("Sleep debt slows reaction time.", { status: "supported" });
    await writeClaim("Recall falls with age.");
    expect((await claims({ status: "supported" })).map((entry) => entry.title)).toEqual([
      "Sleep debt slows reaction time.",
    ]);
  });
});

/** A passage as the Reader sends it: what was dragged over, on the page it was dragged on. */
function excerpt(assetId: string, quoted: string): Record<string, unknown> {
  return {
    kind: "highlight",
    asset_id: assetId,
    page: 4,
    page_label: "4",
    rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
    color: "yellow",
    quoted,
  };
}

describe("kiwi.claim.send-evidence", () => {
  it("writes the claim, the mark, and what one says about the other in one transaction", async () => {
    const paper = await object("source", "Smith 2024");
    const sent = await invoke("kiwi.claim.send-evidence", {
      project_id: project,
      statement: "Sleep debt slows reaction time.",
      excerpt: { object_id: paper, annotation: excerpt("asset-1", "reaction times fell by 12%") },
    });
    expect(sent.status).toBe("committed");
    const receipt = sent.data as {
      claim_created: boolean;
      annotation_id: string;
      attached: number;
    };
    expect(receipt.claim_created).toBe(true);
    expect(receipt.attached).toBe(1);

    const claim = await only();
    expect(claim.title).toBe("Sleep debt slows reaction time.");
    expect(claim.claim.status).toBe("draft");
    expect(claim.evidence.map((piece) => piece.object_id)).toEqual([receipt.annotation_id]);
    expect(claim.evidence[0]?.stance).toBe("supports");

    // The passage is a mark on the paper as well, so it can still be found where it was read.
    const marks = await invoke("kiwi.annotation.list", { object_id: paper });
    expect((marks.data as { annotations: unknown[] }).annotations).toHaveLength(1);
  });

  it("sends marks that already exist to a claim that already exists", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const first = await object("note", "Reaction times, week 3");
    const second = await object("source", "Smith 2024");
    const sent = await invoke("kiwi.claim.send-evidence", {
      claim_id: claim,
      object_ids: [first, second],
      stance: "supports",
    });
    expect(sent.status).toBe("committed");
    expect((sent.data as { attached: number }).attached).toBe(2);
    expect((await only()).evidence).toHaveLength(2);
  });

  it("changes nothing when the same passage is sent to the same claim twice", async () => {
    // People send a passage, read on, and send the page again. A second copy is a mess to undo.
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.send-evidence", { claim_id: claim, object_ids: [note] });
    const again = await invoke("kiwi.claim.send-evidence", { claim_id: claim, object_ids: [note] });
    expect(again.status).toBe("no_change");
    expect((again.data as { skipped: number }).skipped).toBe(1);
    expect((await only()).evidence).toHaveLength(1);
  });

  it("moves a piece of evidence to the other side rather than saying both", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    await invoke("kiwi.claim.send-evidence", { claim_id: claim, object_ids: [note] });
    await invoke("kiwi.claim.send-evidence", {
      claim_id: claim,
      object_ids: [note],
      stance: "contradicts",
    });
    const evidence = (await only()).evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.stance).toBe("contradicts");
  });

  it("writes nothing at all when one of the things sent cannot be evidence", async () => {
    // The whole point of one command is that a claim is never left standing on nothing because
    // the third of three calls failed.
    const other = await writeClaim("Recall falls with age.");
    const refusal = await invoke("kiwi.claim.send-evidence", {
      project_id: project,
      statement: "Sleep debt slows reaction time.",
      object_ids: [other],
    });
    expect(refusal.status).toBe("failed");
    expect(refusal.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect((await claims()).map((entry) => entry.title)).toEqual(["Recall falls with age."]);
  });

  it("refuses a send with nothing in it", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const refusal = await invoke("kiwi.claim.send-evidence", { claim_id: claim });
    expect(refusal.error?.message).toBe("Choose what to send.");
  });

  it("refuses to both choose a claim and write a new one", async () => {
    const claim = await writeClaim("Sleep debt slows reaction time.");
    const note = await object("note", "Reaction times, week 3");
    const refusal = await invoke("kiwi.claim.send-evidence", {
      claim_id: claim,
      project_id: project,
      statement: "Recall falls with age.",
      object_ids: [note],
    });
    expect(refusal.error?.message).toBe("Send this to a claim, or write a new one. Not both.");
  });

  it("refuses a new claim with no project to belong to", async () => {
    const note = await object("note", "Reaction times, week 3");
    const refusal = await invoke("kiwi.claim.send-evidence", {
      statement: "Recall falls with age.",
      object_ids: [note],
    });
    expect(refusal.error?.message).toBe("Choose a claim, or say what the new one asserts.");
  });

  it("says which line of the protocol a claim sent from the Reader answers", async () => {
    const paper = await object("source", "Smith 2024");
    await invoke("kiwi.claim.send-evidence", {
      project_id: project,
      statement: "Sleep debt slows reaction time.",
      answers: ["H1"],
      excerpt: { object_id: paper, annotation: excerpt("asset-1", "reaction times fell by 12%") },
    });
    expect((await only()).claim.answers).toEqual(["H1"]);
  });
});
