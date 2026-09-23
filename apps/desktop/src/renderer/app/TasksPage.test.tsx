import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultProjectSettings, emptyTask, type TaskBody } from "@kiwi/contracts";
import { TasksPage } from "./TasksPage.js";
import { assigneeLabel, dueLabel } from "./task-views.js";
import { forgetAssignees } from "./assignees.js";
import type {
  RendererBridge,
  RendererCommandResult,
  RendererWorkspaceCollaborationSnapshot,
} from "./bridge.js";

const account = { id: "account-1", email: "wren@example.test" };

const members: RendererWorkspaceCollaborationSnapshot = {
  workspace: { id: "workspace-1", title: "Orchard", role: "owner" },
  members: [
    {
      user_id: "account-1",
      email: "wren@example.test",
      display_name: "Wren Adeyemi",
      phone: null,
      role: "owner",
    },
    {
      user_id: "account-2",
      email: "sam@example.test",
      display_name: "Sam Okoye",
      phone: null,
      role: "editor",
    },
  ],
  invitations: [],
  projects: [],
};

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

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "request", status: "succeeded", data };
}

function refused(message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code: "KIWI_INVALID_ARGUMENTS",
      message,
      details: {},
      retryable: false,
      recovery_actions: ["correct_input"],
      correlation_id: "correlation",
    },
  };
}

/** A workspace whose tasks are `rows` and whose writes all succeed, unless `answer` says else. */
function installBridge(
  rows: Array<Record<string, unknown>>,
  answer?: (command: string, args: Record<string, unknown>) => RendererCommandResult | undefined,
): Asked[] {
  const asked: Asked[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const sent = envelope as { command: string; args: Record<string, unknown> };
    asked.push({ command: sent.command, args: sent.args });
    const given = answer?.(sent.command, sent.args);
    if (given !== undefined) return given;
    return sent.command === "kiwi.task.list" ? ok({ tasks: rows }) : ok({});
  });
  window.kiwiDesktop = {
    invokeCommand,
    manageWorkspaceCollaboration: vi.fn(async () => ({ status: "ok", settings: members })),
  } as unknown as RendererBridge;
  return asked;
}

function board(overrides: { writable?: boolean; today?: string } = {}) {
  return render(
    <TasksPage
      workspaceId="workspace-1"
      projectId="project-1"
      account={account}
      settings={defaultProjectSettings()}
      writable={overrides.writable ?? true}
      today={overrides.today ?? "2026-08-26"}
    />,
  );
}

function column(label: string): HTMLElement {
  return screen.getByRole("region", { name: new RegExp(`^${label},`, "u") });
}

