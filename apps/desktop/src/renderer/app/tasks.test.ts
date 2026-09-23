import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { emptyTask, type TaskBody } from "@kiwi/contracts";
import {
  boardColumns,
  readTaskViews,
  taskTitles,
  useTasks,
  waitingOn,
  type TaskView,
} from "./tasks.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

function row(id: string, title: string, task: Partial<TaskBody> = {}): Record<string, unknown> {
  return {
    id,
    version: 3,
    content_hash: `hash-${id}`,
    title,
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    task: { ...emptyTask(), ...task },
  };
}

function view(id: string, title: string, task: Partial<TaskBody> = {}): TaskView {
  return {
    id,
    version: 3,
    content_hash: `hash-${id}`,
    title,
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    task: { ...emptyTask(), ...task },
  };
}

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "request", status: "succeeded", data };
}

function refused(code: string, message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code,
      message,
      details: {},
      retryable: false,
      recovery_actions: ["correct_input"],
      correlation_id: "correlation",
    },
  };
}

function installBridge(
  answer: (command: string, args: Record<string, unknown>) => Promise<RendererCommandResult>,
): Asked[] {
  const asked: Asked[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const sent = envelope as { command: string; args: Record<string, unknown> };
    asked.push({ command: sent.command, args: sent.args });
    return answer(sent.command, sent.args);
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return asked;
}

/** A bridge that answers every list with the same tasks, and every write with a plain yes. */
function bridgeListing(...rows: Array<Record<string, unknown>>): Asked[] {
  return installBridge(async (command) =>
    command === "kiwi.task.list" ? ok({ tasks: rows }) : ok({}),
  );
}

function titles(tasks: TaskView[]): string[] {
  return tasks.map((task) => task.title);
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("readTaskViews", () => {
  it("keeps the order the command answered in", () => {
    const tasks = readTaskViews({ tasks: [row("b", "Read the trial"), row("a", "Write it up")] });
    expect(titles(tasks)).toEqual(["Read the trial", "Write it up"]);
  });

  it("leaves out a row it cannot read and keeps the rest", () => {
    // One task written by a build that knows something this one does not is one task missing.
    // Refusing the whole answer would be every task missing.
    const tasks = readTaskViews({
      tasks: [row("a", "Write it up"), { id: "b", title: "Nonsense", task: { status: "later" } }],
    });
    expect(titles(tasks)).toEqual(["Write it up"]);
  });

  it("reads nothing out of an answer with no tasks in it", () => {
    expect(readTaskViews(undefined)).toEqual([]);
    expect(readTaskViews({})).toEqual([]);
  });
});

describe("boardColumns", () => {
  it("has all four columns even when three of them are empty", () => {
    const columns = boardColumns([view("a", "Write it up", { status: "doing" })]);
    expect(columns.map((column) => column.label)).toEqual(["To do", "Doing", "Blocked", "Done"]);
    expect(columns.map((column) => column.tasks.length)).toEqual([0, 1, 0, 0]);
  });
});

describe("waitingOn", () => {
  it("names what a task is waiting for", () => {
    const tasks = [
      view("a", "Write it up", { status: "blocked", blocked_by: ["b"] }),
      view("b", "Read the trial"),
    ];
    expect(waitingOn(tasks[0] as TaskView, taskTitles(tasks))).toEqual(["Read the trial"]);
  });

  it("says so rather than showing an id for a wait it cannot see", () => {
    const task = view("a", "Write it up", { status: "blocked", blocked_by: ["gone"] });
    expect(waitingOn(task, taskTitles([task]))).toEqual(["a task that is not on this board"]);
  });
});

describe("useTasks", () => {
  it("shows the project's tasks", async () => {
    const asked = bridgeListing(row("a", "Write it up"), row("b", "Read the trial"));
    const { result } = renderHook(() =>
      useTasks({ workspaceId: "workspace-1", projectId: "project-1" }),
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(titles(result.current.tasks)).toEqual(["Write it up", "Read the trial"]);
    expect(asked[0]).toEqual({ command: "kiwi.task.list", args: { project_id: "project-1" } });
  });

  it("never names a folder", async () => {
    // The main process fills in the root from the open workspace. A renderer that sent one could
    // send the wrong one, or one it was never meant to know about.
    const asked = bridgeListing(row("a", "Write it up"));
    const { result } = renderHook(() =>
      useTasks({ workspaceId: "workspace-1", projectId: "project-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.complete("a"));

    for (const call of asked) expect(call.args["root"]).toBeUndefined();
  });

  it("asks for your own work as a question about the caller, not as an account", async () => {
    const asked = bridgeListing(row("a", "Write it up"));
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1", mine: true }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(asked[0]?.args).toEqual({ mine: true });
  });

  it("reads the list again after a write, so every surface agrees", async () => {
    let listed = [row("a", "Write it up")];
    const asked = installBridge(async (command) => {
      if (command === "kiwi.task.list") return ok({ tasks: listed });
      listed = [row("a", "Write it up", { status: "done", completed_at: "2026-08-26T09:00:00Z" })];
      return ok({});
    });
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.complete("a"));
    expect(asked.map((call) => call.command)).toEqual([
      "kiwi.task.list",
      "kiwi.task.complete",
      "kiwi.task.list",
    ]);
    expect(result.current.tasks[0]?.task.status).toBe("done");
  });

  it("says what a refused wait would have looped through", async () => {
    installBridge(async (command) =>
      command === "kiwi.task.list"
        ? ok({
            tasks: [row("a", "Write it up", { blocked_by: ["c"] }), row("b", "Read the trial")],
          })
        : refused(
            "KIWI_INVALID_ARGUMENTS",
            "That would make a loop: Write it up waits for Read the trial waits for Write it up.",
          ),
    );
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let went = true;
    await act(async () => {
      went = await result.current.block("a", "b");
    });
    expect(went).toBe(false);
    expect(result.current.error).toBe(
      "That would make a loop: Write it up waits for Read the trial waits for Write it up.",
    );
    // Refused means unchanged: the task still waits for exactly what it waited for.
    expect(result.current.tasks[0]?.task.blocked_by).toEqual(["c"]);
  });

  it("adds a wait without cancelling the ones already there", async () => {
    const asked = bridgeListing(row("a", "Write it up", { blocked_by: ["c"] }), row("b", "Read"));
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.block("a", "b"));
    expect(asked.find((call) => call.command === "kiwi.task.update")?.args).toEqual({
      task_id: "a",
      blocked_by: ["c", "b"],
    });
  });

  it("treats a wait that is already recorded as recorded", async () => {
    const asked = bridgeListing(row("a", "Write it up", { blocked_by: ["b"] }));
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let went = false;
    await act(async () => {
      went = await result.current.block("a", "b");
    });
    expect(went).toBe(true);
    expect(asked.some((call) => call.command === "kiwi.task.update")).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("carries the version it read when deleting", async () => {
    const asked = bridgeListing(row("a", "Write it up"));
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.remove(result.current.tasks[0] as TaskView));
    expect(asked.find((call) => call.command === "kiwi.task.delete")?.args).toEqual({
      task_id: "a",
      expected_version: 3,
      expected_hash: "hash-a",
    });
  });

  it("does not leave one project's tasks on another project's board", async () => {
    installBridge(async (_command, args) =>
      ok({
        tasks: args["project_id"] === "project-1" ? [row("a", "Write it up")] : [row("b", "Read")],
      }),
    );
    const { result, rerender } = renderHook(
      (projectId: string) => useTasks({ workspaceId: "workspace-1", projectId }),
      { initialProps: "project-1" },
    );
    await waitFor(() => expect(titles(result.current.tasks)).toEqual(["Write it up"]));

    rerender("project-2");
    expect(result.current.tasks).toEqual([]);
    await waitFor(() => expect(titles(result.current.tasks)).toEqual(["Read"]));
  });

  it("ignores an answer to a question that is no longer being asked", async () => {
    let answerFirst = (result: RendererCommandResult): void => void result;
    installBridge(async (_command, args) =>
      args["project_id"] === "project-1"
        ? new Promise<RendererCommandResult>((resolve) => {
            answerFirst = resolve;
          })
        : ok({ tasks: [row("b", "Read")] }),
    );
    const { result, rerender } = renderHook(
      (projectId: string) => useTasks({ workspaceId: "workspace-1", projectId }),
      { initialProps: "project-1" },
    );

    rerender("project-2");
    await waitFor(() => expect(titles(result.current.tasks)).toEqual(["Read"]));

    // The first project finally answers. It is answering a question nobody is asking any more.
    await act(async () => {
      answerFirst(ok({ tasks: [row("a", "Write it up")] }));
    });
    expect(titles(result.current.tasks)).toEqual(["Read"]);
  });

  it("says the bridge is missing rather than waiting forever", async () => {
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("The desktop bridge is unavailable.");
    expect(result.current.tasks).toEqual([]);
  });

  it("puts a refusal away when it is read", async () => {
    installBridge(async (command) =>
      command === "kiwi.task.list"
        ? ok({ tasks: [row("a", "Write it up")] })
        : refused("KIWI_NOT_FOUND", "Task not found."),
    );
    const { result } = renderHook(() => useTasks({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.complete("a"));
    expect(result.current.error).toBe("Task not found.");
    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });
});
