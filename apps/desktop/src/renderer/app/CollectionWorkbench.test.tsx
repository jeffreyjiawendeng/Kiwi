import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionWorkbench } from "./CollectionWorkbench.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.kiwiDesktop;
});

/** Opens the control row overflow, which is where the occasional controls went. */
async function openMore(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("menu", { name: "More" });
}

/** Picks one thing out of the overflow. */
async function chooseMore(name: string | RegExp): Promise<void> {
  const menu = await openMore();
  await userEvent.click(within(menu).getByRole("menuitem", { name }));
}

/** Adds one filter value through the two-level + Filter menu. */
async function addFilter(group: string, value: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Add a filter" }));
  await userEvent.click(screen.getByRole("menuitem", { name: group }));
  await userEvent.click(screen.getByRole("menuitem", { name: value }));
}

/** What the + Filter menu is still offering in one group. */
async function filterChoices(group: string): Promise<string[]> {
  await userEvent.click(screen.getByRole("button", { name: "Add a filter" }));
  if (screen.queryByRole("menuitem", { name: group }) === null) return [];
  await userEvent.click(screen.getByRole("menuitem", { name: group }));
  const names = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return names;
}

/** The Version cell of the row a title is on. The title cell no longer repeats it. */
function versionCell(title: string): HTMLElement {
  const row = screen.getByRole("button", { name: `Select ${title}` }).closest("tr");
  return within(row as HTMLElement).getAllByRole("cell")[1] as HTMLElement;
}

/** Chooses an ordering from the sort menu. */
async function chooseSort(label: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Sort" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: label }));
}

const OBJECTS = [
  {
    id: "object-1",
    type: "inbox_item",
    title: "Measurement uncertainty",
    content: "A calibration result.",
    version: 2,
    content_hash: `sha256:${"a".repeat(64)}`,
    updated_at: "2026-08-22T12:00:00.000Z",
    updated_by: "account:test",
    generation: 4,
  },
  {
    id: "object-2",
    type: "inbox_item",
    title: "Field memo",
    content: "A second observation.",
    version: 1,
    content_hash: `sha256:${"b".repeat(64)}`,
    updated_at: "2026-08-21T12:00:00.000Z",
    updated_by: "account:test",
    generation: 4,
  },
];

