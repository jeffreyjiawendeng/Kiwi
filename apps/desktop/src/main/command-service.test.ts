import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const userData = mkdtempSync(join(tmpdir(), "kiwi-cmdsvc-"));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0", getPath: () => userData },
}));

const { createCommandService, readRequestId, UI_CALLER } = await import("./command-service.js");
const { createSessionRegistry, electronSessionPaths } = await import("./workspace-session.js");
const { createRecoveryDraftStore } = await import("./recovery-draft-store.js");
const { memorySink, createLogger } = await import("@kiwi/diagnostics");

function makeService() {
  const sink = memorySink();
  const logger = createLogger({
    component: "main",
    version: "0.1.0",
    correlationId: "corr-1",
    clock: { now: () => new Date("2026-08-22T00:00:00Z") },
    sink,
  });
  const sessions = createSessionRegistry(electronSessionPaths(), logger);
  const drafts = createRecoveryDraftStore(join(userData, crypto.randomUUID(), "drafts.json"));
  return { sink, service: createCommandService(logger, sessions, undefined, drafts) };
}

function envelope(command: string, args: Record<string, unknown>, requestId = crypto.randomUUID()) {
  return { protocol_version: "1.0.0", request_id: requestId, command, args };
}

let service: ReturnType<typeof makeService>["service"];
let sink: ReturnType<typeof memorySink>;

beforeEach(() => {
  ({ service, sink } = makeService());
});

describe("caller context", () => {
  it("invokes as the local user from the ui surface", () => {
    expect(UI_CALLER).toEqual({
      actor: { kind: "local_user", id: "actor:local/default" },
      origin: { surface: "ui", extension_id: null },
    });
  });
});

describe("registered commands", () => {
  it("exposes the diagnostics commands under one namespace", () => {
    expect(service.commandNames()).toEqual([
      "kiwi.annotation.create",
      "kiwi.annotation.list",
      "kiwi.annotation.locate",
      "kiwi.annotation.send-to-manuscript",
      "kiwi.annotation.send-to-note",
      "kiwi.annotation.update",
      "kiwi.asset.import-managed",
      "kiwi.asset.open-managed",
      "kiwi.asset.reveal-managed",
      "kiwi.bibliography.export",
      "kiwi.bibliography.for-document",
      "kiwi.bibliography.import",
      "kiwi.bibliography.import-preview",
      "kiwi.claim.attach-evidence",
      "kiwi.claim.create",
      "kiwi.claim.detach-evidence",
      "kiwi.claim.list",
      "kiwi.claim.send-evidence",
      "kiwi.claim.update",
      "kiwi.conflict.list",
      "kiwi.conflict.record-external",
      "kiwi.conflict.resolve",
      "kiwi.diagnostics.count",
      "kiwi.diagnostics.crash",
      "kiwi.diagnostics.echo",
      "kiwi.diagnostics.fail",
      "kiwi.diagnostics.slow",
      "kiwi.draft.discard",
      "kiwi.draft.read",
      "kiwi.draft.save",
      "kiwi.event.list",
      "kiwi.note.create",
      "kiwi.note.list",
      "kiwi.note.read",
      "kiwi.note.replace-text",
      "kiwi.object.attach-file",
      "kiwi.object.bulk-add-tag",
      "kiwi.object.bulk-remove-tag",
      "kiwi.object.collect",
      "kiwi.object.create",
      "kiwi.object.create-inbox",
      "kiwi.object.detach-file",
      "kiwi.object.doi-matches",
      "kiwi.object.duplicate",
      "kiwi.object.duplicate-candidates",
      "kiwi.object.files",
      "kiwi.object.history",
      "kiwi.object.list",
      "kiwi.object.move",
      "kiwi.object.organization",
      "kiwi.object.promote",
      "kiwi.object.purge-trash",
      "kiwi.object.quick-capture",
      "kiwi.object.read",
      "kiwi.object.read-version",
      "kiwi.object.remove-from-collection",
      "kiwi.object.rename",
      "kiwi.object.restore-from-trash",
      "kiwi.object.restore-version",
      "kiwi.object.reveal",
      "kiwi.object.save",
      "kiwi.object.set-document",
      "kiwi.object.set-primary-file",
      "kiwi.object.set-read",
      "kiwi.object.set-reference",
      "kiwi.object.set-summary",
      "kiwi.object.set-trash-policy",
      "kiwi.object.tag",
      "kiwi.object.trash",
      "kiwi.object.trash-list",
      "kiwi.object.trash-policy",
      "kiwi.object.validate-restore",
      "kiwi.object.validate-save",
      "kiwi.object.validate-trash",
      "kiwi.object.validate-trash-policy",
      "kiwi.object.validate-trash-purge",
      "kiwi.project.assign",
      "kiwi.project.configure",
      "kiwi.project.create",
      "kiwi.project.delete",
      "kiwi.project.list",
      "kiwi.project.members",
      "kiwi.project.membership",
      "kiwi.project.validate-delete",
      "kiwi.protocol.ensure",
      "kiwi.protocol.freeze",
      "kiwi.protocol.log-deviation",
      "kiwi.protocol.read",
      "kiwi.protocol.update",
      "kiwi.relation.create",
      "kiwi.relation.for-object",
      "kiwi.task.complete",
      "kiwi.task.create",
      "kiwi.task.delete",
      "kiwi.task.link",
      "kiwi.task.list",
      "kiwi.task.reopen",
      "kiwi.task.unlink",
      "kiwi.task.update",
      "kiwi.thread.delete",
      "kiwi.thread.edit-message",
      "kiwi.thread.list",
      "kiwi.thread.reanchor",
      "kiwi.thread.reopen",
      "kiwi.thread.reply",
      "kiwi.thread.resolve",
      "kiwi.thread.start",
      "kiwi.workspace.create",
      "kiwi.workspace.forget",
      "kiwi.workspace.health",
      "kiwi.workspace.open",
      "kiwi.workspace.recent",
      "kiwi.workspace.recover-transactions",
      "kiwi.workspace.rename",
      "kiwi.workspace.repair-layout",
      "kiwi.workspace.set-trust",
    ]);
  });
});

