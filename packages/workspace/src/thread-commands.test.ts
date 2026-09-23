import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandResult,
  type ThreadBody,
} from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { projectCommands } from "./project-commands.js";
import { threadCommands } from "./thread-commands.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACCOUNT_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const OTHER_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2301";
const NOW = "2026-08-26T12:00:00.000Z";
const OPENING = "Is this the right cohort?";

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
  scratch = await mkdtemp(join(tmpdir(), "kiwi-thread-command-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Thread command test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of threadCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  // Commenting needs something to comment on, and filing that in a project needs the project
  // commands, so both take the path a person takes.
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  for (const command of projectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-thread" });
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

async function createPaper(title = "Smith 2024"): Promise<{ id: string }> {
  const result = await invoke("kiwi.object.create", { type: "source", title, content: "" });
  return (result.data as { object: { id: string } }).object;
}

interface ThreadObject {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  thread: ThreadBody;
}

function threadOf(result: CommandResult): ThreadObject {
  return (result.data as { object: ThreadObject }).object;
}

async function startThreadOn(
  objectId: string,
  body = OPENING,
  actorId = ACCOUNT_ID,
): Promise<ThreadObject> {
  const result = await invoke(
    "kiwi.thread.start",
    {
      anchor: {
        object_id: objectId,
        kind: "text_range",
        from: 120,
        to: 161,
        quote: "the effect was larger in the second cohort",
      },
      body,
      author_name: "Ada",
    },
    actorId,
  );
  expect(result.status).toBe("committed");
  return threadOf(result);
}

describe("kiwi.thread.start", () => {
  it("files the comment as its own object and links it to what it is about", async () => {
    const paper = await createPaper();
    const thread = await startThreadOn(paper.id);
    expect(thread).toMatchObject({
      title: OPENING,
      thread: { status: "open", anchor: { object_id: paper.id, kind: "text_range" } },
    });
    expect(thread.thread.messages).toHaveLength(1);

    const relations = await invoke("kiwi.relation.for-object", { object_id: paper.id });
    expect((relations.data as { relations: unknown[] }).relations).toContainEqual(
      expect.objectContaining({
        relation: expect.objectContaining({ type: "comments_on" }) as unknown,
      }),
    );
  });

  it("refuses to comment on something that is not there", async () => {
    const result = await invoke("kiwi.thread.start", {
      anchor: { object_id: "0198c7c1-4e7d-7e31-a23a-8242000000ff", kind: "object" },
      body: OPENING,
      author_name: "Ada",
    });
    expect(result.error).toMatchObject({ code: "KIWI_NOT_FOUND" });
  });

  it("refuses an empty comment", async () => {
    const paper = await createPaper();
    const result = await invoke("kiwi.thread.start", {
      anchor: { object_id: paper.id, kind: "object" },
      body: "",
      author_name: "Ada",
    });
    expect(result.error).toMatchObject({ code: "KIWI_INVALID_ARGUMENTS" });
  });
});

describe("kiwi.thread.reply", () => {
  it("appends without a version to check and keeps both comments", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const replied = await invoke(
      "kiwi.thread.reply",
      { thread_id: started.id, body: "Yes, the second.", author_name: "Grace" },
      OTHER_ID,
    );
    expect(replied.status).toBe("committed");
    const thread = threadOf(replied).thread;
    expect(thread.messages.map((message) => message.body)).toEqual([OPENING, "Yes, the second."]);
    expect(thread.participants).toEqual([ACCOUNT_ID, OTHER_ID]);
  });

  it("says so plainly when the thread is gone", async () => {
    const result = await invoke("kiwi.thread.reply", {
      thread_id: "0198c7c1-4e7d-7e31-a23a-8242000000fe",
      body: "Hello?",
      author_name: "Ada",
    });
    expect(result.error).toMatchObject({ code: "KIWI_NOT_FOUND" });
  });
});

describe("kiwi.thread.edit-message", () => {
  it("rewords your own comment", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const messageId = started.thread.messages[0]?.id ?? "";
    const edited = await invoke("kiwi.thread.edit-message", {
      thread_id: started.id,
      message_id: messageId,
      body: "Is this the right cohort, or the pooled one?",
    });
    expect(edited.status).toBe("committed");
    expect(threadOf(edited).thread.messages[0]).toMatchObject({ edited_at: NOW });
  });

  it("refuses to rewrite somebody else's comment", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const result = await invoke(
      "kiwi.thread.edit-message",
      {
        thread_id: started.id,
        message_id: started.thread.messages[0]?.id ?? "",
        body: "I never said that.",
      },
      OTHER_ID,
    );
    expect(result.error).toMatchObject({ code: "KIWI_FORBIDDEN" });
  });
});

describe("kiwi.thread.resolve", () => {
  it("resolves once however many times it is resolved", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const first = await invoke("kiwi.thread.resolve", { thread_id: started.id });
    expect(first.status).toBe("committed");
    expect(threadOf(first).thread).toMatchObject({ status: "resolved", resolved_by: ACCOUNT_ID });

    const again = await invoke("kiwi.thread.resolve", { thread_id: started.id }, OTHER_ID);
    expect(again.status).toBe("no_change");
    expect(threadOf(again)).toMatchObject({ version: threadOf(first).version });
  });

  it("forgets who resolved a thread when it is reopened", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    await invoke("kiwi.thread.resolve", { thread_id: started.id });
    const reopened = await invoke("kiwi.thread.reopen", { thread_id: started.id });
    expect(threadOf(reopened).thread).toMatchObject({
      status: "open",
      resolved_by: null,
      resolved_at: null,
    });
  });
});

