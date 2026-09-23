import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type CommandEnvelope } from "@kiwi/contracts";
import { createGateway, createRegistry, type Gateway } from "@kiwi/commands";
import { createWorkspace } from "./store.js";
import { objectCommands } from "./object-commands.js";
import { bibliographyCommands } from "./bibliography-commands.js";

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
  scratch = await mkdtemp(join(tmpdir(), "kiwi-bibliography-"));
  sequence = 0;
  await createWorkspace({
    root: scratch,
    workspaceId: WORKSPACE_ID,
    title: "Bibliography test",
    now: NOW,
  });
  const registry = createRegistry();
  for (const command of bibliographyCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  for (const command of objectCommands({ newId: nextId, now: () => NOW })) {
    registry.register(command);
  }
  gateway = createGateway({ registry, newCorrelationId: () => "corr-bib" });
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

/** The same call, made by something other than the person sitting in front of Kiwi. */
async function invokeFrom(
  surface: "ui" | "cli" | "api" | "extension" | "importer" | "ai",
  command: string,
  args: Record<string, unknown> = {},
) {
  return gateway.invoke(envelope(command, { root: scratch, ...args }), {
    actor: { kind: "local_user", id: ACCOUNT_ID },
    origin: { surface, extension_id: null },
  });
}

async function paper(title: string, reference: Record<string, unknown> = {}) {
  const created = await invoke("kiwi.object.create", { type: "source", title, content: "" });
  const object = (created.data as { object: { id: string; version: number; content_hash: string } })
    .object;
  await invoke("kiwi.object.set-reference", {
    object_id: object.id,
    expected_version: object.version,
    expected_hash: object.content_hash,
    reference: {
      kind: "article",
      authors: ["Ada Lovelace"],
      year: 1843,
      container: "Notes",
      ...reference,
    },
  });
  return object.id;
}

async function manuscriptCiting(...objectIds: string[]) {
  const created = await invoke("kiwi.object.create", {
    type: "output",
    title: "Draft",
    content: "",
  });
  const object = (created.data as { object: { id: string; version: number; content_hash: string } })
    .object;
  await invoke("kiwi.object.set-document", {
    object_id: object.id,
    expected_version: object.version,
    expected_hash: object.content_hash,
    mode: "rich",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: objectIds.map((objectId) => ({ type: "citation", attrs: { objectId } })),
        },
      ],
    },
  });
  return object.id;
}

