import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPILE_LIMITS } from "@kiwi/contracts";

/**
 * The files a manuscript needs beside its source: figures, and the bibliography Kiwi writes.
 *
 * Compiling and exporting want the same bundle, assembled the same way, so they share this.
 * The renderer names an asset id and never a path; turning one into bytes happens here.
 */
export interface BundleFileRequest {
  name: string;
  asset_id?: unknown;
  text?: unknown;
}

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

/** A bibliography is written by Kiwi rather than imported, so it has no asset behind it. */
const TEXT_FILE_LIMIT = 4_000_000;

/**
 * The extension `\includegraphics` will look for.
 *
 * `documentToLatex` writes `\includegraphics{figure-abc}` without one, because graphicx picks
 * the extension itself from a list it knows. A file written with no extension at all is a file
 * graphicx cannot find, and the compile fails with "File `figure-abc' not found" on a document
 * that looks correct. The bytes say what the picture is, so they decide the name.
 */
export function figureExtension(bytes: Uint8Array): string {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return ".png";
  if (starts(0xff, 0xd8, 0xff)) return ".jpg";
  if (starts(0x25, 0x50, 0x44, 0x46)) return ".pdf";
  if (starts(0x47, 0x49, 0x46, 0x38)) return ".gif";
  // SVG arrives as text, and either an XML declaration or the root element may come first.
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return ".svg";
  return "";
}

/** A name that is safe to write into a directory that TeX will also read. */
function safeFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}

/**
 * Reads every file a bundle asks for, dropping the ones it cannot.
 *
 * A figure that cannot be read is skipped rather than failing the whole export: a manuscript
 * with nine figures and one broken asset is still worth exporting, and the caller reports what
 * was left out.
 */
export async function resolveBundleFiles(
  requested: unknown,
  readAsset: (assetId: string) => Promise<Uint8Array>,
): Promise<{ files: BundleFile[]; missing: string[] }> {
  const entries = Array.isArray(requested) ? requested : [];
  const files: BundleFile[] = [];
  const missing: string[] = [];
  for (const entry of entries.slice(0, COMPILE_LIMITS.files)) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, asset_id: assetId, text } = entry as BundleFileRequest;
    if (typeof name !== "string" || !safeFileName(name)) continue;
    if (typeof text === "string") {
      if (text.length > TEXT_FILE_LIMIT) continue;
      files.push({ name, bytes: Buffer.from(text, "utf8") });
      continue;
    }
    if (typeof assetId !== "string") continue;
    const bytes = await readAsset(assetId).catch(() => null);
    if (bytes === null) {
      missing.push(name);
      continue;
    }
    files.push({ name: `${name}${figureExtension(bytes)}`, bytes });
  }
  return { files, missing };
}

/**
 * The folder one exported manuscript goes in.
 *
 * A LaTeX bundle is several files that only make sense together, so it gets a folder of its own
 * inside whatever directory the person chose. Titles reach a file name here, so anything a file
 * name cannot hold is replaced rather than removed, removing it silently merges two different
 * manuscripts onto one name.
 */
export function exportFolderName(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return cleaned === "" ? "manuscript" : cleaned.toLowerCase();
}

export interface WrittenBundle {
  folder: string;
  files: string[];
}

/**
 * Writes a source file and its bundle into a new folder, and says what it wrote.
 *
 * The folder is created with `recursive: false` on purpose. Exporting twice into the same place
 * would otherwise overwrite the first export without saying so, and an export a person cannot
 * tell apart from the one before it is worse than an error.
 */
export async function writeDocumentBundle(input: {
  directory: string;
  folder: string;
  sourceName: string;
  source: string;
  files: BundleFile[];
}): Promise<WrittenBundle> {
  let folder = "";
  let target = "";
  for (let attempt = 1; attempt <= 100 && folder === ""; attempt += 1) {
    const candidate = attempt === 1 ? input.folder : `${input.folder}-${String(attempt)}`;
    try {
      await mkdir(join(input.directory, candidate));
      folder = candidate;
      target = join(input.directory, candidate);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  if (folder === "") throw new Error("Kiwi could not find a free folder name for this export.");
  await writeFile(join(target, input.sourceName), input.source, "utf8");
  const written = [input.sourceName];
  for (const file of input.files) {
    if (!safeFileName(file.name)) continue;
    await writeFile(join(target, file.name), file.bytes);
    written.push(file.name);
  }
  return { folder, files: written };
}
