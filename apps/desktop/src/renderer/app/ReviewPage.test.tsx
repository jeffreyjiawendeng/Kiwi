import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPage } from "./ReviewPage.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

function ok(data: Record<string, unknown>) {
  return {
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "committed",
    data,
  };
}

function thread(entry: {
  id: string;
  objectId: string;
  body: string;
  updatedAt: string;
  status?: "open" | "resolved";
  quote?: string;
}) {
  return {
    id: entry.id,
    version: 1,
    content_hash: `sha256:${"a".repeat(64)}`,
    title: entry.body,
    created_at: "2026-08-26T12:00:00.000Z",
    updated_at: entry.updatedAt,
    thread: {
      anchor: {
        object_id: entry.objectId,
        kind: entry.quote === undefined ? "object" : "text_range",
        ...(entry.quote === undefined
          ? {}
          : { from: 0, to: entry.quote.length, quote: entry.quote }),
      },
      status: entry.status ?? "open",
      resolved_by: null,
      resolved_at: null,
      messages: [
        {
          id: `${entry.id}-message-1`,
          author_id: "account:ada",
          author_name: "Ada",
          body: entry.body,
          created_at: "2026-08-26T12:00:00.000Z",
          edited_at: null,
        },
      ],
      participants: ["account:ada"],
      mentions: [],
    },
  };
}

const OBJECTS = [
  { id: "paper-1", title: "Sample sizes", type: "paper" },
  { id: "note-1", title: "The bound", type: "note" },
];

const THREADS = [
  thread({
    id: "thread-1",
    objectId: "paper-1",
    body: "Is this the right cohort?",
    updatedAt: "2026-08-26T12:00:00.000Z",
  }),
  thread({
    id: "thread-2",
    objectId: "paper-1",
    body: "Settled already",
    updatedAt: "2026-08-26T11:00:00.000Z",
    status: "resolved",
  }),
  thread({
    id: "thread-3",
    objectId: "note-1",
    body: "Does the bound hold?",
    updatedAt: "2026-08-26T13:00:00.000Z",
    quote: "bound",
  }),
];

/**
 * The workspace as the inbox sees it: one filtered list, and the unfiltered threads on whatever
 * item the panel opens.
 */
function bridge(threads = THREADS, objects = OBJECTS) {
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as { command: string; args: Record<string, unknown> };
    if (request.command === "kiwi.object.list") return ok({ objects });
    if (request.command === "kiwi.thread.list") {
      const args = request.args;
      const objectId = args["object_id"] as string | undefined;
      if (objectId !== undefined)
        return ok({ threads: threads.filter((one) => one.thread.anchor.object_id === objectId) });
      const status = args["status"] as string | undefined;
      return ok({
        threads: threads.filter((one) => status === undefined || one.thread.status === status),
      });
    }
    return ok({});
  });
  window.kiwiDesktop = {
    invokeCommand,
    // Offline, so the display name is the account's email and the wait is one call long.
    getAccountAuthState: async () => ({
      status: "authenticated",
      account: { id: "ada", email: "ada@example.org", email_verified: true },
      connection: "offline",
    }),
  } as unknown as RendererBridge;
  return invokeCommand;
}

function page(onOpenObject?: (objectId: string, type: string) => void) {
  return (
    <ReviewPage
      workspaceId="workspace-1"
      writable
      projectId="project-1"
      {...(onOpenObject === undefined ? {} : { onOpenObject })}
    />
  );
}

/** What `kiwi.thread.list` was last asked for the inbox, ignoring the panel's own reads. */
function lastInboxArgs(invoked: ReturnType<typeof bridge>): Record<string, unknown> {
  const calls = invoked.mock.calls
    .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
    .filter((call) => call.command === "kiwi.thread.list" && call.args["object_id"] === undefined);
  return calls.at(-1)?.args ?? {};
}

describe("the Review page", () => {
  it("gathers every comment under the thing it is about, most recent first", async () => {
    bridge();
    render(page());

    const inbox = await screen.findByRole("list", { name: "Comments by what they are about" });
    const items = within(inbox).getAllByRole("heading", { level: 4 });
    expect(items.map((heading) => heading.textContent)).toEqual([
      "The bound1 conversation",
      "Sample sizes1 conversation",
    ]);
  });

  it("asks the workspace about the person reading rather than naming them", async () => {
    const invoked = bridge();
    render(page());
    await screen.findByRole("list", { name: "Comments by what they are about" });

    // Open comments are what the page opens on, because that is what is still being asked.
    expect(lastInboxArgs(invoked)).toEqual({ status: "open", project_id: "project-1" });

    await userEvent.click(screen.getByRole("button", { name: "Mentions me" }));
    await waitFor(() =>
      expect(lastInboxArgs(invoked)).toEqual({
        status: "open",
        mentions: true,
        project_id: "project-1",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Both" }));
    await waitFor(() =>
      expect(lastInboxArgs(invoked)).toEqual({ mentions: true, project_id: "project-1" }),
    );
  });

  it("asks for the set the Dashboard counts, written in or named in", async () => {
    const invoked = bridge();
    render(page());
    await screen.findByRole("list", { name: "Comments by what they are about" });

    await userEvent.click(screen.getByRole("button", { name: "Involves me" }));
    await waitFor(() =>
      expect(lastInboxArgs(invoked)).toEqual({
        status: "open",
        involving_me: true,
        project_id: "project-1",
      }),
    );
  });

  it("shows the whole conversation on an item, not the part the filters matched", async () => {
    bridge();
    render(page());

    const inbox = await screen.findByRole("list", { name: "Comments by what they are about" });
    // The paper's settled comment is not in the inbox, which is filtered to open ones.
    expect(within(inbox).queryByText("Settled already")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Is this the right cohort\?/u }));
    const comments = await screen.findByRole("region", { name: "Comments" });
    expect(await within(comments).findByRole("button", { name: "Show 1 settled" })).toBeTruthy();
  });

  it("says so when the thing commented on is no longer there", async () => {
    bridge(THREADS, [{ id: "note-1", title: "The bound", type: "note" }]);
    render(page(() => undefined));

    const inbox = await screen.findByRole("list", { name: "Comments by what they are about" });
    expect(within(inbox).getByText(/Something no longer in the project/u)).toBeTruthy();

    // The bound is what the page opens on, and it is still here, so it can still be opened.
    expect(screen.getByRole("button", { name: "Open it" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Is this the right cohort\?/u }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open it" })).toBeNull());
  });

  it("opens the item a comment is about", async () => {
    const opened = vi.fn();
    bridge();
    render(page(opened));

    await screen.findByRole("list", { name: "Comments by what they are about" });
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    expect(opened).toHaveBeenCalledWith("note-1", "note");
  });

  it("reads the inbox again after a reply is written in the panel", async () => {
    const invoked = bridge();
    render(page());
    await screen.findByRole("list", { name: "Comments by what they are about" });

    const before = invoked.mock.calls.filter(
      ([envelope]) => (envelope as { command: string }).command === "kiwi.object.list",
    ).length;

    await userEvent.type(await screen.findByLabelText("Reply to Does the bound hold?"), "It does.");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() => {
      const after = invoked.mock.calls.filter(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.object.list",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("says nothing has been asked when nothing has", async () => {
    bridge([]);
    render(page());

    expect(await screen.findByText(/Nothing has been asked yet/u)).toBeTruthy();
  });
});
