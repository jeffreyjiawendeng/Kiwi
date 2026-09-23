import { describe, expect, it } from "vitest";
import { isWorkspaceSummary } from "./workspace.js";

describe("isWorkspaceSummary", () => {
  it("accepts the command result shape used to bind a window", () => {
    expect(
      isWorkspaceSummary({
        workspaceId: "0198c7c1-4e7d-7e31-a23a-824269ac23d0",
        title: "Trial",
        root: "C:\\Research\\Trial",
        formatVersion: "1.0.0",
        status: "ready",
        trust: "trusted",
        writable: true,
        problems: [],
      }),
    ).toBe(true);
  });

  it("rejects an incomplete or unknown status", () => {
    expect(isWorkspaceSummary({ status: "ready" })).toBe(false);
    expect(
      isWorkspaceSummary({
        workspaceId: "id",
        title: "Trial",
        root: "root",
        formatVersion: "1.0.0",
        status: "unknown",
        trust: "trusted",
        writable: true,
        problems: [],
      }),
    ).toBe(false);
  });
});
