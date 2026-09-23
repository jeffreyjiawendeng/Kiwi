import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxWorkbench, type InboxObjectView } from "./InboxWorkbench.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: crypto.randomUUID(), status: "committed", data };
}

function note(id: string, title: string, version = 1): InboxObjectView {
  return {
    id,
    type: "inbox_item",
    title,
    content: `Content for ${title}`,
    version,
    content_hash: `sha256:${String(version).repeat(64)}`,
    updated_at: `2026-08-22T12:0${version}:00.000Z`,
    updated_by: "account:test",
  };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("Inbox workbench", () => {
  it("captures a first note and saves its next immutable version", async () => {
    let current: InboxObjectView | null = null;
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.projection.list") {
        return ok({ objects: current === null ? [] : [current] });
      }
      if (envelope.command === "kiwi.object.create-inbox") {
        current = {
          ...note("object-1", String(envelope.args["title"])),
          content: String(envelope.args["content"]),
        };
        return ok({ object: current });
      }
      if (envelope.command === "kiwi.object.save") {
        current = {
          ...current!,
          title: String(envelope.args["title"]),
          content: String(envelope.args["content"]),
          version: 2,
          content_hash: `sha256:${"2".repeat(64)}`,
        };
        return ok({ object: current });
      }
      if (envelope.command === "kiwi.object.read") return ok({ object: current });
      if (envelope.command === "kiwi.object.history") {
        return ok({
          history:
            current === null
              ? []
              : [
                  {
                    version: current.version,
                    title: current.title,
                    content_hash: current.content_hash,
                    updated_at: current.updated_at,
                    updated_by: current.updated_by,
                  },
                ],
        });
      }
      if (envelope.command === "kiwi.projection.relations") return ok({ relations: [] });
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeEnabled());
    await userEvent.type(screen.getByLabelText("Title"), "Migration question");
    await userEvent.type(screen.getByLabelText("Note"), "Check the original dataset.");
    await userEvent.click(screen.getByRole("button", { name: "Add to Inbox" }));

    expect(await screen.findByText("Added to Inbox")).toBeInTheDocument();
    expect(screen.getByText("Migration question")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Note"), " Add a citation.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved version 2")).toBeInTheDocument();

    const createCall = invokeCommand.mock.calls.find(
      ([value]) => (value as { command: string }).command === "kiwi.object.create-inbox",
    );
    expect(createCall?.[0]).toMatchObject({
      workspace_id: WORKSPACE_ID,
      args: { title: "Migration question", content: "Check the original dataset." },
    });
    expect((createCall?.[0] as { args: Record<string, unknown> }).args).not.toHaveProperty("root");
  });

  it("shows both-direction connections and restores history as a new version", async () => {
    const first = note("object-1", "Interview notes", 2);
    const second = note("object-2", "Working claim");
    let current = first;
    let related = false;
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.projection.list") return ok({ objects: [first, second] });
      if (envelope.command === "kiwi.object.read") {
        return ok({ object: envelope.args["object_id"] === second.id ? second : current });
      }
      if (envelope.command === "kiwi.object.history") {
        return ok({
          history: [
            { ...first, version: 1, title: "Raw interview notes" },
            { ...current, version: current.version },
          ],
        });
      }
      if (envelope.command === "kiwi.relation.create") {
        related = true;
        return ok({});
      }
      if (envelope.command === "kiwi.projection.relations") {
        return ok({
          relations: related
            ? [
                {
                  direction: "outgoing",
                  relation: {
                    id: "relation-1",
                    type: "supports",
                    subject: { object_id: first.id },
                    object: { object_id: second.id },
                  },
                },
              ]
            : [],
        });
      }
      if (envelope.command === "kiwi.object.restore-version") {
        current = { ...first, version: 3, title: "Raw interview notes" };
        return ok({ object: current });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);
    await screen.findByDisplayValue("Interview notes");
    await userEvent.click(screen.getByRole("button", { name: /^Connections/ }));
    await userEvent.selectOptions(screen.getByLabelText("Connected note"), second.id);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("button", { name: "Working claim" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^History/ }));
    const restoreButtons = await screen.findAllByRole("button", { name: "Restore" });
    await userEvent.click(restoreButtons[0]!);
    expect(await screen.findByText("Restored version 1 as version 3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Raw interview notes")).toBeInTheDocument();

    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.relation.create",
        args: { type: "supports", subject_id: first.id, object_id: second.id },
      }),
    );
  });

  it("compares preserved variants and resolves without rewriting history", async () => {
    const mine = note("object-1", "Mine", 2);
    const theirs = { ...note("object-1", "Theirs", 2), content: "Their preserved text" };
    let current = mine;
    let resolved = false;
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.projection.list") return ok({ objects: [current] });
      if (envelope.command === "kiwi.object.read") return ok({ object: current });
      if (envelope.command === "kiwi.object.history") return ok({ history: [] });
      if (envelope.command === "kiwi.projection.relations") return ok({ relations: [] });
      if (envelope.command === "kiwi.conflict.list") {
        return ok({
          conflicts: [
            {
              id: "conflict-1",
              object_id: mine.id,
              status: resolved ? "resolved" : "unresolved",
              mine,
              theirs,
            },
          ],
        });
      }
      if (envelope.command === "kiwi.conflict.resolve") {
        resolved = true;
        current = { ...theirs, version: 3 };
        return ok({ object: current });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);
    expect(await screen.findByText(/Both are preserved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review versions" }));
    expect(screen.getByRole("region", { name: "Conflict comparison" })).toHaveTextContent(
      "Their preserved text",
    );
    await userEvent.click(screen.getByRole("button", { name: "Use theirs as new version" }));
    expect(await screen.findByText("Resolved as version 3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Theirs")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.conflict.resolve",
        args: expect.objectContaining({ conflict_id: "conflict-1", resolution: "theirs" }),
      }),
    );
  });

  it("says what differs between the preserved variants, not only what each one says", async () => {
    const mine = { ...note("object-1", "Interview notes", 2), content: "Opening\nMy sentence" };
    const theirs = {
      ...note("object-1", "Interview notes", 2),
      content: "Opening\nTheir sentence",
    };
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string };
      if (envelope.command === "kiwi.projection.list") return ok({ objects: [mine] });
      if (envelope.command === "kiwi.object.read") return ok({ object: mine });
      if (envelope.command === "kiwi.object.history") return ok({ history: [] });
      if (envelope.command === "kiwi.projection.relations") return ok({ relations: [] });
      if (envelope.command === "kiwi.conflict.list") {
        return ok({
          conflicts: [{ id: "conflict-1", object_id: mine.id, status: "unresolved", mine, theirs }],
        });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);
    await screen.findByText(/Both are preserved/);
    await userEvent.click(screen.getByRole("button", { name: "Review versions" }));

    expect(
      screen.getByText("The text differs in one place. Both are called the same thing."),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Line by line" })).toHaveTextContent("Their sentence");
  });

  it("keeps both versions and says where the one that did not win went", async () => {
    const mine = note("object-1", "Mine", 2);
    const theirs = { ...note("object-1", "Theirs", 2), content: "Their preserved text" };
    let current = mine;
    let resolved = false;
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      if (envelope.command === "kiwi.projection.list") return ok({ objects: [current] });
      if (envelope.command === "kiwi.object.read") return ok({ object: current });
      if (envelope.command === "kiwi.object.history") return ok({ history: [] });
      if (envelope.command === "kiwi.projection.relations") return ok({ relations: [] });
      if (envelope.command === "kiwi.conflict.list") {
        return ok({
          conflicts: [
            {
              id: "conflict-1",
              object_id: mine.id,
              status: resolved ? "resolved" : "unresolved",
              mine,
              theirs,
            },
          ],
        });
      }
      if (envelope.command === "kiwi.conflict.resolve") {
        resolved = true;
        current = { ...mine, version: 3 };
        return ok({ object: current, kept: { ...theirs, id: "object-2", version: 1 } });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);
    await screen.findByText(/Both are preserved/);
    await userEvent.click(screen.getByRole("button", { name: "Review versions" }));
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Keep the other version too, as a separate note beside this one",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Keep mine, and save theirs beside it" }),
    );

    expect(
      await screen.findByText(
        "Resolved as version 3. The other version is now a note called Theirs.",
      ),
    ).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.conflict.resolve",
        args: expect.objectContaining({ resolution: "mine", keep_other: true }),
      }),
    );
  });

  it("shows preserved Quick Capture context after the Inbox item is reopened", async () => {
    const captured: InboxObjectView = {
      ...note("capture-1", "Selected observation"),
      provenance: [
        {
          type: "quick_capture",
          captured_at: "2026-08-22T12:10:00.000Z",
          capture_command: "kiwi.object.quick-capture",
          surface: "collection",
          project_id: null,
          object: {
            object_id: "source-1",
            object_type: "source",
            object_title: "Imported field report",
            version: 3,
            content_hash: `sha256:${"a".repeat(64)}`,
          },
          source: {
            object_id: "source-1",
            object_type: "source",
            object_title: "Imported field report",
            version: 3,
            content_hash: `sha256:${"a".repeat(64)}`,
            representation_id: "representation-1",
          },
          selection: {
            text: "The preserved selected passage.",
            prefix: "Before ",
            suffix: " after.",
          },
        },
      ],
    };
    const objectContext = vi.fn();
    window.addEventListener("kiwi:object-context", objectContext, { once: true });
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async (raw: unknown) => {
        const command = (raw as { command: string }).command;
        if (command === "kiwi.projection.list") return ok({ objects: [captured] });
        if (command === "kiwi.object.read") return ok({ object: captured });
        if (command === "kiwi.object.history") return ok({ history: [] });
        if (command === "kiwi.projection.relations") return ok({ relations: [] });
        if (command === "kiwi.conflict.list") return ok({ conflicts: [] });
        return ok({});
      }),
    } as unknown as RendererBridge;

    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable initialObjectId={captured.id} />);
    const context = await screen.findByRole("region", { name: "Quick Capture context" });
    expect(context).toHaveTextContent("Imported field report (version 3)");
    expect(context).toHaveTextContent("The preserved selected passage.");
    expect(context).toHaveTextContent("collection");
    await waitFor(() => expect(objectContext).toHaveBeenCalled());
    expect((objectContext.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      id: captured.id,
      version: captured.version,
      content_hash: captured.content_hash,
    });
  });
});

