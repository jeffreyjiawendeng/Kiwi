import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  WINDOW_ACTIONS,
  CAPTURED_ASSET_LIMIT,
  isAllowedWindowAction,
  readCapturedAssetRequest,
  readDocumentExportRequest,
  readDroppedAssetRequest,
  readLibraryExportRequest,
  readReferenceImportRequest,
  readWorkspaceCreateRequest,
  readWorkspacePresenceRequest,
  presenceSequence,
} from "./ipc.js";

describe("window action validation", () => {
  it.each(WINDOW_ACTIONS)("accepts %s", (action) => {
    expect(isAllowedWindowAction(action)).toBe(true);
  });

  it.each([
    "quit",
    "openDevTools",
    "",
    "MINIMIZE",
    null,
    undefined,
    42,
    { action: "close" },
    ["close"],
  ])("rejects %o", (value) => {
    expect(isAllowedWindowAction(value)).toBe(false);
  });
});

describe("dropped asset request", () => {
  it("accepts only the preload-resolved path and optional browser media type", () => {
    expect(
      readDroppedAssetRequest({
        path: "C:\\Research\\notes.txt",
        declaredMediaType: "text/plain",
      }),
    ).toEqual({ path: "C:\\Research\\notes.txt", declaredMediaType: "text/plain" });
    expect(
      readDroppedAssetRequest({
        path: "C:\\Research\\notes.txt",
        declaredMediaType: null,
        root: "C:\\untrusted",
      }),
    ).toBeNull();
    expect(readDroppedAssetRequest({ path: "", declaredMediaType: null })).toBeNull();
  });
});

