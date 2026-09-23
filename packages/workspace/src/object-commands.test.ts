import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  documentQuotations,
  primaryFileId,
  type CommandEnvelope,
} from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { assetCommands } from "./asset-commands.js";
import { readCanonicalObject } from "./objects.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const ACCOUNT_ID = "account:0198c7c1-4e7d-7e31-a23a-824269ac2300";
const NOW = "2026-08-22T12:00:00.000Z";

let scratch: string;
let gateway: Gateway;
let sequence: number;
let revealFile: (root: string, relativePath: string) => Promise<void>;
let recoveryDraft: boolean;

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
  scratch = await mkdtemp(join(tmpdir(), "kiwi-object-command-"));
  sequence = 0;
  recoveryDraft = false;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Command test",
    now: NOW,
  });
  const registry = createRegistry();
  revealFile = vi.fn(async () => undefined);
  for (const command of objectCommands({
    newId: nextId,
    now: () => NOW,
    revealFile,
    hasRecoveryDraft: async () => recoveryDraft,
  })) {
    registry.register(command);
  }
  // Attaching a file is only meaningful after importing one, so the asset commands are
  // registered here too and the tests take the same path a person does.
  for (const command of assetCommands({ newId: nextId, now: () => NOW, revealFile })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-object" });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function invoke(command: string, args: Record<string, unknown>) {
  return gateway.invoke(envelope(command, { root: scratch, ...args }), {
    actor: { kind: "local_user", id: ACCOUNT_ID },
    origin: { surface: "ui", extension_id: null },
  });
}