beforeEach(() => {
  forgetAssignees();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("dueLabel", () => {
  it("says overdue in words rather than in colour", () => {
    const task: TaskBody = { ...emptyTask(), due_on: "2026-08-20" };
    expect(dueLabel(task, "2026-08-26")).toBe("Overdue, was due 2026-08-20");
  });

  it("names today as today and a later day as a date", () => {
    expect(dueLabel({ ...emptyTask(), due_on: "2026-08-26" }, "2026-08-26")).toBe("Due today");
    expect(dueLabel({ ...emptyTask(), due_on: "2026-09-01" }, "2026-08-26")).toBe("Due 2026-09-01");
  });

  it("says nothing about a task nobody dated", () => {
    expect(dueLabel(emptyTask(), "2026-08-26")).toBeNull();
  });
});

describe("assigneeLabel", () => {
  const assignees = [
    { id: "account:account-1", name: "Wren Adeyemi", email: "w@x.test", role: null, isSelf: true },
  ];

  it("says unassigned rather than leaving the line blank", () => {
    expect(assigneeLabel(emptyTask(), assignees)).toBe("Unassigned");
  });

  it("never puts a stored id on a card", () => {
    const task: TaskBody = { ...emptyTask(), assignee_id: "account:account-9" };
    expect(assigneeLabel(task, assignees)).toBe("Somebody outside this workspace");
  });
});

describe("the tasks page", () => {
  it("shows all four columns even when only one of them has anything in it", async () => {
    installBridge([row("a", "Write it up", { status: "doing" })]);
    board();

    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    for (const label of ["To do", "Doing", "Blocked", "Done"]) {
      expect(column(label)).toBeTruthy();
    }
    expect(within(column("Doing")).getByText("Write it up")).toBeTruthy();
    expect(within(column("To do")).getByText("Nothing here.")).toBeTruthy();
  });

  it("names the assignee and says an overdue task is overdue", async () => {
    installBridge([
      row("a", "Write it up", { assignee_id: "account:account-2", due_on: "2026-08-20" }),
    ]);
    board();

    // A span, not an option: the assignee menu on the card lists the same name.
    await waitFor(() => expect(screen.getByText("Sam Okoye", { selector: "span" })).toBeTruthy());
    expect(screen.getByText("Overdue, was due 2026-08-20")).toBeTruthy();
  });

  it("moves a card with the menu, which is the way a keyboard can", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText("Status of Write it up"), "doing");
    await waitFor(() =>
      expect(asked.find((call) => call.command === "kiwi.task.update")?.args).toEqual({
        task_id: "a",
        status: "doing",
      }),
    );
  });

  it("moves a card by dragging it to another column", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    fireEvent.dragStart(screen.getByText("Write it up").closest("article") as HTMLElement);
    fireEvent.dragOver(column("Doing"));
    fireEvent.drop(column("Doing"));

    await waitFor(() =>
      expect(asked.find((call) => call.command === "kiwi.task.update")?.args).toEqual({
        task_id: "a",
        status: "doing",
      }),
    );
  });

  it("finishes a task rather than setting its status to done", async () => {
    // Done is when the work was finished, which the command records. A status written straight
    // to done would be a finished task with no answer to when.
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText("Status of Write it up"), "done");
    await waitFor(() => expect(asked.some((c) => c.command === "kiwi.task.complete")).toBe(true));
    expect(asked.some((call) => call.command === "kiwi.task.update")).toBe(false);
  });

  it("reopens a finished task rather than moving it back by status", async () => {
    const asked = installBridge([
      row("a", "Write it up", { status: "done", completed_at: "2026-08-25T09:00:00.000Z" }),
    ]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText("Status of Write it up"), "todo");
    await waitFor(() => expect(asked.some((c) => c.command === "kiwi.task.reopen")).toBe(true));
    // Reopening already decides between To do and Blocked, by what the task still waits for.
    expect(asked.some((call) => call.command === "kiwi.task.update")).toBe(false);
  });

  it("says what a refused wait would have looped through", async () => {
    const message =
      "That would make a loop: Write it up waits for Read the trial waits for Write it up.";
    installBridge([row("a", "Write it up"), row("b", "Read the trial")], (command) =>
      command === "kiwi.task.update" ? refused(message) : undefined,
    );
    board();
    await screen.findByLabelText("What Write it up waits for");

    await userEvent.selectOptions(screen.getByLabelText("What Write it up waits for"), "b");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("names what a task is waiting for instead of showing an id", async () => {
    installBridge([
      row("a", "Write it up", { status: "blocked", blocked_by: ["b"] }),
      row("b", "Read the trial"),
    ]);
    board();

    const waiting = await screen.findByRole("list", { name: "Waiting for" });
    expect(within(waiting).getByText("Read the trial")).toBeTruthy();
    expect(within(waiting).getByRole("button", { name: "Stop waiting for Read the trial" }));
  });

  it("asks before deleting, because finishing a task is not deleting it", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(asked.some((call) => call.command === "kiwi.task.delete")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(asked.find((call) => call.command === "kiwi.task.delete")?.args).toEqual({
        task_id: "a",
        expected_version: 3,
        expected_hash: "hash-a",
      }),
    );
  });

  it("writes a new task down and closes the dialog", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    await userEvent.type(screen.getByLabelText("Title"), "Read the trial");
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(asked.find((call) => call.command === "kiwi.task.create")?.args).toEqual({
      title: "Read the trial",
      // Assigned to whoever opened the dialog, which is what most tasks are.
      assignee_id: "account:account-1",
      due_on: null,
      stage: null,
      notes: "",
    });
  });

  it("does not send a task with no title", async () => {
    const asked = installBridge([]);
    board();
    await waitFor(() => expect(screen.getByText("0 tasks")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(screen.getByRole("alert")).toHaveTextContent("A task needs a title");
    expect(asked.some((call) => call.command === "kiwi.task.create")).toBe(false);
  });

  it("asks about the caller when the board is narrowed to your own work", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.click(screen.getByLabelText("Only mine"));
    await waitFor(() =>
      expect(asked.at(-1)).toEqual({
        command: "kiwi.task.list",
        args: { project_id: "project-1", mine: true },
      }),
    );
  });

  it("shows a read-only workspace its tasks without offering to change them", async () => {
    installBridge([row("a", "Write it up")]);
    board({ writable: false });
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(screen.getByLabelText("Status of Write it up")).toBeDisabled();
  });

  it("never names a folder", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText("Status of Write it up"), "doing");
    await waitFor(() => expect(asked.length).toBeGreaterThan(1));
    for (const call of asked) expect(call.args["root"]).toBeUndefined();
  });
});

