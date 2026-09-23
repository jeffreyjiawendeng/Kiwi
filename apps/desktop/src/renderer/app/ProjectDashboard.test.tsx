import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultProjectSettings, emptyTask, type TaskBody } from "@kiwi/contracts";
import { ProjectDashboard, type DashboardMember } from "./ProjectDashboard.js";
import type { RendererBridge } from "./bridge.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const TODAY = "2026-08-25";
const PROJECT = "project-1";
const ACCOUNT = { id: "account-1", email: "wren@example.test" };

function task(id: string, title: string, body: Partial<TaskBody> = {}): Record<string, unknown> {
  return {
    id,
    version: 2,
    content_hash: `hash-${id}`,
    title,
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    task: { ...emptyTask(), ...body },
  };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

interface Harness {
  counts?: Record<string, number>;
  members?: DashboardMember[];
  conflicts?: unknown[];
  threads?: unknown[];
  tasks?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
}

function installBridge({
  counts = {},
  members = [],
  conflicts = [],
  threads = [],
  tasks = [],
  events = [],
}: Harness = {}) {
  const invokeCommand = vi.fn(async (raw: unknown) => {
    const command = (raw as { command: string }).command;
    const data =
      command === "kiwi.project.members"
        ? { objects: members, total: members.length }
        : command === "kiwi.event.list"
          ? { entries: events, matched: events.length, actors: [], event_types: [] }
          : command === "kiwi.project.list"
            ? { projects: [{ id: PROJECT, counts }] }
            : command === "kiwi.thread.list"
              ? { threads }
              : command.startsWith("kiwi.task.")
                ? { tasks }
                : { conflicts };
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

function mount(props: Record<string, unknown> = {}) {
  const onOpenPage = vi.fn();
  const onOpenObject = vi.fn();
  const onQuickCapture = vi.fn();
  const onImportFile = vi.fn();
  render(
    <ProjectDashboard
      workspaceId="workspace-1"
      projectId={PROJECT}
      projectTitle="Ribosome assembly"
      settings={defaultProjectSettings()}
      writable
      now={NOW}
      onOpenPage={onOpenPage}
      onOpenObject={onOpenObject}
      onQuickCapture={onQuickCapture}
      onImportFile={onImportFile}
      {...props}
    />,
  );
  return { onOpenPage, onOpenObject, onQuickCapture, onImportFile };
}

describe("where the project stands", () => {
  it("counts what the project holds, in the reader's words", async () => {
    installBridge({ counts: { source: 12, note: 1 } });
    mount();
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("Papers")).toBeInTheDocument();
    // One note, not "1 Notes".
    expect(screen.getByText("Note")).toBeInTheDocument();
  });

  it("shows zero rather than hiding a page that is on", async () => {
    installBridge();
    mount();
    const stand = await screen.findByRole("region", { name: "Where this project stands" });
    expect(stand.textContent).toContain("Papers");
  });

  it("says nothing about a page the project has switched off", async () => {
    // A project that runs no analyses should not be told it has no runs.
    installBridge({ counts: { run: 3 } });
    mount();
    const stand = await screen.findByRole("region", { name: "Where this project stands" });
    expect(stand.textContent).not.toContain("Runs");
  });

  it("counts a page once the project turns it on", async () => {
    installBridge({ counts: { run: 3 } });
    mount({ settings: defaultProjectSettings("quantitative") });
    const stand = await screen.findByRole("region", { name: "Where this project stands" });
    await waitFor(() => expect(stand.textContent).toContain("Runs"));
  });

  it("opens the page a count belongs to", async () => {
    installBridge({ counts: { source: 4 } });
    const { onOpenPage } = mount();
    await userEvent.click(await screen.findByRole("button", { name: /Papers/u }));
    expect(onOpenPage).toHaveBeenCalledWith("library");
  });
});

describe("getting started", () => {
  it("offers the first actions, and disables the ones a read-only workspace cannot do", async () => {
    installBridge();
    mount({ writable: false });
    expect(await screen.findByRole("button", { name: "Import a paper" })).toBeDisabled();
    // Reading the manuscript is not writing to it.
    expect(screen.getByRole("button", { name: "Open the manuscript" })).toBeEnabled();
  });

  it("does not repeat the rail", async () => {
    // Notes is one click away in the rail. An action that duplicates the rail makes the rail
    // look optional.
    installBridge();
    mount();
    await screen.findByRole("button", { name: "Import a paper" });
    expect(screen.queryByRole("button", { name: "Open Notes" })).not.toBeInTheDocument();
  });

  it("runs the action that was chosen", async () => {
    installBridge();
    const { onImportFile, onQuickCapture } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Import a paper" }));
    await userEvent.click(screen.getByRole("button", { name: "Capture a thought" }));
    expect(onImportFile).toHaveBeenCalled();
    expect(onQuickCapture).toHaveBeenCalled();
  });
});

describe("what needs attention", () => {
  it("says so when nothing does", async () => {
    installBridge();
    mount();
    expect(await screen.findByText("Nothing is waiting on you.")).toBeInTheDocument();
  });

  const broken: DashboardMember = {
    id: "paper-1",
    type: "source",
    title: "Smith 2024",
    updated_at: "2026-08-25T09:00:00.000Z",
  };

  it("makes a conflict an actionable row rather than a number", async () => {
    // A count tells somebody there is a problem and nothing about which problem.
    installBridge({
      members: [broken],
      conflicts: [{ id: "conflict-1", object_id: "paper-1", status: "unresolved" }],
    });
    const { onOpenObject } = mount();

    const panel = await screen.findByRole("region", { name: "Needs attention" });
    await userEvent.click(within(panel).getByRole("button", { name: /Smith 2024/u }));

    expect(onOpenObject).toHaveBeenCalledWith("paper-1", "source");
    expect(
      within(panel).getByText("Two versions of this. Choose which one stands."),
    ).toBeInTheDocument();
  });

  it("does not count what is already on the screen", async () => {
    // "1 conflict waiting on you" above a list of one conflict is a sentence telling somebody
    // what they can see.
    installBridge({
      members: [broken],
      conflicts: [{ id: "conflict-1", object_id: "paper-1", status: "unresolved" }],
    });
    mount();

    const panel = await screen.findByRole("region", { name: "Needs attention" });
    await waitFor(() => expect(within(panel).getByText("Smith 2024")).toBeInTheDocument());
    expect(panel.textContent).not.toContain("waiting on you.");
  });

  it("names the object a comment is waiting on", async () => {
    installBridge({
      members: [broken],
      threads: [
        { id: "thread-1", title: "About the method", thread: { anchor: { object_id: "paper-1" } } },
      ],
    });
    const { onOpenObject } = mount();

    const panel = await screen.findByRole("region", { name: "Needs attention" });
    await userEvent.click(within(panel).getByRole("button", { name: /Smith 2024/u }));

    expect(onOpenObject).toHaveBeenCalledWith("paper-1", "source");
    expect(within(panel).getByText("A comment here is waiting on you.")).toBeInTheDocument();
  });

  it("asks about the reader rather than naming them, and only about this project", async () => {
    const invoked = installBridge({
      members: [broken],
      threads: [
        { id: "thread-1", title: "About the method", thread: { anchor: { object_id: "paper-1" } } },
      ],
    });
    mount();
    await screen.findByText("A comment here is waiting on you.");
    const asked = invoked.mock.calls
      .map(([raw]) => raw as { command: string; args: Record<string, unknown> })
      .find((call) => call.command === "kiwi.thread.list");
    expect(asked?.args).toEqual({ project_id: PROJECT, status: "open", involving_me: true });
  });
});

describe("recently changed", () => {
  it("is not a second panel saying what the activity feed says", async () => {
    // Two lists of the same objects in different orders, one above the other, is one list and a
    // reason to distrust both.
    installBridge({
      members: [
        {
          id: "object-1",
          type: "source",
          title: "Smith 2024",
          updated_at: "2026-08-24T08:00:00.000Z",
        },
      ],
    });
    mount();
    await screen.findByRole("region", { name: "Where this project stands" });
    expect(screen.queryByRole("region", { name: "Recently changed" })).not.toBeInTheDocument();
  });
});

describe("the project itself", () => {
  it("names the project and what it is about", async () => {
    installBridge();
    mount({
      settings: { ...defaultProjectSettings(), description: "How the subunits come together" },
    });
    expect(screen.getByRole("heading", { name: "Ribosome assembly" })).toBeInTheDocument();
    expect(await screen.findByText("How the subunits come together")).toBeInTheDocument();
  });

  it("survives a bridge that is not there", async () => {
    delete window.kiwiDesktop;
    mount();
    expect(
      await screen.findByRole("region", { name: "Where this project stands" }),
    ).toBeInTheDocument();
  });
});

describe("your own work", () => {
  function withTasks(tasks: Array<Record<string, unknown>>, props: Record<string, unknown> = {}) {
    const invoked = installBridge({ tasks });
    const handles = mount({ account: ACCOUNT, today: TODAY, ...props });
    return { invoked, ...handles };
  }

  async function rowsInOrder(): Promise<string[]> {
    const panel = await screen.findByRole("region", { name: "Your work" });
    return within(panel)
      .getAllByRole("listitem")
      .map((row) => row.textContent ?? "");
  }

  it("puts the next thing at the top and the undated work at the bottom", async () => {
    withTasks([
      task("a", "Email the lab"),
      task("b", "Read the Hopper paper", { due_on: "2026-08-28" }),
      task("c", "Write the methods", { due_on: "2026-08-26" }),
    ]);
    const rows = await rowsInOrder();
    expect(rows[0]).toContain("Write the methods");
    expect(rows[1]).toContain("Read the Hopper paper");
    // Not due is a third thing, and it goes after the dated work rather than among it.
    expect(rows[2]).toContain("Email the lab");
  });

  it("says overdue in a word rather than in a colour", async () => {
    withTasks([task("a", "Write the methods", { due_on: "2026-08-20" })]);
    expect(await screen.findByText("Overdue, was due 2026-08-20")).toBeInTheDocument();
  });

  it("leaves finished work on the board where it belongs", async () => {
    withTasks([
      task("a", "Write the methods", { status: "done" }),
      task("b", "Email the lab", { due_on: "2026-08-26" }),
    ]);
    const rows = await rowsInOrder();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Email the lab");
  });

  it("asks for the reader's own tasks, in this project", async () => {
    const { invoked } = withTasks([task("a", "Email the lab")]);
    await screen.findByRole("region", { name: "Your work" });
    const asked = invoked.mock.calls
      .map(([raw]) => raw as { command: string; args: Record<string, unknown> })
      .find((call) => call.command === "kiwi.task.list");
    // Asked about the caller rather than named: the renderer has no business naming an account.
    expect(asked?.args).toEqual({ project_id: PROJECT, mine: true });
  });

  it("finishes a task from the Dashboard", async () => {
    const { invoked } = withTasks([task("a", "Write the methods", { due_on: "2026-08-26" })]);
    await userEvent.click(await screen.findByRole("button", { name: "Finish Write the methods" }));
    const asked = invoked.mock.calls
      .map(([raw]) => raw as { command: string; args: Record<string, unknown> })
      .filter((call) => call.command === "kiwi.task.complete");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.args).toEqual({ task_id: "a" });
  });

  it("cannot finish anything in a workspace that cannot be written to", async () => {
    withTasks([task("a", "Write the methods")], { writable: false });
    expect(await screen.findByRole("button", { name: "Finish Write the methods" })).toBeDisabled();
  });

  it("shows the next few and counts the rest, which is a way in and not a hidden remainder", async () => {
    const { onOpenPage } = withTasks(
      Array.from({ length: 7 }, (_, index) =>
        task(`task-${index}`, `Task ${index}`, { due_on: `2026-08-2${index}` }),
      ),
    );
    expect(await rowsInOrder()).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "2 more →" }));
    expect(onOpenPage).toHaveBeenCalledWith("tasks");
  });

  it("opens the Tasks page on the task that was clicked", async () => {
    const { onOpenPage } = withTasks([task("a", "Write the methods")]);
    // The row itself, not the Done beside it: they say the same words and mean opposite things.
    await userEvent.click(await screen.findByRole("button", { name: /^Write the methods/u }));
    expect(onOpenPage).toHaveBeenCalledWith("tasks");
  });

  it("says an empty panel is empty rather than leaving a blank box", async () => {
    withTasks([]);
    expect(
      await screen.findByText("Nothing in this project is assigned to you."),
    ).toBeInTheDocument();
  });

  it("says nothing about your work when Kiwi does not know who you are", async () => {
    installBridge({ tasks: [task("a", "Write the methods")] });
    mount();
    await screen.findByRole("region", { name: "Where this project stands" });
    expect(screen.queryByRole("region", { name: "Your work" })).not.toBeInTheDocument();
  });
});

