import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrashWorkbench } from "./TrashWorkbench.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("Trash workbench", () => {
  it("lists recovery impact and restores an object with its relations", async () => {
    let restored = false;
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      if (request.command === "kiwi.object.restore-from-trash") {
        restored = true;
        return {
          protocol_version: "1.0.0",
          request_id: "restore",
          status: "committed",
          data: { object: { id: "object-1", title: "Deleted source" }, restored_relation_count: 2 },
        };
      }
      return {
        protocol_version: "1.0.0",
        request_id: "list",
        status: "no_change",
        data: {
          entries: restored
            ? []
            : [
                {
                  manifest: {
                    object_id: "object-1",
                    title: "Deleted source",
                    object_type: "inbox_item",
                    trashed_at: "2026-08-22T12:00:00.000Z",
                    trashed_by: "account:test",
                    deletion_event_id: "event-1",
                  },
                  object: {
                    id: "object-1",
                    title: "Deleted source",
                    type: "inbox_item",
                    version: 1,
                    content_hash: `sha256:${"a".repeat(64)}`,
                  },
                  impact: {
                    relation_count: 2,
                    related_object_count: 2,
                    relation_types: ["supports", "in_collection"],
                  },
                },
              ],
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<TrashWorkbench workspaceId="workspace-1" writable />);

    expect(await screen.findByText("Deleted source")).toBeInTheDocument();
    expect(screen.getByText(/2 relations/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(
      await screen.findByText("Restored Deleted source with 2 relations."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.restore-from-trash",
        args: { object_id: "object-1" },
      }),
    );
  });

  it("disables restoration in a read-only workspace", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: "list",
        status: "no_change",
        data: {
          entries: [
            {
              manifest: { object_id: "object-1", trashed_at: "2026-08-22T12:00:00.000Z" },
              object: { id: "object-1", title: "Deleted source", type: "inbox_item" },
              impact: { relation_count: 0, related_object_count: 0, relation_types: [] },
            },
          ],
        },
      })),
    } as unknown as RendererBridge;
    render(<TrashWorkbench workspaceId="workspace-1" writable={false} />);
    expect(await screen.findByRole("button", { name: "Restore" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Empty Trash..." })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable age cleanup" })).toBeDisabled();
  });

  it("requires an exact review and typed confirmation before emptying Trash", async () => {
    let purged = false;
    const entry = {
      manifest: {
        object_id: "object-1",
        title: "Disposable source",
        object_type: "inbox_item",
        trashed_at: "2026-08-01T12:00:00.000Z",
        trashed_by: "account:test",
        deletion_event_id: "event-1",
      },
      object: { id: "object-1", title: "Disposable source", type: "inbox_item" },
      impact: { relation_count: 2, related_object_count: 1, relation_types: ["supports"] },
    };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      const data =
        request.command === "kiwi.object.trash-list"
          ? { entries: purged ? [] : [entry] }
          : request.command === "kiwi.object.trash-policy"
            ? { policy: { enabled: false, minimum_age_days: 30 } }
            : request.command === "kiwi.object.validate-trash-purge"
              ? {
                  preview: {
                    scope: "all",
                    entry_count: 1,
                    relation_count: 2,
                    related_object_count: 1,
                    asset_count: 0,
                    object_checkpoint_count: 1,
                    relation_checkpoint_count: 2,
                    checkpoint_count: 3,
                    entries: [
                      {
                        object_id: "object-1",
                        title: "Disposable source",
                        object_type: "inbox_item",
                        trashed_at: "2026-08-01T12:00:00.000Z",
                        relation_count: 2,
                      },
                    ],
                    preview_token: `sha256:${"a".repeat(64)}`,
                    limitations: [
                      "Canonical event and version history remain under the workspace history policy.",
                      "Copies may remain in backups, synchronized replicas, exports, or user-controlled Git history.",
                      "This command is not a sensitive-history erasure operation.",
                    ],
                  },
                }
              : request.command === "kiwi.object.purge-trash"
                ? ((purged = true), { receipt: { purged_count: 1, undo: null } })
                : {};
      return {
        protocol_version: "1.0.0",
        request_id: "request",
        status: request.command === "kiwi.object.purge-trash" ? "committed" : "no_change",
        data,
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<TrashWorkbench workspaceId="workspace-1" writable />);

    await userEvent.click(await screen.findByRole("button", { name: "Empty Trash..." }));
    const dialog = await screen.findByRole("alertdialog", { name: "Empty Trash?" });
    expect(dialog).toHaveTextContent("You cannot restore them, and no Undo is available.");
    expect(dialog).toHaveTextContent("Relation tombstones removed");
    expect(dialog).toHaveTextContent("3 version checkpoints remain");
    const permanent = screen.getByRole("button", { name: "Permanently delete" });
    expect(permanent).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type DELETE 1 ITEM/u), "DELETE 1 ITEM");
    expect(permanent).toBeEnabled();
    await userEvent.click(permanent);
    expect(
      await screen.findByText("Permanently deleted 1 item from Trash. No Undo is available."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.purge-trash",
        args: { scope: "all", preview_token: `sha256:${"a".repeat(64)}` },
      }),
    );
  });

  it("reviews an age policy separately and runs no cleanup while saving it", async () => {
    let policy = { enabled: false, minimum_age_days: 30 };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.set-trash-policy")
        policy = {
          enabled: Boolean(request.args["enabled"]),
          minimum_age_days: Number(request.args["minimum_age_days"]),
        };
      const data =
        request.command === "kiwi.object.trash-list"
          ? {
              entries: [
                {
                  manifest: {
                    object_id: "object-1",
                    trashed_at: "2026-07-01T12:00:00.000Z",
                  },
                  object: { id: "object-1", title: "Old source", type: "inbox_item" },
                  impact: { relation_count: 0, related_object_count: 0, relation_types: [] },
                },
              ],
            }
          : request.command === "kiwi.object.trash-policy"
            ? { policy }
            : request.command === "kiwi.object.validate-trash-policy"
              ? {
                  preview: {
                    policy: {
                      enabled: Boolean(request.args["enabled"]),
                      minimum_age_days: Number(request.args["minimum_age_days"]),
                    },
                    eligible_count: 1,
                    eligible_entries: [
                      {
                        object_id: "object-1",
                        title: "Old source",
                        trashed_at: "2026-07-01T12:00:00.000Z",
                      },
                    ],
                    preview_token: `sha256:${"b".repeat(64)}`,
                  },
                }
              : request.command === "kiwi.object.set-trash-policy"
                ? { policy, changed: true }
                : request.command === "kiwi.object.validate-trash-purge"
                  ? {
                      preview: {
                        scope: "age",
                        entry_count: 1,
                        relation_count: 0,
                        related_object_count: 0,
                        asset_count: 0,
                        object_checkpoint_count: 1,
                        relation_checkpoint_count: 0,
                        checkpoint_count: 1,
                        entries: [
                          {
                            object_id: "object-1",
                            title: "Old source",
                            object_type: "inbox_item",
                            trashed_at: "2026-07-01T12:00:00.000Z",
                            relation_count: 0,
                          },
                        ],
                        preview_token: `sha256:${"c".repeat(64)}`,
                        limitations: [],
                      },
                    }
                  : {};
      return {
        protocol_version: "1.0.0",
        request_id: "request",
        status: request.command === "kiwi.object.set-trash-policy" ? "committed" : "no_change",
        data,
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<TrashWorkbench workspaceId="workspace-1" writable />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "Enable age cleanup" }));
    await userEvent.click(screen.getByRole("button", { name: "Review policy" }));
    expect(await screen.findByText(/Saving the policy will not delete them/u)).toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "kiwi.object.purge-trash" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply reviewed policy" }));
    expect(await screen.findByRole("button", { name: "Run age cleanup..." })).toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "kiwi.object.purge-trash" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Run age cleanup..." }));
    expect(
      await screen.findByRole("alertdialog", { name: "Run age cleanup?" }),
    ).toBeInTheDocument();
  });
});