describe("annotations", () => {
  type Stored = { id: string; type: string; version: number; content_hash: string; title: string };
  type Listed = {
    id: string;
    version: number;
    content_hash: string;
    title: string;
    tags: string[];
    created_by: string;
    annotation: Record<string, unknown>;
  };

  async function paper(title = "Attention Is All You Need") {
    const result = await invoke("kiwi.object.create", { type: "source", title, content: "" });
    return (result.data ?? {})["object"] as Stored;
  }

  function mark(overrides: Record<string, unknown> = {}) {
    return {
      kind: "highlight",
      asset_id: "asset-pdf",
      page: 3,
      page_label: "3",
      rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
      color: "yellow",
      quoted: "Attention is all you need",
      comment: "",
      image_asset_id: null,
      ...overrides,
    };
  }

  async function listFor(objectId: string, assetId?: string) {
    const result = await invoke("kiwi.annotation.list", {
      object_id: objectId,
      ...(assetId === undefined ? {} : { asset_id: assetId }),
    });
    return ((result.data ?? {})["annotations"] as Listed[] | undefined) ?? [];
  }

  it("lists a mark with the tags it carries", async () => {
    // A mark is tagged by the command that tags anything else. What the Reader needs is to be
    // told, once, which marks carry what, so it can offer a filter without asking mark by mark.
    const source = await paper();
    const created = (
      await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() })
    ).data?.["object"] as Stored;
    await invoke("kiwi.object.tag", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      tag_id: "tag:user/method",
      action: "add",
    });

    expect((await listFor(source.id))[0]?.tags).toEqual(["tag:user/method"]);
  });

  it("lists who made each mark", async () => {
    // Three people reading the same paper leave three sets of marks in the same list. Without
    // the maker's id the Reader could show all of them or none, and never one person's layer.
    const source = await paper();
    await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() });

    expect((await listFor(source.id))[0]?.created_by).toBe(ACCOUNT_ID);
  });

  it("records a highlight against the paper it was read on", async () => {
    const source = await paper();
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark(),
    });

    expect(result.status).toBe("committed");
    const created = (result.data ?? {})["object"] as Stored;
    expect(created.type).toBe("annotation");
    // The title reads like the paper, so a list of marks is legible without opening each.
    expect(created.title).toBe("Attention is all you need");
  });

  it("stores the quoted passage as the object's content so search finds it", async () => {
    const source = await paper();
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ quoted: "a distinctive phrase to find later" }),
    });
    const created = (result.data ?? {})["object"] as Stored & { content: string };
    expect(created.content).toBe("a distinctive phrase to find later");
  });

  it("does not touch the PDF", async () => {
    const source = await paper();
    await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() });
    // Rewriting the file would break its hash and mean the copy kept is no longer the copy
    // that was downloaded. The mark is a separate record pointing at a region.
    const objects = await readdir(join(scratch, "objects"));
    expect(objects).toContain("annotations");
  });

  it("lists annotations in reading order, not the order they were made", async () => {
    const source = await paper();
    await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ page: 5, quoted: "later" }),
    });
    await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ page: 1, quoted: "earlier" }),
    });
    await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({
        page: 1,
        quoted: "further down page one",
        rects: [{ left: 0.1, top: 0.8, width: 0.3, height: 0.02 }],
      }),
    });

    expect((await listFor(source.id)).map((entry) => entry.title)).toEqual([
      "earlier",
      "further down page one",
      "later",
    ]);
  });

  it("keeps each file's annotations apart when a paper holds two", async () => {
    // A preprint and the published version are both attached to one Paper, and a highlight on
    // page 3 of one is not a highlight on page 3 of the other.
    const source = await paper();
    await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ asset_id: "asset-preprint", quoted: "in the preprint" }),
    });
    await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ asset_id: "asset-published", quoted: "in the published version" }),
    });

    expect((await listFor(source.id)).length).toBe(2);
    expect((await listFor(source.id, "asset-preprint")).map((entry) => entry.title)).toEqual([
      "in the preprint",
    ]);
  });

  it("changes a comment and colour without losing the region", async () => {
    const source = await paper();
    const created = ((
      await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() })
    ).data ?? {})["object"] as Stored;

    const result = await invoke("kiwi.annotation.update", {
      annotation_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      annotation: mark({ color: "green", comment: "Check this against Bahdanau." }),
    });

    expect(result.status).toBe("committed");
    const [listed] = await listFor(source.id);
    expect(listed?.annotation).toMatchObject({
      color: "green",
      comment: "Check this against Bahdanau.",
    });
    expect((listed?.annotation["rects"] as unknown[]).length).toBe(1);
  });

  it("reports a stale annotation edit as a version conflict", async () => {
    const source = await paper();
    const created = ((
      await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() })
    ).data ?? {})["object"] as Stored;

    const result = await invoke("kiwi.annotation.update", {
      annotation_id: created.id,
      expected_version: created.version + 2,
      expected_hash: created.content_hash,
      annotation: mark({ comment: "later" }),
    });
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("names the field that made an annotation unacceptable", async () => {
    const source = await paper();
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ rects: [] }),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["fields"]).toContain("rects");
  });

  it("refuses an area capture that kept no image", async () => {
    const source = await paper();
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ kind: "area", quoted: "" }),
    });
    expect(result.error?.details?.["fields"]).toContain("image_asset_id");
  });

  it("accepts an area capture that kept one", async () => {
    const source = await paper();
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: mark({ kind: "area", quoted: "", image_asset_id: "asset-figure" }),
    });
    expect(result.status).toBe("committed");
    expect((result.data ?? {})["object"]).toMatchObject({ title: "Figure on page 3" });
  });

  it("refuses a mark on an object that is not there", async () => {
    const result = await invoke("kiwi.annotation.create", {
      object_id: "0198c800-0000-7000-8000-000000009999",
      annotation: mark(),
    });
    expect(result.status).toBe("failed");
  });

  it("keeps every version of an annotation", async () => {
    const source = await paper();
    const created = ((
      await invoke("kiwi.annotation.create", { object_id: source.id, annotation: mark() })
    ).data ?? {})["object"] as Stored;
    await invoke("kiwi.annotation.update", {
      annotation_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      annotation: mark({ comment: "second thoughts" }),
    });

    const history = await invoke("kiwi.object.history", { object_id: created.id });
    expect(((history.data ?? {})["history"] as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("sending annotations to a note", () => {
  type Stored = { id: string; type: string; version: number; content_hash: string; title: string };

  async function paperWithMarks(count: number, title = "Attention Is All You Need") {
    const source = ((await invoke("kiwi.object.create", { type: "source", title, content: "" }))
      .data ?? {})["object"] as Stored;
    const marks: Stored[] = [];
    for (let index = 0; index < count; index += 1) {
      const result = await invoke("kiwi.annotation.create", {
        object_id: source.id,
        annotation: {
          kind: "highlight",
          asset_id: "asset-pdf",
          page: index + 1,
          page_label: String(index + 1),
          rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
          color: "yellow",
          quoted: `passage ${String(index + 1)}`,
          comment: "",
          image_asset_id: null,
        },
      });
      marks.push((result.data ?? {})["object"] as Stored);
    }
    return { source, marks };
  }

  async function readNote(noteId: string) {
    const stored = await readCanonicalObject(scratch, noteId);
    return stored?.object.content ?? "";
  }

  it("creates a note holding the passages, each with its paper and page", async () => {
    const { marks } = await paperWithMarks(2);
    const result = await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: marks.map((mark) => mark.id),
      note_title: "Transformers reading",
    });

    expect(result.status).toBe("committed");
    const note = (result.data ?? {})["note"] as Stored;
    expect(note.type).toBe("note");
    expect(note.title).toBe("Transformers reading");

    const content = await readNote(note.id);
    expect(content).toContain("> passage 1");
    expect(content).toContain("> passage 2");
    // A quotation you cannot trace is a quotation you cannot use.
    expect(content).toContain("Attention Is All You Need, p. 1");
  });

  it("appends to an existing note rather than replacing it", async () => {
    const { marks } = await paperWithMarks(2);
    const first = ((
      await invoke("kiwi.annotation.send-to-note", {
        annotation_ids: [marks[0]!.id],
        note_title: "Reading",
      })
    ).data ?? {})["note"] as Stored;

    await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: [marks[1]!.id],
      note_id: first.id,
    });

    const content = await readNote(first.id);
    expect(content).toContain("> passage 1");
    expect(content).toContain("> passage 2");
  });

  it("does not paste the same highlight in twice", async () => {
    // Reading is iterative: people send one passage, read on, then send the rest of the page.
    // Doubling the first one leaves a mess to clean by hand.
    const { marks } = await paperWithMarks(2);
    const note = ((
      await invoke("kiwi.annotation.send-to-note", {
        annotation_ids: [marks[0]!.id],
        note_title: "Reading",
      })
    ).data ?? {})["note"] as Stored;

    const again = await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: [marks[0]!.id, marks[1]!.id],
      note_id: note.id,
    });

    expect(again.data?.["added"]).toBe(1);
    expect(again.data?.["skipped"]).toBe(1);
    const content = await readNote(note.id);
    expect(content.match(/> passage 1/gu)).toHaveLength(1);
  });

  it("gathers passages from several papers in reading order", async () => {
    const first = await paperWithMarks(1, "First paper");
    const second = await paperWithMarks(1, "Second paper");
    const result = await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: [second.marks[0]!.id, first.marks[0]!.id],
      note_title: "Across the literature",
    });
    const note = (result.data ?? {})["note"] as Stored;
    const content = await readNote(note.id);

    expect(content).toContain("First paper");
    expect(content).toContain("Second paper");
  });

  it("carries a comment through with its passage", async () => {
    const source = ((
      await invoke("kiwi.object.create", { type: "source", title: "A paper", content: "" })
    ).data ?? {})["object"] as Stored;
    const mark = ((
      await invoke("kiwi.annotation.create", {
        object_id: source.id,
        annotation: {
          kind: "highlight",
          asset_id: "asset-pdf",
          page: 2,
          page_label: "2",
          rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
          color: "yellow",
          quoted: "the claim",
          comment: "Does this hold at scale?",
          image_asset_id: null,
        },
      })
    ).data ?? {})["object"] as Stored;

    const note = ((
      await invoke("kiwi.annotation.send-to-note", {
        annotation_ids: [mark.id],
        note_title: "Questions",
      })
    ).data ?? {})["note"] as Stored;

    const content = await readNote(note.id);
    expect(content).toContain("> the claim");
    expect(content).toContain("Does this hold at scale?");
  });

  it("records which annotations a note quotes", async () => {
    const { marks } = await paperWithMarks(1);
    const note = ((
      await invoke("kiwi.annotation.send-to-note", {
        annotation_ids: [marks[0]!.id],
        note_title: "Reading",
      })
    ).data ?? {})["note"] as Stored;

    const relations = await invoke("kiwi.relation.for-object", { object_id: note.id });
    const listed = (
      (relations.data ?? {})["relations"] as Array<{ relation: { type: string } }>
    ).map((entry) => entry.relation.type);
    expect(listed).toContain("quotes");
  });

  it("refuses to send into something that is not a note", async () => {
    const { source, marks } = await paperWithMarks(1);
    const result = await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: [marks[0]!.id],
      note_id: source.id,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("not_a_note");
  });

  it("requires either a note to send to or a name for a new one", async () => {
    const { marks } = await paperWithMarks(1);
    const result = await invoke("kiwi.annotation.send-to-note", {
      annotation_ids: [marks[0]!.id],
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("sending a passage into a manuscript", () => {
  type Stored = { id: string; type: string; version: number; content_hash: string; title: string };

  function passage(quoted: string, page = 1) {
    return {
      kind: "highlight",
      asset_id: "asset-pdf",
      page,
      page_label: String(page),
      rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
      color: "yellow",
      quoted,
      comment: "",
      image_asset_id: null,
    };
  }

  async function paper(title = "Attention Is All You Need") {
    return ((await invoke("kiwi.object.create", { type: "source", title, content: "" })).data ??
      {})["object"] as Stored;
  }

  async function markOn(source: Stored, quoted: string, page = 1) {
    const result = await invoke("kiwi.annotation.create", {
      object_id: source.id,
      annotation: passage(quoted, page),
    });
    return ((result.data ?? {})["object"] as Stored).id;
  }

  function heading(text: string) {
    return { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text }] };
  }

  function paragraph(text: string) {
    return { type: "paragraph", content: [{ type: "text", text }] };
  }

  /** A manuscript with two sections, in whichever mode the test is about. */
  async function manuscript(mode: "rich" | "latex") {
    const created = ((
      await invoke("kiwi.object.create", { type: "output", title: "The paper", content: "" })
    ).data ?? {})["object"] as Stored;
    const saved = await invoke("kiwi.object.set-document", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      mode,
      ...(mode === "latex"
        ? {
            source:
              "\\section{Introduction}\nReading is iterative.\n\n\\section{Method}\nWe did it.",
          }
        : {
            document: {
              type: "doc",
              content: [
                heading("Introduction"),
                paragraph("Reading is iterative."),
                heading("Method"),
                paragraph("We did it."),
              ],
            },
          }),
    });
    return (saved.data ?? {})["object"] as Stored;
  }

  async function bodyOf(objectId: string) {
    const stored = await readCanonicalObject(scratch, objectId);
    return stored?.object.content ?? "";
  }

  it("writes the passage at the end of the section it was sent to", async () => {
    // Under the heading somebody chose, not at the end of the paper. A quotation that lands
    // three sections away from where it was wanted is a quotation to be moved by hand.
    const source = await paper();
    const draft = await manuscript("rich");

    const result = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Introduction",
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    expect(result.status).toBe("committed");
    expect(result.data?.["section"]).toBe("Introduction");
    const body = await bodyOf(draft.id);
    expect(body.indexOf("attention is all you need")).toBeGreaterThan(body.indexOf("Reading is"));
    expect(body.indexOf("attention is all you need")).toBeLessThan(body.indexOf("Method"));
    // Traceable, or it is not a quotation, it is a sentence somebody will have to find again.
    expect(body).toContain("Attention Is All You Need, p. 1");
  });

  it("writes into a LaTeX manuscript as source", async () => {
    const source = await paper();
    const draft = await manuscript("latex");

    await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Introduction",
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    const body = await bodyOf(draft.id);
    expect(body).toContain("\\begin{quote}\nattention is all you need\n\\end{quote}");
    // The attribution is a comment: the draft needs to know where the quotation came from, and
    // the typeset paper needs a citation, which is the writer's decision and not this tool's.
    expect(body).toContain("% — Attention Is All You Need, p. 1");
    expect(body.indexOf("\\begin{quote}")).toBeLessThan(body.indexOf("\\section{Method}"));
  });

  it("goes to the end of the manuscript when no section is named", async () => {
    const source = await paper();
    const draft = await manuscript("rich");

    const result = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    expect(result.data?.["section"]).toBeNull();
    const body = await bodyOf(draft.id);
    expect(body.indexOf("attention is all you need")).toBeGreaterThan(body.indexOf("We did it."));
  });

  it("makes the highlight on the way past when a selection is sent", async () => {
    // Sending straight from a selection: the passage becomes a mark on the paper too, so it can
    // still be found on the page it came from and not only inside the draft.
    const source = await paper();
    const draft = await manuscript("rich");

    const result = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Method",
      excerpt: { object_id: source.id, annotation: passage("we trained on eight GPUs", 3) },
    });

    const markId = result.data?.["annotation_id"] as string;
    const mark = await readCanonicalObject(scratch, markId);
    expect(mark?.object.type).toBe("annotation");
    const links = await invoke("kiwi.relation.for-object", { object_id: source.id });
    const types = ((links.data ?? {})["relations"] as Array<{ relation: { type: string } }>).map(
      (entry) => entry.relation.type,
    );
    expect(types).toContain("annotates");
    expect(await bodyOf(draft.id)).toContain("we trained on eight GPUs");
  });

  it("does not write the same passage in twice", async () => {
    const source = await paper();
    const draft = await manuscript("rich");
    const markId = await markOn(source, "attention is all you need");
    await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Introduction",
      annotation_ids: [markId],
    });

    const again = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Introduction",
      annotation_ids: [markId, await markOn(source, "the method we describe", 2)],
    });

    expect(again.data?.["added"]).toBe(1);
    expect(again.data?.["skipped"]).toBe(1);
    expect((await bodyOf(draft.id)).match(/attention is all you need/gu)).toHaveLength(1);
  });

  it("records what the manuscript quotes", async () => {
    const source = await paper();
    const draft = await manuscript("rich");
    await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    const relations = await invoke("kiwi.relation.for-object", { object_id: draft.id });
    const types = (
      (relations.data ?? {})["relations"] as Array<{ relation: { type: string } }>
    ).map((entry) => entry.relation.type);
    expect(types).toContain("quotes");
  });

  it("says so when the section has been renamed away", async () => {
    // The heading was on the list a moment ago. Writing the passage somewhere else instead
    // would put it under a heading nobody chose.
    const source = await paper();
    const draft = await manuscript("rich");

    const result = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Discussion",
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("no_such_section");
  });

  it("refuses to write into something that is not a manuscript", async () => {
    const source = await paper();

    const result = await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: source.id,
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("not_a_manuscript");
  });

  it("writes the attribution as a link back to the mark", async () => {
    // The line says where the passage came from, and it carries the mark it was taken from, so
    // the draft can offer to open the page rather than only naming it.
    const source = await paper();
    const draft = await manuscript("rich");
    const markId = await markOn(source, "attention is all you need");

    await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      section: "Introduction",
      annotation_ids: [markId],
    });

    const stored = await readCanonicalObject(scratch, draft.id);
    const quotations = documentQuotations(stored?.object["document"]);
    expect(quotations).toEqual([
      {
        annotation: markId,
        target: source.id,
        source: "Attention Is All You Need",
        page_label: "1",
      },
    ]);
  });

  it("still says where a passage came from in the words search reads", async () => {
    // The attribution is a node, and a note that dropped the paper's name out of its text would
    // stop being findable by the paper it quotes.
    const source = await paper();
    const draft = await manuscript("rich");
    await invoke("kiwi.annotation.send-to-manuscript", {
      manuscript_id: draft.id,
      annotation_ids: [await markOn(source, "attention is all you need")],
    });

    expect(await bodyOf(draft.id)).toContain("— Attention Is All You Need, p. 1");
  });
});

