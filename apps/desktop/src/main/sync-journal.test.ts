import { describe, expect, it } from "vitest";
import { createSyncJournal } from "./sync-journal.js";

const at = (iso: string): Date => new Date(iso);

describe("what synchronization last did", () => {
  it("knows nothing about a workspace it has not seen", () => {
    expect(createSyncJournal().read("workspace-1")).toEqual({
      last_succeeded_at: null,
      last_failure: null,
    });
  });

  it("records when it last got through", () => {
    const journal = createSyncJournal();

    journal.succeeded("workspace-1", at("2026-08-27T09:00:00.000Z"));

    expect(journal.read("workspace-1").last_succeeded_at).toBe("2026-08-27T09:00:00.000Z");
  });

  it("keeps the last success through a failure, because it is still when it last worked", () => {
    const journal = createSyncJournal();
    journal.succeeded("workspace-1", at("2026-08-27T09:00:00.000Z"));

    journal.failed("workspace-1", "The service is unavailable.", at("2026-08-27T09:05:00.000Z"));

    expect(journal.read("workspace-1")).toEqual({
      last_succeeded_at: "2026-08-27T09:00:00.000Z",
      last_failure: { at: "2026-08-27T09:05:00.000Z", reason: "The service is unavailable." },
    });
  });

  it("clears the failure once something gets through, because nothing is left of it to report", () => {
    const journal = createSyncJournal();
    journal.failed("workspace-1", "The service is unavailable.", at("2026-08-27T09:05:00.000Z"));

    journal.succeeded("workspace-1", at("2026-08-27T09:06:00.000Z"));

    expect(journal.read("workspace-1").last_failure).toBeNull();
  });

  it("keeps one workspace's answer out of another's", () => {
    const journal = createSyncJournal();

    journal.succeeded("workspace-1", at("2026-08-27T09:00:00.000Z"));

    expect(journal.read("workspace-2").last_succeeded_at).toBeNull();
  });

  it("forgets everything, for signing out", () => {
    const journal = createSyncJournal();
    journal.succeeded("workspace-1", at("2026-08-27T09:00:00.000Z"));

    journal.forget();

    expect(journal.read("workspace-1").last_succeeded_at).toBeNull();
  });
});