describe("the table", () => {
  /** The same page, switched to rows. The toggle is in the toolbar both views share. */
  async function showTable(): Promise<void> {
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
  }

  function titlesInOrder(): string[] {
    return screen.getAllByRole("rowheader").map((cell) => cell.textContent ?? "");
  }

  it("shows the same tasks as rows, the next thing due first", async () => {
    installBridge([
      row("a", "Write it up", { due_on: "2026-09-01" }),
      row("b", "Plan the analysis"),
      row("c", "Read the trial", { due_on: "2026-08-20" }),
    ]);
    board();
    // The heading on the card, not the text: every other card lists this one as something it
    // could wait for.
    await screen.findByRole("heading", { name: "Write it up" });

    await showTable();
    // A task with no date is not the most urgent thing on the list, so it is not the top row.
    expect(titlesInOrder()).toEqual(["Read the trial", "Write it up", "Plan the analysis"]);
    expect(screen.queryByRole("region", { name: /^To do,/u })).toBeNull();
  });

  it("sorts by the column whose header was clicked, and reverses on a second click", async () => {
    installBridge([row("a", "Write it up"), row("b", "Plan the analysis")]);
    board();
    await screen.findByRole("heading", { name: "Write it up" });
    await showTable();

    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(titlesInOrder()).toEqual(["Plan the analysis", "Write it up"]);
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(titlesInOrder()).toEqual(["Write it up", "Plan the analysis"]);
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("keeps the filter across the toggle", async () => {
    // Somebody who has narrowed the list to their own work and then wants to see it in rows has
    // not stopped asking the same question.
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());

    await userEvent.click(screen.getByLabelText("Only mine"));
    await waitFor(() => expect(asked.at(-1)?.args["mine"]).toBe(true));
    await showTable();

    expect(screen.getByLabelText("Only mine")).toBeChecked();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("1 task assigned to you")).toBeTruthy();
  });

  it("says a task is overdue in words here too", async () => {
    installBridge([row("a", "Write it up", { due_on: "2026-08-20" })]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    await showTable();

    expect(screen.getByText("Overdue")).toBeTruthy();
  });

  it("finishing a task in the table means what it means on the board", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    await showTable();

    await userEvent.selectOptions(screen.getByLabelText("Status of Write it up"), "done");
    await waitFor(() => expect(asked.some((c) => c.command === "kiwi.task.complete")).toBe(true));
    expect(asked.some((call) => call.command === "kiwi.task.update")).toBe(false);
  });

  it("asks before deleting a row, then sends the version it was looking at", async () => {
    const asked = installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    await showTable();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Write it up, with a question first" }),
    );
    expect(asked.some((call) => call.command === "kiwi.task.delete")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Delete Write it up" }));
    await waitFor(() =>
      expect(asked.find((call) => call.command === "kiwi.task.delete")?.args).toEqual({
        task_id: "a",
        expected_version: 3,
        expected_hash: "hash-a",
      }),
    );
  });

  it("tells an empty project apart from an empty filter", async () => {
    installBridge([]);
    board();
    await waitFor(() => expect(screen.getByText("0 tasks")).toBeTruthy());
    await showTable();

    expect(screen.getByText("No tasks yet. New task makes the first one.")).toBeTruthy();

    await userEvent.click(screen.getByLabelText("Only mine"));
    expect(await screen.findByText("No task here matches that filter.")).toBeTruthy();
  });

  it("opens in the view this project was last read in", async () => {
    window.localStorage.setItem("kiwi.tasks.view.workspace-1.project-1", "table");
    installBridge([row("a", "Write it up")]);
    board();

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.queryByRole("region", { name: /^To do,/u })).toBeNull();
  });

  it("remembers the view that was chosen", async () => {
    installBridge([row("a", "Write it up")]);
    board();
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    await showTable();

    expect(window.localStorage.getItem("kiwi.tasks.view.workspace-1.project-1")).toBe("table");
  });
});