describe("finding the page a quotation came from", () => {
  async function paper(title = "Attention Is All You Need") {
    return ((await invoke("kiwi.object.create", { type: "source", title, content: "" })).data ??
      {})["object"] as { id: string };
  }

  async function markOn(objectId: string, page: number, label: string) {
    const result = await invoke("kiwi.annotation.create", {
      object_id: objectId,
      annotation: {
        kind: "highlight",
        asset_id: "asset-pdf",
        page,
        page_label: label,
        rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
        color: "yellow",
        quoted: "attention is all you need",
        comment: "",
        image_asset_id: null,
      },
    });
    return ((result.data ?? {})["object"] as { id: string }).id;
  }

  it("says which paper, which file and which page", async () => {
    const source = await paper();
    const markId = await markOn(source.id, 7, "434");

    const result = await invoke("kiwi.annotation.locate", { annotation_id: markId });

    expect(result.status).toBe("no_change");
    expect(result.data?.["location"]).toMatchObject({
      annotation_id: markId,
      object_id: source.id,
      object_title: "Attention Is All You Need",
      asset_id: "asset-pdf",
      page: 7,
      page_label: "434",
    });
  });

  it("answers with nothing when the mark has been deleted", async () => {
    // A quotation outliving its mark is ordinary in a workspace people delete from. The surface
    // that asked can say so; a failure would make it an error report instead.
    const result = await invoke("kiwi.annotation.locate", { annotation_id: "annotation-gone" });

    expect(result.status).toBe("no_change");
    expect(result.data?.["location"]).toBeNull();
  });

  it("answers with nothing for something that is not a mark", async () => {
    const source = await paper();

    const result = await invoke("kiwi.annotation.locate", { annotation_id: source.id });

    expect(result.data?.["location"]).toBeNull();
  });
});

