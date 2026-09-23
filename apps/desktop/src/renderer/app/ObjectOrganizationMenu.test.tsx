import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectOrganizationMenu } from "./ObjectOrganizationMenu.js";
import type { RendererBridge } from "./bridge.js";

const OBJECT = {
  id: "object-1",
  type: "inbox_item",
  title: "Field memo",
  content: "An observation.",
  version: 1,
  content_hash: `sha256:${"a".repeat(64)}`,
  updated_at: "2026-08-22T12:00:00.000Z",
  updated_by: "account:test",
};

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("object organization menu", () => {
  it("runs rename and its guarded compensation from the shared action surface", async () => {
    const renamed = {
      ...OBJECT,
      title: "Renamed memo",
      version: 2,
      content_hash: `sha256:${"b".repeat(64)}`,
    };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.organization")
        return {
          protocol_version: "1.0.0",
          request_id: "organization",
          status: "no_change",
          data: { organization: { tags: [], collections: [] } },
        };
      return {
        protocol_version: "1.0.0",
        request_id: "rename",
        status: "committed",
        data: {
          object: renamed,
          undo: {
            command: "kiwi.object.rename",
            args: {
              object_id: renamed.id,
              expected_version: renamed.version,
              expected_hash: renamed.content_hash,
              title: OBJECT.title,
            },
          },
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onObjectChanged = vi.fn();
    render(
      <ObjectOrganizationMenu
        workspaceId="workspace-1"
        writable
        request={{ object: OBJECT, action: "rename", revision: 1 }}
        onClose={vi.fn()}
        onObjectChanged={onObjectChanged}
        onObjectTrashed={vi.fn()}
        onCollectionChanged={vi.fn()}
      />,
    );

    const input = await screen.findByRole("textbox", { name: "New title" });
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed memo");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByText("Rename completed.")).toBeInTheDocument();
    expect(onObjectChanged).toHaveBeenCalledWith(renamed);
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.rename",
        args: expect.objectContaining({
          object_id: OBJECT.id,
          expected_version: 1,
          title: "Renamed memo",
        }),
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(invokeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "kiwi.object.rename",
        args: expect.objectContaining({ expected_version: 2, title: OBJECT.title }),
      }),
    );
  });

  it("keeps mutations disabled in read-only workspaces while reveal remains available", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      if (request.command === "kiwi.object.organization")
        return {
          protocol_version: "1.0.0",
          request_id: "organization",
          status: "no_change",
          data: { organization: { tags: [], collections: [] } },
        };
      return {
        protocol_version: "1.0.0",
        request_id: "reveal",
        status: "no_change",
        data: { object_id: OBJECT.id, revealed: true },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <ObjectOrganizationMenu
        workspaceId="workspace-1"
        writable={false}
        request={{ object: OBJECT, action: null, revision: 1 }}
        onClose={vi.fn()}
        onObjectChanged={vi.fn()}
        onObjectTrashed={vi.fn()}
        onCollectionChanged={vi.fn()}
      />,
    );

    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeDisabled();
    const reveal = screen.getByRole("menuitem", { name: "Reveal in File Explorer" });
    expect(reveal).toBeEnabled();
    await userEvent.click(reveal);
    expect(
      await screen.findByText("Revealed the canonical file in File Explorer."),
    ).toBeInTheDocument();
  });

  it("shows exact dependency impact before moving an object to Trash", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      if (request.command === "kiwi.object.organization")
        return {
          protocol_version: "1.0.0",
          request_id: "organization",
          status: "no_change",
          data: { organization: { tags: [], collections: [] } },
        };
      if (request.command === "kiwi.draft.read")
        return {
          protocol_version: "1.0.0",
          request_id: "draft",
          status: "no_change",
          data: { draft: null },
        };
      if (request.command === "kiwi.object.validate-trash")
        return {
          protocol_version: "1.0.0",
          request_id: "preview",
          status: "no_change",
          data: {
            preview: {
              object: OBJECT,
              impact: {
                relation_count: 2,
                incoming_count: 1,
                outgoing_count: 1,
                related_object_count: 2,
                relation_types: ["in_collection", "supports"],
                collection_membership_count: 1,
              },
              relation_guards: [
                {
                  relation_id: "relation-1",
                  version: 1,
                  content_hash: `sha256:${"b".repeat(64)}`,
                },
              ],
            },
          },
        };
      return {
        protocol_version: "1.0.0",
        request_id: "trash",
        status: "committed",
        data: {
          entry: { object: OBJECT },
          undo: { command: "kiwi.object.restore-from-trash", args: { object_id: OBJECT.id } },
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onObjectTrashed = vi.fn();
    render(
      <ObjectOrganizationMenu
        workspaceId="workspace-1"
        writable
        request={{ object: OBJECT, action: "trash", revision: 1 }}
        onClose={vi.fn()}
        onObjectChanged={vi.fn()}
        onObjectTrashed={onObjectTrashed}
        onCollectionChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("1 incoming, 1 outgoing")).toBeInTheDocument();
    expect(screen.getByText("in_collection, supports")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(onObjectTrashed).toHaveBeenCalledWith(OBJECT.id);
    expect(await screen.findByText(/Moved to workspace Trash/u)).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.trash",
        args: expect.objectContaining({
          object_id: OBJECT.id,
          expected_version: OBJECT.version,
          expected_hash: OBJECT.content_hash,
          expected_relations: [expect.objectContaining({ relation_id: "relation-1", version: 1 })],
        }),
      }),
    );
  });

  /** A workspace holding two projects, with the object already filed in the first. */
  function projectBridge(): ReturnType<typeof vi.fn> {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.organization")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: { organization: { tags: [], collections: [] } },
        };
      if (request.command === "kiwi.draft.read")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: { draft: null },
        };
      if (request.command === "kiwi.project.list")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: {
            projects: [
              { id: "project-1", title: "Ice cores" },
              { id: "project-2", title: "Sediment survey" },
            ],
          },
        };
      if (request.command === "kiwi.project.membership")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: { project: { id: "project-1", title: "Ice cores" } },
        };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { project_id: request.args["project_id"] },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <ObjectOrganizationMenu
        workspaceId="workspace-1"
        writable
        request={{ object: OBJECT, action: "project", revision: 1 }}
        onClose={vi.fn()}
        onObjectChanged={vi.fn()}
        onObjectTrashed={vi.fn()}
        onCollectionChanged={vi.fn()}
      />,
    );
    return invokeCommand;
  }

  it("opens on the project the object is already in and files it in another", async () => {
    const invokeCommand = projectBridge();

    const chooser = await screen.findByRole("combobox", { name: "Project" });
    expect(chooser).toHaveValue("project-1");
    await userEvent.selectOptions(chooser, "project-2");
    await userEvent.click(screen.getByRole("button", { name: "Move to project" }));

    expect(await screen.findByText("Move to project completed.")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "kiwi.project.assign",
        args: { object_id: OBJECT.id, project_id: "project-2" },
      }),
    );
  });

  it("takes an object out of every project", async () => {
    const invokeCommand = projectBridge();

    // Belonging to nothing is a real answer: an object filed in the wrong project has to be able
    // to leave it without being pushed into another.
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Project" }), "");
    await userEvent.click(screen.getByRole("button", { name: "Move to project" }));

    expect(await screen.findByText("Move to project completed.")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "kiwi.project.assign",
        args: { object_id: OBJECT.id, project_id: null },
      }),
    );
  });
});
