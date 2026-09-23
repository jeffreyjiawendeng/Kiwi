import { describe, expect, it } from "vitest";
import { WORKSPACE_SYNC_PATHS, readStructuredSyncRequest } from "./workspace-sync.js";

const hash = `sha256:${"a".repeat(64)}`;

describe("structured synchronization contracts", () => {
  it("accepts a bounded expected-version submission", () => {
    expect(
      readStructuredSyncRequest(WORKSPACE_SYNC_PATHS.submit, {
        workspace_id: "workspace-1",
        command_id: "command-1",
        object_id: "object-1",
        base_version: 1,
        base_hash: hash,
        proposed: { version: 2, content_hash: hash, snapshot: { id: "object-1" } },
      }),
    ).toMatchObject({ object_id: "object-1", base_version: 1 });
  });

  it("rejects malformed hashes, snapshots, and unbounded pulls", () => {
    expect(
      readStructuredSyncRequest(WORKSPACE_SYNC_PATHS.submit, {
        workspace_id: "w",
        command_id: "c",
        object_id: "o",
        base_version: 0,
        base_hash: null,
        proposed: { version: 1, content_hash: "not-a-hash", snapshot: [] },
      }),
    ).toBeNull();
    expect(
      readStructuredSyncRequest(WORKSPACE_SYNC_PATHS.pull, {
        workspace_id: "w",
        after_sequence: 0,
        limit: 501,
      }),
    ).toBeNull();
  });
});
