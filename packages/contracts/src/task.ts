/**
 * A piece of work somebody has to do.
 *
 * A task is its own object rather than a field on the thing it is about, for the same reason a
 * thread is: one paper can carry five tasks belonging to four people, and marking one done must
 * not be a rewrite of the paper. What a task is *for* is a relation, not a field, that is what
 * makes "show me the tasks on this paper" the query the Links dock already answers rather than a
 * second index that can disagree with the first.
 */

import { isProjectPage, type ProjectPage } from "./project.js";

export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The board's columns, in order, and what each is called. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

export interface TaskBody {
  status: TaskStatus;
  /** Null is unassigned, which is different from assigned to whoever is reading. */
  assignee_id: string | null;
  /**
   * A date, not a timestamp.
   *
   * "Due Friday" is what anybody means. Storing an instant would fix the deadline to midnight in
   * whichever timezone the machine happened to have when it was typed, and move the task a day
   * when its owner got on a plane.
   */
  due_on: string | null;
  /** Which page the work belongs to, so a board can be read by stage of the project. */
  stage: ProjectPage | null;
  /** Task ids this one waits for. */
  blocked_by: string[];
  notes: string;
  /** When it was finished. Null while it is not. */
  completed_at: string | null;
}

export const TASK_LIMITS = {
  notes: 20_000,
  blocked_by: 100,
} as const;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** `2026-08-31`, and a day that exists: the 31st of February is a typo, not a deadline. */
export function isDueDate(value: unknown): value is string {
  if (typeof value !== "string" || !DUE_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The calendar date an instant falls on where the person is.
 *
 * Read locally rather than in UTC, because a due date is compared against the day somebody is
 * having. In the hours either side of midnight UTC those are different days, and the wrong one
 * would call a task overdue on the morning it is due.
 */
export function localDate(at: Date): string {
  const year = String(at.getFullYear()).padStart(4, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type TaskDueState = "none" | "overdue" | "today" | "later";

/**
 * How a due date stands against today.
 *
 * One answer for every surface. A board, a table, and the Dashboard disagreeing about whether
 * something is late would be three answers to a question with one.
 */
export function taskDueState(task: TaskBody, today: string): TaskDueState {
  // A finished task is never late. It was done, whenever that was, and saying otherwise makes
  // the word overdue useless: half a board would carry it forever.
  if (task.due_on === null || task.status === "done") return "none";
  if (task.due_on < today) return "overdue";
  return task.due_on === today ? "today" : "later";
}

/**
 * Soonest first, with no date last.
 *
 * A task nobody put a date on is not due in the year 0 and not due in the year 9999. It is not
 * due, which is a third thing, and it belongs after the dated work rather than sorted among it.
 */
export function compareDueDates(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

export function emptyTask(): TaskBody {
  return {
    status: "todo",
    assignee_id: null,
    due_on: null,
    stage: null,
    blocked_by: [],
    notes: "",
    completed_at: null,
  };
}

/**
 * Done, however many times it is asked for.
 *
 * Completing is one click on a board and one click can arrive twice, a double tap, a retry
 * after a slow save, the same task ticked on two machines. The second must not be an error, and
 * must not move `completed_at`, which is when the work was finished rather than when the last
 * click landed.
 */
export function completeTask(task: TaskBody, at: string): TaskBody {
  if (task.status === "done") return task;
  return { ...task, status: "done", completed_at: at };
}

/**
 * Not done after all.
 *
 * Whether it goes back to blocked is a fact about *other* tasks, which this file cannot read, so
 * the caller that can read them says. Guessing here would reopen a task into To do while the
 * thing it waits for is still unfinished.
 */
export function reopenTask(task: TaskBody, stillBlocked = false): TaskBody {
  if (task.status !== "done") return task;
  return { ...task, status: stillBlocked ? "blocked" : "todo", completed_at: null };
}

/**
 * The chain that would close if `waiter` were made to wait for `blocker`, or null if none would.
 *
 * The chain is returned rather than a yes: a refusal that says only "that would make a cycle"
 * leaves somebody staring at a board of forty tasks looking for three of them. The ids come back
 * in the order the waiting runs, beginning and ending with `waiter`, so the caller can name them.
 *
 * `blockedBy` is the graph as it stands, without the proposed edge.
 */
export function findBlockingCycle(
  waiter: string,
  blocker: string,
  blockedBy: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  // A task that waits for itself is the shortest cycle there is, and the one a form is likeliest
  // to produce.
  if (waiter === blocker) return [waiter, waiter];

  const path: string[] = [];
  const seen = new Set<string>();

  // Depth first from the proposed blocker, following what each task waits for. Reaching the
  // waiter means the wait already runs back to it, so adding the edge would close the loop.
  const walk = (id: string): boolean => {
    if (id === waiter) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    path.push(id);
    for (const next of blockedBy.get(id) ?? []) {
      if (walk(next)) return true;
    }
    path.pop();
    return false;
  };

  return walk(blocker) ? [waiter, ...path, waiter] : null;
}

export interface TaskProblem {
  field: keyof TaskBody;
  message: string;
}

export function validateTask(task: TaskBody): TaskProblem[] {
  const problems: TaskProblem[] = [];
  const add = (field: TaskProblem["field"], message: string) => problems.push({ field, message });

  if (!isTaskStatus(task.status)) add("status", "Choose where the task stands.");
  if (task.status === "done" && task.completed_at === null) {
    add("completed_at", "A finished task records when it was finished.");
  }
  if (task.assignee_id !== null && task.assignee_id.trim() === "") {
    add("assignee_id", "Either somebody is doing this or nobody is.");
  }
  if (task.due_on !== null && !isDueDate(task.due_on)) {
    add("due_on", "A due date is a day, written as 2026-08-31.");
  }
  if (task.stage !== null && !isProjectPage(task.stage)) {
    add("stage", "That is not a stage of the project.");
  }

  if (task.blocked_by.length > TASK_LIMITS.blocked_by) {
    add("blocked_by", `A task cannot wait for more than ${TASK_LIMITS.blocked_by} others.`);
  }
  const waitingFor = new Set<string>();
  for (const id of task.blocked_by) {
    if (id.trim() === "") {
      add("blocked_by", "A task waits for another task, not for nothing.");
      break;
    }
    if (waitingFor.has(id)) {
      add("blocked_by", "That task is already what this one is waiting for.");
      break;
    }
    waitingFor.add(id);
  }

  if (task.notes.length > TASK_LIMITS.notes) {
    add("notes", "Those notes are too long to store.");
  }
  return problems;
}

export function isTask(value: unknown): value is TaskBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<TaskBody>;
  return isTaskStatus(candidate.status) && Array.isArray(candidate.blocked_by);
}

/**
 * A stored task, read defensively.
 *
 * A file written by an older build, or merged by another machine, is not a reason to hand the
 * board a status it has no column for or a due date it cannot compare. What cannot be read is
 * replaced by the empty task's answer, which is always something the interface can show.
 */
export function readTask(value: unknown): TaskBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as Partial<TaskBody>;
  if (!isTaskStatus(stored.status)) return null;
  const blockedBy = (Array.isArray(stored.blocked_by) ? stored.blocked_by : []).filter(
    (id): id is string => typeof id === "string" && id.trim() !== "",
  );
  return {
    status: stored.status,
    assignee_id: typeof stored.assignee_id === "string" ? stored.assignee_id : null,
    due_on: isDueDate(stored.due_on) ? stored.due_on : null,
    stage: isProjectPage(stored.stage) ? stored.stage : null,
    blocked_by: [...new Set(blockedBy)],
    notes: typeof stored.notes === "string" ? stored.notes : "",
    completed_at: typeof stored.completed_at === "string" ? stored.completed_at : null,
  };
}

/** The task's searchable text: what somebody wrote about the work, not the work's title. */
export function taskContent(task: TaskBody): string {
  return task.notes;
}
