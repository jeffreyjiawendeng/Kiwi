import { describe, expect, it, vi } from "vitest";
import { attachPickedFiles, describeAttachments, type PickedFile } from "./file-attach.js";
import type { CreatedRow } from "./import-review.js";

function created(...rows: Array<[string, string]>): CreatedRow[] {
  return rows.map(([id, key]) => ({ id, key, title: key }));
}

function picked(...names: Array<[string, string]>): Map<string, PickedFile> {
  return new Map(names.map(([key, name]) => [key, { id: key, name }]));
}

/** Copies anything it is given, and remembers the order it was asked. */
function copier() {
  return vi.fn(async (selectionId: string) => `asset-${selectionId}`);
}

function attacher() {
  return vi.fn(async () => true);
}

describe("attaching picked files to the papers they became", () => {
  it("pairs a file with its paper by the row's name, not by where it ended up", async () => {
    // The one thing this module exists to get right. Three rows go in and the workspace holds the
    // first back as a duplicate, so the created list is two rows long against three files. Paired
    // by position, the second paper would be filed under the first file -- which is not a missing
    // file but a wrong one, and nothing on screen would ever say so.
    const copyIn = copier();
    const attach = attacher();

    await attachPickedFiles(
      copyIn,
      attach,
      created(["object-1", "pdf-2"], ["object-2", "pdf-3"]),
      picked(["pdf-1", "a.pdf"], ["pdf-2", "b.pdf"], ["pdf-3", "c.pdf"]),
    );

    expect(copyIn.mock.calls.map(([id]) => id)).toEqual(["pdf-2", "pdf-3"]);
    expect(attach.mock.calls).toEqual([
      ["object-1", "asset-pdf-2"],
      ["object-2", "asset-pdf-3"],
    ]);
  });

  it("leaves alone a paper whose row never stood for a file", async () => {
    // Every row of a reference file is one of these. There is nothing to copy in, and asking the
    // workspace to copy nothing in would be a request per row for no reason.
    const copyIn = copier();

    const result = await attachPickedFiles(
      copyIn,
      attacher(),
      created(["object-1", "row-0"], ["object-2", "row-1"]),
      picked(),
    );

    expect(copyIn).not.toHaveBeenCalled();
    expect(result).toEqual({ attached: 0, missed: [] });
  });

  it("counts a file that would not copy against itself and goes on", async () => {
    const copyIn = vi.fn(async (id: string) => (id === "pdf-1" ? null : `asset-${id}`));
    const attach = attacher();

    const result = await attachPickedFiles(
      copyIn,
      attach,
      created(["object-1", "pdf-1"], ["object-2", "pdf-2"]),
      picked(["pdf-1", "a.pdf"], ["pdf-2", "b.pdf"]),
    );

    expect(result).toEqual({ attached: 1, missed: ["a.pdf"] });
    // The paper it could not file still exists and was never asked about again.
    expect(attach.mock.calls).toEqual([["object-2", "asset-pdf-2"]]);
  });

  it("counts a file the workspace copied but would not attach", async () => {
    // A copied file that never reached its paper is as missing as one that never copied. Saying
    // it was attached because the copy worked would be reporting half a job as a whole one.
    const result = await attachPickedFiles(
      copier(),
      vi.fn(async (paperId: string) => paperId !== "object-1"),
      created(["object-1", "pdf-1"], ["object-2", "pdf-2"]),
      picked(["pdf-1", "a.pdf"], ["pdf-2", "b.pdf"]),
    );

    expect(result).toEqual({ attached: 1, missed: ["a.pdf"] });
  });

  it("stops asking once the workspace has stopped answering, and says what did not go", async () => {
    const copyIn = vi.fn(async (id: string) => {
      if (id === "pdf-2") throw new Error("gone");
      return `asset-${id}`;
    });

    const result = await attachPickedFiles(
      copyIn,
      attacher(),
      created(["object-1", "pdf-1"], ["object-2", "pdf-2"], ["object-3", "pdf-3"]),
      picked(["pdf-1", "a.pdf"], ["pdf-2", "b.pdf"], ["pdf-3", "c.pdf"]),
    );

    // The third was never tried, and is reported as missed rather than as nothing at all.
    expect(copyIn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attached: 1, missed: ["b.pdf", "c.pdf"] });
  });

  it("counts out loud, once per file it tried", async () => {
    const onProgress = vi.fn();

    await attachPickedFiles(
      copier(),
      attacher(),
      created(["object-1", "pdf-1"], ["object-2", "pdf-2"]),
      picked(["pdf-1", "a.pdf"], ["pdf-2", "b.pdf"]),
      { onProgress },
    );

    expect(onProgress.mock.calls).toEqual([[1], [2]]);
  });
});

describe("saying what the filing came to", () => {
  it("says nothing when there was no filing to do", () => {
    expect(describeAttachments({ attached: 0, missed: [] })).toBeNull();
  });

  it("says the files came in, because that is the part that took the time", () => {
    expect(describeAttachments({ attached: 12, missed: [] })).toBe(
      "12 files were copied into the workspace and attached.",
    );
  });

  it("names what it could not file, and says the papers are still there", () => {
    expect(describeAttachments({ attached: 1, missed: ["a.pdf"] })).toBe(
      "Its file was copied in and attached to it. Kiwi could not attach a.pdf. The papers were still added, and the file can be added from the paper.",
    );
  });

  it("names three and counts the rest, since a long list is a list nobody finishes", () => {
    expect(
      describeAttachments({ attached: 0, missed: ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"] }),
    ).toBe(
      "Kiwi could not attach a.pdf, b.pdf, c.pdf and 2 more. The papers were still added, and the files can be added from the paper.",
    );
  });
});
