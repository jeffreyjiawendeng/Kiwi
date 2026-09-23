import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanonicalObjectEditor, type CanonicalObjectView } from "./CanonicalObjectEditor.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

const OBJECT: CanonicalObjectView = {
  id: "object-1",
  type: "inbox_item",
  title: "Measurement uncertainty",
  content: "A calibration result.",
  version: 2,
  content_hash: `sha256:${"a".repeat(64)}`,
  updated_at: "2026-08-22T12:00:00.000Z",
  updated_by: "account:test",
};

describe("canonical object editor", () => {
  it("autosaves and restores a recovery draft without saving a version", async () => {
    let recovery: Record<string, unknown> | null = null;
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.draft.read") return result({ draft: recovery });
      if (request.command === "kiwi.draft.save") {
        recovery = {
          schema_version: 1,
          actor_id: "account:test",
          workspace_id: "workspace-1",
          object_id: request.args["object_id"],
          base_version: request.args["base_version"],
          base_hash: request.args["base_hash"],
          title: request.args["title"],
          content: request.args["content"],
          updated_at: "2026-08-22T12:05:00.000Z",
        };
        return result({ draft: recovery });
      }
      if (request.command === "kiwi.draft.discard") {
        recovery = null;
        return result({ discarded: true });
      }
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const rendered = render(
      <CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />,
    );

    expect(screen.getByText("Canonical version 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "# Revised\n\nProtected draft text." },
    });

    await waitFor(
      () =>
        expect(
          invokeCommand.mock.calls.some(
            ([request]) => (request as { command: string }).command === "kiwi.draft.save",
          ),
        ).toBe(true),
      { timeout: 2_000 },
    );
    expect(screen.getByText(/Recovery draft protected/)).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([request]) => (request as { command: string }).command === "kiwi.object.save",
      ),
    ).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Return to Read" }));
    expect(
      await screen.findByRole("region", { name: "Recovery draft available" }),
    ).toHaveTextContent("It has not been saved as a version");

    rendered.unmount();
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />);
    expect(
      await screen.findByRole("region", { name: "Recovery draft available" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(screen.getByRole("textbox", { name: "Content" })).toHaveValue(
      "# Revised\n\nProtected draft text.",
    );
    expect(screen.getByText(/still separate from the canonical version/)).toBeInTheDocument();
  });

  it("discloses a stale recovery base and supports guarded discard", async () => {
    const recovery = {
      schema_version: 1,
      actor_id: "account:test",
      workspace_id: "workspace-1",
      object_id: "object-1",
      base_version: 1,
      base_hash: `sha256:${"b".repeat(64)}`,
      title: "Older draft",
      content: "Preserved work",
      updated_at: "2026-08-22T11:00:00.000Z",
    };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      return request.command === "kiwi.draft.read"
        ? result({ draft: recovery })
        : result({ discarded: true });
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />);

    expect(await screen.findByText("Recovery draft has an older base")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Inspect changes" }));
    expect(screen.getByRole("region", { name: "Recovery draft comparison" })).toHaveTextContent(
      "Preserved work",
    );
    await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByText(/Canonical content was not changed/)).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "kiwi.draft.discard",
        args: expect.objectContaining({ base_version: 1, base_hash: recovery.base_hash }),
      }),
    );
  });

  it("keeps Edit unavailable in a read-only workspace", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => result({ draft: null })),
    } as unknown as RendererBridge;
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable={false} />);

    await screen.findByText("Read mode");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "title",
      "This workspace is read only",
    );
  });

  it("keeps typed content visible when recovery autosave fails and retries", async () => {
    let saveAttempts = 0;
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.draft.read") return result({ draft: null });
      saveAttempts += 1;
      if (saveAttempts === 1)
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: { message: "Recovery storage is unavailable." },
        };
      return result({
        draft: {
          schema_version: 1,
          actor_id: "account:test",
          workspace_id: "workspace-1",
          object_id: "object-1",
          base_version: 2,
          base_hash: OBJECT.content_hash,
          title: OBJECT.title,
          content: request.args["content"],
          updated_at: "2026-08-22T12:05:00.000Z",
        },
      });
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "Unsaved recovery text" },
    });
    expect(await screen.findByRole("alert", {}, { timeout: 2_000 })).toHaveTextContent(
      "canonical version is unchanged",
    );
    expect(screen.getByRole("textbox", { name: "Content" })).toHaveValue("Unsaved recovery text");

    await userEvent.click(screen.getByRole("button", { name: "Retry recovery save" }));
    expect(await screen.findByText(/Recovery draft protected/)).toBeInTheDocument();
  });

  it("links incremental errors to their field and blocks saving", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => result({ draft: null })),
    } as unknown as RendererBridge;
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: " " } });

    expect(screen.getByRole("region", { name: "Publication problems" })).toHaveTextContent(
      "Add a title before saving",
    );
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Error: Add a title/ }));
    expect(title).toHaveFocus();
  });

  it("reviews consequential changes, saves exactly once, then removes recovery", async () => {
    const commands: string[] = [];
    const onPublished = vi.fn();
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      commands.push(request.command);
      if (request.command === "kiwi.draft.read") return result({ draft: null });
      if (request.command === "kiwi.draft.save")
        return result({
          draft: {
            schema_version: 1,
            actor_id: "account:test",
            workspace_id: "workspace-1",
            object_id: "object-1",
            base_version: 2,
            base_hash: OBJECT.content_hash,
            title: request.args["title"],
            content: request.args["content"],
            updated_at: "2026-08-22T12:05:00.000Z",
          },
        });
      if (request.command === "kiwi.object.validate-save")
        return result({
          preview: {
            valid: true,
            problems: [
              {
                code: "content_empty",
                severity: "warning",
                field: "content",
                message: "This version has no content beyond its title.",
              },
            ],
            impact: {
              relation_count: 2,
              incoming_count: 1,
              outgoing_count: 1,
              related_object_count: 2,
              relation_types: ["supports"],
            },
          },
        });
      if (request.command === "kiwi.object.save")
        return {
          ...result({
            object: {
              ...OBJECT,
              content: "",
              version: 3,
              content_hash: `sha256:${"c".repeat(64)}`,
            },
          }),
          transaction_id: "transaction-3",
          event_ids: ["prepared-3", "published-3", "committed-3"],
          warnings: ["This version has no content beyond its title."],
        };
      if (request.command === "kiwi.draft.discard") return result({ discarded: true });
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <CanonicalObjectEditor
        workspaceId="workspace-1"
        object={OBJECT}
        writable
        onPublished={onPublished}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "" },
    });
    await screen.findByText(/Recovery draft protected/, {}, { timeout: 2_000 });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));

    const review = await screen.findByRole("region", { name: "Version review" });
    expect(review).toHaveTextContent("immutable version 3");
    expect(review).toHaveTextContent("2 linked relations");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Version message (optional)" }),
      "Reviewed linked evidence",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(onPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "transaction-3",
        eventIds: ["prepared-3", "published-3", "committed-3"],
        recoveryDraftRetained: false,
        object: expect.objectContaining({ version: 3 }),
      }),
    );
    expect(commands.filter((command) => command === "kiwi.object.save")).toHaveLength(1);
    expect(commands.indexOf("kiwi.draft.discard")).toBeGreaterThan(
      commands.indexOf("kiwi.object.save"),
    );
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.save",
        args: expect.objectContaining({
          expected_version: 2,
          expected_hash: OBJECT.content_hash,
          reason: "Reviewed linked evidence",
        }),
      }),
    );
  });

  it("retains recovery when exact-base preflight reports a conflict", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.draft.read") return result({ draft: null });
      if (request.command === "kiwi.draft.save")
        return result({
          draft: {
            schema_version: 1,
            actor_id: "account:test",
            workspace_id: "workspace-1",
            object_id: "object-1",
            base_version: 2,
            base_hash: OBJECT.content_hash,
            title: request.args["title"],
            content: request.args["content"],
            updated_at: "2026-08-22T12:05:00.000Z",
          },
        });
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "failed",
        error: { message: "The object changed since editing began." },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={OBJECT} writable />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "A guarded revision." },
    });
    await screen.findByText(/Recovery draft protected/, {}, { timeout: 2_000 });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("recovery draft was retained");
    expect(
      invokeCommand.mock.calls.some(
        ([request]) => (request as { command: string }).command === "kiwi.object.save",
      ),
    ).toBe(false);
    expect(
      invokeCommand.mock.calls.some(
        ([request]) => (request as { command: string }).command === "kiwi.draft.discard",
      ),
    ).toBe(false);
  });
});