describe("what has been happening", () => {
  const paper: DashboardMember = {
    id: "paper-1",
    type: "source",
    title: "Smith 2024",
    updated_at: "2026-08-25T09:00:00.000Z",
  };
  const note: DashboardMember = {
    id: "note-1",
    type: "note",
    title: "Reading notes",
    updated_at: "2026-08-25T08:00:00.000Z",
  };

  function activity(over: Record<string, unknown> = {}) {
    return {
      id: "event-1",
      event_type: "object.saved",
      occurred_at: "2026-08-25T11:00:00.000Z",
      actor: "account:ana",
      transaction_id: "transaction-1",
      object_ids: ["paper-1"],
      object_type: "source",
      version: 2,
      reason: null,
      ...over,
    };
  }

  it("names what happened, to what, and who did it", async () => {
    installBridge({ members: [paper], events: [activity()] });
    mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(panel).getByText("Smith 2024")).toBeInTheDocument());
    expect(within(panel).getByText(/object saved · ana/u)).toBeInTheDocument();
  });

  it("leaves out what happened elsewhere in the workspace", async () => {
    installBridge({
      members: [paper],
      events: [activity(), activity({ id: "e2", object_ids: ["paper-9"] })],
    });
    mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
  });

  it("leaves narrowing the log to the page that is for reading it", async () => {
    // A pair of select boxes over eight rows is a control for a problem eight rows cannot have.
    installBridge({
      members: [paper, note],
      events: [activity(), activity({ id: "e2", object_ids: ["note-1"] })],
    });
    mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(2));
    expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("opens the object a line is about", async () => {
    installBridge({ members: [paper], events: [activity()] });
    const { onOpenObject } = mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(panel).getByText("Smith 2024")).toBeInTheDocument());
    await userEvent.click(within(panel).getByRole("button", { name: /Smith 2024/u }));

    expect(onOpenObject).toHaveBeenCalledWith("paper-1", "source");
  });

  it("sends the rest of the log to the page that is for reading it", async () => {
    installBridge({ members: [paper], events: [activity()] });
    const { onOpenPage } = mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    await userEvent.click(within(panel).getByRole("button", { name: "History →" }));

    expect(onOpenPage).toHaveBeenCalledWith("history");
  });

  it("says a new project is new rather than showing an empty list", async () => {
    installBridge();
    mount();

    const panel = await screen.findByRole("region", { name: "Recent activity" });
    expect(
      await within(panel).findByText("Nothing has happened in this project yet."),
    ).toBeInTheDocument();
  });
});
