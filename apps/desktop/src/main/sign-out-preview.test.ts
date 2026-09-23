import { describe, expect, it, vi } from "vitest";
import { summarizePendingSynchronization } from "./sign-out-preview.js";

describe("sign-out synchronization preview", () => {
  it("counts every durable local synchronization queue without reading its content", async () => {
    const registrations = { count: vi.fn(async () => 1) };
    const structured = { count: vi.fn(async () => 2) };
    const documents = { count: vi.fn(async () => 3) };

    await expect(
      summarizePendingSynchronization("account-1", { registrations, structured, documents }),
    ).resolves.toEqual({
      pending_workspace_registrations: 1,
      pending_structured_changes: 2,
      pending_document_operations: 3,
      total: 6,
    });
    expect(registrations.count).toHaveBeenCalledWith("account-1");
    expect(structured.count).toHaveBeenCalledWith("account-1");
    expect(documents.count).toHaveBeenCalledWith("account-1");
  });

  it("treats stores that are not initialized yet as empty", async () => {
    await expect(
      summarizePendingSynchronization("account-1", {
        registrations: null,
        structured: null,
        documents: null,
      }),
    ).resolves.toEqual({
      pending_workspace_registrations: 0,
      pending_structured_changes: 0,
      pending_document_operations: 0,
      total: 0,
    });
  });
});