describe("papers and their files", () => {
  type Stored = { id: string; type: string; version: number; content_hash: string; title: string };

  async function paper(title = "Attention Is All You Need") {
    const result = await invoke("kiwi.object.create", { type: "source", title, content: "" });
    return (result.data ?? {})["object"] as Stored;
  }

  async function importFile(name = "paper.pdf") {
    const source = join(scratch, name);
    await writeFile(source, "%PDF-1.7\nnot a real document but it sniffs as one.\n");
    const result = await invoke("kiwi.asset.import-managed", {
      source_path: source,
      declared_media_type: null,
    });
    return (result.data ?? {})["asset"] as Stored;
  }

  it("records a full reference on a Paper", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: {
        kind: "conference",
        authors: ["Vaswani, Ashish", "Shazeer, Noam"],
        container: "NeurIPS",
        year: 2017,
        doi: "10.48550/arXiv.1706.03762",
        url: "https://arxiv.org/abs/1706.03762",
        pages: "5998-6008",
      },
    });

    expect(result.status).toBe("committed");
    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["reference"]).toMatchObject({
      kind: "conference",
      authors: ["Vaswani, Ashish", "Shazeer, Noam"],
      year: 2017,
      doi: "10.48550/arxiv.1706.03762",
    });
  });

  it("accepts a pasted doi.org link and stores the bare DOI", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "article", authors: [], doi: "https://doi.org/10.1000/XYZ123" },
    });
    expect((result.data ?? {})["reference"]).toMatchObject({ doi: "10.1000/xyz123" });
  });

  it("refuses a reference on anything that is not a Paper", async () => {
    const result0 = await invoke("kiwi.object.create", {
      type: "note",
      title: "Just a note",
      content: "",
    });
    const note = (result0.data ?? {})["object"] as Stored;
    const result = await invoke("kiwi.object.set-reference", {
      object_id: note.id,
      expected_version: note.version,
      expected_hash: note.content_hash,
      reference: { kind: "article", authors: [] },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("names the fields that need correcting rather than failing vaguely", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "article", authors: [], doi: "nonsense", year: 12345 },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["fields"]).toContain("doi");
    expect(result.error?.details?.["fields"]).toContain("year");
  });

  it("refuses a link the interface would later open", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "article", authors: [], url: "javascript:alert(1)" },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["fields"]).toContain("url");
  });

  /** A Paper that already carries a DOI, which is what a second entry of it collides with. */
  async function paperWithDoi(title: string, doi: string, year: number | null = null) {
    const created = await paper(title);
    await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "article", authors: [], doi, year },
    });
    return created;
  }

  it("names the Paper already carrying a DOI", async () => {
    const first = await paperWithDoi("Attention Is All You Need", "10.1000/xyz123", 2017);
    await paper("Something else entirely");

    const result = await invoke("kiwi.object.doi-matches", { doi: "10.1000/xyz123" });

    expect(result.status).toBe("no_change");
    expect((result.data ?? {})["doi"]).toBe("10.1000/xyz123");
    expect((result.data ?? {})["matches"]).toEqual([
      { id: first.id, title: "Attention Is All You Need", year: 2017 },
    ]);
  });

  it("does not call a Paper a duplicate of itself", async () => {
    const only = await paperWithDoi("The only copy", "10.1000/xyz123");

    const result = await invoke("kiwi.object.doi-matches", {
      doi: "10.1000/xyz123",
      object_id: only.id,
    });

    // Correcting a typo elsewhere in a reference re-enters the DOI that is already stored on that
    // same Paper. Reporting it would make every second save look like a duplicate.
    expect((result.data ?? {})["matches"]).toEqual([]);
  });

  it("matches a pasted link against a DOI stored bare", async () => {
    const first = await paperWithDoi("Attention Is All You Need", "10.1000/xyz123");

    const result = await invoke("kiwi.object.doi-matches", {
      doi: "https://doi.org/10.1000/XYZ123",
    });

    expect((result.data ?? {})["matches"]).toMatchObject([{ id: first.id }]);
  });

  it("asks nothing of a field that is not a DOI yet", async () => {
    await paperWithDoi("Attention Is All You Need", "10.1000/xyz123");

    const result = await invoke("kiwi.object.doi-matches", { doi: "10.10" });

    // Half a DOI is not a bad DOI, it is an unfinished one. Saving is where a field that never
    // becomes one is refused; asking who else has it is answered with nobody.
    expect(result.status).toBe("no_change");
    expect((result.data ?? {})["doi"]).toBeNull();
    expect((result.data ?? {})["matches"]).toEqual([]);
  });

  /** The groups the duplicates screen is built from. */
  async function candidates() {
    const result = await invoke("kiwi.object.duplicate-candidates", {});
    return (result.data ?? {})["groups"] as Array<{
      reason: string;
      key: string;
      records: Array<{
        id: string;
        title: string;
        files: number;
        annotations: number;
        reference: { doi: string | null; year: number | null };
      }>;
    }>;
  }

  it("groups the Papers that carry one DOI", async () => {
    const first = await paperWithDoi("Attention Is All You Need", "10.1000/xyz123", 2017);
    const second = await paperWithDoi("Attention (preprint)", "https://doi.org/10.1000/XYZ123");
    await paperWithDoi("Something else entirely", "10.1000/other");

    const groups = await candidates();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("doi");
    expect(groups[0]?.key).toBe("10.1000/xyz123");
    expect(groups[0]?.records.map((record) => record.id)).toEqual([first.id, second.id]);
    // The year differs, which is the sort of thing the screen marks and somebody decides about.
    expect(groups[0]?.records.map((record) => record.reference.year)).toEqual([2017, null]);
  });

  it("groups two titles that differ only in case and punctuation", async () => {
    const first = await paper("Attention Is All You Need");
    const second = await paper("Attention is all you need.");

    const groups = await candidates();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("title");
    expect(groups[0]?.records.map((record) => record.id)).toEqual([first.id, second.id]);
  });

  it("leaves two different papers alone", async () => {
    await paperWithDoi("Attention Is All You Need", "10.1000/xyz123");
    await paperWithDoi("Deep residual learning", "10.1000/other");

    expect(await candidates()).toEqual([]);
  });

  it("lists a pair once, under the stronger evidence", async () => {
    await paperWithDoi("Attention Is All You Need", "10.1000/xyz123");
    await paperWithDoi("Attention is all you need", "10.1000/xyz123");

    const groups = await candidates();

    // Both the DOI and the title match. The same decision presented twice, under two headings,
    // is worse than one heading that happens to understate the evidence.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("doi");
  });

  it("counts what would go to Trash with each record", async () => {
    const first = await paperWithDoi("Attention Is All You Need", "10.1000/xyz123");
    await paperWithDoi("Attention (preprint)", "10.1000/xyz123");
    const asset = await importFile();
    await invoke("kiwi.object.attach-file", { object_id: first.id, asset_id: asset.id });

    const groups = await candidates();

    // Kiwi does not merge, so choosing between two records is choosing which attachments to keep.
    // Having to open both to find that out is how the wrong one gets thrown away.
    expect(groups[0]?.records.map((record) => record.files)).toEqual([1, 0]);
    expect(groups[0]?.records.map((record) => record.annotations)).toEqual([0, 0]);
  });

  it("writes a summary in the reader's own words, on one line", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      summary: "  Attention alone\nbeats recurrence,  on translation. ",
    });

    expect(result.status).toBe("committed");
    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["summary"]).toBe("Attention alone beats recurrence, on translation.");
  });

  it("summarises a Note as readily as a Paper", async () => {
    const result0 = await invoke("kiwi.object.create", {
      type: "note",
      title: "Reading notes",
      content: "",
    });
    const note = (result0.data ?? {})["object"] as Stored;
    const result = await invoke("kiwi.object.set-summary", {
      object_id: note.id,
      expected_version: note.version,
      expected_hash: note.content_hash,
      summary: "What to do about the missing controls.",
    });
    expect(result.status).toBe("committed");
  });

  it("does not record a version for a summary nobody changed", async () => {
    const created = await paper();
    const written = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      summary: "Worth reading twice.",
    });
    const saved = (written.data ?? {})["object"] as Stored;

    const again = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: saved.version,
      expected_hash: saved.content_hash,
      summary: " Worth reading twice. ",
    });
    expect(again.status).toBe("no_change");
    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["version"]).toBe(saved.version);
  });

  it("refuses a summary that is a paragraph", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      summary: "word ".repeat(200),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("reports a stale summary edit as a version conflict", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: created.version + 3,
      expected_hash: created.content_hash,
      summary: "Written against a Paper somebody else has since changed.",
    });
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("keeps the reference when the summary is written", async () => {
    const created = await paper();
    const referenced = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "conference", authors: ["Vaswani, Ashish"], year: 2017 },
    });
    const withReference = (referenced.data ?? {})["object"] as Stored;

    await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: withReference.version,
      expected_hash: withReference.content_hash,
      summary: "The transformer paper.",
    });

    // Writing one field must not quietly drop the other: the citation is built from this.
    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["reference"]).toMatchObject({ year: 2017 });
    expect(stored?.object["summary"]).toBe("The transformer paper.");
  });

  it("marks a Paper read, and marks it unread again", async () => {
    const created = await paper();
    const marked = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      read: true,
    });
    expect(marked.status).toBe("committed");
    const read = (marked.data ?? {})["object"] as Stored;
    expect((await readCanonicalObject(scratch, created.id))?.object["read"]).toBe(true);

    const cleared = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: read.version,
      expected_hash: read.content_hash,
      read: false,
    });
    expect(cleared.status).toBe("committed");
    // Put back rather than removed: a paper somebody has decided to read again is unread, and
    // that is the same answer as one nobody has opened.
    expect((await readCanonicalObject(scratch, created.id))?.object["read"]).toBe(false);
  });

  it("does not record a version for a mark that is already there", async () => {
    const created = await paper();
    const marked = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      read: true,
    });
    const saved = (marked.data ?? {})["object"] as Stored;

    const again = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: saved.version,
      expected_hash: saved.content_hash,
      read: true,
    });
    expect(again.status).toBe("no_change");
    expect((await readCanonicalObject(scratch, created.id))?.object["version"]).toBe(saved.version);
  });

  it("reads a Paper nobody has marked as unread", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      read: false,
    });
    // The field is not on a Paper until somebody sets it, so unmarking one nobody marked is
    // asking for the state it is already in.
    expect(result.status).toBe("no_change");
  });

  it("reports a stale read mark as a version conflict", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: created.version + 3,
      expected_hash: created.content_hash,
      read: true,
    });
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("keeps the summary and the reference when the mark is written", async () => {
    const created = await paper();
    const referenced = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      reference: { kind: "conference", authors: ["Vaswani, Ashish"], year: 2017 },
    });
    const withReference = (referenced.data ?? {})["object"] as Stored;
    const summarised = await invoke("kiwi.object.set-summary", {
      object_id: created.id,
      expected_version: withReference.version,
      expected_hash: withReference.content_hash,
      summary: "The transformer paper.",
    });
    const withSummary = (summarised.data ?? {})["object"] as Stored;

    await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: withSummary.version,
      expected_hash: withSummary.content_hash,
      read: true,
    });

    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["reference"]).toMatchObject({ year: 2017 });
    expect(stored?.object["summary"]).toBe("The transformer paper.");
    expect(stored?.object["read"]).toBe(true);
  });

  it("reports a stale reference edit as a version conflict", async () => {
    const created = await paper();
    const result = await invoke("kiwi.object.set-reference", {
      object_id: created.id,
      expected_version: created.version + 3,
      expected_hash: created.content_hash,
      reference: { kind: "article", authors: [] },
    });
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("attaches an imported PDF and lists it against the Paper", async () => {
    const created = await paper();
    const asset = await importFile();

    const attached = await invoke("kiwi.object.attach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect(attached.status).toBe("committed");

    const listed = await invoke("kiwi.object.files", { object_id: created.id });
    const files = (listed.data ?? {})["files"] as Stored[];
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe(asset.id);
  });

  it("carries a two-paper library without crossing the attachments", async () => {
    const first = await paper("First paper");
    const second = await paper("Second paper");
    const fileA = await importFile("a.pdf");
    const fileB = await importFile("b.pdf");
    await invoke("kiwi.object.attach-file", { object_id: first.id, asset_id: fileA.id });
    await invoke("kiwi.object.attach-file", { object_id: second.id, asset_id: fileB.id });

    const listedFirst = (
      ((await invoke("kiwi.object.files", { object_id: first.id })).data ?? {})["files"] as Stored[]
    ).map((file) => file.id);
    expect(listedFirst).toEqual([fileA.id]);
  });

  it("attaches more than one file, because a preprint and a published PDF are both real", async () => {
    const created = await paper();
    const preprint = await importFile("preprint.pdf");
    const published = await importFile("published.pdf");
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: preprint.id });
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: published.id });

    const files = ((await invoke("kiwi.object.files", { object_id: created.id })).data ?? {})[
      "files"
    ] as Stored[];
    expect(files).toHaveLength(2);
  });

  it("refuses to attach the same file twice", async () => {
    const created = await paper();
    const asset = await importFile();
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: asset.id });
    const again = await invoke("kiwi.object.attach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect(again.status).toBe("failed");
    expect(again.error?.details?.["kind"]).toBe("already_attached");
  });

  it("refuses to attach something that is not an imported file", async () => {
    const created = await paper();
    const note = (
      ((await invoke("kiwi.object.create", { type: "note", title: "Not a file", content: "" }))
        .data ?? {})["object"] as Stored
    ).id;
    const result = await invoke("kiwi.object.attach-file", {
      object_id: created.id,
      asset_id: note,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("not_an_asset");
  });

  it("detaches a file without deleting it", async () => {
    const created = await paper();
    const asset = await importFile();
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: asset.id });

    const detached = await invoke("kiwi.object.detach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect(detached.status).toBe("committed");

    const files = ((await invoke("kiwi.object.files", { object_id: created.id })).data ?? {})[
      "files"
    ] as Stored[];
    expect(files).toHaveLength(0);
    // Detaching says "this paper is not that file", not "destroy that file". The import is
    // still there to attach somewhere else.
    expect(await readCanonicalObject(scratch, asset.id)).not.toBeNull();
  });

  it("offers detaching as the undo for attaching", async () => {
    const created = await paper();
    const asset = await importFile();
    const attached = await invoke("kiwi.object.attach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect((attached.data ?? {})["undo"]).toMatchObject({
      command: "kiwi.object.detach-file",
      args: { object_id: created.id, asset_id: asset.id },
    });
  });

  it("reports detaching a file that was never attached", async () => {
    const created = await paper();
    const asset = await importFile();
    const result = await invoke("kiwi.object.detach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("not_attached");
  });

  it("can reattach a file that was detached", async () => {
    const created = await paper();
    const asset = await importFile();
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: asset.id });
    await invoke("kiwi.object.detach-file", { object_id: created.id, asset_id: asset.id });
    const again = await invoke("kiwi.object.attach-file", {
      object_id: created.id,
      asset_id: asset.id,
    });
    expect(again.status).toBe("committed");
  });

  /** A Paper holding the preprint, the published version and nothing chosen between them. */
  async function paperWithTwoFiles() {
    const created = await paper();
    const preprint = await importFile("preprint.pdf");
    const published = await importFile("published.pdf");
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: preprint.id });
    await invoke("kiwi.object.attach-file", { object_id: created.id, asset_id: published.id });
    return { created, preprint, published };
  }

  it("opens the file that was chosen rather than the first one attached", async () => {
    const { created, preprint, published } = await paperWithTwoFiles();
    // Before anybody chooses, the preprint is what the Reader would open, because it arrived
    // first and was the only file this Paper had.
    expect(primaryFileId([preprint.id, published.id], undefined)).toBe(preprint.id);

    const chosen = await invoke("kiwi.object.set-primary-file", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      asset_id: published.id,
    });
    expect(chosen.status).toBe("committed");

    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["primary_asset_id"]).toBe(published.id);
    expect(primaryFileId([preprint.id, published.id], stored?.object["primary_asset_id"])).toBe(
      published.id,
    );
  });

  it("does not record a version for choosing the file already chosen", async () => {
    const { created, published } = await paperWithTwoFiles();
    const args = {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      asset_id: published.id,
    };
    await invoke("kiwi.object.set-primary-file", args);
    const again = await invoke("kiwi.object.set-primary-file", args);
    expect(again.status).toBe("no_change");
    expect((await readCanonicalObject(scratch, created.id))?.object.version).toBe(
      created.version + 1,
    );
  });

  it("refuses to open a file that is not attached to the Paper", async () => {
    const { created } = await paperWithTwoFiles();
    const elsewhere = await importFile("some-other-paper.pdf");
    const result = await invoke("kiwi.object.set-primary-file", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      asset_id: elsewhere.id,
    });
    // A name nothing on this Paper matches reads the same as no choice at all, so it is not
    // stored quietly and ignored on every open.
    expect(result.status).toBe("failed");
    expect(result.error?.details?.["kind"]).toBe("not_attached");
  });

  it("leaves the name behind when the chosen file is detached, and falls back to what is left", async () => {
    const { created, preprint, published } = await paperWithTwoFiles();
    await invoke("kiwi.object.set-primary-file", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      asset_id: published.id,
    });
    await invoke("kiwi.object.detach-file", { object_id: created.id, asset_id: published.id });

    // Detaching writes the relation, not the Paper. The stale name is harmless because the
    // rule that reads it only obeys a file that is still attached.
    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["primary_asset_id"]).toBe(published.id);
    const files = ((await invoke("kiwi.object.files", { object_id: created.id })).data ?? {})[
      "files"
    ] as Stored[];
    expect(
      primaryFileId(
        files.map((file) => file.id),
        stored?.object["primary_asset_id"],
      ),
    ).toBe(preprint.id);
  });

  it("keeps the reference and the read mark when the file is chosen", async () => {
    const { created, published } = await paperWithTwoFiles();
    await invoke("kiwi.object.set-read", {
      object_id: created.id,
      expected_version: created.version,
      expected_hash: created.content_hash,
      read: true,
    });
    const marked = await readCanonicalObject(scratch, created.id);
    await invoke("kiwi.object.set-primary-file", {
      object_id: created.id,
      expected_version: marked?.object.version ?? 1,
      expected_hash: marked?.object.content_hash ?? "",
      asset_id: published.id,
    });

    const stored = await readCanonicalObject(scratch, created.id);
    expect(stored?.object["read"]).toBe(true);
    expect(stored?.object["primary_asset_id"]).toBe(published.id);
  });

  /** Removes the bytes an asset stands for, the way tidying up the folder outside Kiwi would. */
  async function deleteBytes(assetId: string): Promise<void> {
    const asset = await readCanonicalObject(scratch, assetId);
    const storage = asset?.object["storage"] as { relative_path: string };
    await rm(join(scratch, storage.relative_path));
  }

  it("says which attached files are no longer on disk", async () => {
    const { created, preprint, published } = await paperWithTwoFiles();
    await deleteBytes(preprint.id);

    const listed = (await invoke("kiwi.object.files", { object_id: created.id })).data ?? {};
    // The file is still attached, and the Paper still records it. What changed is outside the
    // workspace's writing, which is why the listing has to look rather than remember.
    expect((listed["files"] as Stored[]).map((file) => file.id)).toEqual([
      preprint.id,
      published.id,
    ]);
    expect(listed["missing"]).toEqual([preprint.id]);
  });

  it("lists nothing missing while every file is where it was put", async () => {
    const { created } = await paperWithTwoFiles();
    const listed = (await invoke("kiwi.object.files", { object_id: created.id })).data ?? {};
    expect(listed["missing"]).toEqual([]);
  });

  it("keeps calling the file available in the object it stored", async () => {
    const { created, preprint } = await paperWithTwoFiles();
    await deleteBytes(preprint.id);
    await invoke("kiwi.object.files", { object_id: created.id });

    // Listing is a read. It does not write the asset to record what it found, because the file
    // may well be back before anybody asks again, and a version recording a passing absence
    // would be history nobody made.
    const asset = await readCanonicalObject(scratch, preprint.id);
    expect(asset?.object["availability"]).toBe("available");
    expect(asset?.object.version).toBe(1);
  });

  it("counts a file that has been replaced by a folder as missing", async () => {
    const { created, preprint } = await paperWithTwoFiles();
    const asset = await readCanonicalObject(scratch, preprint.id);
    const storage = asset?.object["storage"] as { relative_path: string };
    await rm(join(scratch, storage.relative_path));
    await mkdir(join(scratch, storage.relative_path));

    // Something is at the path, and it is not a file anybody can read. Answering on existence
    // alone would report this one as fine and fail in the Reader, which is the whole failure.
    const listed = (await invoke("kiwi.object.files", { object_id: created.id })).data ?? {};
    expect(listed["missing"]).toEqual([preprint.id]);
  });
});

