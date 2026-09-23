import { describe, expect, it, vi } from "vitest";
import { createSelectionResponder, type PendingSelection } from "./selection-protocol.js";

const PICKED: PendingSelection = {
  path: "C:\\Research\\private\\paper.pdf",
  declaredMediaType: "application/pdf",
};

/** A responder over one picked file, with everything else unknown. */
function responderFor(
  selections: Record<string, PendingSelection>,
  readBytes?: (path: string) => Promise<Uint8Array>,
) {
  return createSelectionResponder({
    allowOrigin: "kiwi-app://kiwi",
    peek: (id) => selections[id] ?? null,
    readBytes: readBytes ?? (async () => new TextEncoder().encode("%PDF-1.7\n")),
  });
}

describe("selection protocol", () => {
  it("serves the bytes of the file an identifier stands for", async () => {
    const readBytes = vi.fn(async () => new TextEncoder().encode("%PDF-1.7\n"));

    const response = await responderFor(
      { "selection-1": PICKED },
      readBytes,
    )("kiwi-selection://pending/selection-1");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-1.7\n");
    expect(readBytes).toHaveBeenCalledWith("C:\\Research\\private\\paper.pdf");
  });

  it("says nothing about where the file is", async () => {
    // The whole point of the identifier. A response that leaked the path would hand the renderer
    // the one thing the picker exists to keep from it.
    const response = await responderFor({ "selection-1": PICKED })(
      "kiwi-selection://pending/selection-1",
    );

    for (const [, value] of response.headers) expect(value).not.toContain("Research");
  });

  it("serves the bytes as bytes, whatever the name claimed", async () => {
    // Nothing has determined what this file is yet: determining that is part of importing it.
    const response = await responderFor({ "selection-1": PICKED })(
      "kiwi-selection://pending/selection-1",
    );

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("does not let a picked file be held on to", async () => {
    // A file in somebody's folder can change under the review that is reading it, unlike an
    // asset, whose bytes are fixed the moment it is recorded.
    const response = await responderFor({ "selection-1": PICKED })(
      "kiwi-selection://pending/selection-1",
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("refuses an identifier it does not know, which an expired one also is", async () => {
    const response = await responderFor({})("kiwi-selection://pending/selection-1");

    expect(response.status).toBe(404);
  });

  it("refuses an address on any other host", async () => {
    const respond = responderFor({ "selection-1": PICKED });

    expect((await respond("kiwi-selection://workspace-1/selection-1")).status).toBe(404);
    expect((await respond("kiwi-selection://pending/")).status).toBe(404);
  });

  it("refuses something that is not an address at all", async () => {
    expect((await responderFor({ "selection-1": PICKED })("not a url")).status).toBe(404);
  });

  it("refuses a file that has gone since it was picked", async () => {
    const respond = responderFor({ "selection-1": PICKED }, async () => {
      throw new Error("ENOENT");
    });

    expect((await respond("kiwi-selection://pending/selection-1")).status).toBe(404);
  });

  it("reads the identifier as it was written, not as the URL encoded it", async () => {
    const peek = vi.fn(() => PICKED);
    const respond = createSelectionResponder({
      allowOrigin: "kiwi-app://kiwi",
      peek,
      readBytes: async () => new Uint8Array(),
    });

    await respond("kiwi-selection://pending/selection%2Fone");

    expect(peek).toHaveBeenCalledWith("selection/one");
  });
});
