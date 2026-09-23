import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type CommandEnvelope } from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { projectCommands } from "./project-commands.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACCOUNT_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const NOW = "2026-08-25T12:00:00.000Z";

let scratch: string;
let gateway: Gateway;
let sequence: number;

function nextId(): string {
  sequence += 1;
  return `0198c800-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-project-command-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Project command test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of projectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  // Assigning something to a project needs something to assign, so the object commands take
  // the same path a person does.
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-project" });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

async function invoke(command: string, args: Record<string, unknown> = {}) {
  return gateway.invoke(envelope(command, { root: scratch, ...args }), {
    actor: { kind: "local_user", id: ACCOUNT_ID },
    origin: { surface: "ui", extension_id: null },
  });
}

async function createProject(title = "Ribosome assembly", args: Record<string, unknown> = {}) {
  const result = await invoke("kiwi.project.create", { title, ...args });
  return (
    result.data as {
      project: { id: string; title: string; version: number; content_hash: string };
    }
  ).project;
}

async function createPaper(title = "Smith 2024") {
  const result = await invoke("kiwi.object.create", { type: "source", title, content: "" });
  return (result.data as { object: { id: string } }).object;
}

describe("kiwi.project.create", () => {
  it("creates a project with the general template by default", async () => {
    const result = await invoke("kiwi.project.create", { title: "Thesis chapter 3" });
    expect(result.status).toBe("committed");
    expect(result.data).toMatchObject({
      settings: { template: "general", pages: [] },
      project: { type: "project", title: "Thesis chapter 3" },
    });
  });

  it("turns on the pages a template asks for", async () => {
    const result = await invoke("kiwi.project.create", {
      title: "Screen 2026",
      template: "quantitative",
    });
    expect((result.data as { settings: { pages: string[] } }).settings.pages).toEqual([
      "data",
      "analysis",
      "results",
    ]);
  });

  it("refuses a template it does not have", async () => {
    const result = await invoke("kiwi.project.create", { title: "X", template: "telepathy" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses a blank name", async () => {
    const result = await invoke("kiwi.project.create", { title: "   " });
    expect(result.status).toBe("failed");
  });
});

describe("kiwi.project.list", () => {
  it("is empty in a new workspace", async () => {
    const result = await invoke("kiwi.project.list");
    expect(result.data).toEqual({ projects: [] });
  });

  it("returns what the switcher needs to open a project", async () => {
    await createProject();
    const listed = (await invoke("kiwi.project.list")).data as {
      projects: Array<Record<string, unknown>>;
    };
    expect(listed.projects[0]).toMatchObject({
      title: "Ribosome assembly",
      version: 1,
      counts: {},
    });
    expect(listed.projects[0]?.["content_hash"]).toMatch(/^sha256:/u);
  });

  it("counts what belongs to each project", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });

    const listed = (await invoke("kiwi.project.list")).data as {
      projects: Array<{ counts: Record<string, number> }>;
    };
    expect(listed.projects[0]?.counts).toEqual({ source: 1 });
  });
});

describe("kiwi.project.configure", () => {
  it("turns a page on", async () => {
    const project = await createProject();
    const result = await invoke("kiwi.project.configure", {
      project_id: project.id,
      expected_version: project.version,
      expected_hash: project.content_hash,
      title: project.title,
      settings: { pages: ["screening"] },
    });
    expect(result.status).toBe("committed");
    expect((result.data as { settings: { pages: string[] } }).settings.pages).toEqual([
      "screening",
    ]);
  });

  it("leaves untouched settings alone", async () => {
    // A page switch must not silently reset the citation style.
    const project = await createProject("Review", { template: "literature_review" });
    await invoke("kiwi.project.configure", {
      project_id: project.id,
      expected_version: project.version,
      expected_hash: project.content_hash,
      title: project.title,
      settings: { citation_style: "ieee" },
    });
    const listed = (await invoke("kiwi.project.list")).data as {
      projects: Array<{ settings: { pages: string[]; citation_style: string } }>;
    };
    expect(listed.projects[0]?.settings).toMatchObject({
      citation_style: "ieee",
      pages: ["screening", "extraction"],
    });
  });

  it("refuses a page name it does not have", async () => {
    const project = await createProject();
    const result = await invoke("kiwi.project.configure", {
      project_id: project.id,
      expected_version: project.version,
      expected_hash: project.content_hash,
      title: project.title,
      settings: { pages: ["library"] },
    });
    // Library is always on. Accepting it here would imply it could be switched off.
    expect(result.status).toBe("failed");
  });

  it("reports a stale version rather than overwriting", async () => {
    const project = await createProject();
    const result = await invoke("kiwi.project.configure", {
      project_id: project.id,
      expected_version: project.version,
      expected_hash: "sha256:" + "0".repeat(64),
      title: project.title,
      settings: {},
    });
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("warns without refusing when Results has no Analysis behind it", async () => {
    const project = await createProject();
    const result = await invoke("kiwi.project.configure", {
      project_id: project.id,
      expected_version: project.version,
      expected_hash: project.content_hash,
      title: project.title,
      settings: { pages: ["results"] },
    });
    expect(result.status).toBe("committed");
    expect((result.data as { warnings: unknown[] }).warnings).toHaveLength(1);
  });

  it("says so when the project is not there", async () => {
    const result = await invoke("kiwi.project.configure", {
      project_id: "0198c800-0000-7000-8000-000000009999",
      expected_version: 1,
      expected_hash: "sha256:" + "0".repeat(64),
      title: "Gone",
      settings: {},
    });
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.project.assign", () => {
  it("puts a paper in a project", async () => {
    const project = await createProject();
    const paper = await createPaper();
    const result = await invoke("kiwi.project.assign", {
      object_id: paper.id,
      project_id: project.id,
    });
    expect(result.status).toBe("committed");

    const membership = await invoke("kiwi.project.membership", { object_id: paper.id });
    expect((membership.data as { project: { id: string } }).project.id).toBe(project.id);
  });

  it("reports no change when it is already there", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });
    const again = await invoke("kiwi.project.assign", {
      object_id: paper.id,
      project_id: project.id,
    });
    expect(again.status).toBe("no_change");
  });

  it("takes an object out of every project", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: null });

    const membership = await invoke("kiwi.project.membership", { object_id: paper.id });
    expect((membership.data as { project: unknown }).project).toBeNull();
  });

  it("says so when the object is not there", async () => {
    const project = await createProject();
    const result = await invoke("kiwi.project.assign", {
      object_id: "0198c800-0000-7000-8000-000000009999",
      project_id: project.id,
    });
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });

  it("refuses to nest one project in another", async () => {
    const outer = await createProject("Outer");
    const inner = await createProject("Inner");
    const result = await invoke("kiwi.project.assign", {
      object_id: inner.id,
      project_id: outer.id,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("kiwi.project.membership", () => {
  it("is null for something in no project", async () => {
    const paper = await createPaper();
    const result = await invoke("kiwi.project.membership", { object_id: paper.id });
    expect((result.data as { project: unknown }).project).toBeNull();
  });
});

describe("kiwi.project.members", () => {
  it("lists what belongs to the project, most recently changed first", async () => {
    const target = await createProject();
    const first = await createPaper("First");
    const second = await createPaper("Second");
    await invoke("kiwi.project.assign", { object_id: first.id, project_id: target.id });
    await invoke("kiwi.project.assign", { object_id: second.id, project_id: target.id });

    const result = await invoke("kiwi.project.members", { project_id: target.id });
    const data = result.data as { objects: Array<{ id: string }>; total: number };
    expect(data.total).toBe(2);
    expect(data.objects.map((object) => object.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("does not list an object in another project", async () => {
    const mine = await createProject("Mine");
    const theirs = await createProject("Theirs");
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: theirs.id });

    const result = await invoke("kiwi.project.members", { project_id: mine.id });
    expect((result.data as { objects: unknown[] }).objects).toEqual([]);
  });

  it("honours a limit while still reporting the true total", async () => {
    const target = await createProject();
    for (const title of ["One", "Two", "Three"]) {
      const paper = await createPaper(title);
      await invoke("kiwi.project.assign", { object_id: paper.id, project_id: target.id });
    }
    const result = await invoke("kiwi.project.members", { project_id: target.id, limit: 2 });
    const data = result.data as { objects: unknown[]; total: number };
    expect(data.objects).toHaveLength(2);
    expect(data.total).toBe(3);
  });
});

describe("deleting a project", () => {
  it("says what is filed in it before anybody is asked to confirm", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });

    const preview = (await invoke("kiwi.project.validate-delete", { project_id: project.id }))
      .data as { counts: Record<string, number>; object_count: number };

    expect(preview.counts).toEqual({ source: 1 });
    expect(preview.object_count).toBe(1);
  });

  it("refuses without the project's name typed", async () => {
    const project = await createProject();

    const result = await invoke("kiwi.project.delete", {
      project_id: project.id,
      confirmation: "Ribosome",
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    expect((await invoke("kiwi.project.list")).data).toMatchObject({ projects: [{}] });
  });

  it("deletes the project and leaves everything that was in it in the workspace", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });

    const result = await invoke("kiwi.project.delete", {
      project_id: project.id,
      confirmation: "Ribosome assembly",
    });

    expect(result.status).toBe("committed");
    expect(result.data).toMatchObject({ unfiled: 1 });
    expect((await invoke("kiwi.project.list")).data).toEqual({ projects: [] });
    // The whole point: a project is a folder somebody put work into, not the work.
    const listed = (await invoke("kiwi.object.list")).data as { objects: Array<{ id: string }> };
    expect(listed.objects.map((object) => object.id)).toContain(paper.id);
  });

  it("takes the object out of the project rather than leaving a link to nothing", async () => {
    const project = await createProject();
    const paper = await createPaper();
    await invoke("kiwi.project.assign", { object_id: paper.id, project_id: project.id });

    await invoke("kiwi.project.delete", {
      project_id: project.id,
      confirmation: "Ribosome assembly",
    });

    const links = (await invoke("kiwi.relation.for-object", { object_id: paper.id })).data as {
      relations: Array<unknown>;
    };
    expect(links.relations).toEqual([]);
  });

  it("ignores the spaces somebody typed around the name", async () => {
    const project = await createProject();

    const result = await invoke("kiwi.project.delete", {
      project_id: project.id,
      confirmation: "  Ribosome assembly  ",
    });

    expect(result.status).toBe("committed");
  });

  it("refuses to delete something that is not a project", async () => {
    const paper = await createPaper();

    const result = await invoke("kiwi.project.delete", {
      project_id: paper.id,
      confirmation: "Smith 2024",
    });

    expect(result.status).toBe("failed");
  });
});
