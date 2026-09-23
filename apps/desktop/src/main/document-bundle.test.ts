import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportFolderName,
  figureExtension,
  resolveBundleFiles,
  writeDocumentBundle,
} from "./document-bundle.js";

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kiwi-export-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe("figure extensions", () => {
  it("names a figure by what its bytes actually are", () => {
    expect(figureExtension(PNG)).toBe(".png");
    expect(figureExtension(JPEG)).toBe(".jpg");
    expect(figureExtension(Buffer.from("%PDF-1.7"))).toBe(".pdf");
    expect(figureExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      ".svg",
    );
  });

  it("leaves a picture it cannot recognise unnamed rather than guessing wrong", () => {
    // graphicx fails to find a file with the wrong extension in a way that reads like a missing
    // figure. No extension at least fails honestly, and the source is unchanged either way.
    expect(figureExtension(Buffer.from("not a picture"))).toBe("");
  });
});

describe("bundle files", () => {
  it("gives an asset the extension the LaTeX source expects to find", async () => {
    // documentToLatex writes \includegraphics{figure-abc} with no extension, because graphicx
    // supplies one. Writing the file as `figure-abc` means graphicx never finds it.
    const { files } = await resolveBundleFiles(
      [{ name: "figure-abc", asset_id: "asset-1" }],
      async () => PNG,
    );
    expect(files).toEqual([{ name: "figure-abc.png", bytes: PNG }]);
  });

  it("carries the bibliography as text, because Kiwi wrote it and no asset holds it", async () => {
    const { files } = await resolveBundleFiles(
      [{ name: "references.bib", text: "@article{a,title={A}}" }],
      async () => {
        throw new Error("a text file must not be read from the workspace");
      },
    );
    expect(files).toHaveLength(1);
    expect(Buffer.from(files[0]?.bytes ?? []).toString("utf8")).toContain("@article");
  });

  it("reports a figure it could not read instead of exporting as though nothing was missing", async () => {
    const { files, missing } = await resolveBundleFiles(
      [
        { name: "figure-good", asset_id: "asset-1" },
        { name: "figure-gone", asset_id: "asset-2" },
      ],
      async (assetId) => {
        if (assetId === "asset-2") throw new Error("no such asset");
        return PNG;
      },
    );
    expect(files.map((file) => file.name)).toEqual(["figure-good.png"]);
    expect(missing).toEqual(["figure-gone"]);
  });

  it("refuses a name that would escape the folder it is written into", async () => {
    const { files } = await resolveBundleFiles(
      [
        { name: "../escape", asset_id: "asset-1" },
        { name: "sub/dir", asset_id: "asset-1" },
      ],
      async () => PNG,
    );
    expect(files).toEqual([]);
  });
});

describe("export folder names", () => {
  it("turns a title into something a file system will accept", () => {
    expect(exportFolderName("Ice Cores and the Younger Dryas")).toBe(
      "ice-cores-and-the-younger-dryas",
    );
  });

  it("keeps a name for a title made entirely of punctuation", () => {
    // An empty folder name is a write into the parent directory, which would scatter the bundle
    // across whatever the person had chosen.
    expect(exportFolderName("???")).toBe("manuscript");
    expect(exportFolderName("")).toBe("manuscript");
  });
});

describe("writing a bundle", () => {
  it("writes the source and every file it was given", async () => {
    const directory = await scratch();
    const written = await writeDocumentBundle({
      directory,
      folder: "draft",
      sourceName: "draft.tex",
      source: "\\documentclass{article}\\begin{document}Hi\\end{document}",
      files: [{ name: "references.bib", bytes: Buffer.from("@book{b}") }],
    });
    expect(written.folder).toBe("draft");
    expect(written.files).toEqual(["draft.tex", "references.bib"]);
    expect(await readdir(join(directory, "draft"))).toEqual(["draft.tex", "references.bib"]);
    expect(await readFile(join(directory, "draft", "draft.tex"), "utf8")).toContain(
      "\\documentclass",
    );
  });

  it("exports beside an earlier export rather than over the top of it", async () => {
    // Two exports of the same manuscript are usually a person checking something changed.
    // Overwriting the first leaves them comparing a folder with itself.
    const directory = await scratch();
    const first = await writeDocumentBundle({
      directory,
      folder: "draft",
      sourceName: "draft.tex",
      source: "first",
      files: [],
    });
    const second = await writeDocumentBundle({
      directory,
      folder: "draft",
      sourceName: "draft.tex",
      source: "second",
      files: [],
    });
    expect(first.folder).toBe("draft");
    expect(second.folder).toBe("draft-2");
    expect(await readFile(join(directory, "draft", "draft.tex"), "utf8")).toBe("first");
  });
});
