import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectHistoryPanel } from "./ObjectHistoryPanel.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

const HASHES = ["a", "b", "c", "d"].map((value) => `sha256:${value.repeat(64)}`);
const OBJECT = {
  id: "object-1",
  type: "inbox_item",
  title: "Current title",
  content: "Shared line\nCurrent line",
  version: 3,
  content_hash: HASHES[2]!,
  updated_at: "2026-08-22T12:03:00.000Z",
  updated_by: "account:test",
};
const VERSIONS = [
  {
    ...OBJECT,
    title: "Original title",
    content: "Shared line\nOriginal line",
    version: 1,
    content_hash: HASHES[0]!,
    updated_at: "2026-08-22T12:01:00.000Z",
  },
  {
    ...OBJECT,
    title: "Middle title",
    content: "Shared line\nMiddle line",
    version: 2,
    content_hash: HASHES[1]!,
    updated_at: "2026-08-22T12:02:00.000Z",
  },
  OBJECT,
];

function ok(data: Record<string, unknown>) {
  return {
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "committed",
    data,
  };
}

function historyResult() {
  return ok({
    history: VERSIONS.map(({ version, content_hash, title, updated_at, updated_by }) => ({
      version,
      content_hash,
      title,
      updated_at,
      updated_by,
    })),
    activity: VERSIONS.map((version) => ({
      id: `event-${version.version}`,
      event_type: version.version === 1 ? "object.created" : "object.saved",
      occurred_at: version.updated_at,
      actor: "account:test",
      transaction_id: `transaction-${version.version}`,
      version: version.version,
      reason: version.version === 2 ? "Clarified methods" : null,
    })),
  });
}

async function selectFirstAndCurrent(): Promise<void> {
  await screen.findByText("Clarified methods");
  await userEvent.click(screen.getByRole("checkbox", { name: "Compare version 2" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Compare version 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Compare selected" }));
}

describe("object history panel", () => {
  it("selects exact checkpoints and renders a read-only structured Markdown comparison", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.history") return historyResult();
      if (request.command === "kiwi.object.read-version")
        return ok({
          object: VERSIONS.find((version) => version.version === request.args["version"]),
        });
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <ObjectHistoryPanel
        workspaceId="workspace-1"
        object={OBJECT}
        writable
        restoreBlocked={false}
      />,
    );

    await selectFirstAndCurrent();
    const comparison = await screen.findByRole("region", { name: "Version comparison" });
    expect(comparison).toHaveTextContent("Version 1 compared with version 3");
    expect(screen.getByRole("article", { name: "Read-only version 1" })).toHaveTextContent(
      "Original line",
    );
    expect(screen.getByRole("article", { name: "Read-only version 3" })).toHaveTextContent(
      "Current line",
    );
    expect(screen.getByRole("list", { name: "Markdown line changes" })).toHaveTextContent(
      "Original line",
    );
    expect(
      invokeCommand.mock.calls.filter(
        ([request]) => (request as { command: string }).command === "kiwi.object.read-version",
      ),
    ).toHaveLength(2);
  });

  it("reviews restoration and returns a receipt that preserves every version", async () => {
    const onRestored = vi.fn();
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.history") return historyResult();
      if (request.command === "kiwi.object.read-version")
        return ok({
          object: VERSIONS.find((version) => version.version === request.args["version"]),
        });
      if (request.command === "kiwi.object.validate-restore")
        return ok({
          preview: {
            source: VERSIONS[0],
            current_version: 3,
            next_version: 4,
            history_count: 3,
            impact: {
              relation_count: 1,
              incoming_count: 0,
              outgoing_count: 1,
              related_object_count: 1,
              relation_types: ["supports"],
            },
          },
        });
      if (request.command === "kiwi.object.restore-version")
        return {
          ...ok({
            object: {
              ...VERSIONS[0],
              version: 4,
              content_hash: HASHES[3],
              restored_from_version: 1,
            },
            restore: {
              source_version: 1,
              new_version: 4,
              history_count: 4,
              impact: {
                relation_count: 1,
                incoming_count: 0,
                outgoing_count: 1,
                related_object_count: 1,
                relation_types: ["supports"],
              },
            },
          }),
          transaction_id: "transaction-restore-4",
          event_ids: ["prepared-4", "restored-4", "committed-4"],
        };
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <ObjectHistoryPanel
        workspaceId="workspace-1"
        object={OBJECT}
        writable
        restoreBlocked={false}
        onRestored={onRestored}
      />,
    );

    await selectFirstAndCurrent();
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    const review = await screen.findByRole("region", { name: "Restoration review" });
    expect(review).toHaveTextContent("create version 4");
    expect(review).toHaveTextContent("All 3 existing versions remain unchanged");
    expect(review).toHaveTextContent("1 linked relation remains");
    const reason = screen.getByRole("textbox", { name: "Restoration reason" });
    await userEvent.clear(reason);
    await userEvent.type(reason, "Return to the original observation");
    await userEvent.click(screen.getByRole("button", { name: "Restore as version 4" }));

    expect(onRestored).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceVersion: 1,
        historyCount: 4,
        transactionId: "transaction-restore-4",
        eventIds: ["prepared-4", "restored-4", "committed-4"],
        object: expect.objectContaining({ version: 4, restored_from_version: 1 }),
      }),
    );
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.restore-version",
        args: expect.objectContaining({
          restore_version: 1,
          expected_version: 3,
          expected_hash: HASHES[2],
          reason: "Return to the original observation",
        }),
      }),
    );
  });

  it("keeps restore unavailable while a recovery draft exists", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.history") return historyResult();
      return ok({
        object: VERSIONS.find((version) => version.version === request.args["version"]),
      });
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <ObjectHistoryPanel workspaceId="workspace-1" object={OBJECT} writable restoreBlocked />,
    );

    await selectFirstAndCurrent();
    const restore = await screen.findByRole("button", { name: "Restore version 1" });
    expect(restore).toBeDisabled();
    expect(restore).toHaveAttribute(
      "title",
      "Save or discard the recovery draft before restoring history",
    );
  });
});