describe("filing an Inbox note in a project", () => {
  const PROJECTS = [
    { id: "project-1", title: "Field study" },
    { id: "project-2", title: "Reading group" },
  ];

  function inboxBridge(options: { note?: InboxObjectView; holder?: string | null } = {}) {
    const item = options.note ?? note("object-1", "Migration question");
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string; args: Record<string, unknown> };
      sent.push(envelope);
      if (envelope.command === "kiwi.projection.list") return ok({ objects: [item] });
      if (envelope.command === "kiwi.object.read") return ok({ object: item });
      if (envelope.command === "kiwi.object.history") return ok({ history: [] });
      if (envelope.command === "kiwi.projection.relations") return ok({ relations: [] });
      if (envelope.command === "kiwi.conflict.list") return ok({ conflicts: [] });
      if (envelope.command === "kiwi.project.list") return ok({ projects: PROJECTS });
      if (envelope.command === "kiwi.project.membership") {
        const holder = options.holder ?? null;
        return ok({
          project: holder === null ? null : { id: holder, title: `Project ${holder}`, version: 1 },
        });
      }
      return ok({});
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return { sent, item };
  }

  function assignments(sent: Array<{ command: string; args: Record<string, unknown> }>) {
    return sent
      .filter((entry) => entry.command === "kiwi.project.assign")
      .map((entry) => entry.args);
  }

  it("files the note in the project that was chosen", async () => {
    const { sent } = inboxBridge();
    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);

    const chooser = await screen.findByLabelText("Project");
    await waitFor(() => expect(chooser).toBeEnabled());
    await userEvent.selectOptions(chooser, "project-1");

    expect(await screen.findByText("Filed in Field study")).toBeInTheDocument();
    expect(assignments(sent)).toEqual([{ object_id: "object-1", project_id: "project-1" }]);
    for (const entry of sent) expect(entry.args).not.toHaveProperty("root");
  });

  it("takes the note out of every project", async () => {
    // Not the same as leaving it where it was: a note filed by mistake has to be filable back
    // out, and `project_id: null` is what the command reads as nowhere.
    const { sent } = inboxBridge({ holder: "project-2" });
    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);

    const chooser = await screen.findByLabelText("Project");
    await waitFor(() => expect((chooser as HTMLSelectElement).value).toBe("project-2"));
    await userEvent.selectOptions(chooser, "");

    expect(await screen.findByText("Taken out of its project")).toBeInTheDocument();
    expect(assignments(sent)).toEqual([{ object_id: "object-1", project_id: null }]);
  });

  it("shows the project the note is already in", async () => {
    inboxBridge({ holder: "project-1" });
    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);

    const chooser = (await screen.findByLabelText("Project")) as HTMLSelectElement;
    await waitFor(() => expect(chooser.value).toBe("project-1"));
  });

  it("does not offer to file from a read-only workspace", async () => {
    inboxBridge();
    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable={false} />);

    const chooser = await screen.findByLabelText("Project");
    expect(chooser).toBeDisabled();
  });

  it("names the project a note was captured in", async () => {
    // The provenance records an identifier, which is the right thing to record and the wrong
    // thing to read.
    const captured: InboxObjectView = {
      ...note("capture-1", "Selected observation"),
      provenance: [
        {
          type: "quick_capture",
          captured_at: "2026-08-22T12:10:00.000Z",
          capture_command: "kiwi.object.quick-capture",
          surface: "collection",
          project_id: "project-2",
          object: null,
          source: null,
          selection: null,
        },
      ],
    };
    inboxBridge({ note: captured });
    render(<InboxWorkbench workspaceId={WORKSPACE_ID} writable />);

    const context = await screen.findByRole("region", { name: "Quick Capture context" });
    await waitFor(() => expect(context).toHaveTextContent("Reading group"));
    expect(context).not.toHaveTextContent("project-2");
  });
});