describe("kiwi.thread.reanchor", () => {
  it("points an orphan at the words it is about now", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const moved = await invoke("kiwi.thread.reanchor", {
      thread_id: started.id,
      from: 40,
      to: 62,
      quote: "the pooled estimate",
    });
    expect(threadOf(moved).thread.anchor).toMatchObject({
      from: 40,
      to: 62,
      quote: "the pooled estimate",
    });
  });

  it("refuses an empty selection", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const result = await invoke("kiwi.thread.reanchor", {
      thread_id: started.id,
      from: 40,
      to: 40,
      quote: "x",
    });
    expect(result.error).toMatchObject({ code: "KIWI_INVALID_ARGUMENTS" });
  });
});

describe("kiwi.thread.list", () => {
  it("answers the inbox without changing anything", async () => {
    const paper = await createPaper();
    const other = await createPaper("Jones 2023");
    await startThreadOn(paper.id);
    const mine = await startThreadOn(other.id, `Ping @[Ada](user:${ACCOUNT_ID})`, OTHER_ID);
    await invoke("kiwi.thread.resolve", { thread_id: mine.id });

    const all = await invoke("kiwi.thread.list");
    expect(all.status).toBe("no_change");
    expect((all.data as { threads: unknown[] }).threads).toHaveLength(2);

    const onPaper = await invoke("kiwi.thread.list", { object_id: paper.id });
    expect((onPaper.data as { threads: ThreadObject[] }).threads).toHaveLength(1);

    const open = await invoke("kiwi.thread.list", { status: "open" });
    expect((open.data as { threads: ThreadObject[] }).threads).toHaveLength(1);

    const written = await invoke("kiwi.thread.list", { mine: true }, OTHER_ID);
    expect((written.data as { threads: ThreadObject[] }).threads[0]).toMatchObject({ id: mine.id });

    const mentioned = await invoke("kiwi.thread.list", { mentions: true });
    expect((mentioned.data as { threads: ThreadObject[] }).threads[0]).toMatchObject({
      id: mine.id,
    });
  });

  it("gathers what the caller is part of, written in or named in", async () => {
    const paper = await createPaper();
    const other = await createPaper("Jones 2023");
    const wrote = await startThreadOn(paper.id);
    const named = await startThreadOn(other.id, `Ping @[Ada](user:${ACCOUNT_ID})`, OTHER_ID);

    const involved = await invoke("kiwi.thread.list", { involving_me: true });
    expect((involved.data as { threads: ThreadObject[] }).threads.map((one) => one.id)).toEqual([
      wrote.id,
      named.id,
    ]);

    // The same question asked by the other account: it wrote one and is named in none.
    const theirs = await invoke("kiwi.thread.list", { involving_me: true }, OTHER_ID);
    expect((theirs.data as { threads: ThreadObject[] }).threads.map((one) => one.id)).toEqual([
      named.id,
    ]);
  });

  it("filters by the project the commented object is filed in", async () => {
    const filed = await createPaper();
    const loose = await createPaper("Jones 2023");
    const project = (
      (await invoke("kiwi.project.create", { title: "Ribosome assembly" })).data as {
        project: { id: string };
      }
    ).project;
    await invoke("kiwi.project.assign", { object_id: filed.id, project_id: project.id });
    const inProject = await startThreadOn(filed.id);
    await startThreadOn(loose.id, "Unrelated.");

    const found = await invoke("kiwi.thread.list", { project_id: project.id });
    expect((found.data as { threads: ThreadObject[] }).threads).toEqual([
      expect.objectContaining({ id: inProject.id }),
    ]);
  });
});

describe("kiwi.thread.delete", () => {
  it("moves a thread to Trash and offers the way back", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    const deleted = await invoke("kiwi.thread.delete", {
      thread_id: started.id,
      expected_version: started.version,
      expected_hash: started.content_hash,
    });
    expect(deleted.status).toBe("committed");
    expect(deleted.data).toMatchObject({
      undo: { command: "kiwi.object.restore-from-trash", args: { object_id: started.id } },
    });
    expect((await invoke("kiwi.thread.list")).data).toMatchObject({ threads: [] });

    await invoke("kiwi.object.restore-from-trash", { object_id: started.id });
    expect((await invoke("kiwi.thread.list")).data).toMatchObject({
      threads: [expect.objectContaining({ id: started.id })],
    });
  });

  it("refuses to delete a thread somebody has replied to since", async () => {
    const paper = await createPaper();
    const started = await startThreadOn(paper.id);
    await invoke(
      "kiwi.thread.reply",
      { thread_id: started.id, body: "One more thing.", author_name: "Grace" },
      OTHER_ID,
    );
    const result = await invoke("kiwi.thread.delete", {
      thread_id: started.id,
      expected_version: started.version,
      expected_hash: started.content_hash,
    });
    expect(result.error).toMatchObject({ code: "KIWI_CONFLICT_VERSION" });
  });
});
