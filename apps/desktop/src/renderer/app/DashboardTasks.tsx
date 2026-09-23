import { useMemo } from "react";
import { localDate, taskDueState } from "@kiwi/contracts";
import { useTasks } from "./tasks.js";
import { dueLabel, sortTasks } from "./task-views.js";

/**
 * Your own work, on the Dashboard.
 *
 * The board and the table answer questions about the project. This answers the one somebody has
 * about themselves when they sit down: what is mine, and what is late. It is the same list the
 * Tasks page reads, asked with `mine`, so the answer cannot disagree with the one two clicks away.
 *
 * It is a few rows and not all of them. A dashboard that reprints the board is a dashboard nobody
 * reads twice; the point of the panel is the next handful, and the way in for everything else.
 */

/**
 * How many rows this shows.
 *
 * Enough to be the next few things rather than a summary of the week. What does not fit is said
 * as a count that opens the page holding it, so nothing is hidden without saying so.
 */
const SHOWN = 5;

export interface DashboardTasksProps {
  workspaceId: string;
  projectId: string;
  writable: boolean;
  /** Today, where the person is. Passed in so a test can be about a particular day. */
  today?: string | undefined;
  onOpenTasks: () => void;
}

export function DashboardTasks({
  workspaceId,
  projectId,
  writable,
  today = localDate(new Date()),
  onOpenTasks,
}: DashboardTasksProps): React.JSX.Element {
  const board = useTasks({ workspaceId, projectId, mine: true });

  // Finished work is not work you have to do. It stays on the board, where the Done column is
  // the record of what happened; here it would push the next thing off the bottom.
  //
  // Sorting by due date never consults a name, so the empty list of assignees is the honest
  // argument and not a stub: every one of these tasks is yours already.
  const mine = useMemo(
    () =>
      sortTasks(
        board.tasks.filter((entry) => entry.task.status !== "done"),
        "due",
        "ascending",
        [],
      ),
    [board.tasks],
  );
  const shown = mine.slice(0, SHOWN);
  const rest = mine.length - shown.length;

  return (
    <section className="dashboard__tasks-panel" aria-labelledby="dashboard-tasks-title">
      <h3 id="dashboard-tasks-title">Your work</h3>

      {board.error === null ? null : (
        <p className="dashboard__quiet" role="alert">
          {board.error}
          <button type="button" onClick={board.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {board.loading ? (
        <p className="dashboard__quiet">Reading your tasks</p>
      ) : shown.length === 0 ? (
        // What is true, rather than a green tick. Nobody needs congratulating daily, but they do
        // need to be able to tell an empty panel from a panel that failed to load.
        <p className="dashboard__quiet">Nothing in this project is assigned to you.</p>
      ) : (
        <ul className="dashboard__tasks">
          {shown.map((task) => (
            <li key={task.id}>
              {/*
                A circle you tick rather than a button reading "Done". Finishing something is the
                one thing anybody does to a task from here, and a word is a strange shape for it:
                every list of things to do that anybody has ever used has a box on the left.
              */}
              <button
                type="button"
                className="dashboard__tasks-done"
                disabled={!writable || board.busy}
                onClick={() => void board.complete(task.id)}
                aria-label={`Finish ${task.title}`}
              />
              <button type="button" className="dashboard__tasks-open" onClick={onOpenTasks}>
                <span className="dashboard__tasks-title">{task.title}</span>
                {/* The word, then the colour. "Overdue" is readable in greyscale. */}
                <span data-due={taskDueState(task.task, today)}>
                  {dueLabel(task.task, today) ?? "No due date"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {rest === 0 ? null : (
        <button type="button" className="dashboard__tasks-more" onClick={onOpenTasks}>
          {rest} more →
        </button>
      )}
    </section>
  );
}
