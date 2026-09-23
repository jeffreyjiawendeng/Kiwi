import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandResult,
  type ProtocolBody,
} from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { projectCommands } from "./project-commands.js";
import { protocolCommands } from "./protocol-commands.js";

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

interface ProtocolObject {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  protocol: ProtocolBody;
}

function protocolOf(result: CommandResult): ProtocolObject {
  const found = (result.data as { protocol: ProtocolObject | null }).protocol;
  if (found === null) throw new Error("The command answered with no protocol.");
  return found;
}

/** The project's protocol as it stands, which is what the page would be showing. */
async function current(): Promise<ProtocolObject> {
  return protocolOf(await invoke("kiwi.protocol.read", { project_id: project }));
}

/** Saves a change the way the page does: against the version it was showing. */
async function save(changes: Record<string, unknown>): Promise<CommandResult> {
  const shown = await current();
  return invoke("kiwi.protocol.update", {
    project_id: project,
    expected_version: shown.version,
    expected_hash: shown.content_hash,
    ...changes,
  });
}

function hypothesis(id: string, statement: string): Record<string, unknown> {
  return { id, statement, direction: "increase", status: "open" };
}

function criterion(id: string, code: string, text: string): Record<string, unknown> {
  return { id, code, kind: code.startsWith("I") ? "inclusion" : "exclusion", text };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-protocol-command-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Protocol command test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of protocolCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  // A protocol belongs to a project, so the project is made the way a person makes one.
  for (const command of projectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-protocol" });
  const made = await invoke("kiwi.project.create", { title: "Sleep and recall" });
  project = (made.data as { project: { id: string } }).project.id;
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("kiwi.protocol.ensure", () => {
  it("makes the project a protocol the first time and finds it after that", async () => {
    const first = await invoke("kiwi.protocol.ensure", { project_id: project });
    expect((first.data as { created: boolean }).created).toBe(true);

    const second = await invoke("kiwi.protocol.ensure", { project_id: project });
    expect((second.data as { created: boolean }).created).toBe(false);
    // Nothing was written, and the result says so rather than reporting a transaction.
    expect(second.status).toBe("no_change");
    // The same object, not a second one, and not a second version of the first.
    expect(protocolOf(second).id).toBe(protocolOf(first).id);
    expect(protocolOf(second).version).toBe(1);
  });

  it("starts a protocol with nothing filled in and no freeze", async () => {
    const made = protocolOf(await invoke("kiwi.protocol.ensure", { project_id: project }));
    expect(made.protocol).toMatchObject({
      question: "",
      hypotheses: [],
      frozen_at: null,
      frozen_version: null,
      deviations: [],
    });
  });

  it("refuses a project that is not there, and an object that is not a project", async () => {
    const missing = await invoke("kiwi.protocol.ensure", { project_id: "no-such-project" });
    expect(missing.error?.code).toBe("KIWI_NOT_FOUND");

    const paper = await invoke("kiwi.object.create", {
      type: "source",
      title: "Smith 2024",
      content: "",
    });
    const wrong = await invoke("kiwi.protocol.ensure", {
      project_id: (paper.data as { object: { id: string } }).object.id,
    });
    expect(wrong.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("kiwi.protocol.read", () => {
  it("answers with nothing for a project that has never opened the page", async () => {
    const result = await invoke("kiwi.protocol.read", { project_id: project });
    expect(result.status).toBe("committed");
    expect((result.data as { protocol: unknown }).protocol).toBeNull();
  });

  it("does not write a protocol just because somebody looked", async () => {
    await invoke("kiwi.protocol.read", { project_id: project });
    const after = await invoke("kiwi.protocol.ensure", { project_id: project });
    expect((after.data as { created: boolean }).created).toBe(true);
  });
});

describe("kiwi.protocol.update", () => {
  beforeEach(async () => {
    await invoke("kiwi.protocol.ensure", { project_id: project });
  });

  it("changes one part and leaves the rest of the protocol alone", async () => {
    await save({ question: "Does sleep improve recall?" });
    await save({ method: "A randomised trial" });
    const shown = await current();
    expect(shown.protocol.question).toBe("Does sleep improve recall?");
    expect(shown.protocol.method).toBe("A randomised trial");
  });

  it("names the object after the question, so a search result says which project it is", async () => {
    await save({ question: "Does sleep improve recall?" });
    expect((await current()).title).toBe("Does sleep improve recall?");
  });

  it("keeps the ids of what is left when an entry in the middle is deleted", async () => {
    await save({
      criteria: [
        criterion("c-1", "I1", "Adults"),
        criterion("c-2", "E1", "Under 18"),
        criterion("c-3", "E2", "Not in English"),
      ],
    });
    await save({
      criteria: [criterion("c-1", "I1", "Adults"), criterion("c-3", "E2", "Not in English")],
    });
    // E2 is what a screening decision recorded. Renumbering it to E1 would quietly change what
    // every decision that mentions it says.
    expect((await current()).protocol.criteria.map((entry) => entry.code)).toEqual(["I1", "E2"]);
  });

  it("refuses a save made against a version somebody else has already replaced", async () => {
    const stale = await current();
    await save({ question: "Does sleep improve recall?" });
    const refused = await invoke("kiwi.protocol.update", {
      project_id: project,
      expected_version: stale.version,
      expected_hash: stale.content_hash,
      question: "Something else",
    });
    expect(refused.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("refuses a protocol that says two things by the same name", async () => {
    const refused = await save({
      hypotheses: [hypothesis("H1", "Sleep helps"), hypothesis("H1", "Sleep hurts")],
    });
    expect(refused.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(refused.error?.details["fields"]).toBe("hypotheses");
  });

  it("refuses a project that has no protocol yet", async () => {
    const other = await invoke("kiwi.project.create", { title: "Another project" });
    const refused = await invoke("kiwi.protocol.update", {
      project_id: (other.data as { project: { id: string } }).project.id,
      expected_version: 1,
      expected_hash: `sha256:${"0".repeat(64)}`,
      question: "Does anything?",
    });
    expect(refused.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.protocol.freeze", () => {
  beforeEach(async () => {
    await invoke("kiwi.protocol.ensure", { project_id: project });
    await save({ question: "Does sleep improve recall?" });
  });

  it("records when it was frozen and which version the freeze covers", async () => {
    const frozen = protocolOf(await invoke("kiwi.protocol.freeze", { project_id: project }));
    expect(frozen.protocol.frozen_at).toBe(NOW);
    // The version the freeze covers is the one carrying it, which is what History opens to show
    // exactly what the project committed to.
    expect(frozen.protocol.frozen_version).toBe(frozen.version);
  });

  it("does not move the date when it is frozen again", async () => {
    const once = protocolOf(await invoke("kiwi.protocol.freeze", { project_id: project }));
    const twice = protocolOf(await invoke("kiwi.protocol.freeze", { project_id: project }));
    expect(twice.version).toBe(once.version);
    expect(twice.protocol.frozen_at).toBe(once.protocol.frozen_at);
  });

  it("refuses an edit afterwards and says what to do instead", async () => {
    await invoke("kiwi.protocol.freeze", { project_id: project });
    const refused = await save({ question: "Does sleep improve recall in adults?" });
    expect(refused.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(refused.error?.message).toBe(
      "This protocol was frozen. Log a deviation rather than editing it.",
    );
    expect(refused.error?.details["instead"]).toBe("kiwi.protocol.log-deviation");
    expect(refused.error?.details["frozen_at"]).toBe(NOW);
  });
});

describe("kiwi.protocol.log-deviation", () => {
  beforeEach(async () => {
    await invoke("kiwi.protocol.ensure", { project_id: project });
    await save({ question: "Does sleep improve recall?" });
  });

  async function logIt(what: string): Promise<CommandResult> {
    return invoke("kiwi.protocol.log-deviation", {
      project_id: project,
      on: "2026-08-20",
      what,
      why: "Recruitment fell short",
      approved_by: "R. Okonkwo",
    });
  }

  it("appends to a frozen protocol without being told which version it saw", async () => {
    await invoke("kiwi.protocol.freeze", { project_id: project });
    await logIt("Widened the age range to 65");
    const twice = protocolOf(await logIt("Dropped the second site"));
    expect(twice.protocol.deviations.map((entry) => entry.id)).toEqual(["D1", "D2"]);
    expect(twice.protocol.deviations[1]).toMatchObject({
      what: "Dropped the second site",
      approved_by: "R. Okonkwo",
    });
  });

  it("refuses a departure from a protocol nobody froze", async () => {
    const refused = await logIt("Widened the age range to 65");
    expect(refused.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect(refused.error?.message).toBe(
      "A deviation is a departure from a protocol that was frozen.",
    );
  });

  it("refuses a day that is not a day", async () => {
    await invoke("kiwi.protocol.freeze", { project_id: project });
    const refused = await invoke("kiwi.protocol.log-deviation", {
      project_id: project,
      on: "last Tuesday",
      what: "Widened the age range",
      why: "Recruitment fell short",
      approved_by: "R. Okonkwo",
    });
    expect(refused.status).toBe("failed");
  });
});
