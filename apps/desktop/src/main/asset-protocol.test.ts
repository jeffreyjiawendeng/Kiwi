import { describe, expect, it, vi } from "vitest";
import { createAssetResponder, type AssetRecord } from "./asset-protocol.js";

const ROOT = process.platform === "win32" ? "C:\\workspaces\\alpha" : "/workspaces/alpha";
const WORKSPACE = "workspace-1";
const ASSET = "asset-1";

function responder(
  overrides: {
    rootFor?: (workspaceId: string) => string | null;
    asset?: AssetRecord | null;
    readBytes?: (path: string) => Promise<Uint8Array>;
  } = {},
) {
  const readBytes =
    overrides.readBytes ?? vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  const respond = createAssetResponder({
    allowOrigin: "kiwi-app://kiwi",
    rootFor: overrides.rootFor ?? ((id) => (id === WORKSPACE ? ROOT : null)),
    readAsset: async () =>
      overrides.asset === undefined
        ? { relativePath: "assets/paper.pdf", mediaType: "application/pdf" }
        : overrides.asset,
    readBytes,
  });
  return { respond, readBytes };
}

describe("asset protocol", () => {
  it("serves an imported file with the media type the import determined", async () => {
    const { respond } = responder();
    const response = await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
  });

  it("refuses a workspace that is not open in this process", async () => {
    const { respond, readBytes } = responder();
    const response = await respond(`kiwi-asset://workspace-elsewhere/${ASSET}`);

    expect(response.status).toBe(404);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a recorded asset", async () => {
    const { respond, readBytes } = responder({ asset: null });
    expect((await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`)).status).toBe(404);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("refuses a stored path that escapes the workspace", async () => {
    // Canonical files are editable on disk by design, so the path inside an asset object is
    // untrusted input. Someone can type ../../ into it with a text editor.
    const { respond, readBytes } = responder({
      asset: { relativePath: "../../../.ssh/id_rsa", mediaType: "application/pdf" },
    });

    const response = await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`);
    expect(response.status).toBe(403);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("refuses an absolute stored path", async () => {
    const escape = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const { respond, readBytes } = responder({
      asset: { relativePath: escape, mediaType: "application/pdf" },
    });

    expect((await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`)).status).toBe(403);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("does not echo an arbitrary media type into the response header", async () => {
    // The media type is also read out of an editable file, so it cannot be trusted into a
    // header where a newline would let it inject one of its own.
    for (const hostile of ["text/html\r\nX-Evil: 1", "not a media type", ""]) {
      const { respond } = responder({
        asset: { relativePath: "assets/paper.pdf", mediaType: hostile },
      });
      const response = await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
    }
  });

  it("serves the bytes with a policy that keeps the file inert", async () => {
    const { respond } = responder();
    const response = await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`);
    // A PDF is data, not a document that may load anything of its own.
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("lets the window's own origin read it, and names no other", async () => {
    // The window is a page on the application scheme and this is another scheme, so every read
    // is a cross-origin request. Without this header the browser refuses the response and no
    // document opens at all.
    const { respond } = responder();
    const response = await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`);

    expect(response.headers.get("access-control-allow-origin")).toBe("kiwi-app://kiwi");
  });

  it("reports a missing file rather than failing the request", async () => {
    const { respond } = responder({
      readBytes: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    expect((await respond(`kiwi-asset://${WORKSPACE}/${ASSET}`)).status).toBe(404);
  });

  it("rejects a malformed request without throwing", async () => {
    const { respond } = responder();
    for (const url of ["not a url", "kiwi-asset://", `kiwi-asset://${WORKSPACE}/`]) {
      expect((await respond(url)).status).toBe(404);
    }
  });

  it("decodes an id that arrived percent-encoded", async () => {
    const seen: string[] = [];
    const respond = createAssetResponder({
      allowOrigin: "kiwi-app://kiwi",
      rootFor: () => ROOT,
      readAsset: async (_root, assetId) => {
        seen.push(assetId);
        return { relativePath: "assets/paper.pdf", mediaType: "application/pdf" };
      },
      readBytes: async () => new Uint8Array([1]),
    });
    await respond(`kiwi-asset://${WORKSPACE}/asset%2Done`);
    expect(seen).toEqual(["asset-one"]);
  });
});
