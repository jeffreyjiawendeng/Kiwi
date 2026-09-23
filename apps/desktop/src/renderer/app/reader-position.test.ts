import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markOpened,
  pageOffsetFraction,
  readerPositionKey,
  readReaderPosition,
  scrollTopForOffset,
  writeReaderPosition,
} from "./reader-position.js";
import type { RendererBridge } from "./bridge.js";

const KEY = readerPositionKey("workspace-1", "asset-1");

afterEach(() => {
  window.localStorage.clear();
  delete window.kiwiDesktop;
  vi.restoreAllMocks();
});

describe("where a document was left", () => {
  it("writes the page and how far down it, and reads them back", () => {
    writeReaderPosition("workspace-1", "asset-1", { page: 12, offset: 0.4 });

    expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 12, offset: 0.4 });
  });

  it("still understands a page number written before offsets existed", () => {
    // Somebody who left a paper on page 40 last week should not be sent back to the start
    // because the format grew a second field.
    window.localStorage.setItem(KEY, "40");

    expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 40, offset: 0 });
  });

  it("starts at the top rather than trusting nonsense", () => {
    for (const stored of ["", "not a page", "{", '{"page":0}', '{"page":-3,"offset":0.5}']) {
      window.localStorage.setItem(KEY, stored);
      expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 1, offset: 0 });
    }
  });

  it("keeps the offset inside the page it is a fraction of", () => {
    window.localStorage.setItem(KEY, '{"page":3,"offset":7}');
    expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 3, offset: 1 });

    writeReaderPosition("workspace-1", "asset-1", { page: 3, offset: -2 });
    expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 3, offset: 0 });
  });

  it("reads and writes nothing on a machine with storage turned off", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage is disabled.");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage is disabled.");
    });

    // A document still opens. It just opens at the top.
    expect(readReaderPosition("workspace-1", "asset-1")).toEqual({ page: 1, offset: 0 });
    expect(() =>
      writeReaderPosition("workspace-1", "asset-1", { page: 4, offset: 0.2 }),
    ).not.toThrow();
  });

  it("measures and restores an offset as a fraction of the page", () => {
    // Half a 1000-pixel page has gone past the top of the window.
    expect(pageOffsetFraction(1700, 1200, 1000)).toBe(0.5);
    // The same fraction of a page drawn twice as tall is twice as far down, which is the whole
    // reason this is not stored in pixels.
    expect(scrollTopForOffset(2400, 2000, 0.5)).toBe(3400);
  });

  it("answers zero for a page nothing has measured yet", () => {
    // A page that has not been drawn has no height, and a fraction of an unknown height would
    // put the reader somewhere arbitrary.
    expect(pageOffsetFraction(500, 0, 0)).toBe(0);
    expect(scrollTopForOffset(1200, 0, 0.5)).toBe(1200);
  });
});

describe("noting that an item was opened", () => {
  it("tells the machine's index, naming the item and nothing else", async () => {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "opened",
      status: "committed",
      data: {},
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    await markOpened("workspace-1", "object-1");

    const [envelope] = invokeCommand.mock.calls[0] as unknown as [
      { command: string; args: Record<string, unknown> },
    ];
    expect(envelope.command).toBe("kiwi.projection.mark-opened");
    // No path, no time. The renderer names the item; the main process supplies the rest.
    expect(envelope.args).toEqual({ object_id: "object-1" });
  });

  it("says nothing when the index will not take it", async () => {
    const invokeCommand = vi.fn(async () => {
      throw new Error("The index is busy.");
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    // It feeds one optional column. A Reader that refused to open a paper because it could not
    // write down that the paper was opened would have its priorities backwards.
    await expect(markOpened("workspace-1", "object-1")).resolves.toBeUndefined();
  });
});
