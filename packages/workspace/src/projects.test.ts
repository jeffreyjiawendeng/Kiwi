import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectSettings, type ProjectSettings } from "@kiwi/contracts";
import { createWorkspace } from "./store.js";
import {
  IN_PROJECT_RELATION,
  NotAProjectError,
  ProjectValidationError,
  assignObjectToProject,
  configureProject,
  createAnnotation,
  createObject,
  createProject,
  listProjects,
  projectForObject,
  projectMembers,
  projectSettingsOf,
  readCanonicalObject,
  relationsForObject,
} from "./objects.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACTOR = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
let scratch: string;
let sequence: number;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-projects-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Project tests",
    now: "2026-08-25T12:00:00.000Z",
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

function id(): string {
  sequence += 1;
  return `0198c800-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function ids() {
  return {
    transactionId: id(),
    preparedEventId: id(),
    domainEventId: id(),
    committedEventId: id(),
  };
}

async function project(title = "Ribosome assembly", settings?: Partial<ProjectSettings>) {
  // The template decides which pages start on, so the defaults are built from it the way
  // the creation page does rather than from "general".
  const base = defaultProjectSettings(settings?.template ?? "general");
  return createProject({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    objectId: id(),
    title,
    settings: { ...base, ...settings },
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-25T12:01:00.000Z",
    ...ids(),
  });
}

async function paper(title = "Smith 2024") {
  return createObject({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    objectId: id(),
    type: "source",
    title,
    content: "",
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-25T12:02:00.000Z",
    ...ids(),
  });
}

/** A highlight on a paper, the way the Reader makes one. */
async function mark(objectId: string) {
  return createAnnotation({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    annotationId: id(),
    relationId: id(),
    objectId,
    annotation: {
      kind: "highlight",
      asset_id: "asset-pdf",
      page: 3,
      page_label: "3",
      rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
      color: "yellow",
      quoted: "Attention is all you need",
      comment: "",
      image_asset_id: null,
    },
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-25T12:04:00.000Z",
    ...ids(),
  });
}

async function assign(objectId: string, projectId: string | null) {
  return assignObjectToProject({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    relationId: id(),
    objectId,
    projectId,
    actor: ACTOR,
    requestId: id(),
    now: "2026-08-25T12:03:00.000Z",
    ...ids(),
  });
}

describe("createProject", () => {
  it("writes the settings with the first version", async () => {
    // Settings written in a second transaction would leave a version 1 no page could read.
    const created = await project("Thesis chapter 3", { template: "quantitative" });
    expect(created.version).toBe(1);
    expect(projectSettingsOf(created).pages).toEqual(["data", "analysis", "results"]);
  });

  it("keeps the description searchable", async () => {
    // The description is the object's content, so workspace search finds a project by what it
    // is about rather than only by its name.
    const created = await project("Screen", { description: "Ribosome assembly in yeast" });
    expect(created.content).toBe("Ribosome assembly in yeast");
  });

  it("refuses a project with no name", async () => {
    await expect(project("   ")).rejects.toBeInstanceOf(ProjectValidationError);
  });

  it("is readable back off disk", async () => {
    const created = await project();
    const found = await readCanonicalObject(scratch, created.id);
    expect(found?.object.type).toBe("project");
    expect(projectSettingsOf(found!.object).template).toBe("general");
  });
});

describe("configureProject", () => {
  it("turns a page on without touching anything else", async () => {
    const created = await project();
    const next = await configureProject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      projectId: created.id,
      expectedVersion: created.version,
      expectedHash: created.content_hash,
      title: created.title,
      settings: { ...projectSettingsOf(created), pages: ["screening"] },
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-25T12:05:00.000Z",
      ...ids(),
    });
    expect(projectSettingsOf(next).pages).toEqual(["screening"]);
    expect(next.title).toBe(created.title);
    expect(next.version).toBe(2);
  });

  it("refuses an object that is not a project", async () => {
    const notAProject = await paper();
    await expect(
      configureProject({
        root: scratch,
        workspaceId: WORKSPACE_ID,
        projectId: notAProject.id,
        expectedVersion: notAProject.version,
        expectedHash: notAProject.content_hash,
        title: notAProject.title,
        settings: defaultProjectSettings(),
        actor: ACTOR,
        requestId: id(),
        now: "2026-08-25T12:05:00.000Z",
        ...ids(),
      }),
    ).rejects.toBeInstanceOf(NotAProjectError);
  });

  it("keeps a disabled page's objects", async () => {
    // Turning a page off hides it. Losing the work behind it would make the switch dangerous
    // enough that nobody would touch it.
    const created = await project("Review", { template: "literature_review" });
    const source = await paper();
    await assign(source.id, created.id);
    await configureProject({
      root: scratch,
      workspaceId: WORKSPACE_ID,
      projectId: created.id,
      expectedVersion: created.version,
      expectedHash: created.content_hash,
      title: created.title,
      settings: { ...projectSettingsOf(created), pages: [] },
      actor: ACTOR,
      requestId: id(),
      now: "2026-08-25T12:06:00.000Z",
      ...ids(),
    });
    expect(await projectMembers(scratch, created.id)).toHaveLength(1);
  });
});

describe("assignObjectToProject", () => {
  it("puts an object in a project", async () => {
    const target = await project();
    const source = await paper();
    const receipt = await assign(source.id, target.id);

    expect(receipt.projectId).toBe(target.id);
    expect((await projectForObject(scratch, source.id))?.id).toBe(target.id);
  });

  it("leaves an object in exactly one project", async () => {
    // Two asserted memberships would make "which project is this in" unanswerable.
    const first = await project("First");
    const second = await project("Second");
    const source = await paper();
    await assign(source.id, first.id);
    await assign(source.id, second.id);

    const active = (await relationsForObject(scratch, source.id)).filter(
      (link) => link.relation.type === IN_PROJECT_RELATION,
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.relation.object.object_id).toBe(second.id);
  });

  it("retracts the old membership rather than deleting it", async () => {
    const first = await project("First");
    const second = await project("Second");
    const source = await paper();
    await assign(source.id, first.id);
    await assign(source.id, second.id);

    const everything = await relationsForObject(scratch, source.id, true);
    const retracted = everything.filter(
      (link) =>
        link.relation.type === IN_PROJECT_RELATION && link.relation.assertion === "retracted",
    );
    expect(retracted).toHaveLength(1);
    expect(retracted[0]?.relation.object.object_id).toBe(first.id);
  });

  it("writes nothing when the object is already in that project", async () => {
    // Every page load would otherwise add a version to the history of everything it lists.
    const target = await project();
    const source = await paper();
    await assign(source.id, target.id);
    const receipt = await assign(source.id, target.id);
    expect(receipt.relations).toEqual([]);
  });

  it("removes an object from every project when given no destination", async () => {
    const target = await project();
    const source = await paper();
    await assign(source.id, target.id);
    await assign(source.id, null);
    expect(await projectForObject(scratch, source.id)).toBeNull();
  });

  it("writes nothing when there was no membership to remove", async () => {
    const source = await paper();
    expect((await assign(source.id, null)).relations).toEqual([]);
  });

  it("refuses to put a project inside a project", async () => {
    const outer = await project("Outer");
    const inner = await project("Inner");
    await expect(assign(inner.id, outer.id)).rejects.toBeInstanceOf(NotAProjectError);
  });

  it("refuses a destination that is not a project", async () => {
    const source = await paper();
    const other = await paper("Another paper");
    await expect(assign(source.id, other.id)).rejects.toBeInstanceOf(NotAProjectError);
  });
});

describe("listProjects", () => {
  it("is empty in a new workspace", async () => {
    expect(await listProjects(scratch)).toEqual([]);
  });

  it("counts members by type", async () => {
    const target = await project();
    await assign((await paper("One")).id, target.id);
    await assign((await paper("Two")).id, target.id);

    const listed = await listProjects(scratch);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.counts).toEqual({ source: 2 });
  });

  it("does not count a member that moved away", async () => {
    const first = await project("First");
    const second = await project("Second");
    const source = await paper();
    await assign(source.id, first.id);
    await assign(source.id, second.id);

    const byId = new Map((await listProjects(scratch)).map((entry) => [entry.object.id, entry]));
    expect(byId.get(first.id)?.counts).toEqual({});
    expect(byId.get(second.id)?.counts).toEqual({ source: 1 });
  });

  it("counts a mark where the paper it was made on is filed", async () => {
    // A mark is never filed in a project itself, and a Dashboard that counted only what was
    // filed said "no annotations" over a project full of highlights.
    const target = await project();
    const elsewhere = await project("Elsewhere");
    const filed = await paper("Filed");
    const loose = await paper("Loose");
    await assign(filed.id, target.id);
    await mark(filed.id);
    await mark(filed.id);
    await mark(loose.id);

    const byId = new Map((await listProjects(scratch)).map((entry) => [entry.object.id, entry]));
    expect(byId.get(target.id)?.counts).toEqual({ source: 1, annotation: 2 });
    expect(byId.get(elsewhere.id)?.counts).toEqual({});
  });

  it("sinks an archived project below an active one", async () => {
    const archived = await project("Finished", { archived: true });
    const active = await project("Current");
    const listed = await listProjects(scratch);
    expect(listed.map((entry) => entry.object.id)).toEqual([active.id, archived.id]);
  });
});

describe("projectMembers", () => {
  it("lists what belongs to the project and nothing else", async () => {
    const target = await project();
    const other = await project("Other");
    const mine = await paper("Mine");
    await assign(mine.id, target.id);
    await assign((await paper("Theirs")).id, other.id);
    const unfiled = await paper("Unfiled");

    const members = await projectMembers(scratch, target.id);
    expect(members.map((object) => object.id)).toEqual([mine.id]);
    expect(members.map((object) => object.id)).not.toContain(unfiled.id);
  });
});
