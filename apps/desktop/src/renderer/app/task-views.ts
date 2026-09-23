import {
  TASK_STATUSES,
  compareDueDates,
  taskDueState,
  type ProjectPage,
  type TaskBody,
  type TaskStatus,
} from "@kiwi/contracts";
import type { Assignee } from "./assignees.js";
import type { TaskChanges, TaskView } from "./tasks.js";

/**
 * What the board and the table both need, and neither of them owns.
 *
 * The two views are one list shown two ways. Everything that decides what a task says -- the words
 * a due date gets, the name an assignee gets, the props a view is handed -- lives here so that a
 * task cannot mean one thing on the board and another in the table.
 */

/**
 * What a due date says.
 *
 * The word, not the colour. Somebody reading this in greyscale, or not distinguishing red from
 * the text around it, has the same information as everybody else.
 */
export function dueLabel(task: TaskBody, today: string): string | null {
  if (task.due_on === null) return null;
  const state = taskDueState(task, today);
  if (state === "overdue") return `Overdue, was due ${task.due_on}`;
  if (state === "today") return "Due today";
  return `Due ${task.due_on}`;
}

/**
 * Who is doing it, by name.
 *
 * An assignee the workspace no longer knows about is said as much. Printing the stored id
 * instead would put a string nobody chose on a card, and it would be the one piece of a task
 * that means nothing to the person reading it.
 */
export function assigneeLabel(task: TaskBody, assignees: readonly Assignee[]): string {
  if (task.assignee_id === null) return "Unassigned";
  const found = assignees.find((assignee) => assignee.id === task.assignee_id);
  return found?.name ?? "Somebody outside this workspace";
}

export type TaskSortKey = "title" | "assignee" | "due" | "status";

/** The words `aria-sort` uses, so the header does not have to translate. */
export type SortDirection = "ascending" | "descending";

export const TASK_SORT_LABELS: Record<TaskSortKey, string> = {
  title: "Title",
  assignee: "Assignee",
  due: "Due",
  status: "Status",
};

/**
 * The table's order.
 *
 * Status sorts in the order work moves through it rather than alphabetically: Blocked before Doing
 * would be a column order nobody thinks in. Descending is the exact reverse of ascending, undated
 * tasks and all, because somebody who clicks a header twice is asking for the other end of the
 * list and not for a second set of rules. Equal rows fall back to the title so that the order does
 * not shuffle under the reader between two reads that agree.
 */
export function sortTasks(
  tasks: readonly TaskView[],
  key: TaskSortKey,
  direction: SortDirection,
  assignees: readonly Assignee[],
): TaskView[] {
  const compare = (left: TaskView, right: TaskView): number => {
    if (key === "due") return compareDueDates(left.task.due_on, right.task.due_on);
    if (key === "status")
      return TASK_STATUSES.indexOf(left.task.status) - TASK_STATUSES.indexOf(right.task.status);
    if (key === "assignee") {
      // Unassigned last, the way an undated task is last: it is the absence of an answer rather
      // than an answer beginning with U.
      const one = left.task.assignee_id === null;
      const other = right.task.assignee_id === null;
      if (one !== other) return one ? 1 : -1;
      return assigneeLabel(left.task, assignees).localeCompare(
        assigneeLabel(right.task, assignees),
      );
    }
    return 0;
  };
  const ordered = [...tasks].sort((left, right) => {
    const answer = compare(left, right);
    return answer !== 0 ? answer : left.title.localeCompare(right.title);
  });
  return direction === "ascending" ? ordered : ordered.reverse();
}

/**
 * What a view of the tasks is handed.
 *
 * Neither view reads or writes anything itself. The page above them holds the one list, the one
 * filter and the one set of writes, which is what lets the toggle between them keep the filter and
 * lets a task ticked off in either place mean the same thing.
 */
export interface TaskViewProps {
  tasks: readonly TaskView[];
  assignees: readonly Assignee[];
  /** The stages this project actually has, for the menu that puts a task on one. */
  stages: readonly ProjectPage[];
  titles: ReadonlyMap<string, string>;
  today: string;
  writable: boolean;
  busy: boolean;
  /**
   * Whether a filter is on.
   *
   * An empty page means two different things and they need different words: nothing here yet, or
   * nothing matched what you asked for.
   */
  filtered: boolean;
  /** The task whose deletion has been asked about and not yet answered. */
  confirmingDelete: string | null;
  onConfirmDelete: (taskId: string | null) => void;
  onMove: (task: TaskView, status: TaskStatus) => void;
  onChange: (taskId: string, changes: TaskChanges) => void;
  onBlock: (taskId: string, blockerId: string) => void;
  onUnblock: (taskId: string, blockerId: string) => void;
  onDelete: (task: TaskView) => void;
}
