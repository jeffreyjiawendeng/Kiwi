import { useMemo, useState } from "react";
import {
  PROJECT_PAGE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  taskDueState,
  type ProjectPage,
  type TaskStatus,
} from "@kiwi/contracts";
import { waitingOn } from "./tasks.js";
import {
  TASK_SORT_LABELS,
  assigneeLabel,
  sortTasks,
  type SortDirection,
  type TaskSortKey,
  type TaskViewProps,
} from "./task-views.js";

/**
 * The same tasks as a table.
 *
 * The board answers "what is happening"; the table answers "what is there", which is the question
 * somebody has when they are looking for one task among sixty rather than looking at the shape of
 * the work. It is the same list, the same filter and the same writes -- only the arrangement
 * differs, so switching is a change of view and never a change of subject.
 *
 * Rows sort by one column at a time. Multi-column sort is complexity nobody asked for, and a table
 * whose order cannot be read off its header is a table people stop trusting.
 */

const SORTABLE: readonly TaskSortKey[] = ["title", "assignee", "due", "status"];

export function TaskTable({
  tasks,
  assignees,
  stages,
  titles,
  today,
  writable,
  busy,
  filtered,
  confirmingDelete,
  onConfirmDelete,
  onMove,
  onChange,
  onBlock,
  onUnblock,
  onDelete,
}: TaskViewProps): React.JSX.Element {
  // Due date first, ascending: the next thing that has to happen is the top row, which is what a
  // list of work is usually being opened to find out.
  const [sortKey, setSortKey] = useState<TaskSortKey>("due");
  const [direction, setDirection] = useState<SortDirection>("ascending");

  const rows = useMemo(
    () => sortTasks(tasks, sortKey, direction, assignees),
    [tasks, sortKey, direction, assignees],
  );

  function sortBy(key: TaskSortKey): void {
    if (key === sortKey) {
      setDirection(direction === "ascending" ? "descending" : "ascending");
      return;
    }
    setSortKey(key);
    setDirection("ascending");
  }

  if (tasks.length === 0)
    return (
      <p className="task-table__quiet">
        {/* An empty page means two different things and the difference is the whole message: one
            of them is answered by making a task and the other by clearing the filter. */}
        {filtered
          ? "No task here matches that filter."
          : "No tasks yet. New task makes the first one."}
      </p>
    );

  return (
    <div className="task-table__scroll">
      <table className="task-table">
        <caption className="sr-only">
          Tasks, sorted by {TASK_SORT_LABELS[sortKey]}, {direction}
        </caption>
        <thead>
          <tr>
            {SORTABLE.map((key) => (
              <th key={key} scope="col" aria-sort={key === sortKey ? direction : "none"}>
                <button type="button" className="task-table__sort" onClick={() => sortBy(key)}>
                  {TASK_SORT_LABELS[key]}
                  <span aria-hidden="true">
                    {key !== sortKey ? "" : direction === "ascending" ? " ▲" : " ▼"}
                  </span>
                </button>
              </th>
            ))}
            <th scope="col">Stage</th>
            <th scope="col">Waiting for</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const waiting = waitingOn(task, titles);
            const state = taskDueState(task.task, today);
            const canWaitFor = tasks.filter(
              (entry) => entry.id !== task.id && !task.task.blocked_by.includes(entry.id),
            );
            return (
              <tr key={task.id} data-status={task.task.status}>
                <th scope="row">
                  <span className="task-table__title">{task.title}</span>
                  {task.task.notes === "" ? null : (
                    <span className="task-table__notes">{task.task.notes}</span>
                  )}
                </th>
                <td>
                  <select
                    value={task.task.assignee_id ?? ""}
                    disabled={!writable || busy}
                    onChange={(event) =>
                      onChange(task.id, {
                        assigneeId:
                          event.currentTarget.value === "" ? null : event.currentTarget.value,
                      })
                    }
                    aria-label={`Assignee of ${task.title}`}
                  >
                    <option value="">Unassigned</option>
                    {assignees.map((assignee) => (
                      <option key={assignee.id} value={assignee.id}>
                        {assignee.name}
                      </option>
                    ))}
                  </select>
                  {task.task.assignee_id === null ||
                  assignees.some((assignee) => assignee.id === task.task.assignee_id) ? null : (
                    // The menu cannot show a person the workspace has never heard of, so the row
                    // says who it is rather than looking unassigned.
                    <span className="task-table__note">{assigneeLabel(task.task, assignees)}</span>
                  )}
                </td>
                <td>
                  <input
                    type="date"
                    value={task.task.due_on ?? ""}
                    disabled={!writable || busy}
                    onChange={(event) =>
                      onChange(task.id, {
                        dueOn: event.currentTarget.value === "" ? null : event.currentTarget.value,
                      })
                    }
                    aria-label={`Due date of ${task.title}`}
                  />
                  {/* The date itself is already in the field beside this, so the word is the part
                      that is worth saying. It is a word and not only a colour. */}
                  {state === "overdue" || state === "today" ? (
                    <span data-due={state}>{state === "overdue" ? "Overdue" : "Today"}</span>
                  ) : null}
                </td>
                <td>
                  <select
                    value={task.task.status}
                    disabled={!writable || busy}
                    onChange={(event) => onMove(task, event.currentTarget.value as TaskStatus)}
                    aria-label={`Status of ${task.title}`}
                  >
                    {TASK_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {TASK_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={task.task.stage ?? ""}
                    disabled={!writable || busy}
                    onChange={(event) =>
                      onChange(task.id, {
                        stage:
                          event.currentTarget.value === ""
                            ? null
                            : (event.currentTarget.value as ProjectPage),
                      })
                    }
                    aria-label={`Stage of ${task.title}`}
                  >
                    <option value="">No stage</option>
                    {stages.map((stage) => (
                      <option key={stage} value={stage}>
                        {PROJECT_PAGE_LABELS[stage]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {waiting.length === 0 ? null : (
                    <ul className="task-table__waiting" aria-label={`What ${task.title} waits for`}>
                      {task.task.blocked_by.map((id, index) => (
                        <li key={id}>
                          <span>{waiting[index]}</span>
                          <button
                            type="button"
                            disabled={!writable || busy}
                            onClick={() => onUnblock(task.id, id)}
                            aria-label={`Stop waiting for ${waiting[index] ?? "that task"}`}
                          >
                            Stop waiting
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <select
                    value=""
                    disabled={!writable || busy || canWaitFor.length === 0}
                    onChange={(event) => {
                      if (event.currentTarget.value !== "")
                        onBlock(task.id, event.currentTarget.value);
                    }}
                    aria-label={`Wait for, on ${task.title}`}
                  >
                    <option value="">
                      {canWaitFor.length === 0 ? "No other task to wait for" : "Wait for"}
                    </option>
                    {canWaitFor.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.title}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {confirmingDelete === task.id ? (
                    <span className="task-table__confirm">
                      Delete it?
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDelete(task)}
                        aria-label={`Delete ${task.title}`}
                      >
                        Delete
                      </button>
                      <button type="button" onClick={() => onConfirmDelete(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={!writable || busy}
                      onClick={() => onConfirmDelete(task.id)}
                      aria-label={`Delete ${task.title}, with a question first`}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