function result(data: Record<string, unknown>) {
  return {
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "committed",
    data,
  };
}

describe("a quotation inside a note", () => {
  /** A note as one arrives from the Reader: the passage, then a line saying where it came from. */
  const QUOTING: CanonicalObjectView = {
    ...OBJECT,
    type: "note",
    content: [
      "> machines can think",
      "",
      "— Computing Machinery and Intelligence, p. 434 [[kiwi:annotation/annotation-1]]",
    ].join("\n"),
  };

  function stub() {
    const invokeCommand = vi.fn(async () => result({ draft: null }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  }

  it("reads the passage as a quotation rather than as a line starting with a caret", async () => {
    stub();
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={QUOTING} writable />);

    expect(screen.getByText("machines can think")).toBeInTheDocument();
  });

  it("never shows the marker", async () => {
    // It is punctuation for a program. A reader who sees it is reading the plumbing.
    stub();
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={QUOTING} writable />);

    expect(screen.queryByText(/kiwi:annotation/u)).not.toBeInTheDocument();
  });

  it("offers the page the passage was read on", async () => {
    stub();
    const onOpenAnnotation = vi.fn();
    render(
      <CanonicalObjectEditor
        workspaceId="workspace-1"
        object={QUOTING}
        writable
        onOpenAnnotation={onOpenAnnotation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open the page" }));
    expect(onOpenAnnotation).toHaveBeenCalledWith("annotation-1");
  });

  it("says where the passage came from without offering to show it, where there is no Reader", () => {
    stub();
    render(<CanonicalObjectEditor workspaceId="workspace-1" object={QUOTING} writable />);

    expect(screen.getByText(/Computing Machinery and Intelligence, p. 434/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the page" })).not.toBeInTheDocument();
  });
});
