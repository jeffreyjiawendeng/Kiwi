import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RendererBridge, RendererWorkspacePresenceResult } from "./bridge.js";
import type { PresenceMember } from "./presence.js";
import { PRESENCE_INTERVAL_MS, usePresence } from "./usePresence.js";

const MEMBERS: PresenceMember[] = [
  { user_id: "ada", display_name: "Ada Okonkwo", email: "ada@example.test" },
  { user_id: "wei", display_name: "Wei Chen", email: "wei@example.test" },
];

function here(...actors: string[]): RendererWorkspacePresenceResult {
  return {
    status: "present",
    collaborators: actors.map((actor) => ({
      actor_id: `account:${actor}`,
      sequence: 1,
      cursor: 0,
      // Far enough out that nothing here expires on its own. Expiry has its own tests.
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    })),
  };
}

function never(): Promise<RendererWorkspacePresenceResult> {
  return new Promise<RendererWorkspacePresenceResult>(() => undefined);
}

function installBridge(
  answer: (input: {
    documentId: string;
    cursor: number;
  }) => Promise<RendererWorkspacePresenceResult>,
) {
  const readWorkspacePresence = vi.fn(answer);
  window.kiwiDesktop = { readWorkspacePresence } as unknown as RendererBridge;
  return readWorkspacePresence;
}

function focus(state: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(state);
}

/** Lets whatever was asked for come back, without waiting on a clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** One turn of the poll. */
async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
  });
  await settle();
}

function watch(documentId: string | null = "doc-1") {
  return renderHook(() => usePresence({ documentId, members: MEMBERS, selfUserId: "ada" }));
}

// jsdom has no window manager, so nothing is focused unless it is said to be. Every test that is
// not about losing focus is about a window somebody is looking at.
beforeEach(() => {
  focus(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.kiwiDesktop;
});

describe("polling for who is here", () => {
  it("asks straight away rather than after the first tick", async () => {
    const asked = installBridge(async () => here("ada", "wei"));
    const { result } = watch();

    await waitFor(() => expect(result.current.state).toBe("here"));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(result.current.people.map((person) => person.name)).toEqual(["Wei Chen"]);
  });

  it("keeps asking every five seconds", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => here("wei"));
    watch();
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);

    await tick();
    expect(asked).toHaveBeenCalledTimes(2);
    await tick();
    expect(asked).toHaveBeenCalledTimes(3);
  });

  it("carries the document and nothing about a workspace", async () => {
    const asked = installBridge(async () => here("wei"));
    watch("doc-7");

    await waitFor(() => expect(asked).toHaveBeenCalled());
    // The workspace is the main process's to fill in from the session bound to this window. A
    // renderer that named one could report itself into a workspace it does not have open.
    expect(asked).toHaveBeenCalledWith({ documentId: "doc-7", cursor: 0 });
  });

  it("does not stack a second question behind a slow one", async () => {
    vi.useFakeTimers();
    const asked = installBridge(never);
    watch();
    await settle();

    await tick();
    await tick();

    // A service slower than the tick would otherwise collect a queue that never empties.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks nothing at all when there is no document open", async () => {
    const asked = installBridge(async () => here("wei"));
    const { result } = watch(null);

    await settle();
    expect(asked).not.toHaveBeenCalled();
    expect(result.current.state).toBe("unknown");
  });

  it("works with no bridge at all", async () => {
    const { result } = watch();
    await settle();
    expect(result.current.state).toBe("unknown");
  });
});

describe("a window nobody is looking at", () => {
  it("stops asking when the window loses focus", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => here("wei"));
    watch();
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);

    focus(false);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await tick();
    await tick();

    // Not asking is also not answering. The row stops being refreshed at the service too, so this
    // window drops off everybody else's presence half a minute later, which is what it should do.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("shows nobody while it is not asking", async () => {
    installBridge(async () => here("wei"));
    const { result } = watch();
    await waitFor(() => expect(result.current.state).toBe("here"));

    focus(false);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current.state).toBe("unknown");
    expect(result.current.people).toEqual([]);
  });

  it("asks again the moment the window is back, not five seconds later", async () => {
    vi.useFakeTimers();
    const asked = installBridge(async () => here("wei"));
    watch();
    await settle();

    focus(false);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    focus(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("never starts on a window that was not focused to begin with", async () => {
    focus(false);
    const asked = installBridge(async () => here("wei"));
    watch();

    await settle();
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("answers that arrive too late to mean anything", () => {
  it("does not show an answer for a document that has since been closed", async () => {
    const answers: Array<(result: RendererWorkspacePresenceResult) => void> = [];
    installBridge(
      async () =>
        new Promise<RendererWorkspacePresenceResult>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(
      (documentId: string | null) =>
        usePresence({ documentId, members: MEMBERS, selfUserId: "ada" }),
      { initialProps: "doc-1" as string | null },
    );

    rerender(null);
    answers[0]?.(here("wei"));
    await settle();

    expect(result.current.state).toBe("unknown");
  });

  it("shows nobody from the last document while the next is still being asked about", async () => {
    installBridge(async (input) => (input.documentId === "doc-1" ? here("wei") : never()));
    const { result, rerender } = renderHook(
      (documentId: string) => usePresence({ documentId, members: MEMBERS, selfUserId: "ada" }),
      { initialProps: "doc-1" },
    );
    await waitFor(() => expect(result.current.state).toBe("here"));

    rerender("doc-2");
    await settle();

    expect(result.current.people).toEqual([]);
  });
});

describe("names that arrive after the people do", () => {
  it("names somebody once the roster lands, without waiting for the next tick", async () => {
    const asked = installBridge(async () => here("wei"));
    const { result, rerender } = renderHook(
      (members: PresenceMember[]) =>
        usePresence({ documentId: "doc-1", members, selfUserId: "ada" }),
      { initialProps: [] as PresenceMember[] },
    );
    await waitFor(() => expect(result.current.state).toBe("here"));
    expect(result.current.people.map((person) => person.named)).toEqual([false]);

    rerender(MEMBERS);

    expect(result.current.people.map((person) => person.name)).toEqual(["Wei Chen"]);
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
