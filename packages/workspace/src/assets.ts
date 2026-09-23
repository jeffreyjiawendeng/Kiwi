import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prettyJson, sha256 } from "./canonical-json.js";
import { isInsideRoot } from "./paths.js";
import {
  commitCanonical,
  withCanonicalWrite,
  type CanonicalEvent,
} from "./canonical-transaction.js";
import {
  OBJECT_SCHEMA_VERSION,
  canonicalObjectPath,
  listCanonicalObjects,
  readCanonicalObject,
  type CanonicalIds,
  type CanonicalObject,
} from "./objects.js";

export const ASSET_SCHEMA = "https://kiwi-research.org/schemas/object/asset/1-0-0.json";

export interface ManagedAssetObject extends CanonicalObject {
  $schema: typeof ASSET_SCHEMA;
  type: "asset";
  lifecycle: "active";
  original_filename: string;
  byte_size: number;
  sha256: string;
  media_type: {
    declared: string | null;
    determined: string;
    evidence: "signature" | "extension" | "text_probe" | "fallback";
  };
  storage: {
    disposition: "managed";
    relative_path: string;
  };
  availability: "available";
}

export interface ManagedAssetDuplicate {
  asset_id: string;
  title: string;
  sha256: string;
}

export interface ImportManagedAssetInput extends CanonicalIds {
  root: string;
  workspaceId: string;
  assetId: string;
  sourcePath: string;
  declaredMediaType: string | null;
  actor: string;
  requestId: string;
  now: string;
  signal?: AbortSignal;
  faultAfterTarget?: number;
}

export interface ImportManagedAssetReceipt {
  asset: ManagedAssetObject;
  duplicate_assets: ManagedAssetDuplicate[];
  copied_bytes: number;
  manifest_hash: string;
}

export class ManagedAssetImportError extends Error {
  constructor(
    readonly kind: "invalid_file" | "source_changed",
    message: string,
  ) {
    super(message);
    this.name = "ManagedAssetImportError";
  }
}

const MEDIA_BY_EXTENSION = new Map([
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
]);

function semantic(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy["content_hash"];
  return copy;
}

function sanitizedFilename(filename: string, assetId: string): string {
  const withoutControls = [...filename.normalize("NFC")]
    .map((character) => (character.codePointAt(0)! < 32 ? "_" : character))
    .join("");
  const normalized = withoutControls
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  const fallback = normalized === "" ? `asset-${assetId}` : normalized;
  const extension = extname(fallback);
  const stem = fallback.slice(0, fallback.length - extension.length).slice(0, 140);
  const candidate = `${stem}${extension.slice(0, 20)}`;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(candidate);
  return reserved ? `_${candidate}` : candidate;
}

function signatureType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-")
    return "application/pdf";
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

function detectedMediaType(
  filename: string,
  bytes: Uint8Array,
): Pick<ManagedAssetObject["media_type"], "determined" | "evidence"> {
  const signature = signatureType(bytes);
  if (signature !== null) return { determined: signature, evidence: "signature" };
  const extension = MEDIA_BY_EXTENSION.get(extname(filename).toLocaleLowerCase("en-US"));
  if (extension !== undefined) return { determined: extension, evidence: "extension" };
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { determined: "text/plain", evidence: "text_probe" };
    } catch {
      // Invalid UTF-8 is ordinary binary data, not a failed import.
    }
  }
  return { determined: "application/octet-stream", evidence: "fallback" };
}