describe("collection workbench", () => {
  it("keeps its query and selected object while switching view", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      void envelope;
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));
    await userEvent.type(screen.getByRole("searchbox"), "field");
    await userEvent.click(screen.getByRole("button", { name: "Cards" }));

    expect(screen.queryByRole("table", { name: "Research items" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Field memo" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("searchbox")).toHaveValue("field");
    // No Apply button: the list follows the keyboard a moment after it stops.
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          command: "kiwi.projection.list",
          args: expect.objectContaining({
            object_types: ["inbox_item"],
            text: "field",
            page: { offset: 0, limit: 50 },
          }),
        }),
      ),
    );
  });

  it("keeps the filter box while rows are picked, and swaps only the title", async () => {
    // Clicking a row is how the dock is opened, and it happens constantly. Taking the filter
    // away every time would take it away from somebody who had just started narrowing.
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Inbox/ })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select Measurement uncertainty" }), {
      ctrlKey: true,
    });

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
  });

  it("offers retry after a recoverable projection failure", async () => {
    const invokeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "failed",
        error: { message: "The local index is unavailable." },
      })
      .mockResolvedValueOnce({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 5, total: 0, offset: 0, limit: 50, objects: [] },
      });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("workspace files remain unchanged");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No research items yet")).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });

  it("keeps bulk mutations unavailable in a read-only workspace", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      void envelope;
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" writable={false} />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));

    expect(screen.getByRole("button", { name: "Add Needs review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Needs review" })).toHaveAttribute(
      "title",
      "This workspace is read only",
    );
    expect(
      invokeCommand.mock.calls.filter(
        ([request]) => (request as { command: string }).command === "kiwi.projection.list",
      ),
    ).toHaveLength(1);
    expect(
      invokeCommand.mock.calls.some(
        ([request]) => (request as { command: string }).command === "kiwi.object.bulk-add-tag",
      ),
    ).toBe(false);
  });

  it("opens the same short object-action menu from a row context key and the object editor", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "no_change",
      };
      if (request.command === "kiwi.projection.list")
        return {
          ...base,
          data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
        };
      if (request.command === "kiwi.draft.read") return { ...base, data: { draft: null } };
      if (request.command === "kiwi.object.organization")
        return { ...base, data: { organization: { tags: [], collections: [] } } };
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    const row = await screen.findByRole("button", { name: "Select Measurement uncertainty" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Organize object" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close object actions" }));

    await userEvent.click(screen.getByRole("button", { name: "Organize" }));
    expect(await screen.findByRole("menu", { name: "Organize object" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Move to collection",
      "Add to collection",
      "Move to project",
      "Add tag",
      "Duplicate",
      "Reveal in File Explorer",
      "Move to Trash",
    ]);
  });

  it("tags a nonadjacent selection and invokes the guarded undo receipt", async () => {
    const third = {
      ...OBJECTS[1]!,
      id: "object-3",
      title: "Third note",
      content_hash: `sha256:${"c".repeat(64)}`,
    };
    const objects = [...OBJECTS, third];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.projection.list")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "committed",
          data: { generation: 4, total: 3, offset: 0, limit: 50, objects },
        };
      if (request.command === "kiwi.draft.read")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: { draft: null },
        };
      const action = request.command === "kiwi.object.bulk-add-tag" ? "add" : "remove";
      const targets = request.args["targets"] as Array<{
        object_id: string;
        expected_version: number;
        expected_hash: string;
      }>;
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: {
          receipt: {
            action,
            changed_count: targets.length,
            skipped_count: 0,
            changes: targets.map((target) => ({
              object: {
                ...objects.find((item) => item.id === target.object_id)!,
                version: target.expected_version + 1,
                content_hash: `sha256:${action === "add" ? "d".repeat(64) : "e".repeat(64)}`,
              },
            })),
            undo: {
              action: action === "add" ? "remove" : "add",
              tag_id: "tag:kiwi/needs-review",
              targets: targets.map((target) => ({
                ...target,
                expected_version: target.expected_version + 1,
                expected_hash: `sha256:${action === "add" ? "d".repeat(64) : "e".repeat(64)}`,
              })),
            },
          },
        },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Measurement uncertainty" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Third note" }), {
      shiftKey: true,
    });
    expect(screen.getByText(/3 selected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await userEvent.click(screen.getByRole("button", { name: "Select Measurement uncertainty" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Third note" }), {
      ctrlKey: true,
    });
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add Needs review" }));
    expect(await screen.findByText("2 items tagged.")).toBeInTheDocument();
    const addCall = invokeCommand.mock.calls.find(
      ([request]) => (request as { command: string }).command === "kiwi.object.bulk-add-tag",
    );
    expect(addCall?.[0]).toEqual(
      expect.objectContaining({
        args: {
          tag_id: "tag:kiwi/needs-review",
          targets: [
            expect.objectContaining({ object_id: "object-1" }),
            expect.objectContaining({ object_id: "object-3" }),
          ],
        },
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("2 items restored.")).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([request]) => (request as { command: string }).command === "kiwi.object.bulk-remove-tag",
      ),
    ).toBe(true);
  });

  it("updates the collection row and exposes an inspectable immutable receipt for the saved version", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
      };
      if (request.command === "kiwi.projection.list")
        return {
          ...base,
          data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
        };
      if (request.command === "kiwi.draft.read") return { ...base, data: { draft: null } };
      if (request.command === "kiwi.draft.save")
        return {
          ...base,
          data: {
            draft: {
              schema_version: 1,
              actor_id: "account:test",
              workspace_id: "workspace-1",
              object_id: request.args["object_id"],
              base_version: request.args["base_version"],
              base_hash: request.args["base_hash"],
              title: request.args["title"],
              content: request.args["content"],
              updated_at: "2026-08-22T12:05:00.000Z",
            },
          },
        };
      if (request.command === "kiwi.object.validate-save")
        return {
          ...base,
          status: "no_change",
          data: {
            preview: {
              valid: true,
              problems: [],
              impact: {
                relation_count: 0,
                incoming_count: 0,
                outgoing_count: 0,
                related_object_count: 0,
                relation_types: [],
              },
            },
          },
        };
      if (request.command === "kiwi.object.save")
        return {
          ...base,
          transaction_id: "transaction-published-3",
          event_ids: ["event-prepared-3", "event-published-3", "event-committed-3"],
          data: {
            object: {
              ...OBJECTS[0],
              content: request.args["content"],
              version: 3,
              content_hash: `sha256:${"d".repeat(64)}`,
            },
          },
        };
      if (request.command === "kiwi.draft.discard") return { ...base, data: { discarded: true } };
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "A published calibration result." },
    });
    await screen.findByText(/Recovery draft protected/, {}, { timeout: 2_000 });
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect(await screen.findByText("Saved version 3.")).toBeInTheDocument();
    // The table has a Version column and the title cell no longer repeats what it says.
    expect(versionCell("Measurement uncertainty")).toHaveTextContent("3");
    await userEvent.click(screen.getByText("Inspect receipt"));
    expect(screen.getByText("transaction-published-3")).toBeInTheDocument();
    expect(screen.getByText(/event-prepared-3/)).toBeInTheDocument();
  });

  it("restores from universal history and keeps the intervening version in its receipt", async () => {
    const current = OBJECTS[0]!;
    const first = { ...current, version: 1, title: "Original title", content: "Original" };
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      const base = {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
      };
      if (request.command === "kiwi.projection.list")
        return {
          ...base,
          data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
        };
      if (request.command === "kiwi.draft.read") return { ...base, data: { draft: null } };
      if (request.command === "kiwi.object.history")
        return {
          ...base,
          data: {
            history: [first, current].map(
              ({ version, content_hash, title, updated_at, updated_by }) => ({
                version,
                content_hash,
                title,
                updated_at,
                updated_by,
              }),
            ),
            activity: [],
          },
        };
      if (request.command === "kiwi.object.read-version")
        return {
          ...base,
          data: { object: request.args["version"] === 1 ? first : current },
        };
      if (request.command === "kiwi.object.validate-restore")
        return {
          ...base,
          data: {
            preview: {
              source: first,
              current_version: 2,
              next_version: 3,
              history_count: 2,
              impact: {
                relation_count: 0,
                incoming_count: 0,
                outgoing_count: 0,
                related_object_count: 0,
                relation_types: [],
              },
            },
          },
        };
      if (request.command === "kiwi.object.restore-version")
        return {
          ...base,
          transaction_id: "transaction-restored-3",
          event_ids: ["prepared-restored-3", "restored-3", "committed-restored-3"],
          data: {
            object: {
              ...first,
              version: 3,
              content_hash: `sha256:${"f".repeat(64)}`,
            },
            restore: {
              source_version: 1,
              new_version: 3,
              history_count: 3,
              impact: {
                relation_count: 0,
                incoming_count: 0,
                outgoing_count: 0,
                related_object_count: 0,
                relation_types: [],
              },
            },
          },
        };
      throw new Error(`Unexpected command ${request.command}`);
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    await userEvent.click(await screen.findByRole("button", { name: "Compare selected" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore as version 3" }));

    expect(await screen.findByText(/Restored version 1 as version 3/)).toBeInTheDocument();
    expect(screen.getByText(/All 3 versions remain in immutable history/)).toBeInTheDocument();
    expect(versionCell("Original title")).toHaveTextContent("3");
    await userEvent.click(screen.getByText("Inspect restoration receipt"));
    expect(screen.getByText("transaction-restored-3")).toBeInTheDocument();
  });
});

describe("creating an item in a collection", () => {
  function stubBridge(overrides: Record<string, unknown> = {}) {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.object.create") {
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "committed",
          data: {
            object: {
              id: "object-new",
              type: request.args["type"],
              title: request.args["title"],
              content: "",
              version: 1,
              content_hash: `sha256:${"c".repeat(64)}`,
              updated_at: "2026-08-25T12:00:00.000Z",
              updated_by: "account:test",
              generation: 5,
            },
          },
          ...overrides,
        };
      }
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 0, offset: 0, limit: 50, objects: [] },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return invokeCommand;
  }

  it("names the family rather than calling everything a research item", async () => {
    stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    // "Research items" is storage vocabulary. Someone looking at a list of papers should see
    // the word they use for them.
    expect(await screen.findByRole("heading", { name: /^Papers/ })).toBeInTheDocument();
    expect(
      within(await openMore()).getByRole("menuitem", { name: "New Paper" }),
    ).toBeInTheDocument();
  });

  it("opens the duplicate review from the Library and comes back to it", async () => {
    stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    await screen.findByRole("heading", { name: /^Papers/ });
    await chooseMore("Review duplicates");
    expect(await screen.findByRole("heading", { name: "Possible duplicates" })).toBeInTheDocument();

    // The review answers a question about the whole Library, so it takes the screen from the
    // filtered table rather than sitting beside it.
    expect(screen.queryByRole("heading", { name: /^Papers/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to the Library" }));
    expect(await screen.findByRole("heading", { name: /^Papers/ })).toBeInTheDocument();
  });

  it("does not offer a duplicate review of Notes", async () => {
    stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="note" />);

    // The evidence is bibliographic: a shared DOI, or a title that matches. Two notes with the
    // same heading are two notes.
    expect(await screen.findByRole("heading", { name: /^Notes/ })).toBeInTheDocument();
    expect(
      within(await openMore()).queryByRole("menuitem", { name: "Review duplicates" }),
    ).not.toBeInTheDocument();
  });

  it("creates a Paper with the title that was typed", async () => {
    const invokeCommand = stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    await screen.findByRole("heading", { name: /^Papers/ });
    await chooseMore("New Paper");
    await userEvent.type(screen.getByLabelText("Paper title"), "Attention Is All You Need");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const created = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((request) => request.command === "kiwi.object.create");
    expect(created?.args).toMatchObject({
      type: "source",
      title: "Attention Is All You Need",
    });
  });

  it("uses each family's own word on the button and the field", async () => {
    for (const [family, label] of [
      ["note", "Note"],
      ["output", "Manuscript"],
      ["project", "Project"],
    ] as const) {
      stubBridge();
      const view = render(<CollectionWorkbench workspaceId="workspace-1" objectFamily={family} />);
      await screen.findByRole("button", { name: "More" });
      await chooseMore(`New ${label}`);
      expect(screen.getByLabelText(`${label} title`)).toBeInTheDocument();
      view.unmount();
      window.localStorage.clear();
    }
  });

  it("offers no New action for a family a person cannot create", async () => {
    // Managed files arrive by importing and the Inbox by capture, so a New button on either
    // would open a form that leads nowhere.
    for (const family of ["asset", "inbox_item"]) {
      stubBridge();
      const view = render(<CollectionWorkbench workspaceId="workspace-1" objectFamily={family} />);
      await screen.findByRole("heading", {
        name: family === "asset" ? /^Files/ : /^Inbox/,
      });
      expect(
        within(await openMore()).queryByRole("menuitem", { name: /^New / }),
      ).not.toBeInTheDocument();
      view.unmount();
      window.localStorage.clear();
    }
  });

  it("offers no New action in a read-only workspace", async () => {
    stubBridge();
    render(
      <CollectionWorkbench workspaceId="workspace-1" objectFamily="source" writable={false} />,
    );
    await screen.findByRole("heading", { name: /^Papers/ });
    expect(
      within(await openMore()).queryByRole("menuitem", { name: "New Paper" }),
    ).not.toBeInTheDocument();
  });

  it("will not create an item with a blank title", async () => {
    const invokeCommand = stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    await screen.findByRole("heading", { name: /^Papers/ });
    await chooseMore("New Paper");
    await userEvent.type(screen.getByLabelText("Paper title"), "   ");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      invokeCommand.mock.calls.some(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.object.create",
      ),
    ).toBe(false);
  });

  it("abandons the form on Cancel without creating anything", async () => {
    const invokeCommand = stubBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    await screen.findByRole("heading", { name: /^Papers/ });
    await chooseMore("New Paper");
    await userEvent.type(screen.getByLabelText("Paper title"), "Never mind");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Paper title")).not.toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.object.create",
      ),
    ).toBe(false);
  });

  it("reports a refused creation and keeps what was typed", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      if (request.command === "kiwi.object.create") {
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: { code: "KIWI_INVALID_ARGUMENTS", message: "That title is not usable." },
        };
      }
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 0, offset: 0, limit: 50, objects: [] },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);

    await screen.findByRole("heading", { name: /^Papers/ });
    await chooseMore("New Paper");
    await userEvent.type(screen.getByLabelText("Paper title"), "Something");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That title is not usable.");
    // Losing the typed title on a rejection would make the person type it again to find out
    // what was wrong with it.
    expect(screen.getByLabelText("Paper title")).toHaveValue("Something");
  });
});

