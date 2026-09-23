import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isInsideRoot, readCanonicalObject } from "@kiwi/workspace";

export const ASSET_SCHEME = "kiwi-asset";

/**
 * Serves an imported file to the renderer.
 *
 * The renderer cannot reach the network at all, and it should not be able to name a path in any
 * case. So a request addresses an asset by its id, and the main process is the only thing that
 * ever turns an id into a path.
 *
 *     kiwi-asset://<workspace-id>/<asset-id>
 *
 * Two checks matter. The asset must be a real `asset` object recorded in that workspace, and the
 * path it carries must still resolve inside the workspace root. The second check is not
 * redundant: canonical files are readable and editable on disk by design, so a hand-edited
 * `relative_path` of `../../../.ssh/id_rsa` is reachable input, not a hypothetical.
 */
export interface AssetProtocolOptions {
  /** Resolves an open workspace to its root, or null when it is not open in this process. */
  rootFor(workspaceId: string): string | null;
  /**
   * The one origin allowed to read an asset: the window's own.
   *
   * A document is fetched from a page on another scheme, which makes it a cross-origin request
   * whatever the two schemes belong to, so the response has to say which origin may read it.
   * Naming the window's origin rather than `*` keeps it to this application.
   */
  allowOrigin: string;
  readAsset?: (root: string, assetId: string) => Promise<AssetRecord | null>;
  readBytes?: (path: string) => Promise<Uint8Array>;
}

export interface AssetRecord {
  relativePath: string;
  mediaType: string;
}

async function readAssetRecord(root: string, assetId: string): Promise<AssetRecord | null> {
  const found = await readCanonicalObject(root, assetId);
  if (found === null || found.object.type !== "asset") return null;
  const storage = found.object["storage"];
  const media = found.object["media_type"];
  const relativePath =
    storage !== null && typeof storage === "object" && !Array.isArray(storage)
      ? (storage as Record<string, unknown>)["relative_path"]
      : undefined;
  const determined =
    media !== null && typeof media === "object" && !Array.isArray(media)
      ? (media as Record<string, unknown>)["determined"]
      : undefined;
  if (typeof relativePath !== "string" || relativePath === "") return null;
  return {
    relativePath,
    mediaType:
      typeof determined === "string" && determined !== "" ? determined : "application/octet-stream",
  };
}

/** A media type is echoed into a response header, so it may not carry one. */
function safeMediaType(value: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu.test(value)
    ? value
    : "application/octet-stream";
}

export function createAssetResponder(
  options: AssetProtocolOptions,
): (url: string) => Promise<Response> {
  const readAsset = options.readAsset ?? readAssetRecord;
  const readBytes = options.readBytes ?? ((path: string) => readFile(path));

  return async function respond(url: string): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const workspaceId = parsed.hostname;
    const assetId = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
    if (workspaceId === "" || assetId === "") return new Response("Not found", { status: 404 });

    const root = options.rootFor(workspaceId);
    if (root === null) return new Response("Not found", { status: 404 });

    const record = await readAsset(root, assetId).catch(() => null);
    if (record === null) return new Response("Not found", { status: 404 });

    // `join` would quietly fold an absolute path into the root and produce a nonsense path
    // rather than escaping, so rejecting it outright says what is meant and does not depend
    // on that behaviour holding on every platform.
    if (isAbsolute(record.relativePath) || /^[a-z]:/iu.test(record.relativePath)) {
      return new Response("Forbidden", { status: 403 });
    }
    const absolute = join(root, record.relativePath);
    if (!isInsideRoot(root, absolute)) return new Response("Forbidden", { status: 403 });

    try {
      const bytes = await readBytes(absolute);
      // Response wants an ArrayBuffer-backed body; a Node Buffer view is not one.
      const body = new Uint8Array(bytes).buffer as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": safeMediaType(record.mediaType),
          // The bytes are immutable: an asset is addressed by an id that is only ever
          // written once, and importing a changed file produces a different asset.
          "cache-control": "private, max-age=31536000, immutable",
          "content-security-policy": "default-src 'none'; sandbox",
          "access-control-allow-origin": options.allowOrigin,
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

/**
 * Reads an imported file by id, for callers inside the main process.
 *
 * The compile bundle needs the bytes of every figure, and it needs them by asset id for the
 * same reason the renderer does: an id can be checked against the workspace, a path cannot.
 */
export async function readWorkspaceAsset(root: string, assetId: string): Promise<Uint8Array> {
  const record = await readAssetRecord(root, assetId);
  if (record === null) throw new Error("Asset not found.");
  if (isAbsolute(record.relativePath) || /^[a-z]:/iu.test(record.relativePath)) {
    throw new Error("Asset path is not inside the workspace.");
  }
  const absolute = join(root, record.relativePath);
  if (!isInsideRoot(root, absolute)) throw new Error("Asset path is not inside the workspace.");
  return readFile(absolute);
}
