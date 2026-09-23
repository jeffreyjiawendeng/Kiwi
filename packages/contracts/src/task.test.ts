import { describe, expect, it } from "vitest";
import {
  compareDueDates,
  completeTask,
  emptyTask,
  findBlockingCycle,
  isDueDate,
  localDate,
  readTask,
  reopenTask,
  taskDueState,
  validateTask,
  type TaskBody,
} from "./task.js";

function task(fields: Partial<TaskBody> = {}): TaskBody {
  return { ...emptyTask(), ...fields };
}

describe("when a task is due", () => {
  it("takes a day and refuses a day that does not exist", () => {
    expect(isDueDate("2026-08-31")).toBe(true);
    // A typo, not a deadline.
    expect(isDueDate("2026-02-31")).toBe(false);
    expect(isDueDate("2026-8-1")).toBe(false);
    // A due date is a date. An instant would fix it to midnight in one timezone.
    expect(isDueDate("2026-08-31T09:00:00.000Z")).toBe(false);
  });

  it("reads the day where the person is, not the day in UTC", () => {
    // Late on the 31st somewhere east of UTC is already the 1st in UTC, and a task due on the
    // 31st is not late that evening.
    expect(localDate(new Date(2026, 7, 31, 23, 30))).toBe("2026-08-31");
    expect(localDate(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
  });

  it("says whether a date has passed, is today, or is still ahead", () => {
    const today = "2026-08-26";
    expect(taskDueState(task({ due_on: "2026-08-25" }), today)).toBe("overdue");
    expect(taskDueState(task({ due_on: today }), today)).toBe("today");
    expect(taskDueState(task({ due_on: "2026-09-01" }), today)).toBe("later");
    expect(taskDueState(task(), today)).toBe("none");
  });

  it("does not call finished work late", () => {
    // Otherwise half a board carries overdue forever, and the word stops meaning anything.
    const done = task({ due_on: "2026-08-01", status: "done", completed_at: "2026-08-05" });
    expect(taskDueState(done, "2026-08-26")).toBe("none");
  });

  it("sorts the soonest first and the undated last", () => {
    const dates = ["2026-09-01", null, "2026-08-26", null, "2026-08-01"];
    expect([...dates].sort(compareDueDates)).toEqual([
      "2026-08-01",
      "2026-08-26",
      "2026-09-01",
      null,
      null,
    ]);
  });
});

describe("finishing and unfinishing", () => {
  it("stays done when it is ticked twice", () => {
    // One click on a board can arrive twice: a double tap, a retry, the same task ticked on two
    // machines. The second must not be an error, and must not move when the work was finished.
    const first = completeTask(task(), "2026-08-26T09:00:00.000Z");
    const second = completeTask(first, "2026-08-26T17:00:00.000Z");
    expect(second.completed_at).toBe("2026-08-26T09:00:00.000Z");
    expect(second).toBe(first);
  });

  it("comes back as work to do, or as waiting when it is still waiting", () => {
    const done = completeTask(task(), "2026-08-26T09:00:00.000Z");
    expect(reopenTask(done)).toMatchObject({ status: "todo", completed_at: null });
    expect(reopenTask(done, true)).toMatchObject({ status: "blocked", completed_at: null });
  });

  it("leaves unfinished work alone", () => {
    const doing = task({ status: "doing" });
    expect(reopenTask(doing)).toBe(doing);
  });
});

describe("what a task waits for", () => {
  const graph = new Map<string, readonly string[]>([
    ["write", ["analyse"]],
    ["analyse", ["collect"]],
  ]);

  it("refuses a task that would wait for itself", () => {
    expect(findBlockingCycle("write", "write", graph)).toEqual(["write", "write"]);
  });

  it("names the chain that would close", () => {
    // Collect waiting for write closes write → analyse → collect → write. Saying only that it
    // would make a cycle leaves somebody hunting three tasks on a board of forty.
    expect(findBlockingCycle("collect", "write", graph)).toEqual([
      "collect",
      "write",
      "analyse",
      "collect",
    ]);
  });

  it("allows a wait that does not come back round", () => {
    expect(findBlockingCycle("write", "collect", graph)).toBeNull();
  });

  it("finishes on a graph where two tasks wait for the same thing", () => {
    // Two paths to one task is not a cycle, and walking it must not visit it twice forever.
    const diamond = new Map<string, readonly string[]>([
      ["report", ["figures", "tables"]],
      ["figures", ["numbers"]],
      ["tables", ["numbers"]],
    ]);
    expect(findBlockingCycle("numbers", "report", diamond)).toEqual([
      "numbers",
      "report",
      "figures",
      "numbers",
    ]);
    expect(findBlockingCycle("report", "numbers", diamond)).toBeNull();
  });
});

describe("a task that can be stored", () => {
  it("accepts an ordinary one", () => {
    expect(validateTask(task({ due_on: "2026-08-31", stage: "manuscript" }))).toEqual([]);
  });

  it("objects to what cannot be shown", () => {
    const problems = validateTask(
      task({
        status: "done",
        due_on: "the 31st",
        stage: "wherever" as TaskBody["stage"],
        blocked_by: ["one", "one"],
      }),
    );
    expect(problems.map((problem) => problem.field)).toEqual([
      "completed_at",
      "due_on",
      "stage",
      "blocked_by",
    ]);
  });
});

describe("reading a stored task", () => {
  it("keeps what it can and drops what it cannot show", () => {
    const read = readTask({
      status: "doing",
      assignee_id: "account:ada",
      due_on: "next Tuesday",
      stage: "nowhere",
      blocked_by: ["one", "one", "", 4],
      notes: "Check the cohort.",
      completed_at: null,
    });
    expect(read).toEqual({
      status: "doing",
      assignee_id: "account:ada",
      // Neither of these can be compared or opened, and the board has to render regardless.
      due_on: null,
      stage: null,
      blocked_by: ["one"],
      notes: "Check the cohort.",
      completed_at: null,
    });
  });

  it("is not a task without a column to stand in", () => {
    expect(readTask({ status: "abandoned", blocked_by: [] })).toBeNull();
    expect(readTask(null)).toBeNull();
    expect(readTask([])).toBeNull();
  });
});