describe("kiwi.bibliography.for-document", () => {
  it("lists only what the manuscript cites", async () => {
    // A reference list holding everything the author owns is wrong in a way that gets a paper
    // rejected.
    const cited = await paper("Cited paper");
    await paper("Never cited");
    const draft = await manuscriptCiting(cited);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    const data = result.data as {
      entries: Array<{ title: string }>;
      uncited: Array<{ title: string }>;
    };
    expect(data.entries.map((entry) => entry.title)).toEqual(["Cited paper"]);
    expect(data.uncited.map((entry) => entry.title)).toEqual(["Never cited"]);
  });

  it("formats each entry in the chosen style", async () => {
    const cited = await paper("On the Analytical Engine");
    const draft = await manuscriptCiting(cited);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    const first = (result.data as { entries: Array<{ text: string }> }).entries[0];
    expect(first?.text).toContain("Lovelace, A.");
    expect(first?.text).toContain("(1843)");
  });

  it("numbers a numeric style by order of first citation", async () => {
    const second = await paper("Second");
    const first = await paper("First");
    const draft = await manuscriptCiting(first, second);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "ieee",
    });
    const data = result.data as {
      numbered: boolean;
      entries: Array<{ title: string; number: number; in_text: string }>;
    };
    expect(data.numbered).toBe(true);
    expect(data.entries.map((entry) => entry.title)).toEqual(["First", "Second"]);
    // The in-text form is the number, which is what makes the ordering meaningful.
    expect(data.entries.map((entry) => entry.in_text)).toEqual(["[1]", "[2]"]);
  });

  it("says how often each work is cited, which one line in a list cannot", async () => {
    const carrying = await paper("Cited throughout");
    const passing = await paper("Cited once");
    const draft = await manuscriptCiting(carrying, passing, carrying);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    const entries = (result.data as { entries: Array<{ title: string; count: number }> }).entries;
    expect(Object.fromEntries(entries.map((entry) => [entry.title, entry.count]))).toEqual({
      "Cited throughout": 2,
      "Cited once": 1,
    });
  });

  it("reports a citation whose Paper has been deleted", async () => {
    // Silently dropping it would leave a manuscript citing something no reader can find.
    const draft = await manuscriptCiting("0198c800-0000-7000-8000-000000009999");
    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    expect((result.data as { broken: Array<{ reason: string }> }).broken).toMatchObject([
      { reason: "deleted" },
    ]);
  });

  it("reports a cited Paper that carries no bibliographic record", async () => {
    const created = await invoke("kiwi.object.create", {
      type: "source",
      title: "No record",
      content: "",
    });
    const id = (created.data as { object: { id: string } }).object.id;
    const draft = await manuscriptCiting(id);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    expect((result.data as { broken: Array<{ reason: string }> }).broken).toMatchObject([
      { reason: "no_reference" },
    ]);
  });

  it("says which fields a style still needs", async () => {
    const cited = await paper("Missing year", { year: null, authors: [] });
    const draft = await manuscriptCiting(cited);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    const incomplete = (result.data as { entries: Array<{ incomplete: string[] }> }).entries[0]
      ?.incomplete;
    expect(incomplete).toContain("year");
    expect(incomplete).toContain("authors");
  });

  it("gives a citation key a person can read in a LaTeX source", async () => {
    const cited = await paper("On the Analytical Engine");
    const draft = await manuscriptCiting(cited);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    expect((result.data as { entries: Array<{ key: string }> }).entries[0]?.key).toBe(
      "lovelace1843",
    );
  });

  it("separates two papers that share an author and a year", async () => {
    const one = await paper("First paper");
    const two = await paper("Second paper");
    const draft = await manuscriptCiting(one, two);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "ieee",
    });
    const keys = (result.data as { entries: Array<{ key: string }> }).entries.map(
      (entry) => entry.key,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("writes a BibTeX file for the compiler", async () => {
    const cited = await paper("On the Analytical Engine");
    const draft = await manuscriptCiting(cited);

    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    const bibtex = (result.data as { bibtex: string }).bibtex;
    expect(bibtex).toContain("@article{lovelace1843,");
    expect(bibtex).toContain("On the Analytical Engine");
  });

  it("is empty for a manuscript that cites nothing", async () => {
    const draft = await manuscriptCiting();
    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: draft,
      style: "apa",
    });
    expect((result.data as { entries: unknown[] }).entries).toEqual([]);
  });

  it("says so when the manuscript is not there", async () => {
    const result = await invoke("kiwi.bibliography.for-document", {
      object_id: "0198c800-0000-7000-8000-000000009999",
      style: "apa",
    });
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });
});

describe("kiwi.bibliography.export", () => {
  it("writes every Paper that has a record", async () => {
    await paper("First");
    await paper("Second");
    const result = await invoke("kiwi.bibliography.export", {});
    expect((result.data as { count: number }).count).toBe(2);
  });

  it("writes only the chosen Papers", async () => {
    const first = await paper("First");
    await paper("Second");
    const result = await invoke("kiwi.bibliography.export", { object_ids: [first] });
    const data = result.data as { text: string; count: number };
    expect(data.count).toBe(1);
    expect(data.text).toContain("First");
    expect(data.text).not.toContain("Second");
  });

  it("writes BibTeX when no format is asked for", async () => {
    await paper("First");
    const data = (await invoke("kiwi.bibliography.export", {})).data as {
      format: string;
      extension: string;
      text: string;
    };
    expect(data).toMatchObject({ format: "bibtex", extension: "bib" });
    expect(data.text).toContain("@article{");
  });

  it("writes the same Papers as RIS when RIS is asked for", async () => {
    await paper("First");
    const data = (await invoke("kiwi.bibliography.export", { format: "ris" })).data as {
      extension: string;
      text: string;
      count: number;
    };
    expect(data).toMatchObject({ extension: "ris", count: 1 });
    expect(data.text).toContain("TI  - First");
    expect(data.text).toContain("ER  - ");
  });

  it("writes a spreadsheet when CSV is asked for", async () => {
    await paper("First");
    const data = (await invoke("kiwi.bibliography.export", { format: "csv" })).data as {
      extension: string;
      text: string;
    };
    expect(data.extension).toBe("csv");
    expect(data.text.split(String.fromCodePoint(13, 10))[0]).toContain("key,title,authors");
  });

  it("refuses a format it cannot write", async () => {
    const result = await invoke("kiwi.bibliography.export", { format: "endnote" });
    expect(result.status).toBe("failed");
  });

  it("skips a Paper with no record rather than writing a hollow entry", async () => {
    await invoke("kiwi.object.create", { type: "source", title: "No record", content: "" });
    expect((await invoke("kiwi.bibliography.export", {})).data).toMatchObject({ count: 0 });
  });
});