describe("typed object commands", () => {
  type Stored = { id: string; type: string; version: number; content_hash: string; title: string };

  async function createInbox(title = "Sort this out later") {
    const result = await invoke("kiwi.object.create-inbox", { title, content: "Captured." });
    return (result.data ?? {})["object"] as Stored;
  }

  it("creates each type a person can choose", async () => {
    for (const type of ["source", "note", "output", "project"]) {
      const result = await invoke("kiwi.object.create", {
        type,
        title: `A new ${type}`,
        content: "",
      });
      expect(result.status).toBe("committed");
      expect((result.data ?? {})["object"]).toMatchObject({ type, version: 1 });
    }
  });

  it("refuses a type the schema does not offer", async () => {
    // The wet-lab types and inbox_item are rejected at the gateway, before the handler runs,
    // because the schema enumerates only what a person may create.
    const result = await invoke("kiwi.object.create", {
      type: "claim",
      title: "Should not exist",
      content: "",
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("requires a title with something in it", async () => {
    const result = await invoke("kiwi.object.create", { type: "note", title: "   ", content: "" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("promotes an Inbox item and keeps its identity", async () => {
    const item = await createInbox();
    const result = await invoke("kiwi.object.promote", {
      object_id: item.id,
      type: "source",
      expected_version: item.version,
      expected_hash: item.content_hash,
    });

    expect(result.status).toBe("committed");
    const promoted = (result.data ?? {})["object"] as Stored;
    expect(promoted.id).toBe(item.id);
    expect(promoted.type).toBe("source");
    expect(promoted.version).toBe(item.version + 1);
    const stored = await readCanonicalObject(scratch, item.id);
    expect(stored?.relativePath).toContain("sources");
  });

  it("retitles while promoting", async () => {
    const item = await createInbox("downloaded pdf");
    const result = await invoke("kiwi.object.promote", {
      object_id: item.id,
      type: "source",
      expected_version: item.version,
      expected_hash: item.content_hash,
      title: "Attention Is All You Need",
    });
    expect((result.data ?? {})["object"]).toMatchObject({
      title: "Attention Is All You Need",
    });
  });

  it("reports a stale promotion as a version conflict the interface can recover from", async () => {
    const item = await createInbox();
    const result = await invoke("kiwi.object.promote", {
      object_id: item.id,
      type: "note",
      expected_version: item.version + 5,
      expected_hash: item.content_hash,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_CONFLICT_VERSION");
    expect(result.error?.recovery_actions).toContain("reload_current");
  });

  it("refuses to promote something already promoted", async () => {
    const item = await createInbox();
    const first = await invoke("kiwi.object.promote", {
      object_id: item.id,
      type: "source",
      expected_version: item.version,
      expected_hash: item.content_hash,
    });
    const promoted = (first.data ?? {})["object"] as Stored;

    const second = await invoke("kiwi.object.promote", {
      object_id: promoted.id,
      type: "note",
      expected_version: promoted.version,
      expected_hash: promoted.content_hash,
    });
    expect(second.status).toBe("failed");
    expect(second.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("reports a missing object rather than failing obscurely", async () => {
    const result = await invoke("kiwi.object.promote", {
      object_id: "0198c800-0000-7000-8000-000000009999",
      type: "source",
      expected_version: 1,
      expected_hash: `sha256:${"0".repeat(64)}`,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("canonical object command boundary", () => {
  it("returns a durable receipt and records the authenticated account actor", async () => {
    const result = await invoke("kiwi.object.create-inbox", {
      title: "Field note",
      content: "A durable observation.",
    });

    expect(result.status).toBe("committed");
    expect(result.transaction_id).toMatch(/^0198c800-/);
    expect(result.event_ids).toHaveLength(3);
    const object = (result.data ?? {})["object"] as { id: string };
    const stored = await readCanonicalObject(scratch, object.id);
    expect(stored?.object["created_by"]).toBe(ACCOUNT_ID);
  });

  it("creates a Quick Capture receipt with exact selected-object provenance", async () => {
    const sourceResult = await invoke("kiwi.object.create-inbox", {
      title: "Active source note",
      content: "A passage to select.",
    });
    const source = (sourceResult.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const context = {
      surface: "inbox",
      project_id: null,
      object: {
        object_id: source.id,
        version: source.version,
        content_hash: source.content_hash,
      },
      source: null,
      selection: { text: "A passage", prefix: null, suffix: " to select." },
    };
    const result = await invoke("kiwi.object.quick-capture", {
      title: "Passage note",
      content: "A passage",
      context,
    });

    expect(result).toMatchObject({
      status: "committed",
      data: {
        object: { title: "Passage note", type: "inbox_item" },
        capture_context: {
          type: "quick_capture",
          capture_command: "kiwi.object.quick-capture",
          object: { object_id: source.id, version: 1 },
          selection: { text: "A passage", suffix: " to select." },
        },
      },
    });
    const stale = await invoke("kiwi.object.quick-capture", {
      title: "Unavailable context",
      content: "Keep the draft visible.",
      context: {
        ...context,
        object: { ...context.object, version: 99 },
      },
    });
    expect(stale.error).toMatchObject({
      code: "KIWI_CONFLICT_VERSION",
      recovery_actions: ["reload_current"],
    });
  });

  it("publishes against an expected version and reports stale edits as conflicts", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Draft",
      content: "Version one",
    });
    const first = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const published = await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "Published",
      content: "Version two",
    });
    expect(published.status).toBe("committed");

    const stale = await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "Stale draft",
      content: "Must not overwrite version two",
    });
    expect(stale.error?.code).toBe("KIWI_CONFLICT_VERSION");
    expect(stale.error?.recovery_actions).toEqual(["reload_current"]);
  });

  it("preflights validation and related-object impact before returning a publication receipt", async () => {
    const firstResult = await invoke("kiwi.object.create-inbox", {
      title: "Source",
      content: "Version one",
    });
    const secondResult = await invoke("kiwi.object.create-inbox", {
      title: "Related",
      content: "Supporting material",
    });
    const first = (firstResult.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const second = (secondResult.data ?? {})["object"] as { id: string };
    await invoke("kiwi.relation.create", {
      type: "supports",
      subject_id: first.id,
      object_id: second.id,
    });

    const invalid = await invoke("kiwi.object.validate-save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: " ",
      content: "",
    });
    expect(invalid.status).toBe("no_change");
    expect((invalid.data ?? {})["preview"]).toMatchObject({
      valid: false,
      problems: [
        { code: "title_required", severity: "error", field: "title" },
        { code: "content_empty", severity: "warning", field: "content" },
      ],
      impact: {
        relation_count: 1,
        outgoing_count: 1,
        incoming_count: 0,
        related_object_count: 1,
        relation_types: ["supports"],
      },
    });

    const published = await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "Source",
      content: "",
      reason: "Publish the title-only record",
    });
    expect(published.status).toBe("committed");
    expect(published.warnings).toEqual(["This version has no content beyond its title."]);
    expect((published.data ?? {})["preview"]).toMatchObject({
      valid: true,
      impact: { relation_count: 1, related_object_count: 1 },
    });
    expect((published.data ?? {})["object"]).toMatchObject({ version: 2, content: "" });
  });

  it("reads exact checkpoints and restores one without removing intervening history", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Original title",
      content: "Original content",
    });
    const first = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const published = await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "Revised title",
      content: "Revised content",
    });
    const second = (published.data ?? {})["object"] as {
      version: number;
      content_hash: string;
    };

    const historical = await invoke("kiwi.object.read-version", {
      object_id: first.id,
      version: 1,
    });
    expect((historical.data ?? {})["object"]).toMatchObject({
      version: 1,
      title: "Original title",
      content: "Original content",
    });

    const preview = await invoke("kiwi.object.validate-restore", {
      object_id: first.id,
      restore_version: 1,
      expected_version: second.version,
      expected_hash: second.content_hash,
    });
    expect((preview.data ?? {})["preview"]).toMatchObject({
      source: { version: 1, title: "Original title" },
      current_version: 2,
      next_version: 3,
      history_count: 2,
    });

    const restored = await invoke("kiwi.object.restore-version", {
      object_id: first.id,
      restore_version: 1,
      expected_version: second.version,
      expected_hash: second.content_hash,
      reason: "Return to the original observation",
    });
    expect(restored.status).toBe("committed");
    expect((restored.data ?? {})["object"]).toMatchObject({
      version: 3,
      title: "Original title",
      content: "Original content",
      restored_from_version: 1,
    });
    expect((restored.data ?? {})["restore"]).toMatchObject({
      source_version: 1,
      new_version: 3,
      history_count: 3,
    });
    const history = await invoke("kiwi.object.history", { object_id: first.id });
    expect(
      ((history.data ?? {})["history"] as Array<{ version: number }>).map((entry) => entry.version),
    ).toEqual([1, 2, 3]);

    const stale = await invoke("kiwi.object.restore-version", {
      object_id: first.id,
      restore_version: 2,
      expected_version: second.version,
      expected_hash: second.content_hash,
      reason: "Stale restore",
    });
    expect(stale.error?.code).toBe("KIWI_CONFLICT_VERSION");
    const unchanged = await invoke("kiwi.object.history", { object_id: first.id });
    expect(((unchanged.data ?? {})["history"] as unknown[]).length).toBe(3);
  });

  it("surfaces checkpoint corruption through the stable workspace error boundary", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Integrity fixture",
      content: "Original content",
    });
    const object = (created.data ?? {})["object"] as { id: string };
    const path = join(scratch, ".kiwi", "checkpoints", object.id, "00000001.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(
      path,
      `${JSON.stringify({ ...checkpoint, content: "Changed bytes" }, null, 2)}\n`,
    );

    const result = await invoke("kiwi.object.read-version", {
      object_id: object.id,
      version: 1,
    });
    expect(result.error).toMatchObject({
      code: "KIWI_WORKSPACE_INVALID",
      recovery_actions: ["open_logs"],
      details: { object_id: object.id, version: 1 },
    });
  });

  it("tags a nonadjacent batch atomically and undoes it with exact version guards", async () => {
    const created = await Promise.all(
      ["First", "Second", "Third"].map((title) =>
        invoke("kiwi.object.create-inbox", { title, content: `${title} content` }),
      ),
    );
    const objects = created.map(
      (result) =>
        (result.data ?? {})["object"] as {
          id: string;
          title: string;
          content: string;
          version: number;
          content_hash: string;
        },
    );
    const first = objects[0]!;
    const third = objects[2]!;
    const selected = [first, third];
    const tagged = await invoke("kiwi.object.bulk-add-tag", {
      tag_id: "tag:kiwi/needs-review",
      targets: selected.map((object) => ({
        object_id: object.id,
        expected_version: object.version,
        expected_hash: object.content_hash,
      })),
    });
    expect(tagged.status).toBe("committed");
    const receipt = (tagged.data ?? {})["receipt"] as {
      changed_count: number;
      skipped_count: number;
      undo: { tag_id: string; targets: Record<string, unknown>[] };
    };
    expect(receipt).toMatchObject({ changed_count: 2, skipped_count: 0 });
    expect((await readCanonicalObject(scratch, first.id))?.object).toMatchObject({
      version: 2,
      tags: ["tag:kiwi/needs-review"],
    });
    expect((await readCanonicalObject(scratch, objects[1]!.id))?.object).toMatchObject({
      version: 1,
      tags: [],
    });

    const undone = await invoke("kiwi.object.bulk-remove-tag", {
      tag_id: receipt.undo.tag_id,
      targets: receipt.undo.targets,
    });
    expect(undone.status).toBe("committed");
    expect((undone.data ?? {})["receipt"]).toMatchObject({ changed_count: 2 });
    expect((await readCanonicalObject(scratch, third.id))?.object).toMatchObject({
      version: 3,
      tags: [],
    });

    const currentFirst = (await readCanonicalObject(scratch, first.id))!.object;
    await invoke("kiwi.object.save", {
      object_id: currentFirst.id,
      expected_version: currentFirst.version,
      expected_hash: currentFirst.content_hash,
      title: currentFirst.title,
      content: "Changed after selection.",
    });
    const stale = await invoke("kiwi.object.bulk-add-tag", {
      tag_id: "tag:kiwi/needs-review",
      targets: [
        {
          object_id: currentFirst.id,
          expected_version: currentFirst.version,
          expected_hash: currentFirst.content_hash,
        },
        {
          object_id: objects[1]!.id,
          expected_version: objects[1]!.version,
          expected_hash: objects[1]!.content_hash,
        },
      ],
    });
    expect(stale.error?.code).toBe("KIWI_CONFLICT_VERSION");
    expect((await readCanonicalObject(scratch, objects[1]!.id))?.object).toMatchObject({
      version: 1,
      tags: [],
    });
  });

  it("renames through a new immutable version, relocates the readable path, and reveals by identity", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Original label",
      content: "Stable object identity.",
    });
    const first = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const before = await readCanonicalObject(scratch, first.id);
    const renamed = await invoke("kiwi.object.rename", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "Renamed label",
    });
    expect(renamed.status).toBe("committed");
    const object = (renamed.data ?? {})["object"] as {
      id: string;
      title: string;
      version: number;
      content_hash: string;
    };
    expect(object).toMatchObject({ id: first.id, title: "Renamed label", version: 2 });
    const after = await readCanonicalObject(scratch, first.id);
    expect(after?.relativePath).toContain("renamed-label--");
    await expect(access(join(scratch, before!.relativePath))).rejects.toThrow();

    const revealed = await invoke("kiwi.object.reveal", { object_id: first.id });
    expect(revealed.status).toBe("no_change");
    expect(revealFile).toHaveBeenCalledWith(scratch, after!.relativePath);

    const undo = (renamed.data ?? {})["undo"] as { command: string; args: Record<string, unknown> };
    const undone = await invoke(undo.command, undo.args);
    expect((undone.data ?? {})["object"]).toMatchObject({
      id: first.id,
      title: "Original label",
      version: 3,
    });
  });

  it("collects and moves membership without copying the object and returns guarded compensation", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Reusable source",
      content: "One object in several views.",
    });
    const object = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const guard = {
      object_id: object.id,
      expected_version: object.version,
      expected_hash: object.content_hash,
    };
    const collected = await invoke("kiwi.object.collect", {
      ...guard,
      expected_collection_ids: [],
      destination_title: "Methods",
    });
    expect(collected.status).toBe("committed");
    const firstReceipt = (collected.data ?? {})["receipt"] as {
      collections: Array<{ id: string; title: string }>;
    };
    expect(firstReceipt.collections).toHaveLength(1);
    expect(firstReceipt.collections[0]?.title).toBe("Methods");
    expect((await readCanonicalObject(scratch, object.id))?.object.version).toBe(1);

    const moved = await invoke("kiwi.object.move", {
      ...guard,
      expected_collection_ids: [firstReceipt.collections[0]!.id],
      source_collection_id: firstReceipt.collections[0]!.id,
      destination_title: "Results",
    });
    const moveReceipt = (moved.data ?? {})["receipt"] as {
      collections: Array<{ id: string; title: string }>;
    };
    expect(moveReceipt.collections.map((collection) => collection.title)).toEqual(["Results"]);

    const undo = (moved.data ?? {})["undo"] as { command: string; args: Record<string, unknown> };
    const undone = await invoke(undo.command, undo.args);
    expect(
      ((undone.data ?? {})["receipt"] as { collections: Array<{ title: string }> }).collections,
    ).toEqual([{ id: firstReceipt.collections[0]!.id, title: "Methods" }]);

    const stale = await invoke("kiwi.object.collect", {
      ...guard,
      expected_collection_ids: [],
      destination_title: "Discussion",
    });
    expect(stale.error?.code).toBe("KIWI_CONFLICT_VERSION");
  });

  it("duplicates into a new identity with an explicit branched-from relation", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Original",
      content: "Original content.",
    });
    const original = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const duplicated = await invoke("kiwi.object.duplicate", {
      object_id: original.id,
      expected_version: original.version,
      expected_hash: original.content_hash,
      title: "Copy of Original",
    });
    const copy = (duplicated.data ?? {})["object"] as { id: string; version: number };
    const relation = (duplicated.data ?? {})["relation"] as {
      type: string;
      subject: { object_id: string };
      object: { object_id: string };
    };
    expect(copy.id).not.toBe(original.id);
    expect(copy.version).toBe(1);
    expect(relation).toMatchObject({
      type: "branched_from",
      subject: { object_id: copy.id },
      object: { object_id: original.id },
    });
    expect((await readdir(join(scratch, ".kiwi", "checkpoints", original.id))).sort()).toEqual([
      "00000001.json",
    ]);
  });

  it("previews dependency impact and restores a trashed object through a compensating command", async () => {
    const firstResult = await invoke("kiwi.object.create-inbox", {
      title: "Referenced source",
      content: "Recoverable content.",
    });
    const secondResult = await invoke("kiwi.object.create-inbox", {
      title: "Dependent note",
      content: "Related content.",
    });
    const first = (firstResult.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    const second = (secondResult.data ?? {})["object"] as { id: string };
    await invoke("kiwi.relation.create", {
      type: "supports",
      subject_id: first.id,
      object_id: second.id,
    });
    const guard = {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
    };
    const preview = await invoke("kiwi.object.validate-trash", guard);
    expect(preview.status).toBe("no_change");
    expect((preview.data ?? {})["preview"]).toMatchObject({
      object: { id: first.id },
      impact: { relation_count: 1, related_object_count: 1, relation_types: ["supports"] },
    });

    const relationGuards = (
      (preview.data ?? {})["preview"] as {
        relation_guards: unknown[];
      }
    ).relation_guards;
    const trashed = await invoke("kiwi.object.trash", {
      ...guard,
      expected_relations: relationGuards,
    });
    expect(trashed.status).toBe("committed");
    expect(await readCanonicalObject(scratch, first.id)).toBeNull();
    const listed = await invoke("kiwi.object.trash-list", {});
    expect((listed.data ?? {})["entries"] as unknown[]).toHaveLength(1);

    const undo = (trashed.data ?? {})["undo"] as {
      command: string;
      args: Record<string, unknown>;
    };
    const restored = await invoke(undo.command, undo.args);
    expect(restored.status).toBe("committed");
    expect((restored.data ?? {})["object"]).toMatchObject({ id: first.id, version: 2 });
    expect((restored.data ?? {})["restored_relation_count"]).toBe(1);
  });

  it("keeps an object with a local recovery draft out of Trash", async () => {
    const created = await invoke("kiwi.object.create-inbox", {
      title: "Unpublished edits",
      content: "Canonical content.",
    });
    const object = (created.data ?? {})["object"] as {
      id: string;
      version: number;
      content_hash: string;
    };
    recoveryDraft = true;
    const result = await invoke("kiwi.object.trash", {
      object_id: object.id,
      expected_version: object.version,
      expected_hash: object.content_hash,
      expected_relations: [],
    });
    expect(result.error).toMatchObject({
      code: "KIWI_INVALID_REQUEST",
      recovery_actions: ["correct_input"],
    });
    expect((await readCanonicalObject(scratch, object.id))?.object).toMatchObject({
      id: object.id,
    });
  });

  it("reviews and saves the optional age policy without running cleanup", async () => {
    const current = await invoke("kiwi.object.trash-policy", {});
    expect(current).toMatchObject({
      status: "no_change",
      data: { policy: { enabled: false, minimum_age_days: 30 } },
    });
    const reviewed = await invoke("kiwi.object.validate-trash-policy", {
      enabled: true,
      minimum_age_days: 45,
    });
    const preview = (reviewed.data ?? {})["preview"] as {
      preview_token: string;
      eligible_count: number;
    };
    expect(preview.eligible_count).toBe(0);

    const saved = await invoke("kiwi.object.set-trash-policy", {
      enabled: true,
      minimum_age_days: 45,
      preview_token: preview.preview_token,
    });
    expect(saved).toMatchObject({
      status: "committed",
      data: { policy: { enabled: true, minimum_age_days: 45 }, changed: true },
    });
    expect(await invoke("kiwi.object.trash-policy", {})).toMatchObject({
      data: { policy: { enabled: true, minimum_age_days: 45 } },
    });
  });

  it("returns an irreversible purge receipt and rejects a stale reviewed scope", async () => {
    async function createAndTrash(title: string) {
      const created = await invoke("kiwi.object.create-inbox", {
        title,
        content: "Disposable fixture.",
      });
      const object = (created.data ?? {})["object"] as {
        id: string;
        version: number;
        content_hash: string;
      };
      await invoke("kiwi.object.trash", {
        object_id: object.id,
        expected_version: object.version,
        expected_hash: object.content_hash,
        expected_relations: [],
      });
      return object;
    }

    const first = await createAndTrash("First disposable object");
    const reviewed = await invoke("kiwi.object.validate-trash-purge", { scope: "all" });
    const stalePreview = (reviewed.data ?? {})["preview"] as {
      preview_token: string;
      entry_count: number;
    };
    expect(stalePreview.entry_count).toBe(1);
    await createAndTrash("Second disposable object");
    const stale = await invoke("kiwi.object.purge-trash", {
      scope: "all",
      preview_token: stalePreview.preview_token,
    });
    expect(stale.error).toMatchObject({
      code: "KIWI_CONFLICT_VERSION",
      recovery_actions: ["reload_current"],
    });

    const fresh = await invoke("kiwi.object.validate-trash-purge", { scope: "all" });
    const freshPreview = (fresh.data ?? {})["preview"] as {
      preview_token: string;
      entry_count: number;
    };
    const purged = await invoke("kiwi.object.purge-trash", {
      scope: "all",
      preview_token: freshPreview.preview_token,
    });
    expect(purged).toMatchObject({
      status: "committed",
      data: {
        receipt: {
          scope: "all",
          purged_count: 2,
          purged_object_ids: expect.arrayContaining([first.id]),
          undo: null,
        },
      },
    });
    expect((await invoke("kiwi.object.trash-list", {})).data).toEqual({ entries: [] });
  });
});

