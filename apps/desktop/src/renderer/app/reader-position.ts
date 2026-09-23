import { readBridge } from "./bridge.js";

/**
 * Where you were in a document, and the note that you were there at all.
 *
 * Two records of the same act of reading, kept in two places on purpose. The place in the
 * document is one person's business on one machine and never leaves the browser storage of the
 * window that wrote it: it is worthless to anybody else, and a scroll offset syncing between
 * collaborators would be an odd thing to explain. The fact that the item was opened goes to the
 * machine's own index instead, because the Library sorts a column by it and a sort runs in
 * SQLite, which cannot see browser storage.
 *
 * Neither is workspace state. Nothing written here changes a file, and a workspace copied to
 * another computer arrives with no reading history at all, which is the honest answer: that
 * computer has not read anything.
 */

export interface ReaderPosition {
  /** The page that was in view, counted from one. */
  page: number;
  /**
   * How far down that page, as a fraction of its height.
   *
   * A fraction and not a pixel count, because the same passage sits at a different pixel offset
   * at a different zoom, and reopening a paper at 200% should not land a screen and a half from
   * where it was left.
   */
  offset: number;
}

export const READER_START: ReaderPosition = { page: 1, offset: 0 };

export function readerPositionKey(workspaceId: string, assetId: string): string {
  return `kiwi.reader.${workspaceId}.${assetId}`;
}

function clampOffset(value: unknown): number {
  const offset = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(offset, 0), 1);
}

/**
 * Reads back a saved place, and takes the top of page one over anything it cannot make sense of.
 *
 * A bare number is what the Reader used to write, before it remembered anything but the page,
 * so it is still read as one: somebody who left a paper on page 40 last week should not be sent
 * back to the start because the format grew a second field.
 */
export function readReaderPosition(workspaceId: string, assetId: string): ReaderPosition {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(readerPositionKey(workspaceId, assetId));
  } catch {
    return READER_START;
  }
  if (raw === null) return READER_START;
  const legacy = Number.parseInt(raw, 10);
  const parsed: unknown = raw.trimStart().startsWith("{")
    ? ((): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })()
    : { page: legacy, offset: 0 };
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const page = typeof record["page"] === "number" ? record["page"] : Number.NaN;
  if (!Number.isInteger(page) || page < 1) return READER_START;
  return { page, offset: clampOffset(record["offset"]) };
}

export function writeReaderPosition(
  workspaceId: string,
  assetId: string,
  position: ReaderPosition,
): void {
  try {
    window.localStorage.setItem(
      readerPositionKey(workspaceId, assetId),
      JSON.stringify({ page: position.page, offset: clampOffset(position.offset) }),
    );
  } catch {
    // A machine with storage turned off still reads documents. It just starts each one at the top.
  }
}

/**
 * How far into the page the window has scrolled, given where the page starts.
 *
 * Zero for a page whose height nothing has measured yet, which in practice means a page that has
 * not been drawn. Guessing at a fraction of an unknown height would put the reader somewhere
 * arbitrary; the top of the right page is at least right about the page.
 */
export function pageOffsetFraction(scrollTop: number, pageTop: number, pageHeight: number): number {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return 0;
  return clampOffset((scrollTop - pageTop) / pageHeight);
}

/** The scroll position that puts a saved offset back where it was. */
export function scrollTopForOffset(pageTop: number, pageHeight: number, offset: number): number {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return pageTop;
  return pageTop + clampOffset(offset) * pageHeight;
}

/**
 * Tells the machine's index that this item has just been opened.
 *
 * Nothing waits on it and nothing reports it failing. It feeds one optional column; a Reader that
 * refused to open a paper because it could not write down that the paper was opened would have
 * its priorities backwards.
 */
export async function markOpened(workspaceId: string, objectId: string): Promise<void> {
  const bridge = readBridge();
  if (bridge === null) return;
  const requestId = crypto.randomUUID();
  try {
    await bridge.invokeCommand({
      protocol_version: "1.0.0",
      request_id: requestId,
      idempotency_key: requestId,
      workspace_id: workspaceId,
      command: "kiwi.projection.mark-opened",
      args: { object_id: objectId },
    });
  } catch {
    // See above.
  }
}