describe("exporting the library", () => {
  const PAPERS = OBJECTS.map((object, index) => ({
    ...object,
    type: "source",
    id: `paper-${String(index + 1)}`,
    title: index === 0 ? "Measurement uncertainty" : "Field memo",
  }));

  function libraryBridge(
    outcome: unknown = { status: "written", path: "kiwi-library-2026-08-26.bib", count: 2 },
  ): { exportLibrary: ReturnType<typeof vi.fn> } {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: { generation: 4, total: 2, offset: 0, limit: 50, objects: PAPERS },
    }));
    const exportLibrary = vi.fn(async () => outcome);
    window.kiwiDesktop = { invokeCommand, exportLibrary } as unknown as RendererBridge;
    return { exportLibrary };
  }

  async function library(): Promise<void> {
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);
    await screen.findByRole("table", { name: "Research items" });
  }

  it("exports everything when nothing is picked, and says so on the button", async () => {
    const { exportLibrary } = libraryBridge();
    await library();
    await chooseMore("Export the library as BibTeX");

    expect(exportLibrary).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      format: "bibtex",
      object_ids: [],
    });
  });

  it("exports only what is picked", async () => {
    const { exportLibrary } = libraryBridge();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));
    await chooseMore("Export 1 selected as BibTeX");

    expect(exportLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ object_ids: ["paper-2"] }),
    );
  });

  it("writes the format that was chosen", async () => {
    const { exportLibrary } = libraryBridge();
    await library();
    await chooseMore("Export the library as RIS");

    expect(exportLibrary).toHaveBeenCalledWith(expect.objectContaining({ format: "ris" }));
  });

  it("says what was written and where", async () => {
    libraryBridge();
    await library();
    await chooseMore("Export the library as BibTeX");

    expect(
      await screen.findByText("2 references written to kiwi-library-2026-08-26.bib."),
    ).toBeInTheDocument();
  });

  it("says why an export could not be written", async () => {
    libraryBridge({ status: "error", message: "None of those items has a reference record yet." });
    await library();
    await chooseMore("Export the library as BibTeX");

    expect(
      await screen.findByText("None of those items has a reference record yet."),
    ).toBeInTheDocument();
  });

  it("reports nothing when the person changes their mind at the dialog", async () => {
    libraryBridge({ status: "cancelled" });
    await library();
    await chooseMore("Export the library as BibTeX");

    expect(screen.queryByText(/written to/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("never names a folder", async () => {
    const { exportLibrary } = libraryBridge();
    await library();
    await chooseMore("Export the library as BibTeX");

    const [request] = exportLibrary.mock.calls[0] as [Record<string, unknown>];
    expect(request["root"]).toBeUndefined();
    expect(Object.keys(request).sort()).toEqual(["format", "object_ids", "workspace_id"]);
  });

  it("is not offered on a collection that holds no references", async () => {
    libraryBridge();
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="inbox_item" />);
    await screen.findByRole("table", { name: "Research items" });

    expect(within(await openMore()).queryByRole("menuitem", { name: /^Export/ })).toBeNull();
  });
});

describe("sorting by a column", () => {
  const PAPERS = [
    {
      ...OBJECTS[0],
      type: "source",
      id: "paper-1",
      title: "Calibration drift",
      created_at: "2026-08-01T12:00:00.000Z",
      reference_year: 2019,
      first_author: "Zoe Adler",
    },
    {
      ...OBJECTS[1],
      type: "source",
      id: "paper-2",
      title: "Sensor noise",
      created_at: "2026-08-02T12:00:00.000Z",
      reference_year: null,
      first_author: null,
    },
  ];

  function stub(objects: unknown[] = PAPERS): ReturnType<typeof vi.fn> {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: { generation: 4, total: objects.length, offset: 0, limit: 50, objects },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return invokeCommand;
  }

  function lastSort(invokeCommand: ReturnType<typeof vi.fn>): unknown {
    const listed = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .filter((request) => request.command === "kiwi.projection.list");
    return listed[listed.length - 1]?.args["sort"];
  }

  async function library(): Promise<void> {
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);
    await screen.findByRole("table", { name: "Research items" });
  }

  it("asks the index for the column whose header was clicked", async () => {
    const invokeCommand = stub();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Year" }));

    // A year is asked for newest first, so the first click does not need a second one.
    expect(lastSort(invokeCommand)).toEqual({ field: "year", direction: "descending" });
  });

  it("starts a name at the top of the alphabet and turns it round on a second click", async () => {
    const invokeCommand = stub();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Author" }));
    expect(lastSort(invokeCommand)).toEqual({ field: "first_author", direction: "ascending" });

    await userEvent.click(screen.getByRole("button", { name: "Author" }));
    expect(lastSort(invokeCommand)).toEqual({ field: "first_author", direction: "descending" });
  });

  it("says which column is sorted and which way", async () => {
    stub();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Updated" }));

    expect(screen.getByRole("columnheader", { name: "Updated" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("shows the author and the year a Paper is looked up by", async () => {
    stub();
    await library();

    expect(screen.getByRole("cell", { name: "Zoe Adler" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2019" })).toBeInTheDocument();
  });

  it("offers no author or year on a collection that has neither", async () => {
    stub(OBJECTS);
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="inbox_item" />);
    await screen.findByRole("table", { name: "Research items" });

    expect(screen.queryByRole("button", { name: "Year" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Version" })).toBeInTheDocument();
  });

  it("keeps the chosen column when the page is opened again", async () => {
    stub();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Year" }));
    cleanup();

    const reopened = stub();
    await library();
    expect(lastSort(reopened)).toEqual({ field: "year", direction: "descending" });
  });
});

describe("filtering by several columns at once", () => {
  const AVAILABLE = {
    kinds: ["article", "book"],
    tags: ["tag:kiwi/needs-review"],
    authors: ["Zoe Adler", "Ana Ortiz"],
    years: [2024, 2019],
    read: ["read", "unread"],
  };

  function stub(
    objects: unknown[],
    available: unknown = AVAILABLE,
    total = objects.length,
  ): ReturnType<typeof vi.fn> {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      status: "committed",
      data: { generation: 4, total, offset: 0, limit: 50, objects, available },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return invokeCommand;
  }

  function lastFilters(invokeCommand: ReturnType<typeof vi.fn>): unknown {
    const listed = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .filter((request) => request.command === "kiwi.projection.list");
    return listed[listed.length - 1]?.args["filters"];
  }

  async function library(): Promise<void> {
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);
    await screen.findByRole("table", { name: "Research items" });
  }

  const PAPERS = [
    { ...OBJECTS[0], type: "source", id: "paper-1", title: "Calibration drift" },
    { ...OBJECTS[1], type: "source", id: "paper-2", title: "Sensor noise" },
  ];

  it("asks the index for the value chosen from a menu", async () => {
    const invokeCommand = stub(PAPERS);
    await library();
    await addFilter("Author", "Zoe Adler");

    await waitFor(() =>
      expect(lastFilters(invokeCommand)).toEqual({
        kinds: [],
        tags: [],
        authors: ["Zoe Adler"],
        years: [],
        read: [],
      }),
    );
  });

  it("narrows on every group chosen, and shows a chip for each", async () => {
    const invokeCommand = stub(PAPERS);
    await library();
    await addFilter("Author", "Zoe Adler");
    await addFilter("Year", "2019");
    await addFilter("Tag", "needs review");

    expect(lastFilters(invokeCommand)).toEqual({
      kinds: [],
      tags: ["tag:kiwi/needs-review"],
      authors: ["Zoe Adler"],
      years: [2019],
      read: [],
    });
    expect(
      screen.getByRole("button", { name: "Remove Author filter Zoe Adler" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Year filter 2019" })).toBeInTheDocument();
    // The chip reads as the tag was named, not as it is stored.
    expect(
      screen.getByRole("button", { name: "Remove Tag filter needs review" }),
    ).toBeInTheDocument();
  });

  it("stops offering a value it is already filtering by, and offers it again once removed", async () => {
    const invokeCommand = stub(PAPERS);
    await library();
    await addFilter("Author", "Zoe Adler");
    expect(await filterChoices("Author")).toEqual(["Ana Ortiz"]);

    await userEvent.click(screen.getByRole("button", { name: "Remove Author filter Zoe Adler" }));
    expect(lastFilters(invokeCommand)).toEqual({
      kinds: [],
      tags: [],
      authors: [],
      years: [],
      read: [],
    });
    expect(await filterChoices("Author")).toEqual(["Zoe Adler", "Ana Ortiz"]);
  });

  it("narrows a library down to the papers nobody has read yet", async () => {
    const invokeCommand = stub(PAPERS);
    await library();
    await addFilter("Read state", "Unread");

    expect(lastFilters(invokeCommand)).toEqual({
      kinds: [],
      tags: [],
      authors: [],
      years: [],
      read: ["unread"],
    });
    // The chip reads as a person would say it, not as the index stores it.
    expect(
      screen.getByRole("button", { name: "Remove Read state filter Unread" }),
    ).toBeInTheDocument();
  });

  it("offers no filters on a collection that has nothing to filter by", async () => {
    stub(OBJECTS, { kinds: [], tags: [], authors: [], years: [], read: [] });
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="inbox_item" />);
    await screen.findByRole("table", { name: "Research items" });

    // Nothing to narrow by, so nothing to open: the + Filter button is not there at all.
    expect(screen.queryByRole("button", { name: "Add a filter" })).toBeNull();
  });

  it("keeps the chips when the page is opened again", async () => {
    stub(PAPERS);
    await library();
    await addFilter("Type", "Article");
    cleanup();

    const reopened = stub(PAPERS);
    await library();
    expect(lastFilters(reopened)).toEqual({
      kinds: ["article"],
      tags: [],
      authors: [],
      years: [],
      read: [],
    });
    expect(screen.getByRole("button", { name: "Remove Type filter Article" })).toBeInTheDocument();
  });

  it("clears the chips and the text together when nothing matches", async () => {
    const invokeCommand = stub([], AVAILABLE, 0);
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);
    // An empty collection is not the same thing as one filtered down to nothing.
    await screen.findByRole("heading", { name: "No research items yet" });
    await addFilter("Year", "2024");
    expect(await screen.findByRole("heading", { name: "No matching items" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(lastFilters(invokeCommand)).toEqual({
      kinds: [],
      tags: [],
      authors: [],
      years: [],
      read: [],
    });
  });
});

describe("arranging the table columns", () => {
  const PAPERS = [
    {
      ...OBJECTS[0],
      type: "source",
      id: "paper-1",
      title: "Calibration drift",
      created_at: "2026-08-01T12:00:00.000Z",
      reference_year: 2019,
      first_author: "Zoe Adler",
      summary: "Drift is a room temperature problem, not an instrument one.",
    },
  ];

  function stub(): void {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 1, offset: 0, limit: 50, objects: PAPERS },
      })),
    } as unknown as RendererBridge;
  }

  async function library(): Promise<void> {
    render(<CollectionWorkbench workspaceId="workspace-1" objectFamily="source" />);
    await screen.findByRole("table", { name: "Research items" });
  }

  /** The headers as they read, without the mark that says which one the table is sorted on. */
  function headers(): string[] {
    return screen
      .getAllByRole("columnheader")
      .map((cell) => (cell.textContent ?? "").replaceAll(/[^\p{L} ]/gu, "").trim());
  }

  async function openColumns(): Promise<void> {
    await chooseMore("Columns…");
  }

  it("leads a library with who wrote the paper and when", async () => {
    stub();
    await library();

    // Added is off by default and still available. Two date columns side by side is one column
    // somebody has to read twice to find out which is which.
    expect(headers()).toEqual(["Title", "Author", "Year", "Updated", "Read"]);
  });

  it("takes a column away and puts another one back", async () => {
    stub();
    await library();
    await openColumns();
    await userEvent.click(screen.getByRole("checkbox", { name: "Year" }));

    expect(headers()).toEqual(["Title", "Author", "Updated", "Read"]);

    await userEvent.click(screen.getByRole("checkbox", { name: "Version" }));

    // A column that was not being shown joins at the end rather than in some remembered place.
    expect(headers()).toEqual(["Title", "Author", "Updated", "Read", "Version"]);
  });

  it("moves a column one place at a time", async () => {
    stub();
    await library();
    await openColumns();
    await userEvent.click(screen.getByRole("button", { name: "Move Year left" }));

    expect(headers()).toEqual(["Title", "Year", "Author", "Updated", "Read"]);

    await userEvent.click(screen.getByRole("button", { name: "Move Year right" }));

    expect(headers()).toEqual(["Title", "Author", "Year", "Updated", "Read"]);
  });

  it("keeps the title first and keeps it showing", async () => {
    stub();
    await library();
    await openColumns();

    // The title is the row header and carries the button that opens the paper.
    expect(screen.getByRole("checkbox", { name: "Title" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move Title left" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Author left" })).toBeDisabled();
  });

  it("keeps the arrangement when the page is opened again", async () => {
    stub();
    await library();
    await openColumns();
    await userEvent.click(screen.getByRole("checkbox", { name: "Added" }));
    await userEvent.click(screen.getByRole("button", { name: "Move Year left" }));
    cleanup();

    stub();
    await library();
    expect(headers()).toEqual(["Title", "Year", "Author", "Updated", "Read", "Added"]);
  });

  it("puts the family's own columns back", async () => {
    stub();
    await library();
    await openColumns();
    await userEvent.click(screen.getByRole("checkbox", { name: "Author" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Type" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset columns" }));

    expect(headers()).toEqual(["Title", "Author", "Year", "Updated", "Read"]);
  });

  it("says whether a paper has been read without being asked", async () => {
    stub();
    await library();

    // Unlike the summary, every paper has an answer to this from the day it arrives, so the
    // column is shown rather than offered, and both states are spelled out.
    expect(headers()).toContain("Read");
    expect(screen.getByRole("cell", { name: "Unread" })).toBeInTheDocument();
  });

  it("shows the reader's own summary once the column is turned on", async () => {
    stub();
    await library();

    // A library nobody has written summaries in yet would open as a column of empty cells, so
    // the column is offered rather than shown.
    expect(headers()).not.toContain("Summary");
    expect(
      screen.queryByText("Drift is a room temperature problem, not an instrument one."),
    ).toBeNull();

    await openColumns();
    await userEvent.click(screen.getByRole("checkbox", { name: "Summary" }));

    expect(headers()).toEqual(["Title", "Author", "Year", "Updated", "Read", "Summary"]);
    expect(
      screen.getByText("Drift is a room temperature problem, not an instrument one."),
    ).toBeInTheDocument();
  });

  it("shows when this machine last opened a paper, once the column is turned on", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: {
          generation: 4,
          total: 2,
          offset: 0,
          limit: 50,
          objects: [
            { ...PAPERS[0]!, last_opened_at: "2026-08-20T12:00:00.000Z" },
            { ...PAPERS[0]!, id: "paper-2", title: "Never read", last_opened_at: null },
          ],
        },
      })),
    } as unknown as RendererBridge;
    await library();

    // Empty until this machine has opened something, and blank on a colleague's copy of the same
    // library, so it is asked for rather than shown.
    expect(headers()).not.toContain("Last opened");
    await openColumns();
    await userEvent.click(screen.getByRole("checkbox", { name: "Last opened" }));

    expect(headers()).toContain("Last opened");
    expect(
      screen.getByRole("cell", { name: new Date("2026-08-20T12:00:00.000Z").toLocaleDateString() }),
    ).toBeInTheDocument();
    // Said in words. A blank cell would read as a date the index has mislaid.
    expect(screen.getByRole("cell", { name: "Not opened here" })).toBeInTheDocument();
  });

  it("orders the library by what was read most recently", async () => {
    const sorts: unknown[] = [];
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      sorts.push((envelope as { args: { sort?: unknown } }).args.sort);
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 1, offset: 0, limit: 50, objects: PAPERS },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    await library();

    await chooseSort("Recently opened");

    // The ordering happens in the index, not in the table: the whole point of a column the index
    // holds is that it can be sorted on across every page of a long library.
    await waitFor(() =>
      expect(sorts.at(-1)).toEqual({ field: "last_opened", direction: "descending" }),
    );
  });

  it("offers no columns to arrange where there is no table", async () => {
    stub();
    await library();
    await userEvent.click(screen.getByRole("button", { name: "Cards" }));

    expect(within(await openMore()).queryByRole("menuitem", { name: "Columns…" })).toBeNull();
  });
});

describe("moving a selection into a project", () => {
  const PROJECTS = [
    { id: "project-1", title: "Ice cores" },
    { id: "project-2", title: "Sediment survey" },
  ];

  /** A workspace that answers every assignment, unless a refusal is asked for at a given turn. */
  function stub(refuseAfter = Number.POSITIVE_INFINITY): ReturnType<typeof vi.fn> {
    let assigned = 0;
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string; args: Record<string, unknown> };
      if (request.command === "kiwi.projection.list")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "committed",
          data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
        };
      if (request.command === "kiwi.project.list")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "no_change",
          data: { projects: PROJECTS },
        };
      if (request.command === "kiwi.project.assign") assigned += 1;
      if (assigned > refuseAfter)
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: { message: "The workspace is open somewhere else." },
        };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { project_id: request.args["project_id"] },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return invokeCommand;
  }

  /** Picks both rows and waits for the destinations to arrive. */
  async function pickBoth(): Promise<void> {
    render(<CollectionWorkbench workspaceId="workspace-1" />);
    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Measurement uncertainty" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Field memo" }), { ctrlKey: true });
    await screen.findByRole("option", { name: "Sediment survey" });
  }

  function assignments(invokeCommand: ReturnType<typeof vi.fn>): unknown[] {
    return invokeCommand.mock.calls
      .filter(([request]) => (request as { command: string }).command === "kiwi.project.assign")
      .map(([request]) => (request as { args: Record<string, unknown> }).args);
  }

  it("files every picked item in the chosen project", async () => {
    const invokeCommand = stub();
    await pickBoth();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Project to move the selection into" }),
      "project-2",
    );
    await userEvent.click(screen.getByRole("button", { name: "Move to project" }));

    expect(await screen.findByText("2 items moved into Sediment survey.")).toBeInTheDocument();
    expect(assignments(invokeCommand)).toEqual([
      { object_id: "object-1", project_id: "project-2" },
      { object_id: "object-2", project_id: "project-2" },
    ]);
  });

  it("takes a selection out of every project when no project is chosen", async () => {
    const invokeCommand = stub();
    await pickBoth();
    await userEvent.click(screen.getByRole("button", { name: "Move to project" }));

    expect(await screen.findByText("2 items moved out of every project.")).toBeInTheDocument();
    expect(assignments(invokeCommand)).toEqual([
      { object_id: "object-1", project_id: null },
      { object_id: "object-2", project_id: null },
    ]);
  });

  it("says how far it got when the workspace refuses partway", async () => {
    stub(1);
    await pickBoth();
    await userEvent.click(screen.getByRole("button", { name: "Move to project" }));

    // The one item that did move is not written off as nothing having happened.
    expect(
      await screen.findByText(
        "Kiwi stopped after 1 of 2 selected items had moved. The workspace is open somewhere else.",
      ),
    ).toBeInTheDocument();
  });

  it("offers no move until the projects have been read", async () => {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      if (request.command === "kiwi.project.list")
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "failed",
          error: { message: "The workspace index is unavailable." },
        };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data: { generation: 4, total: 2, offset: 0, limit: 50, objects: OBJECTS },
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(<CollectionWorkbench workspaceId="workspace-1" />);
    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));

    const move = await screen.findByRole("button", { name: "Move to project" });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "Kiwi has not read the projects in this workspace");
  });

  it("keeps the move unavailable in a read-only workspace", async () => {
    stub();
    render(<CollectionWorkbench workspaceId="workspace-1" writable={false} />);
    await screen.findByRole("table", { name: "Research items" });
    await userEvent.click(screen.getByRole("button", { name: "Select Field memo" }));

    const move = screen.getByRole("button", { name: "Move to project" });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "This workspace is read only");
  });
});

