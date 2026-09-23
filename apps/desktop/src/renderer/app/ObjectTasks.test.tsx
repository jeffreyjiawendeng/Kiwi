import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyTask, type TaskBody } from "@kiwi/contracts";
import { ObjectTasks } from "./ObjectTasks.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const WORKSPACE = "workspace-1";
const PROJECT = "project-1";
const OBJECT = "object-1";
const TITLE = "Kwon 2024";
const TODAY = "2026-08-26";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

function row(id: string, title: string, task: Partial<TaskBody> = {}): Record<string, unknown> {
  return {
    id,
    version: 2,
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

/**
 * A workspace where `on` is what is on the object and `pool` is what the project holds.
 *
 * The two lists are told apart by the argument they were asked with, which is the same thing the
 * service does: one command, filtered two ways.
 */
function installBridge(
  on: Array<Record<string, unknown>>,
  pool: Array<Record<string, unknown>> = [],
  answer?: (command: string, args: Record<string, unknown>) => RendererCommandResult | undefined,
): Asked[] {
  const asked: Asked[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const sent = envelope as { command: string; args: Record<string, unknown> };
    asked.push({ command: sent.command, args: sent.args });
    const given = answer?.(sent.command, sent.args);
    if (given !== undefined) return given;
    if (sent.command !== "kiwi.task.list") return ok({});
    return ok({ tasks: sent.args["object_id"] === undefined ? pool : on });
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return asked;
}

function dock(writable = true) {
  return render(
    <ObjectTasks
      workspaceId={WORKSPACE}
      projectId={PROJECT}
      objectId={OBJECT}
      objectTitle={TITLE}
      writable={writable}
      today={TODAY}
    />,
  );
}

async function tasksOnIt(): Promise<string[]> {
  const panel = await screen.findByRole("region", { name: "Work on this" });
  return within(panel)
    .getAllByRole("listitem")
    .map((entry) => entry.textContent ?? "");
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("the work on one object", () => {
  it("asks for the tasks on this object and no others", async () => {
    const asked = installBridge([row("a", "Check the sample size")]);
    dock();

    await screen.findByText("Check the sample size");
    const list = asked.filter((call) => call.command === "kiwi.task.list");
    expect(list).toHaveLength(1);
    expect(list[0]?.args).toEqual({ object_id: OBJECT });
  });

  it("says what state a task is in and when it is due, in words", async () => {
    installBridge([row("a", "Check the sample size", { status: "doing", due_on: "2026-08-20" })]);
    dock();

    expect(await tasksOnIt()).toEqual([
      "Check the sample sizeDoing, Overdue, was due 2026-08-20Take off",
    ]);
  });

  it("tells an object with no work on it from one that has not loaded", async () => {
    installBridge([]);
    dock();

    expect(await screen.findByText("No task is on this yet.")).toBeTruthy();
  });

  it("makes a new task on the object it is beside", async () => {
    const asked = installBridge([]);
    dock();
    await screen.findByText("No task is on this yet.");

    await userEvent.type(
      screen.getByRole("textbox", { name: `A task on ${TITLE}` }),
      "Read the appendix",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    const made = asked.filter((call) => call.command === "kiwi.task.create");
    expect(made).toHaveLength(1);
    expect(made[0]?.args).toEqual({ title: "Read the appendix", for_object_id: OBJECT });
  });

  it("empties the box once the task is made, so the next one starts blank", async () => {
    installBridge([]);
    dock();
    await screen.findByText("No task is on this yet.");

    const box = screen.getByRole("textbox", { name: `A task on ${TITLE}` });
    await userEvent.type(box, "Read the appendix");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect((box as HTMLInputElement).value).toBe(""));
  });

  it("will not make a task out of an empty box", async () => {
    installBridge([]);
    dock();
    await screen.findByText("No task is on this yet.");

    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("takes a task off the object without touching the task", async () => {
    const asked = installBridge([row("a", "Check the sample size")]);
    dock();

    await userEvent.click(
      await screen.findByRole("button", { name: `Take Check the sample size off ${TITLE}` }),
    );

    const off = asked.filter((call) => call.command === "kiwi.task.unlink");
    expect(off).toHaveLength(1);
    expect(off[0]?.args).toEqual({ task_id: "a", object_id: OBJECT });
    expect(asked.some((call) => call.command === "kiwi.task.delete")).toBe(false);
  });

  it("only reads the project's tasks once somebody wants to choose one", async () => {
    const asked = installBridge([], [row("b", "Write the methods")]);
    dock();
    await screen.findByText("No task is on this yet.");

    expect(asked.filter((call) => call.command === "kiwi.task.list")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Put an existing task on this" }));

    await waitFor(() =>
      expect(asked.filter((call) => call.command === "kiwi.task.list")).toHaveLength(2),
    );
    expect(asked[asked.length - 1]?.args).toEqual({ project_id: PROJECT });
  });

  it("does not offer a task that is on the object already", async () => {
    installBridge(
      [row("a", "Check the sample size")],
      [row("a", "Check the sample size"), row("b", "Write the methods")],
    );
    dock();
    await screen.findByText("Check the sample size");

    await userEvent.click(screen.getByRole("button", { name: "Put an existing task on this" }));

    const menu = await screen.findByRole("combobox", { name: "A task to put on this" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((choice) => choice.textContent),
    ).toEqual(["Choose a task", "Write the methods (To do)"]);
  });

  it("puts an existing task on the object and closes the menu", async () => {
    const asked = installBridge([], [row("b", "Write the methods")]);
    dock();
    await screen.findByText("No task is on this yet.");

    await userEvent.click(screen.getByRole("button", { name: "Put an existing task on this" }));
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "A task to put on this" }),
      "b",
    );
    await userEvent.click(screen.getByRole("button", { name: "Put it on" }));

    const put = asked.filter((call) => call.command === "kiwi.task.link");
    expect(put).toHaveLength(1);
    expect(put[0]?.args).toEqual({ task_id: "b", object_id: OBJECT });
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "A task to put on this" })).toBeNull(),
    );
  });

  it("says why a link was refused, in the words the command used", async () => {
    installBridge([], [row("b", "Write the methods")], (command) =>
      command === "kiwi.task.link" ? refused("That task is already on this.") : undefined,
    );
    dock();
    await screen.findByText("No task is on this yet.");

    await userEvent.click(screen.getByRole("button", { name: "Put an existing task on this" }));
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "A task to put on this" }),
      "b",
    );
    await userEvent.click(screen.getByRole("button", { name: "Put it on" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That task is already on this.");
  });

  it("shows the work on a read-only object without offering to change it", async () => {
    installBridge([row("a", "Check the sample size")]);
    dock(false);

    await screen.findByText("Check the sample size");
    expect(
      screen
        .getByRole("button", { name: `Take Check the sample size off ${TITLE}` })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("textbox", { name: `A task on ${TITLE}` })).toBeNull();
    expect(screen.queryByRole("button", { name: "Put an existing task on this" })).toBeNull();
  });
});
