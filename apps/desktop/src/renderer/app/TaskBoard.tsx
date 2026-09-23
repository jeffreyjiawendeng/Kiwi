import { useMemo, useRef } from "react";
import {
  PROJECT_PAGE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  taskDueState,
  type ProjectPage,
  type TaskStatus,
} from "@kiwi/contracts";
import type { Assignee } from "./assignees.js";
import { boardColumns, waitingOn, type TaskView } from "./tasks.js";
import { assigneeLabel, dueLabel, type TaskViewProps } from "./task-views.js";

/**
 * The tasks as a board.
 *
 * Four columns, always all four, because a column is where work goes rather than a report of
 * work that is already there. A card can be dragged between them and can be moved with a menu
 * on the card itself: a board that only answers to dragging is a board some people cannot use,
 * and the menu is the one both a keyboard and a trackpad can reach.
 *
 * Reading and writing are not here. The page above holds them, and hands the same list and the
 * same writes to the table, so that ticking something off means the same thing wherever it was
 * ticked.
 */

export function TaskBoard({
  tasks,
  assignees,
  stages,
  titles,
  today,
  writable,
  busy,
  confirmingDelete,
  onConfirmDelete,
  onMove,
  onChange,
  onBlock,
  onUnblock,
  onDelete,
}: TaskViewProps): React.JSX.Element {
  const columns = useMemo(() => boardColumns(tasks), [tasks]);

  /**
   * The card being dragged.
   *
   * A ref rather than state: nothing on the screen changes while it is in the air, and a render
   * on every dragover event is a render for every pixel the pointer travels.
   */
  const dragging = useRef<string | null>(null);

  return (
    <div className="task-board__columns">
      {columns.map((column) => (
        <section
          key={column.status}
          className="task-board__column"
          aria-label={`${column.label}, ${column.tasks.length}`}
          onDragOver={(event) => {
            if (dragging.current !== null && writable) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const id = dragging.current;
            dragging.current = null;
            const task = tasks.find((entry) => entry.id === id);
            if (task !== undefined && writable) onMove(task, column.status);
          }}
        >
          <header>
            <strong>{column.label}</strong>
            <span>{column.tasks.length}</span>
          </header>
          {column.tasks.length === 0 ? (
            <p className="task-board__quiet">Nothing here.</p>
          ) : (
            <ul>
              {column.tasks.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    assignees={assignees}
                    stages={stages}
                    others={tasks}
                    titles={titles}
                    today={today}
                    writable={writable}
                    busy={busy}
                    confirmingDelete={confirmingDelete === task.id}
                    onConfirmDelete={() => onConfirmDelete(task.id)}
                    onCancelDelete={() => onConfirmDelete(null)}
                    onDragStart={() => {
                      dragging.current = task.id;
                    }}
                    onDragEnd={() => {
                      dragging.current = null;
                    }}
                    onMove={(status) => onMove(task, status)}
                    onChange={(changes) => onChange(task.id, changes)}
                    onBlock={(blockerId) => onBlock(task.id, blockerId)}
                    onUnblock={(blockerId) => onUnblock(task.id, blockerId)}
                    onDelete={() => onDelete(task)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  assignees,
  stages,
  others,
  titles,
  today,
  writable,
  busy,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onDragStart,
  onDragEnd,
  onMove,
  onChange,
  onBlock,
  onUnblock,
  onDelete,
}: {
  task: TaskView;
  assignees: readonly Assignee[];
  stages: readonly ProjectPage[];
  others: readonly TaskView[];
  titles: ReadonlyMap<string, string>;
  today: string;
  writable: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: TaskStatus) => void;
  onChange: (changes: {
    assigneeId?: string | null;
    dueOn?: string | null;
    stage?: ProjectPage | null;
  }) => void;
  onBlock: (blockerId: string) => void;
  onUnblock: (blockerId: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const due = dueLabel(task.task, today);
  const waiting = waitingOn(task, titles);
  const canWaitFor = others.filter(
    (entry) => entry.id !== task.id && !task.task.blocked_by.includes(entry.id),
  );

  return (
    <article
      className="task-card"
      data-status={task.task.status}
      draggable={writable && !busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <h4>{task.title}</h4>
      <p className="task-card__who">
        <span>{assigneeLabel(task.task, assignees)}</span>
        {due === null ? null : <span data-due={taskDueState(task.task, today)}>{due}</span>}
      </p>

      {waiting.length === 0 ? null : (
        <ul className="task-card__waiting" aria-label="Waiting for">
          {task.task.blocked_by.map((id, index) => (
            <li key={id}>
              <span>{waiting[index]}</span>
              <button
                type="button"
                disabled={!writable || busy}
                onClick={() => onUnblock(id)}
                aria-label={`Stop waiting for ${waiting[index] ?? "that task"}`}
              >
                Stop waiting
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="task-card__controls">
        <label>
          <span className="task-card__label">Status</span>
          <select
            value={task.task.status}
            disabled={!writable || busy}
            onChange={(event) => onMove(event.currentTarget.value as TaskStatus)}
            aria-label={`Status of ${task.title}`}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details className="task-card__more">
        <summary>Change</summary>
        <label>
          <span className="task-card__label">Assignee</span>
          <select
            value={task.task.assignee_id ?? ""}
            disabled={!writable || busy}
            onChange={(event) =>
              onChange({
                assigneeId: event.currentTarget.value === "" ? null : event.currentTarget.value,
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
        </label>
        <label>
          <span className="task-card__label">Due</span>
          <input
            type="date"
            value={task.task.due_on ?? ""}
            disabled={!writable || busy}
            onChange={(event) =>
              onChange({
                dueOn: event.currentTarget.value === "" ? null : event.currentTarget.value,
              })
            }
            aria-label={`Due date of ${task.title}`}
          />
        </label>
        <label>
          <span className="task-card__label">Stage</span>
          <select
            value={task.task.stage ?? ""}
            disabled={!writable || busy}
            onChange={(event) =>
              onChange({
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
        </label>
        <label>
          <span className="task-card__label">Wait for</span>
          <select
            value=""
            disabled={!writable || busy || canWaitFor.length === 0}
            onChange={(event) => {
              if (event.currentTarget.value !== "") onBlock(event.currentTarget.value);
            }}
            aria-label={`What ${task.title} waits for`}
          >
            <option value="">
              {canWaitFor.length === 0 ? "No other task to wait for" : "Choose a task"}
            </option>
            {canWaitFor.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        {confirmingDelete ? (
          <p className="task-card__confirm">
            {/* Deleting a task is not the same as finishing it, and the board cannot tell which
                was meant from one click on a small button. */}
            Delete this task? Finishing it is not the same thing.
            <button type="button" disabled={busy} onClick={onDelete}>
              Delete
            </button>
            <button type="button" onClick={onCancelDelete}>
              Keep it
            </button>
          </p>
        ) : (
          <button
            className="task-card__delete"
            type="button"
            disabled={!writable || busy}
            onClick={onConfirmDelete}
          >
            Delete
          </button>
        )}
      </details>
    </article>
  );
}
