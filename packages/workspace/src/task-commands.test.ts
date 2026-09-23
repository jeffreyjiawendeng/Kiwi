import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandResult,
  type TaskBody,
} from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { projectCommands } from "./project-commands.js";
import { taskCommands } from "./task-commands.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACCOUNT_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const OTHER_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2301";
const NOW = "2026-08-26T12:00:00.000Z";

let scratch: string;
let gateway: Gateway;
let sequence: number;

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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-task-command-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Task command test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of taskCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  // A task is work on something, and filing that something in a project needs the project
  // commands, so both take the path a person takes.
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  for (const command of projectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-task" });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

async function invoke(
  command: string,
  args: Record<string, unknown> = {},
  actorId = ACCOUNT_ID,
): Promise<CommandResult> {
  return gateway.invoke(envelope(command, { root: scratch, ...args }), {
    actor: { kind: "local_user", id: actorId },
    origin: { surface: "ui", extension_id: null },
  });
}

interface TaskObject {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  task: TaskBody;
}

function taskOf(result: CommandResult): TaskObject {
  return (result.data as { object: TaskObject }).object;
}

function listed(result: CommandResult): TaskObject[] {
  return (result.data as { tasks: TaskObject[] }).tasks;
}

async function createTask(title: string, args: Record<string, unknown> = {}): Promise<TaskObject> {
  return taskOf(await invoke("kiwi.task.create", { title, ...args }));
}

async function createPaper(title = "Smith 2024"): Promise<{ id: string }> {
  const result = await invoke("kiwi.object.create", { type: "source", title, content: "" });
  return (result.data as { object: { id: string } }).object;
}

describe("kiwi.task.create", () => {
  it("writes down work that is not on anything yet", async () => {
    const task = await createTask("Re-run the power analysis");
    expect(task.title).toBe("Re-run the power analysis");
    expect(task.task).toMatchObject({ status: "todo", assignee_id: null, due_on: null });
  });

  it("takes an assignee, a day, and a stage", async () => {
    const task = await createTask("Screen the last forty", {
      assignee_id: OTHER_ID,
      due_on: "2026-08-31",
      stage: "screening",
      notes: "Start with the 2024 batch.",
    });
    expect(task.task).toMatchObject({
      assignee_id: OTHER_ID,
      due_on: "2026-08-31",
      stage: "screening",
    });
  });

  it("attaches the task to what it is work on in the same transaction", async () => {
    const paper = await createPaper();
    const task = await createTask("Check the sample size", { for_object_id: paper.id });
    expect(listed(await invoke("kiwi.task.list", { object_id: paper.id }))).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
  });

  it("refuses a day that is not a day", async () => {
    const refused = await invoke("kiwi.task.create", {
      title: "Something",
      due_on: "next Tuesday",
    });
    expect(refused.status).toBe("failed");
  });
});

describe("kiwi.task.update", () => {
  it("changes one field and leaves the rest alone", async () => {
    const task = await createTask("Draft the methods", { assignee_id: ACCOUNT_ID });
    const updated = taskOf(
      await invoke("kiwi.task.update", { task_id: task.id, due_on: "2026-09-04" }),
    );
    expect(updated.task).toMatchObject({ assignee_id: ACCOUNT_ID, due_on: "2026-09-04" });
  });

  it("takes a task off somebody when the assignee is cleared", async () => {
    // Null is a value here: unassigning and leaving it alone are different intentions.
    const task = await createTask("Draft the methods", { assignee_id: ACCOUNT_ID });
    const updated = taskOf(
      await invoke("kiwi.task.update", { task_id: task.id, assignee_id: null }),
    );
    expect(updated.task.assignee_id).toBeNull();
  });

  it("writes nothing when nothing changed", async () => {
    const task = await createTask("Draft the methods", { due_on: "2026-09-04" });
    const again = await invoke("kiwi.task.update", { task_id: task.id, due_on: "2026-09-04" });
    expect(again.status).toBe("no_change");
    expect(taskOf(again).version).toBe(task.version);
  });

  it("clears the finish time when a done task is dragged back", async () => {
    const task = await createTask("Draft the methods");
    await invoke("kiwi.task.complete", { task_id: task.id });
    const moved = taskOf(await invoke("kiwi.task.update", { task_id: task.id, status: "doing" }));
    expect(moved.task).toMatchObject({ status: "doing", completed_at: null });
  });
});

describe("what a task waits for", () => {
  it("records the wait", async () => {
    const collect = await createTask("Collect");
    const write = await createTask("Write");
    const waiting = taskOf(
      await invoke("kiwi.task.update", { task_id: write.id, blocked_by: [collect.id] }),
    );
    expect(waiting.task.blocked_by).toEqual([collect.id]);
  });

  it("refuses a loop and names every task in it", async () => {
    const collect = await createTask("Collect");
    const analyse = await createTask("Analyse");
    const write = await createTask("Write");
    await invoke("kiwi.task.update", { task_id: analyse.id, blocked_by: [collect.id] });
    await invoke("kiwi.task.update", { task_id: write.id, blocked_by: [analyse.id] });

    const refused = await invoke("kiwi.task.update", {
      task_id: collect.id,
      blocked_by: [write.id],
    });
    expect(refused.status).toBe("failed");
    // The ids mean nothing to the person who clicked. The titles are how they find the three
    // tasks among forty.
    expect(refused.error?.message).toBe(
      "That would make a loop: Collect waits for Write waits for Analyse waits for Collect.",
    );
  });

  it("refuses a task that waits for itself", async () => {
    const task = await createTask("Collect");
    const refused = await invoke("kiwi.task.update", { task_id: task.id, blocked_by: [task.id] });
    expect(refused.status).toBe("failed");
  });

  it("refuses to wait for a task that is not there", async () => {
    const task = await createTask("Collect");
    const refused = await invoke("kiwi.task.update", {
      task_id: task.id,
      blocked_by: ["0198c810-0000-7000-8000-000000009999"],
    });
    expect(refused.status).toBe("failed");
    expect(refused.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.task.complete and kiwi.task.reopen", () => {
  it("records when the work was finished", async () => {
    const task = await createTask("Draft the methods");
    const done = taskOf(await invoke("kiwi.task.complete", { task_id: task.id }));
    expect(done.task).toMatchObject({ status: "done", completed_at: NOW });
  });

  it("is one click however many times it arrives", async () => {
    const task = await createTask("Draft the methods");
    const first = await invoke("kiwi.task.complete", { task_id: task.id });
    const second = await invoke("kiwi.task.complete", { task_id: task.id });
    expect(second.status).toBe("no_change");
    expect(taskOf(second).version).toBe(taskOf(first).version);
  });

  it("comes back as work to do", async () => {
    const task = await createTask("Draft the methods");
    await invoke("kiwi.task.complete", { task_id: task.id });
    const back = taskOf(await invoke("kiwi.task.reopen", { task_id: task.id }));
    expect(back.task).toMatchObject({ status: "todo", completed_at: null });
  });

  it("comes back as waiting when what it waits for is unfinished", async () => {
    const collect = await createTask("Collect");
    const write = await createTask("Write");
    await invoke("kiwi.task.update", { task_id: write.id, blocked_by: [collect.id] });
    await invoke("kiwi.task.complete", { task_id: write.id });

    const back = taskOf(await invoke("kiwi.task.reopen", { task_id: write.id }));
    expect(back.task.status).toBe("blocked");
  });

  it("comes back as work to do when what it waited for is finished", async () => {
    const collect = await createTask("Collect");
    const write = await createTask("Write");
    await invoke("kiwi.task.update", { task_id: write.id, blocked_by: [collect.id] });
    await invoke("kiwi.task.complete", { task_id: write.id });
    await invoke("kiwi.task.complete", { task_id: collect.id });

    const back = taskOf(await invoke("kiwi.task.reopen", { task_id: write.id }));
    expect(back.task.status).toBe("todo");
  });
});

describe("kiwi.task.link and kiwi.task.unlink", () => {
  it("says what a task is work on, and takes it off again", async () => {
    const paper = await createPaper();
    const task = await createTask("Check the sample size");
    expect((await invoke("kiwi.task.link", { task_id: task.id, object_id: paper.id })).status).toBe(
      "committed",
    );
    expect(listed(await invoke("kiwi.task.list", { object_id: paper.id }))).toHaveLength(1);

    await invoke("kiwi.task.unlink", { task_id: task.id, object_id: paper.id });
    expect(listed(await invoke("kiwi.task.list", { object_id: paper.id }))).toEqual([]);
    // The task itself is not deleted by being taken off a paper.
    expect(listed(await invoke("kiwi.task.list"))).toHaveLength(1);
  });

  it("refuses to attach the same task twice", async () => {
    const paper = await createPaper();
    const task = await createTask("Check the sample size", { for_object_id: paper.id });
    const again = await invoke("kiwi.task.link", { task_id: task.id, object_id: paper.id });
    expect(again.status).toBe("failed");
    expect(again.error?.message).toBe("That task is already on this.");
  });
});

describe("kiwi.task.list", () => {
  it("puts the soonest first and the undated last", async () => {
    const later = await createTask("Later", { due_on: "2026-09-30" });
    const undated = await createTask("Undated");
    const soon = await createTask("Soon", { due_on: "2026-08-27" });

    expect(listed(await invoke("kiwi.task.list")).map((task) => task.id)).toEqual([
      soon.id,
      later.id,
      undated.id,
    ]);
  });

  it("answers what is mine, what nobody has taken, and what stands where", async () => {
    const mine = await createTask("Mine", { assignee_id: ACCOUNT_ID });
    const theirs = await createTask("Theirs", { assignee_id: OTHER_ID });
    const nobody = await createTask("Nobody");
    await invoke("kiwi.task.update", { task_id: theirs.id, status: "doing" });

    expect(listed(await invoke("kiwi.task.list", { mine: true })).map((task) => task.id)).toEqual([
      mine.id,
    ]);
    expect(
      listed(await invoke("kiwi.task.list", { unassigned: true })).map((task) => task.id),
    ).toEqual([nobody.id]);
    expect(
      listed(await invoke("kiwi.task.list", { status: "doing" })).map((task) => task.id),
    ).toEqual([theirs.id]);
  });

  it("finds the work on anything filed in a project", async () => {
    const filed = await createPaper();
    const loose = await createPaper("Jones 2023");
    const project = (
      (await invoke("kiwi.project.create", { title: "Ribosome assembly" })).data as {
        project: { id: string };
      }
    ).project;
    await invoke("kiwi.project.assign", { object_id: filed.id, project_id: project.id });
    const onFiled = await createTask("Check the cohort", { for_object_id: filed.id });
    await createTask("Unrelated", { for_object_id: loose.id });

    expect(
      listed(await invoke("kiwi.task.list", { project_id: project.id })).map((task) => task.id),
    ).toEqual([onFiled.id]);
  });
});

describe("kiwi.task.delete", () => {
  it("moves a task to Trash and offers the way back", async () => {
    const task = await createTask("Draft the methods");
    const deleted = await invoke("kiwi.task.delete", {
      task_id: task.id,
      expected_version: task.version,
      expected_hash: task.content_hash,
    });
    expect(deleted.status).toBe("committed");
    expect(deleted.data).toMatchObject({
      undo: { command: "kiwi.object.restore-from-trash", args: { object_id: task.id } },
    });
    expect(listed(await invoke("kiwi.task.list"))).toEqual([]);

    await invoke("kiwi.object.restore-from-trash", { object_id: task.id });
    expect(listed(await invoke("kiwi.task.list"))).toEqual([
      expect.objectContaining({ id: task.id }),
    ]);
  });

  it("does not hold a task in Blocked behind work that has been deleted", async () => {
    const collect = await createTask("Collect");
    const write = await createTask("Write");
    await invoke("kiwi.task.update", { task_id: write.id, blocked_by: [collect.id] });
    await invoke("kiwi.task.complete", { task_id: write.id });
    const stored = listed(await invoke("kiwi.task.list")).find((task) => task.id === collect.id);
    await invoke("kiwi.task.delete", {
      task_id: collect.id,
      expected_version: stored?.version,
      expected_hash: stored?.content_hash,
    });

    const back = taskOf(await invoke("kiwi.task.reopen", { task_id: write.id }));
    expect(back.task.status).toBe("todo");
  });
});