describe("opening a note that has been written in", () => {
  const NOTE = {
    id: "note-1",
    type: "note",
    title: "Reading group, week three",
    content: "machines can think",
    version: 3,
    content_hash: `sha256:${"c".repeat(64)}`,
    updated_at: "2026-08-26T12:00:00.000Z",
    updated_by: "account:ada",
    generation: 4,
  };

  /** The index knows the words; only the object itself knows the node tree they are written in. */
  function stubNote(body: Record<string, unknown>) {
    const invokeCommand = vi.fn(async (envelope: unknown) => {
      const request = envelope as { command: string };
      const data =
        request.command === "kiwi.projection.list"
          ? { generation: 4, total: 1, offset: 0, limit: 50, objects: [NOTE] }
          : request.command === "kiwi.object.read"
            ? { object: { ...NOTE, ...body } }
            : { relations: [], history: [], threads: [] };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data,
      };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    return invokeCommand;
  }

  it("opens the editor on what the note actually says", async () => {
    // The listing carries the words as one string, which is what a listing needs and not what
    // an editor can be built from. An editor built from it would show a written note as a blank
    // page, and save the blank page over it at the first keystroke.
    stubNote({
      document_mode: "rich",
      document: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "machines can think" }] }],
      },
    });
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    expect(await screen.findByText("machines can think")).toBeInTheDocument();
  });

  it("reads the body once rather than once a listing", async () => {
    const invokeCommand = stubNote({
      document_mode: "rich",
      document: { type: "doc", content: [] },
    });
    render(<CollectionWorkbench workspaceId="workspace-1" />);

    await waitFor(() =>
      expect(
        invokeCommand.mock.calls.filter(
          ([raw]) => (raw as { command: string }).command === "kiwi.object.read",
        ),
      ).toHaveLength(1),
    );
  });
});