describe("conflicts", () => {
  type Saved = { id: string; version: number; content_hash: string; title: string };

  /** An open draft against a version the file on disk has already moved past. */
  async function conflicted() {
    const base = (
      await invoke("kiwi.object.create-inbox", {
        title: "Interview notes",
        content: "What we both started from",
      })
    ).data?.["object"] as Saved;
    const theirs = (
      await invoke("kiwi.object.save", {
        object_id: base.id,
        expected_version: base.version,
        expected_hash: base.content_hash,
        title: "Their reading",
        content: "Their sentence",
      })
    ).data?.["object"] as Saved;
    const conflict = (
      await invoke("kiwi.conflict.record-external", {
        object_id: base.id,
        base_version: base.version,
        base_hash: base.content_hash,
        mine_title: "My reading",
        mine_content: "My sentence",
      })
    ).data?.["conflict"] as { id: string };
    return { theirs, conflictId: conflict.id };
  }

  it("resolves to one side and leaves one object behind", async () => {
    const { theirs, conflictId } = await conflicted();

    const result = await invoke("kiwi.conflict.resolve", {
      conflict_id: conflictId,
      resolution: "mine",
      expected_version: theirs.version,
      expected_hash: theirs.content_hash,
    });

    expect(result).toMatchObject({
      status: "committed",
      data: { object: { title: "My reading" }, kept: null },
    });
    expect((await invoke("kiwi.object.list", {})).data?.["objects"] as unknown[]).toHaveLength(1);
  });

  it("keeps the other side as a second object when asked to keep both", async () => {
    const { theirs, conflictId } = await conflicted();

    const result = await invoke("kiwi.conflict.resolve", {
      conflict_id: conflictId,
      resolution: "mine",
      expected_version: theirs.version,
      expected_hash: theirs.content_hash,
      keep_other: true,
    });

    expect(result).toMatchObject({
      status: "committed",
      data: {
        object: { title: "My reading" },
        kept: { title: "Their reading", content: "Their sentence", version: 1 },
      },
    });
    const listed = (await invoke("kiwi.object.list", {})).data?.["objects"] as Saved[];
    expect(listed.map((item) => item.title).sort()).toEqual(["My reading", "Their reading"]);
  });

  it("reports the copy and its relation as events of the same transaction", async () => {
    const { theirs, conflictId } = await conflicted();

    const result = await invoke("kiwi.conflict.resolve", {
      conflict_id: conflictId,
      resolution: "theirs",
      expected_version: theirs.version,
      expected_hash: theirs.content_hash,
      keep_other: true,
    });

    // Prepared, saved, created, related, committed: the copy is not a silent write.
    expect(result.event_ids).toHaveLength(5);
    const kept = result.data?.["kept"] as Saved;
    const links = (await invoke("kiwi.relation.for-object", { object_id: kept.id })).data?.[
      "relations"
    ] as unknown[];
    expect(links).toHaveLength(1);
  });
});

