import { readFile } from "node:fs/promises";

export const SELECTION_SCHEME = "kiwi-selection";

/**
 * Serves a file somebody picked but has not imported yet.
 *
 * An import shows what it is about to commit before it commits it, and for a PDF that means
 * reading the file: the title on its first page, what its info dictionary claims, whether it
 * opens at all. That reading happens in the renderer, on PDF.js, and PDF.js is given a URL. The
 * asset scheme cannot supply one, because it addresses a file by the id it was given when it was
 * recorded in a workspace, and a file waiting to be reviewed has not been recorded anywhere.
 *
 *     kiwi-selection://pending/<selection-id>
 *
 * So this is the same trade the asset scheme makes, one step earlier. The renderer holds an
 * identifier and never a path; the main process is the only thing that turns one into the other.
 * The identifier is the same single-use handle the file picker already issues, which means the
 * address stops working ten minutes after the file was chosen, and stops working immediately once
 * the import takes it -- a thing that has been imported has an asset id, and should be asked for
 * by that.
 *
 * Two smaller decisions. The bytes are served as bytes and not as whatever the file's name
 * claimed, because nothing has determined what they are yet: determining that is part of
 * importing, and this runs before it. And the answer is never cached. An asset's bytes cannot
 * change, so the asset scheme lets them be held forever; a file sitting in somebody's folder can
 * change under the review that is reading it, and a stale copy would be a review of the wrong
 * thing.
 */

/** What the broker knows about a file that has been picked and not yet taken. */
export interface PendingSelection {
  path: string;
  declaredMediaType: string | null;
}

export interface SelectionProtocolOptions {
  /** Resolves an identifier to the file it stands for, without spending it. */
  peek(selectionId: string): PendingSelection | null;
  /** The one origin allowed to read it: the window's own. See the asset scheme for why. */
  allowOrigin: string;
  readBytes?: (path: string) => Promise<Uint8Array>;
}

/**
 * The only host the scheme answers on.
 *
 * A standard scheme has to have one, and naming what the address space is leaves room for a second
 * kind of thing to be served later without either of them having to guess which it is looking at.
 */
const PENDING_HOST = "pending";

export function createSelectionResponder(
  options: SelectionProtocolOptions,
): (url: string) => Promise<Response> {
  const readBytes = options.readBytes ?? ((path: string) => readFile(path));

  return async function respond(url: string): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (parsed.hostname !== PENDING_HOST) return new Response("Not found", { status: 404 });

    const selectionId = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
    if (selectionId === "") return new Response("Not found", { status: 404 });

    // An identifier that has expired, been spent, or never existed are one answer here. They are
    // the same answer on purpose: what the renderer does about it is open the file again, and it
    // would do that either way.
    const selection = options.peek(selectionId);
    if (selection === null) return new Response("Not found", { status: 404 });

    try {
      // The file was checked when it was picked -- a plain file, not a symbolic link. Checking
      // again here would not close the gap between the two, since the read follows whatever the
      // path names at the moment it runs, and the picker is where that judgement belongs.
      const bytes = await readBytes(selection.path);
      // Response wants an ArrayBuffer-backed body; a Node Buffer view is not one.
      const body = new Uint8Array(bytes).buffer as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "access-control-allow-origin": options.allowOrigin,
        },
      });
    } catch {
      // A file that has moved or been deleted since it was picked. The import has to survive one
      // of those without the person having to work out which of thirty files it was.
      return new Response("Not found", { status: 404 });
    }
  };
}
