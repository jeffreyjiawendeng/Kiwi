import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentThreads } from "./CommentThreads.js";
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

function thread(
  overrides: {
    id?: string;
    status?: "open" | "resolved";
    quote?: string;
    messages?: Array<{ id: string; author_name: string; body: string; edited_at?: string }>;
  } = {},
) {
  const messages = overrides.messages ?? [
    { id: "message-1", author_name: "Ada", body: "Is this the right cohort?" },
  ];
  return {
    id: overrides.id ?? "thread-1",
    version: 1,
    content_hash: `sha256:${"a".repeat(64)}`,
    title: messages[0]!.body,
    created_at: "2026-08-26T12:00:00.000Z",
    updated_at: "2026-08-26T12:00:00.000Z",
    thread: {
      anchor: {
        object_id: "object-1",
        kind: "object",
        ...(overrides.quote === undefined ? {} : { quote: overrides.quote }),
      },
      status: overrides.status ?? "open",
      resolved_by: null,
      resolved_at: null,
      messages: messages.map((message) => ({
        id: message.id,
        author_id: "account:ada",
        author_name: message.author_name,
        body: message.body,
        created_at: "2026-08-26T12:00:00.000Z",
        edited_at: message.edited_at ?? null,
      })),
      participants: ["account:ada"],
      mentions: [],
    },
  };
}

/** A signed-in account whose display name is readable, and the threads it is shown. */
function bridge(
  threads: () => unknown[],
  handle: (command: string, args: Record<string, unknown>) => unknown = () => ok({}),
) {
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const request = envelope as { command: string; args: Record<string, unknown> };
    if (request.command === "kiwi.thread.list") return ok({ threads: threads() });
    return handle(request.command, request.args);
  });
  window.kiwiDesktop = {
    invokeCommand,
    getAccountAuthState: async () => ({
      status: "authenticated",
      account: { id: "ada", email: "ada@example.org", email_verified: true },
      connection: "online",
    }),
    getAccountSettings: async () => ({
      status: "ok",
      settings: { account: { display_name: "Ada Lovelace" } },
    }),
  } as unknown as RendererBridge;
  return invokeCommand;
}

function panel(writable = true) {
  return <CommentThreads workspaceId="workspace-1" objectId="object-1" writable={writable} />;
}

describe("comment threads", () => {
  it("shows the conversation on an object, oldest message first", async () => {
    bridge(() => [
      thread({
        quote: "recruited in 2019",
        messages: [
          { id: "message-1", author_name: "Ada", body: "Is this the right cohort?" },
          { id: "message-2", author_name: "Belle", body: "Ping @[Ada](user:account:ada)" },
        ],
      }),
    ]);
    render(panel());

    expect(await screen.findByText("Is this the right cohort?")).toBeInTheDocument();
    expect(screen.getByText("recruited in 2019")).toBeInTheDocument();
    // The mention is stored as a link to an account and read as a name.
    expect(screen.getByText("Ping @Ada")).toBeInTheDocument();
  });

  it("files a comment on the object under the name the account is signed in as", async () => {
    let started = false;
    const invokeCommand = bridge(
      () => (started ? [thread()] : []),
      (command) => {
        if (command === "kiwi.thread.start") {
          started = true;
          return ok({ object: { id: "thread-1" } });
        }
        throw new Error(`Unexpected command ${command}`);
      },
    );
    render(panel());

    await screen.findByText(/No comments on this yet/u);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Start a comment" }),
      "Is this the right cohort?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    await screen.findByText("Is this the right cohort?");
    expect(
      invokeCommand.mock.calls.map(([request]) => request as { command: string; args: unknown }),
    ).toContainEqual({
      protocol_version: "1.0.0",
      request_id: expect.any(String),
      idempotency_key: expect.any(String),
      workspace_id: "workspace-1",
      command: "kiwi.thread.start",
      args: {
        anchor: { object_id: "object-1", kind: "object" },
        body: "Is this the right cohort?",
        author_name: "Ada Lovelace",
      },
    });
  });

  it("replies to a thread without an expected version", async () => {
    let replied = false;
    const invokeCommand = bridge(
      () => [
        replied
          ? thread({
              messages: [
                { id: "message-1", author_name: "Ada", body: "Is this the right cohort?" },
                { id: "message-2", author_name: "Ada Lovelace", body: "Only the 2019 intake." },
              ],
            })
          : thread(),
      ],
      (command) => {
        if (command === "kiwi.thread.reply") {
          replied = true;
          return ok({ object: { id: "thread-1" } });
        }
        throw new Error(`Unexpected command ${command}`);
      },
    );
    render(panel());

    const box = await screen.findByRole("textbox", { name: "Reply to Is this the right cohort?" });
    await userEvent.type(box, "Only the 2019 intake.");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));

    await screen.findByText("Only the 2019 intake.");
    const reply = invokeCommand.mock.calls
      .map(([request]) => request as { command: string; args: Record<string, unknown> })
      .find((request) => request.command === "kiwi.thread.reply");
    expect(reply?.args).toEqual({
      thread_id: "thread-1",
      body: "Only the 2019 intake.",
      author_name: "Ada Lovelace",
    });
  });

  it("settles a thread and keeps it readable behind one click", async () => {
    let status: "open" | "resolved" = "open";
    const invokeCommand = bridge(
      () => [thread({ status })],
      (command) => {
        if (command === "kiwi.thread.resolve") {
          status = "resolved";
          return ok({ object: { id: "thread-1" } });
        }
        throw new Error(`Unexpected command ${command}`);
      },
    );
    render(panel());

    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    // Settled threads leave the list rather than sitting at the top of it, and are one click away.
    await screen.findByText(/No comments on this yet/u);
    await userEvent.click(screen.getByRole("button", { name: "Show 1 settled" }));
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.filter(
        ([request]) => (request as { command: string }).command === "kiwi.thread.resolve",
      ),
    ).toHaveLength(1);
  });

  it("says what went wrong and leaves the draft where it was typed", async () => {
    bridge(
      () => [thread()],
      (command) => {
        if (command === "kiwi.thread.reply")
          return {
            protocol_version: "1.0.0",
            request_id: crypto.randomUUID(),
            status: "failed",
            error: { code: "KIWI_NOT_FOUND", message: "Comment thread not found." },
          };
        throw new Error(`Unexpected command ${command}`);
      },
    );
    render(panel());

    const box = await screen.findByRole("textbox", { name: "Reply to Is this the right cohort?" });
    await userEvent.type(box, "Only the 2019 intake.");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Comment thread not found.");
    expect(box).toHaveValue("Only the 2019 intake.");
  });

  it("reads but does not write in a read-only workspace", async () => {
    bridge(() => [thread()]);
    render(panel(false));

    expect(await screen.findByText("Is this the right cohort?")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Start a comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
  });
});
