import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listPdfFolder } from "./pdf-folder.js";

let scratch = "";

afterEach(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
  scratch = "";
});

/** A folder holding the named files, each with enough bytes to be a real file. */
async function folder(...names: string[]): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-pdf-folder-"));
  for (const name of names) await writeFile(join(scratch, name), "%PDF-1.7\n");
  return scratch;
}

/** The listing's file names, which is what the assertions are about; the folder is a temp path. */
function names(paths: string[]): string[] {
  return paths.map((path) => basename(path));
}

describe("listPdfFolder", () => {
  it("lists the PDFs in the folder, with the folder's own path on each", async () => {
    const root = await folder("second.pdf", "first.pdf");

    const listing = await listPdfFolder(root);

    expect(names(listing.paths)).toEqual(["first.pdf", "second.pdf"]);
    expect(listing.paths).toEqual([join(root, "first.pdf"), join(root, "second.pdf")]);
    expect(listing.skipped).toBe(0);
    expect(listing.truncated).toBe(false);
  });

  it("counts what is not a PDF rather than naming it back", async () => {
    // A folder of papers usually holds a few other things. Listing them would bury the papers;
    // saying nothing would make twenty rows out of thirty files look like a loss.
    const root = await folder("paper.pdf", "notes.txt", "table.csv");

    const listing = await listPdfFolder(root);

    expect(names(listing.paths)).toEqual(["paper.pdf"]);
    expect(listing.skipped).toBe(2);
  });

  it("takes the extension whatever case it is written in", async () => {
    const root = await folder("Scanned.PDF");

    expect(names((await listPdfFolder(root)).paths)).toEqual(["Scanned.PDF"]);
  });

  it("leaves a subfolder alone, and does not count it as something passed over", async () => {
    const root = await folder("paper.pdf");
    await mkdir(join(root, "supplement"));
    await writeFile(join(root, "supplement", "appendix.pdf"), "%PDF-1.7\n");

    const listing = await listPdfFolder(root);

    expect(names(listing.paths)).toEqual(["paper.pdf"]);
    expect(listing.skipped).toBe(0);
  });

  it("skips a dotfile, which on macOS is a resource fork and not the paper", async () => {
    const root = await folder("paper.pdf", "._paper.pdf");

    const listing = await listPdfFolder(root);

    expect(names(listing.paths)).toEqual(["paper.pdf"]);
    expect(listing.skipped).toBe(1);
  });

  it("orders names the way they were meant, so chapter9 comes before chapter10", async () => {
    const root = await folder("chapter10.pdf", "chapter9.pdf", "chapter1.pdf");

    expect(names((await listPdfFolder(root)).paths)).toEqual([
      "chapter1.pdf",
      "chapter9.pdf",
      "chapter10.pdf",
    ]);
  });

  it("takes only as many as one pass allows, and says the rest were left", async () => {
    const root = await folder("a.pdf", "b.pdf", "c.pdf");

    const listing = await listPdfFolder(root, 2);

    expect(names(listing.paths)).toEqual(["a.pdf", "b.pdf"]);
    expect(listing.truncated).toBe(true);
  });

  it("does not call a folder truncated when it holds exactly as many as fit", async () => {
    const root = await folder("a.pdf", "b.pdf");

    expect((await listPdfFolder(root, 2)).truncated).toBe(false);
  });

  it("reads an empty folder as an answer rather than a failure", async () => {
    const root = await folder();

    await expect(listPdfFolder(root)).resolves.toEqual({
      paths: [],
      skipped: 0,
      truncated: false,
    });
  });

  it("raises when the folder cannot be read at all", async () => {
    // "There is nothing here" and "I could not look" are different answers, and only one of
    // them belongs on screen as a result.
    const root = await folder();

    await expect(listPdfFolder(join(root, "gone"))).rejects.toThrow();
  });
});