describe("recovery drafts", () => {
  it("saves, reads, and discards an exact-base local draft", async () => {
    const baseHash = `sha256:${"a".repeat(64)}`;
    const saved = await service.invoke(
      {
        ...envelope("kiwi.draft.save", {
          object_id: "object-1",
          base_version: 2,
          base_hash: baseHash,
          title: "",
          content: "Recovery content",
        }),
        workspace_id: "workspace-1",
      },
      null,
    );
    expect(saved.status).toBe("committed");
    expect(saved.data?.["draft"]).toMatchObject({
      workspace_id: "workspace-1",
      object_id: "object-1",
      base_version: 2,
    });

    const read = await service.invoke(
      { ...envelope("kiwi.draft.read", { object_id: "object-1" }), workspace_id: "workspace-1" },
      null,
    );
    expect(read.data?.["draft"]).toMatchObject({ content: "Recovery content" });

    const discarded = await service.invoke(
      {
        ...envelope("kiwi.draft.discard", {
          object_id: "object-1",
          base_version: 2,
          base_hash: baseHash,
        }),
        workspace_id: "workspace-1",
      },
      null,
    );
    expect(discarded.data).toEqual({ discarded: true });
  });
});

describe("invocation", () => {
  it("returns a committed receipt", async () => {
    const result = await service.invoke(envelope("kiwi.diagnostics.echo", { message: "hi" }), null);
    expect(result.status).toBe("committed");
    expect(result.data).toEqual({ echoed: "hi", length: 2 });
  });

  it("logs the outcome without the argument values", async () => {
    const secret = "unpublished-cohort-name";
    await service.invoke(envelope("kiwi.diagnostics.echo", { message: secret }), null);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.event).toBe("command.completed");
    expect(sink.records[0]?.fields).toMatchObject({
      command: "kiwi.diagnostics.echo",
      result_status: "committed",
    });
    expect(JSON.stringify(sink.records)).not.toContain(secret);
  });

  it("reports a validation failure without throwing", async () => {
    const result = await service.invoke(envelope("kiwi.diagnostics.echo", { message: "" }), null);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
  });
});

describe("cancellation tracking", () => {
  it("cancels a tracked request and reports a canceled receipt", async () => {
    const requestId = crypto.randomUUID();
    const pending = service.invoke(
      envelope("kiwi.diagnostics.slow", { steps: 40, stepMs: 50 }, requestId),
      requestId,
    );

    await vi.waitFor(() => expect(service.inFlight()).toBe(1));
    expect(service.cancel(requestId)).toBe(true);

    const result = await pending;
    expect(result.status).toBe("canceled");
    expect(service.inFlight()).toBe(0);
  });

  it("reports false for an unknown request", () => {
    expect(service.cancel(crypto.randomUUID())).toBe(false);
  });

  it("stops tracking a request once it settles", async () => {
    const requestId = crypto.randomUUID();
    await service.invoke(envelope("kiwi.diagnostics.echo", { message: "x" }, requestId), requestId);
    expect(service.inFlight()).toBe(0);
    expect(service.cancel(requestId)).toBe(false);
  });
});

describe("readRequestId", () => {
  it("reads a usable identifier", () => {
    expect(readRequestId({ request_id: "abc" })).toBe("abc");
  });

  it.each([null, undefined, 42, [], { request_id: 1 }, { request_id: "" }, {}])(
    "returns null for %o",
    (value) => {
      expect(readRequestId(value)).toBeNull();
    },
  );

  it("rejects an oversized identifier", () => {
    expect(readRequestId({ request_id: "x".repeat(200) })).toBeNull();
  });
});