describe("the workspace event log", () => {
  type Saved = { id: string; version: number; content_hash: string; title: string };

  async function activity(args: Record<string, unknown> = {}) {
    const result = await invoke("kiwi.event.list", args);
    return (result.data ?? {}) as {
      entries: Array<{ event_type: string; actor: string; object_ids: string[] }>;
      matched: number;
      actors: string[];
      event_types: string[];
    };
  }

  it("reads back newest first, because that is the end somebody reads from", async () => {
    const first = (await invoke("kiwi.object.create-inbox", { title: "First", content: "a" }))
      .data?.["object"] as Saved;
    await invoke("kiwi.object.create-inbox", { title: "Second", content: "b" });
    await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "First again",
      content: "c",
    });

    const log = await activity();

    expect(log.entries[0]?.event_type).toBe("object.saved");
    expect(log.matched).toBe(3);
  });

  it("offers the people and the kinds of event that are actually in the log", async () => {
    await invoke("kiwi.object.create-inbox", { title: "First", content: "a" });

    const log = await activity();

    expect(log.actors).toEqual([ACCOUNT_ID]);
    expect(log.event_types).toEqual(["object.created"]);
  });

  it("filters to one object without losing the menu the next filter comes from", async () => {
    const first = (await invoke("kiwi.object.create-inbox", { title: "First", content: "a" }))
      .data?.["object"] as Saved;
    await invoke("kiwi.object.create-inbox", { title: "Second", content: "b" });
    await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "First again",
      content: "c",
    });

    const log = await activity({ object_id: first.id });

    expect(log.matched).toBe(2);
    expect(log.entries.every((entry) => entry.object_ids.includes(first.id))).toBe(true);
    // Choosing one filter must not empty the menu the next one is chosen from.
    expect(log.event_types).toEqual(["object.created", "object.saved"]);
  });

  it("filters by what was done", async () => {
    const first = (await invoke("kiwi.object.create-inbox", { title: "First", content: "a" }))
      .data?.["object"] as Saved;
    await invoke("kiwi.object.save", {
      object_id: first.id,
      expected_version: first.version,
      expected_hash: first.content_hash,
      title: "First again",
      content: "c",
    });

    const log = await activity({ event_type: "object.saved" });

    expect(log.matched).toBe(1);
    expect(log.entries[0]?.event_type).toBe("object.saved");
  });

  it("says how many matched even when it returns fewer", async () => {
    await invoke("kiwi.object.create-inbox", { title: "First", content: "a" });
    await invoke("kiwi.object.create-inbox", { title: "Second", content: "b" });
    await invoke("kiwi.object.create-inbox", { title: "Third", content: "c" });

    const log = await activity({ limit: 2 });

    expect(log.entries).toHaveLength(2);
    expect(log.matched).toBe(3);
  });

  it("answers with nothing rather than failing on a workspace that has done nothing", async () => {
    const log = await activity({ actor: "account:nobody" });

    expect(log.entries).toEqual([]);
    expect(log.matched).toBe(0);
  });
});