async function sample(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(8192);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function stageAndHash(
  sourcePath: string,
  stagedPath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    hashing,
    createWriteStream(stagedPath, { flags: "wx" }),
    ...(signal === undefined ? [] : [{ signal }]),
  );
  const handle = await open(stagedPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

function isManagedAsset(value: CanonicalObject): value is ManagedAssetObject {
  return (
    value.type === "asset" &&
    typeof value["sha256"] === "string" &&
    typeof value["byte_size"] === "number" &&
    value["storage"] !== null &&
    typeof value["storage"] === "object"
  );
}

export async function readManagedAsset(
  root: string,
  assetId: string,
): Promise<ManagedAssetObject | null> {
  const found = await readCanonicalObject(root, assetId);
  return found !== null && isManagedAsset(found.object) ? found.object : null;
}

/**
 * Whether the bytes this asset stands for are on disk right now.
 *
 * `availability` is written once at import and says "available" forever after, because nothing
 * asks the object again. That is fine for the object, which records what the workspace did, and
 * useless as an answer to whether the file can be opened: the workspace root is an ordinary
 * folder that people back up, sync and tidy, and a file can leave it while Kiwi is not running.
 * So the question is asked of the disk each time rather than remembered.
 *
 * `lstat` and not `stat`: a link left where the imported file used to be is not that file, and
 * import refuses a link in the first place.
 */
export async function assetBytesOnDisk(root: string, asset: CanonicalObject): Promise<boolean> {
  const storage = asset["storage"];
  const relative =
    storage !== null && typeof storage === "object" && !Array.isArray(storage)
      ? (storage as Record<string, unknown>)["relative_path"]
      : undefined;
  if (typeof relative !== "string" || relative === "") return false;
  // Canonical files are readable and editable on disk by design, so a hand-edited path pointing
  // out of the workspace is reachable input. Nothing outside the root is this workspace's file.
  if (isAbsolute(relative) || /^[a-z]:/iu.test(relative)) return false;
  const absolute = join(root, relative);
  if (!isInsideRoot(root, absolute)) return false;
  const found = await lstat(absolute).catch(() => null);
  return found !== null && found.isFile();
}

/**
 * Which of these files the workspace no longer holds, in the order they were given.
 *
 * Returned beside a listing rather than folded into each object, so that nothing in the listing
 * claims to be a stored field when it is a fact about the disk a moment ago.
 */
export async function missingAssetFiles(
  root: string,
  assets: readonly CanonicalObject[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const asset of assets) {
    if (!(await assetBytesOnDisk(root, asset))) missing.push(asset.id);
  }
  return missing;
}

/**
 * Extensions the operating system runs rather than shows when a file is handed to it.
 *
 * Opening a file through the shell asks the system what it does with that kind of file, and for
 * these the answer is to execute it. A workspace folder is an ordinary folder that people sync
 * and share, so a file sitting in one is not necessarily a file this person chose, and the escape
 * hatch for reading a document must not double as a way to start a program.
 *
 * A deny list and not an allow list, because the point of the escape hatch is that it works on
 * whatever somebody imported. Anything refused here can still be revealed in its folder, where
 * opening it is that person's own deliberate act rather than a button in Kiwi.
 */
const RUNNABLE_EXTENSIONS = new Set([
  ".appref-ms",
  ".application",
  ".bat",
  ".chm",
  ".cmd",
  ".com",
  ".cpl",
  ".exe",
  ".gadget",
  ".hta",
  ".inf",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".msc",
  ".msi",
  ".msp",
  ".mst",
  ".pif",
  ".ps1",
  ".psm1",
  ".reg",
  ".scf",
  ".scr",
  ".sct",
  ".url",
  ".vbe",
  ".vbs",
  ".wsf",
  ".wsh",
]);

/**
 * Whether handing this path to the system would run it instead of showing it.
 *
 * Asked of the stored path and not of `original_filename`: the stored path is the one the system
 * is given, and it is the extension on that path that decides what happens to it.
 */
export function runsWhenOpened(relativePath: string): boolean {
  return RUNNABLE_EXTENSIONS.has(extname(relativePath).toLocaleLowerCase("en-US"));
}

export async function importManagedAsset(
  input: ImportManagedAssetInput,
): Promise<ImportManagedAssetReceipt> {
  return withCanonicalWrite(input.root, async () => {
    const before = await lstat(input.sourcePath);
    if (!before.isFile() || before.isSymbolicLink())
      throw new ManagedAssetImportError(
        "invalid_file",
        "The selected managed asset must be a regular file.",
      );
    const originalFilename = basename(input.sourcePath).normalize("NFC");
    if (originalFilename === "" || originalFilename.length > 255)
      throw new ManagedAssetImportError(
        "invalid_file",
        "The selected managed asset filename is not supported.",
      );
    const declared = input.declaredMediaType?.trim().toLocaleLowerCase("en-US") ?? null;
    if (
      declared !== null &&
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(declared)
    )
      throw new ManagedAssetImportError("invalid_file", "The declared media type is not valid.");

    const transactionRoot = join(input.root, ".kiwi", "transactions", input.transactionId);
    const acquiredPath = join(transactionRoot, "acquired", "original.data");
    await mkdir(join(transactionRoot, "acquired"), { recursive: true });
    let assetHash: string;
    try {
      assetHash = await stageAndHash(input.sourcePath, acquiredPath, input.signal);
      const after = await lstat(input.sourcePath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new ManagedAssetImportError(
          "source_changed",
          "The selected file changed while Kiwi was copying it. Choose it again.",
        );
    } catch (cause) {
      await rm(transactionRoot, { recursive: true, force: true });
      throw cause;
    }

    const storedName = sanitizedFilename(originalFilename, input.assetId);
    const storedPath = join("assets", input.assetId, storedName).replaceAll("\\", "/");
    const mediaType = detectedMediaType(originalFilename, await sample(acquiredPath));
    const duplicates = (await listCanonicalObjects(input.root))
      .filter(isManagedAsset)
      .filter((asset) => asset.sha256 === assetHash)
      .map((asset) => ({ asset_id: asset.id, title: asset.title, sha256: asset.sha256 }))
      .sort((left, right) => left.asset_id.localeCompare(right.asset_id));
    const asset = {
      $schema: ASSET_SCHEMA as typeof ASSET_SCHEMA,
      id: input.assetId,
      type: "asset" as const,
      schema_version: OBJECT_SCHEMA_VERSION,
      title: originalFilename,
      lifecycle: "active" as const,
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      updated_by: input.actor,
      version: 1,
      last_event_id: input.domainEventId,
      last_transaction_id: input.transactionId,
      sensitivity: "internal" as const,
      provenance: [
        {
          type: "managed_import",
          imported_at: input.now,
          command: "kiwi.asset.import-managed",
          origin: "local_file",
          original_filename: originalFilename,
        },
      ],
      tags: [],
      extensions: {},
      content: "",
      original_filename: originalFilename,
      byte_size: before.size,
      sha256: assetHash,
      media_type: { declared, ...mediaType },
      storage: { disposition: "managed" as const, relative_path: storedPath },
      availability: "available" as const,
    };
    const canonicalAsset: ManagedAssetObject = {
      ...asset,
      content_hash: sha256(semantic(asset)),
    };
    const serialized = prettyJson(canonicalAsset);
    const event: CanonicalEvent = {
      id: input.domainEventId,
      workspace_id: input.workspaceId,
      transaction_id: input.transactionId,
      schema_version: "1.0.0",
      event_type: "asset.imported_managed",
      occurred_at: input.now,
      recorded_at: input.now,
      actor: input.actor,
      origin: "ui",
      request_id: input.requestId,
      object_ids: [canonicalAsset.id],
      asset_sha256: assetHash,
      byte_size: before.size,
      stored_path: storedPath,
      duplicate_asset_ids: duplicates.map((duplicate) => duplicate.asset_id),
      snapshot: canonicalAsset,
    };
    const checkpointPath = join(".kiwi", "checkpoints", canonicalAsset.id, "00000001.json");
    try {
      await commitCanonical({
        root: input.root,
        workspaceId: input.workspaceId,
        transactionId: input.transactionId,
        now: input.now,
        actor: input.actor,
        origin: "ui",
        requestId: input.requestId,
        preparedEventId: input.preparedEventId,
        committedEventId: input.committedEventId,
        domainEvents: [event],
        targets: [
          { relativePath: storedPath, stagedFile: { path: acquiredPath, hash: assetHash } },
          { relativePath: canonicalObjectPath(canonicalAsset), after: serialized },
          { relativePath: checkpointPath, after: serialized },
        ],
        ...(input.faultAfterTarget === undefined
          ? {}
          : { faultAfterTarget: input.faultAfterTarget }),
      });
    } catch (cause) {
      if ((cause as Error).name === "AbortError")
        await rm(transactionRoot, { recursive: true, force: true });
      throw cause;
    }
    return {
      asset: canonicalAsset,
      duplicate_assets: duplicates,
      copied_bytes: before.size,
      manifest_hash: canonicalAsset.content_hash,
    };
  });
}
