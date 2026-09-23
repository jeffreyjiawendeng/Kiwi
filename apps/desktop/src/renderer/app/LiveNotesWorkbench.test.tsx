import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveNotesWorkbench, type LiveNoteView } from "./LiveNotesWorkbench.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
const hash = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: crypto.randomUUID(), status: "committed", data };
}

function note(content = "Shared draft"): LiveNoteView {
  return {
    document_id: "document-1",
    title: "Field notes",
    content,
    content_hash: hash(String(content.length % 10)),
    operation_count: 1,
    updated_at: "2026-08-22T12:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("Live Notes workbench", () => {
  it("creates a minimal collaborative note", async () => {
    let current: LiveNoteView | null = null;
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.note.list")
        return ok({ notes: current === null ? [] : [current] });
      if (envelope.command === "kiwi.note.create") {
        current = {
          ...note(String(envelope.args["content"])),
          title: String(envelope.args["title"]),
        };
        return ok({ note: current, operations: [], sync: { status: "synchronized" } });
      }
      return ok({ note: current });
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<LiveNotesWorkbench workspaceId={WORKSPACE_ID} writable />);

    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Title"), "Interview notes");
    await userEvent.type(screen.getByLabelText("Note"), "A shared observation.");
    await userEvent.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByText("Created and synchronized")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.note.create",
        args: { title: "Interview notes", content: "A shared observation." },
      }),
    );
  });

  it("shares typed changes after a short quiet period", async () => {
    let current = note();
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.note.list") return ok({ notes: [current] });
      if (envelope.command === "kiwi.note.read") return ok({ note: current });
      if (envelope.command === "kiwi.note.replace-text") {
        current = {
          ...current,
          content: String(envelope.args["content"]),
          content_hash: hash("9"),
        };
        return ok({
          note: current,
          operations: [{ operation_id: "operation-2" }],
          sync: {
            status: "synchronized",
            collaborators: 2,
            presence: [
              { actor_id: "account:a", cursor: 4 },
              { actor_id: "account:b", cursor: 20 },
            ],
          },
        });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<LiveNotesWorkbench workspaceId={WORKSPACE_ID} writable />);

    const editor = await screen.findByLabelText("Note");
    await waitFor(() => expect(editor).toHaveValue("Shared draft"));
    await userEvent.type(editor, " updated");

    await waitFor(
      () =>
        expect(invokeCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: "kiwi.note.replace-text",
            args: expect.objectContaining({ content: "Shared draft updated" }),
          }),
        ),
      { timeout: 2_000 },
    );
    expect(await screen.findByText(/2 collaborators present/)).toBeInTheDocument();
    expect(screen.getByLabelText("Collaborator cursors")).toHaveTextContent("4, 20");
  });
});