describe("kiwi.bibliography.import", () => {
  const FILE = [
    "@article{lovelace1843,",
    "  title = {Notes on the Analytical Engine},",
    "  author = {Ada Lovelace},",
    "  year = {1843},",
    "  doi = {10.1000/analytical}",
    "}",
  ].join("\n");

  it("creates a Paper per entry", async () => {
    const result = await invoke("kiwi.bibliography.import", { source: FILE });
    const data = result.data as { created: Array<{ title: string }>; found: number };
    expect(data.found).toBe(1);
    expect(data.created.map((entry) => entry.title)).toEqual(["Notes on the Analytical Engine"]);
  });

  it("keeps the record so a citation can be built from it", async () => {
    await invoke("kiwi.bibliography.import", { source: FILE });
    const exported = await invoke("kiwi.bibliography.export", {});
    expect((exported.data as { text: string }).text).toContain("Ada Lovelace");
  });

  it("does not double a paper already in the library", async () => {
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", { source: FILE });
    const data = again.data as { created: unknown[]; skipped: Array<{ reason: string }> };
    expect(data.created).toEqual([]);
    expect(data.skipped).toMatchObject([{ reason: "duplicate_doi" }]);
  });

  it("reports what it skipped as well as what it added", async () => {
    // An import that says "400 added" while silently dropping 12 is worse than one that says
    // 388 and 12.
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", { source: FILE });
    expect((again.data as { found: number }).found).toBe(1);
  });

  it("refuses a file holding no references", async () => {
    const result = await invoke("kiwi.bibliography.import", { source: "not a bib file" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("says back the name the sender gave each row it created", async () => {
    // A folder import has a PDF waiting behind every row, and once the Paper exists the file has
    // to go on it. Counting cannot find the pair: the receipt reports what was created and what
    // was held back in two lists, so the created list stops lining up with the rows that went.
    const result = await invoke("kiwi.bibliography.import", {
      entries: [
        { key: "pdf-7", title: "Notes on the Analytical Engine", reference: { kind: "article" } },
      ],
    });
    const data = result.data as { created: Array<{ key: string; id: string }> };
    expect(data.created).toMatchObject([{ key: "pdf-7" }]);
    expect(data.created[0]?.id).toEqual(expect.any(String));
  });

  it("says back the name of a row it held back, not only of one it created", async () => {
    // The created list alone is shorter than the rows that were sent whenever anything was held
    // back, so a caller reading it by position would pair every later row with the wrong record.
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", { source: FILE });
    const data = again.data as { skipped: Array<{ key: string; reason: string }> };
    expect(data.skipped).toMatchObject([{ key: "lovelace1843", reason: "duplicate_doi" }]);
  });

  it("names rows of a file by what the file itself calls them", async () => {
    // A file sends no names of its own choosing, but it does state one per entry, and the entry's
    // own citation key is more use to anybody reading the receipt than its position would be.
    const result = await invoke("kiwi.bibliography.import", { source: FILE });
    expect((result.data as { created: Array<{ key: string }> }).created).toMatchObject([
      { key: "lovelace1843" },
    ]);
  });

  const RIS_FILE = [
    "TY  - JOUR",
    "TI  - Notes on the Analytical Engine",
    "AU  - Lovelace, Ada",
    "PY  - 1843",
    "DO  - 10.1000/analytical",
    "ER  - ",
  ].join("\r\n");

  it("takes a RIS file without being told it is one", async () => {
    // Half a library arrives from something that is not Zotero, and the file's own contents
    // say which format it is more reliably than the extension it was saved under.
    const result = await invoke("kiwi.bibliography.import", { source: RIS_FILE });
    const data = result.data as { created: Array<{ title: string }> };
    expect(data.created.map((entry) => entry.title)).toEqual(["Notes on the Analytical Engine"]);
  });

  it("counts a paper as already held whichever format it arrived in", async () => {
    // The same work in two formats is one paper. A duplicate check that only sees its own
    // format is a duplicate check that doubles a library the second time somebody exports it.
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", { source: RIS_FILE });
    const data = again.data as { created: unknown[]; skipped: Array<{ reason: string }> };
    expect(data.created).toEqual([]);
    expect(data.skipped).toMatchObject([{ reason: "duplicate_doi" }]);
  });

  it("says which Paper the entry it skipped was a second copy of", async () => {
    // "Skipped: 12" answers nothing. Naming the Paper already held turns the receipt into
    // twelve things somebody can open and check.
    const first = await invoke("kiwi.bibliography.import", { source: FILE });
    const held = (first.data as { created: Array<{ id: string }> }).created[0]?.id;
    const again = await invoke("kiwi.bibliography.import", { source: FILE });
    expect((again.data as { skipped: Array<{ object_id: string }> }).skipped).toMatchObject([
      { object_id: held },
    ]);
  });

  it("creates one Paper from a file that lists the same paper twice", async () => {
    // Two collections exported together, both holding the paper. Nothing in the library to
    // compare against, so a check that only looks outwards creates it twice.
    const result = await invoke("kiwi.bibliography.import", { source: `${FILE}\n${FILE}` });
    const data = result.data as {
      created: unknown[];
      skipped: Array<{ reason: string }>;
      found: number;
    };
    expect(data.found).toBe(2);
    expect(data.created).toHaveLength(1);
    expect(data.skipped).toMatchObject([{ reason: "repeated_in_file" }]);
  });

  it("holds back a paper whose title reads the same as one already held", async () => {
    // Not certain, which is why it is reported under its own reason rather than as a DOI
    // match: this is the row a person is meant to look at.
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", {
      source: [
        "@article{lovelace,",
        "  title = {Notes on the analytical engine.},",
        "  author = {Ada Lovelace},",
        "  year = {1843}",
        "}",
      ].join("\n"),
    });
    const data = again.data as { created: unknown[]; skipped: Array<{ reason: string }> };
    expect(data.created).toEqual([]);
    expect(data.skipped).toMatchObject([{ reason: "duplicate_title" }]);
  });

  it("still imports a paper that only resembles one already held", async () => {
    // A near miss is not a duplicate. Refusing everything that reads a bit alike would lose
    // the second half of a two-part paper.
    await invoke("kiwi.bibliography.import", { source: FILE });
    const again = await invoke("kiwi.bibliography.import", {
      source: [
        "@article{lovelace1844,",
        "  title = {Notes on the Analytical Engine},",
        "  author = {Charles Babbage},",
        "  year = {1844}",
        "}",
      ].join("\n"),
    });
    expect((again.data as { created: unknown[] }).created).toHaveLength(1);
  });

  it("creates the rows it was handed rather than a file", async () => {
    const result = await invoke("kiwi.bibliography.import", {
      entries: [
        {
          title: "Notes on the Analytical Engine",
          reference: { kind: "article", authors: ["Ada Lovelace"], year: 1843 },
        },
      ],
    });
    const data = result.data as { created: Array<{ title: string }>; reviewed: boolean };
    expect(data.created.map((entry) => entry.title)).toEqual(["Notes on the Analytical Engine"]);
    expect(data.reviewed).toBe(true);
  });

  it("keeps a correction made in the preview instead of the value the file held", async () => {
    // The whole reason for showing the rows is that somebody can fix what the exporter got
    // wrong. An import that re-reads the file and imports that has wasted their time.
    await invoke("kiwi.bibliography.import", {
      entries: [
        {
          title: "Notes on the Analytical Engine",
          reference: { kind: "article", authors: ["A. A. Lovelace"], year: 1843 },
        },
      ],
    });
    const exported = await invoke("kiwi.bibliography.export", {});
    expect((exported.data as { text: string }).text).toContain("A. A. Lovelace");
  });

  it("creates a reviewed row that looks like a copy, and says on the receipt that it does", async () => {
    // Somebody was shown what this resembled and ticked it anyway. Overruling them would make
    // the preview a formality; saying nothing would hide that the library now holds two.
    const first = await invoke("kiwi.bibliography.import", { source: FILE });
    const held = (first.data as { created: Array<{ id: string }> }).created[0]?.id;
    const again = await invoke("kiwi.bibliography.import", {
      entries: [
        {
          title: "Notes on the Analytical Engine",
          reference: {
            kind: "article",
            authors: ["Ada Lovelace"],
            year: 1843,
            doi: "10.1000/analytical",
          },
        },
      ],
    });
    const data = again.data as {
      created: Array<{ duplicate: { by: string; object_id: string } | null }>;
      skipped: unknown[];
    };
    expect(data.skipped).toEqual([]);
    expect(data.created).toMatchObject([{ duplicate: { by: "doi", object_id: held } }]);
  });

  it("refuses a file and a set of rows in the same request", async () => {
    // One of them has been read by a person and the other has not, so there is no sensible
    // way to obey both.
    const result = await invoke("kiwi.bibliography.import", { source: FILE, entries: [] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses a request carrying neither", async () => {
    const result = await invoke("kiwi.bibliography.import", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("kiwi.bibliography.import-preview", () => {
  const FILE = [
    "@article{lovelace1843,",
    "  title = {Notes on the Analytical Engine},",
    "  author = {Ada Lovelace},",
    "  year = {1843},",
    "  doi = {10.1000/analytical}",
    "}",
  ].join("\n");

  it("shows the rows a file would add and adds none of them", async () => {
    const result = await invoke("kiwi.bibliography.import-preview", { source: FILE });
    const data = result.data as {
      found: number;
      rows: Array<{ row: number; title: string; selected: boolean; duplicate: unknown }>;
    };
    expect(data.found).toBe(1);
    expect(data.rows).toMatchObject([
      { row: 0, title: "Notes on the Analytical Engine", selected: true, duplicate: null },
    ]);
    expect((await invoke("kiwi.bibliography.export", {})).data).toMatchObject({ count: 0 });
  });

  it("carries the record so the table has something to show and to correct", async () => {
    const data = (await invoke("kiwi.bibliography.import-preview", { source: FILE })).data as {
      rows: Array<{ reference: { authors: string[]; doi: string | null } }>;
    };
    expect(data.rows[0]?.reference).toMatchObject({
      authors: ["Ada Lovelace"],
      doi: "10.1000/analytical",
    });
  });

  it("names the Paper a row would duplicate before anybody commits to it", async () => {
    const first = await invoke("kiwi.bibliography.import", { source: FILE });
    const held = (first.data as { created: Array<{ id: string }> }).created[0]?.id;
    const data = (await invoke("kiwi.bibliography.import-preview", { source: FILE })).data as {
      rows: Array<{ selected: boolean; duplicate: Record<string, unknown> }>;
    };
    expect(data.rows[0]?.selected).toBe(false);
    expect(data.rows[0]?.duplicate).toMatchObject({
      where: "library",
      by: "doi",
      certain: true,
      object_id: held,
    });
  });

  it("says what the exporter left out while it is still worth typing in", async () => {
    // A row with no author and no year is found now, in a table somebody can correct, rather
    // than later in a bibliography that will not format.
    const data = (
      await invoke("kiwi.bibliography.import-preview", {
        source: "@article{nothing,\n  title = {A paper with nothing else}\n}",
      })
    ).data as { rows: Array<{ missing: string[] }> };
    expect(data.rows[0]?.missing).toEqual(["authors", "year", "container"]);
  });

  it("says what is wrong with a field the exporter did fill in", async () => {
    const data = (
      await invoke("kiwi.bibliography.import-preview", {
        source: "@article{bad,\n  title = {A paper},\n  doi = {not-a-doi}\n}",
      })
    ).data as { rows: Array<{ problems: Array<{ field: string }> }> };
    expect(data.rows[0]?.problems.map((problem) => problem.field)).toContain("doi");
  });

  it("answers rows read somewhere else with the verdict a file would have got", async () => {
    // A folder of PDFs is opened in the window, so its rows reach the workspace already read.
    // They still have to be told what the library holds, and told it by this command: two
    // entrances deciding for themselves what a duplicate is would be two sets of bugs.
    const first = await invoke("kiwi.bibliography.import", { source: FILE });
    const held = (first.data as { created: Array<{ id: string }> }).created[0]?.id;
    const data = (
      await invoke("kiwi.bibliography.import-preview", {
        entries: [
          {
            title: "Notes on the Analytical Engine",
            reference: {
              kind: "article",
              authors: ["Ada Lovelace"],
              year: 1843,
              doi: "10.1000/analytical",
            },
          },
        ],
      })
    ).data as { found: number; rows: Array<{ selected: boolean; duplicate: unknown }> };
    expect(data.found).toBe(1);
    expect(data.rows[0]?.selected).toBe(false);
    expect(data.rows[0]?.duplicate).toMatchObject({
      where: "library",
      by: "doi",
      certain: true,
      object_id: held,
    });
  });

  it("reports one folder holding the same paper twice as a repeat of its own earlier row", async () => {
    // Two copies of a download, named differently, in the folder somebody dragged in. Neither
    // is in the library, so nothing but this comparison catches it.
    const entry = {
      title: "Notes on the Analytical Engine",
      reference: { kind: "article", authors: ["Ada Lovelace"], year: 1843 },
    };
    const data = (await invoke("kiwi.bibliography.import-preview", { entries: [entry, entry] }))
      .data as { rows: Array<{ selected: boolean; duplicate: { where: string; row: number } }> };
    expect(data.rows[0]).toMatchObject({ selected: true, duplicate: null });
    expect(data.rows[1]?.selected).toBe(false);
    expect(data.rows[1]?.duplicate).toMatchObject({ where: "file", row: 0 });
  });

  it("refuses a file and a set of rows in the same request", async () => {
    const result = await invoke("kiwi.bibliography.import-preview", { source: FILE, entries: [] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses a file holding no references", async () => {
    const result = await invoke("kiwi.bibliography.import-preview", { source: "not a bib file" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("importing a file the command fetches for itself", () => {
  /** What a Windows exporter puts in front of a file, written where it can be seen. */
  const MARK = String.fromCodePoint(0xfeff);

  /** Somewhere outside the workspace, the way a downloads folder is. */
  let inbox: string;

  beforeEach(async () => {
    inbox = await mkdtemp(join(tmpdir(), "kiwi-inbox-"));
  });

  afterEach(async () => {
    await rm(inbox, { recursive: true, force: true }).catch(() => undefined);
  });

  /** A BibTeX file of `count` distinct entries, written where the command can reach it. */
  async function library(count: number, name = "library.bib"): Promise<string> {
    const entries = Array.from({ length: count }, (_unused, index) =>
      [
        `@article{paper${index},`,
        `  title = {Paper number ${index}},`,
        "  author = {Ada Lovelace},",
        "  year = {1843},",
        `  doi = {10.1000/paper${index}}`,
        "}",
      ].join("\n"),
    );
    const path = join(inbox, name);
    await writeFile(path, entries.join("\n\n"), "utf8");
    return path;
  }

  it("reads a library too large to have been sent in one command", async () => {
    // The point of the whole argument. A command envelope is capped at 256 KB, and a Zotero
    // export of a few hundred papers is past that before it is anywhere near a large library.
    const path = await library(2_500);
    const sent = await invoke("kiwi.bibliography.import-preview", {
      source: await readFile(path, "utf8"),
    });
    expect(sent.status).toBe("failed");

    const fetched = await invoke("kiwi.bibliography.import-preview", { source_path: path });
    expect(fetched.error).toBeUndefined();
    expect((fetched.data as { found: number }).found).toBe(2_500);
  });

  it("previews a file it was told where to find", async () => {
    const path = await library(2);
    const data = (await invoke("kiwi.bibliography.import-preview", { source_path: path })).data as {
      found: number;
      rows: Array<{ title: string }>;
    };
    expect(data.found).toBe(2);
    expect(data.rows.map((row) => row.title)).toEqual(["Paper number 0", "Paper number 1"]);
  });

  it("reads a RIS file past the byte order mark a Windows export puts in front of it", async () => {
    // The mark sits where the sniffer looks for `TY  -`, so read flatly the file holds nothing
    // at all -- which is what the person is told, about a file plainly full of references.
    const path = join(inbox, "endnote.ris");
    const ris = ["TY  - JOUR", "TI  - Notes on the Analytical Engine", "ER  - "].join("\r\n");
    await writeFile(path, `${MARK}${ris}`, "utf8");
    const data = (await invoke("kiwi.bibliography.import-preview", { source_path: path })).data as {
      rows: Array<{ title: string }>;
    };
    expect(data.rows.map((row) => row.title)).toEqual(["Notes on the Analytical Engine"]);
  });

  it("reads a file the exporter wrote as UTF-16", async () => {
    const path = join(inbox, "utf16.bib");
    const bib = "@article{k,\n  title = {Notes on the Analytical Engine}\n}";
    await writeFile(path, Buffer.from(`${MARK}${bib}`, "utf16le"));
    const data = (await invoke("kiwi.bibliography.import-preview", { source_path: path })).data as {
      rows: Array<{ title: string }>;
    };
    expect(data.rows.map((row) => row.title)).toEqual(["Notes on the Analytical Engine"]);
  });

  it("reads a file written the other way round", async () => {
    const path = join(inbox, "utf16be.bib");
    const bytes = Buffer.from(`${MARK}@article{k,\n  title = {A paper}\n}`, "utf16le");
    bytes.swap16();
    await writeFile(path, bytes);
    const data = (await invoke("kiwi.bibliography.import-preview", { source_path: path })).data as {
      rows: Array<{ title: string }>;
    };
    expect(data.rows.map((row) => row.title)).toEqual(["A paper"]);
  });

  it("lets the command line name a file, because it is at the same machine", async () => {
    const path = await library(1);
    const result = await invokeFrom("cli", "kiwi.bibliography.import-preview", {
      source_path: path,
    });
    expect(result.error).toBeUndefined();
  });

  it("will not fetch a file for a surface that is not at the machine", async () => {
    // A path means something only here. Asked from outside, it names a file the caller cannot
    // see and did not choose, and reading it would be Kiwi fetching somebody's disk for them.
    const path = await library(1);
    const result = await invokeFrom("api", "kiwi.bibliography.import-preview", {
      source_path: path,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_PATH_DENIED");
  });

  it("still takes a file such a surface already has", async () => {
    const result = await invokeFrom("api", "kiwi.bibliography.import-preview", {
      source: "@article{k, title = {A paper}}",
    });
    expect(result.error).toBeUndefined();
  });

  it("refuses a file and the location of one in the same request", async () => {
    const path = await library(1);
    const result = await invoke("kiwi.bibliography.import", {
      source: "@article{k, title = {A paper}}",
      source_path: path,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses the rows chosen from a file alongside the location of one", async () => {
    const path = await library(1);
    const result = await invoke("kiwi.bibliography.import", {
      source_path: path,
      entries: [{ title: "A paper" }],
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("says a file has gone rather than reporting nothing in it", async () => {
    const result = await invoke("kiwi.bibliography.import-preview", {
      source_path: join(inbox, "moved.bib"),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_NOT_FOUND");
  });

  it("says a folder is a folder", async () => {
    const path = join(inbox, "exports");
    await mkdir(path);
    const result = await invoke("kiwi.bibliography.import-preview", { source_path: path });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });

  it("refuses a file larger than an import will read, before reading any of it", async () => {
    const path = join(inbox, "enormous.bib");
    await writeFile(path, Buffer.alloc(8_000_001, 0x20));
    const result = await invoke("kiwi.bibliography.import-preview", { source_path: path });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("8 MB");
  });
});
