import { describe, expect, it } from "vitest";
import { WORKSPACE_COEDIT_PATHS, readCoeditSyncRequest } from "./workspace-coedit.js";

describe("coediting synchronization contracts", () => {
  it("accepts bounded operation batches and pull cursors", () => {
    expect(
      readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.push, {
        workspace_id: "workspace-1",
        document_id: "document-1",
        operations: [
          {
            document_id: "document-1",
            operation_id: "operation-1",
            actor_id: "account-1",
            lamport: 1,
            kind: "insert",
            after_id: null,
            text: "Finding",
          },
        ],
      }),
    ).toMatchObject({ operations: [{ kind: "insert" }] });
    expect(
      readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.pull, {
        workspace_id: "workspace-1",
        document_id: "document-1",
        after_sequence: 0,
      }),
    ).toMatchObject({ limit: 500 });
  });

  it("rejects cross-document operations and invalid presence", () => {
    expect(
      readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.push, {
        workspace_id: "workspace-1",
        document_id: "document-1",
        operations: [
          {
            document_id: "another-document",
            operation_id: "operation-1",
            actor_id: "account-1",
            lamport: 1,
            kind: "insert",
            after_id: null,
            text: "Finding",
          },
        ],
      }),
    ).toBeNull();
    expect(
      readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.presence, {
        workspace_id: "workspace-1",
        document_id: "document-1",
        sequence: 0,
        cursor: -1,
      }),
    ).toBeNull();
  });

  it("accepts authorized document discovery", () => {
    expect(
      readCoeditSyncRequest(WORKSPACE_COEDIT_PATHS.documents, { workspace_id: "workspace-1" }),
    ).toEqual({ workspace_id: "workspace-1" });
  });
});