describe("ipc channels", () => {
  it("uses a namespaced prefix for every channel", () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel.startsWith("kiwi:")).toBe(true);
    }
  });

  it("declares no duplicate channel names", () => {
    const names = Object.values(IPC_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("workspace create request", () => {
  it("accepts the folder selection and visible title", () => {
    expect(readWorkspaceCreateRequest({ selectionId: "selection-1", title: "Trial" })).toEqual({
      selectionId: "selection-1",
      title: "Trial",
    });
  });

  it.each([
    null,
    {},
    { selectionId: "", title: "Trial" },
    { selectionId: "selection-1", title: "   " },
    { selectionId: "selection-1", title: "Trial", root: "C:\\untrusted" },
  ])("rejects %o", (value) => {
    expect(readWorkspaceCreateRequest(value)).toBeNull();
  });
});

describe("captured assets", () => {
  const PNG = "iVBORw0KGgo=";

  it("accepts a cropped page image", () => {
    expect(readCapturedAssetRequest({ bytes: PNG, name: "page-1.png" })).toEqual({
      bytes: PNG,
      name: "page-1.png",
    });
  });

  it("refuses a name that is not one a capture produces", () => {
    // The name becomes a file on disk, so only what the Reader generates is allowed through.
    for (const name of ["../escape.png", "page-1.exe", "page 1", ".png", ""]) {
      expect(readCapturedAssetRequest({ bytes: PNG, name })).toBeNull();
    }
  });

  it("refuses anything that is not base64", () => {
    expect(readCapturedAssetRequest({ bytes: "not base64!", name: "page-1.png" })).toBeNull();
  });

  it("refuses a payload larger than a page crop could be", () => {
    expect(
      readCapturedAssetRequest({ bytes: "A".repeat(CAPTURED_ASSET_LIMIT + 4), name: "a.png" }),
    ).toBeNull();
  });

  it("refuses a request carrying anything extra", () => {
    expect(
      readCapturedAssetRequest({ bytes: PNG, name: "page-1.png", path: "C:/secrets" }),
    ).toBeNull();
  });

  it("refuses a request that is not an object", () => {
    expect(readCapturedAssetRequest(null)).toBeNull();
    expect(readCapturedAssetRequest(["bytes"])).toBeNull();
    expect(readCapturedAssetRequest({ bytes: 7, name: "a.png" })).toBeNull();
  });
});

describe("export requests", () => {
  const base = { workspace_id: "ws-1", title: "A paper", files: [] };

  it("refuses a LaTeX export with nothing to write", () => {
    expect(readDocumentExportRequest({ ...base, format: "tex", source: "   " })).toBeNull();
  });

  it("refuses a Word export with no document, which is what a source manuscript has", () => {
    expect(readDocumentExportRequest({ ...base, format: "docx", source: "" })).toBeNull();
  });

  it("takes the tree, the reference list, and the labels for a Word export", () => {
    const request = readDocumentExportRequest({
      ...base,
      format: "docx",
      source: "",
      document: { type: "doc", content: [] },
      references: ["Smith, J. (2019)."],
      citation_labels: { "obj-1": "(Smith, 2019)" },
    });
    expect(request?.references).toEqual(["Smith, J. (2019)."]);
    expect(request?.citation_labels).toEqual({ "obj-1": "(Smith, 2019)" });
  });

  it("drops labels that are not strings rather than passing them on", () => {
    const request = readDocumentExportRequest({
      ...base,
      format: "docx",
      source: "",
      document: {},
      references: ["fine", 7],
      citation_labels: { good: "(A)", bad: { nested: true } },
    });
    expect(request?.references).toEqual(["fine"]);
    expect(request?.citation_labels).toEqual({ good: "(A)" });
  });

  it("refuses a format it does not write", () => {
    expect(readDocumentExportRequest({ ...base, format: "odt", source: "x" })).toBeNull();
  });
});

describe("library export requests", () => {
  const base = { workspace_id: "workspace-1", format: "bibtex", object_ids: ["paper-1"] };

  it("takes a request naming the Papers and the format", () => {
    expect(readLibraryExportRequest(base)).toEqual(base);
  });

  it("reads no chosen Papers as the whole library rather than as a refusal", () => {
    expect(readLibraryExportRequest({ workspace_id: "workspace-1", format: "ris" })).toEqual({
      workspace_id: "workspace-1",
      format: "ris",
      object_ids: [],
    });
  });

  it("refuses a format it does not write", () => {
    expect(readLibraryExportRequest({ ...base, format: "endnote" })).toBeNull();
    expect(readLibraryExportRequest({ ...base, format: 7 })).toBeNull();
  });

  it("refuses a request with no workspace", () => {
    expect(readLibraryExportRequest({ ...base, workspace_id: "" })).toBeNull();
    expect(readLibraryExportRequest(null)).toBeNull();
  });

  it("drops an id that is not a string rather than passing it on", () => {
    expect(readLibraryExportRequest({ ...base, object_ids: ["paper-1", 7] })?.object_ids).toEqual([
      "paper-1",
    ]);
  });
});

describe("reference import requests", () => {
  it("takes the identifier out, so the path can be put in", () => {
    const request = readReferenceImportRequest({ selection_id: "selection-1" });
    expect(request).toEqual({ status: "ready", selectionId: "selection-1", args: {} });
  });

  it("leaves the rest of the arguments where they were", () => {
    const request = readReferenceImportRequest({
      selection_id: "selection-1",
      project_id: "project-1",
    });
    expect(request).toEqual({
      status: "ready",
      selectionId: "selection-1",
      args: { project_id: "project-1" },
    });
  });

  it("passes a request with no file through untouched", () => {
    const entries = [{ title: "A corrected row" }];
    expect(readReferenceImportRequest({ entries })).toEqual({
      status: "ready",
      selectionId: null,
      args: { entries },
    });
  });

  it("refuses a path the renderer named itself", () => {
    expect(readReferenceImportRequest({ source_path: "C:/Users/someone/library.bib" })).toEqual({
      status: "path_named",
    });
  });

  it("refuses a path even alongside a proper selection, rather than preferring one", () => {
    expect(
      readReferenceImportRequest({ selection_id: "selection-1", source_path: "/etc/passwd" }),
    ).toEqual({ status: "path_named" });
  });

  it("refuses an identifier that is not one", () => {
    expect(readReferenceImportRequest({ selection_id: "" })).toEqual({ status: "malformed" });
    expect(readReferenceImportRequest({ selection_id: 7 })).toEqual({ status: "malformed" });
    expect(readReferenceImportRequest({ selection_id: "x".repeat(101) })).toEqual({
      status: "malformed",
    });
  });

  it("refuses arguments that are not arguments", () => {
    expect(readReferenceImportRequest(null)).toEqual({ status: "malformed" });
    expect(readReferenceImportRequest("library.bib")).toEqual({ status: "malformed" });
    expect(readReferenceImportRequest([{ selection_id: "selection-1" }])).toEqual({
      status: "malformed",
    });
  });

  it("reads a request with no arguments at all as one with nothing in it", () => {
    expect(readReferenceImportRequest(undefined)).toEqual({
      status: "ready",
      selectionId: null,
      args: {},
    });
  });
});

describe("presence requests", () => {
  it("takes the document and the caret, which is all a poll says", () => {
    expect(readWorkspacePresenceRequest({ documentId: "doc-1", cursor: 42 })).toEqual({
      documentId: "doc-1",
      cursor: 42,
    });
  });

  it("refuses a workspace named by the renderer, so the session is the only source of one", () => {
    expect(
      readWorkspacePresenceRequest({ documentId: "doc-1", cursor: 0, workspaceId: "elsewhere" }),
    ).toBeNull();
  });

  it("refuses a caret that is not a place in a document", () => {
    expect(readWorkspacePresenceRequest({ documentId: "doc-1", cursor: -1 })).toBeNull();
    expect(readWorkspacePresenceRequest({ documentId: "doc-1", cursor: 1.5 })).toBeNull();
    expect(readWorkspacePresenceRequest({ documentId: "doc-1", cursor: "0" })).toBeNull();
  });

  it("refuses a request with no document to be present in", () => {
    expect(readWorkspacePresenceRequest({ documentId: "", cursor: 0 })).toBeNull();
    expect(readWorkspacePresenceRequest({ cursor: 0 })).toBeNull();
    expect(readWorkspacePresenceRequest(null)).toBeNull();
    expect(readWorkspacePresenceRequest(["doc-1"])).toBeNull();
  });
});

describe("the sequence a presence poll carries", () => {
  it("climbs with the clock", () => {
    expect(presenceSequence(1, 1_000)).toBe(1_000);
  });

  it("climbs anyway when the clock does not", () => {
    // The service refreshes a row only for a sequence above the one it holds, so standing still is
    // how you expire yourself while you are still typing. A clock correction does it, and so does a
    // second window of the same account on the same document, which shares the row.
    expect(presenceSequence(5_000, 4_000)).toBe(5_001);
    expect(presenceSequence(5_000, 5_000)).toBe(5_001);
  });

  it("never sends a sequence the request format refuses", () => {
    expect(presenceSequence(0, 0)).toBe(1);
  });
});
