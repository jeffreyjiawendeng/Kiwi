import { useEffect, useMemo, useRef, useState } from "react";
import {
  PROJECT_PAGE_LABELS,
  enabledProjectPages,
  localDate,
  type ProjectPage,
  type ProjectSettings,
  type TaskStatus,
} from "@kiwi/contracts";
import { useAssignees, type Assignee } from "./assignees.js";
import { TaskBoard } from "./TaskBoard.js";
import { TaskTable } from "./TaskTable.js";
import { taskTitles, useTasks, type NewTask, type TaskView } from "./tasks.js";
import type { TaskViewProps } from "./task-views.js";

/**
 * The project's tasks, as a board or as a table.
 *
 * One list, one filter, one set of writes, shown two ways. The toggle is a change of arrangement
 * and nothing else: the filter survives it, because somebody who has narrowed a list to their own
 * overdue work and then wants to see it in rows has not stopped asking the same question.
 *
 * Which view somebody last used is kept on this machine, per project. It is a preference about
 * reading rather than a fact about the research, so it does not belong in the workspace where it
 * would be everybody's.
 */

export type TaskViewMode = "board" | "table";

export function taskViewKey(workspaceId: string, projectId: string | null): string {
  return projectId === null
    ? `kiwi.tasks.view.${workspaceId}`
    : `kiwi.tasks.view.${workspaceId}.${projectId}`;
}

export function storedTaskView(workspaceId: string, projectId: string | null): TaskViewMode {
  try {
    return window.localStorage.getItem(taskViewKey(workspaceId, projectId)) === "table"
      ? "table"
      : "board";
  } catch {
    // Storage can be off entirely. A view preference is not worth failing a page over.
    return "board";
  }
}

export interface TasksPageProps {
  workspaceId: string;
  /** The project whose work this is, or null for everything in the workspace. */
  projectId: string | null;
  account: { id: string; email: string };
  settings: ProjectSettings;
  writable: boolean;
  /**
   * Today, where the person is.
   *
   * Passed in so that a test can be about a particular day rather than about the day it runs on.
   */
  today?: string;
}

export function TasksPage({
  workspaceId,
  projectId,
  account,
  settings,
  writable,
  today = localDate(new Date()),
}: TasksPageProps): React.JSX.Element {
  const [view, setView] = useState<TaskViewMode>(() => storedTaskView(workspaceId, projectId));
  const [mineOnly, setMineOnly] = useState(false);
  const [composing, setComposing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const composeReturnFocus = useRef<HTMLButtonElement>(null);

  const board = useTasks({ workspaceId, projectId, mine: mineOnly });
  const { assignees } = useAssignees({ workspaceId, account });

  const titles = useMemo(() => taskTitles(board.tasks), [board.tasks]);
  const stages = useMemo(() => enabledProjectPages(settings), [settings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(taskViewKey(workspaceId, projectId), view);
    } catch {
      // Not being able to remember the view is not a reason to stop showing it.
    }
  }, [view, workspaceId, projectId]);

  useEffect(() => {
    // A different project's board is a different set of tasks, so the question asked about the
    // last one goes with it rather than following somebody across.
    setView(storedTaskView(workspaceId, projectId));
    setMineOnly(false);
    setConfirmingDelete(null);
  }, [workspaceId, projectId]);

  async function moveTo(task: TaskView, status: TaskStatus): Promise<void> {
    if (task.task.status === status) return;
    if (status === "done") {
      await board.complete(task.id);
      return;
    }
    if (task.task.status === "done") {
      const reopened = await board.reopen(task.id);
      // Reopening decides between To do and Blocked by what the task still waits for, which is
      // a better answer than a drop can give. Only a move to some other column overrides it.
      if (!reopened || status === "todo") return;
    }
    await board.update(task.id, { status });
  }

  async function create(input: NewTask): Promise<boolean> {
    const made = await board.create(input);
    if (made) setComposing(false);
    return made;
  }

  function closeCompose(): void {
    setComposing(false);
    composeReturnFocus.current?.focus();
  }

  const shared: TaskViewProps = {
    tasks: board.tasks,
    assignees,
    stages,
    titles,
    today,
    writable,
    busy: board.busy,
    filtered: mineOnly,
    confirmingDelete,
    onConfirmDelete: setConfirmingDelete,
    onMove: (task, status) => void moveTo(task, status),
    onChange: (taskId, changes) => void board.update(taskId, changes),
    onBlock: (taskId, blockerId) => void board.block(taskId, blockerId),
    onUnblock: (taskId, blockerId) => void board.unblock(taskId, blockerId),
    onDelete: (task) => {
      setConfirmingDelete(null);
      void board.remove(task);
    },
  };

  return (
    <section className="task-board" aria-labelledby="task-board-title">
      <div className="task-board__bar" role="toolbar" aria-label="Task controls">
        <h3 id="task-board-title">
          {board.tasks.length} {board.tasks.length === 1 ? "task" : "tasks"}
          {mineOnly ? " assigned to you" : ""}
        </h3>
        <label className="task-board__filter">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(event) => setMineOnly(event.currentTarget.checked)}
          />
          Only mine
        </label>
        <div className="task-board__views" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}>
            Board
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>
        <div className="task-board__spacer" />
        <button type="button" onClick={() => void board.reload()} disabled={board.busy}>
          Refresh
        </button>
        <button
          ref={composeReturnFocus}
          className="button"
          type="button"
          disabled={!writable || board.busy}
          onClick={() => setComposing(true)}
        >
          New task
        </button>
      </div>

      {board.error === null ? null : (
        <p className="task-board__error" role="alert">
          {board.error}
          <button type="button" onClick={board.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {board.loading ? (
        <p className="task-board__quiet">Reading the tasks</p>
      ) : view === "board" ? (
        <TaskBoard {...shared} />
      ) : (
        <TaskTable {...shared} />
      )}

      {composing ? (
        <NewTaskDialog
          assignees={assignees}
          stages={stages}
          busy={board.busy}
          onCreate={create}
          onClose={closeCompose}
        />
      ) : null}
    </section>
  );
}

function NewTaskDialog({
  assignees,
  stages,
  busy,
  onCreate,
  onClose,
}: {
  assignees: readonly Assignee[];
  stages: readonly ProjectPage[];
  busy: boolean;
  onCreate: (input: NewTask) => Promise<boolean>;
  onClose: () => void;
}): React.JSX.Element {
  // Assigned to you until somebody says otherwise, which is what most tasks are, and which
  // means the Dashboard's own work is not empty for anybody who never opened this menu.
  const [assigneeId, setAssigneeId] = useState(assignees[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [stage, setStage] = useState("");
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    if (title.trim() === "") {
      setProblem("A task needs a title. It is what everybody will see it by.");
      titleRef.current?.focus();
      return;
    }
    setProblem(null);
    await onCreate({
      title: title.trim(),
      assigneeId: assigneeId === "" ? null : assigneeId,
      dueOn: dueOn === "" ? null : dueOn,
      stage: stage === "" ? null : (stage as ProjectPage),
      notes,
    });
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && event.ctrlKey && !busy) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("input, textarea, select, button") ??
        []),
    ].filter((element) => !element.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="task-dialog__backdrop">
      <div
        ref={dialogRef}
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onKeyDown={keyDown}
      >
        <header>
          <h3 id="new-task-title">New task</h3>
        </header>
        <label>
          Title
          <input
            ref={titleRef}
            value={title}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label>
          Assignee
          <select
            value={assigneeId}
            disabled={busy}
            onChange={(event) => setAssigneeId(event.currentTarget.value)}
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
          Due
          <input
            type="date"
            value={dueOn}
            disabled={busy}
            onChange={(event) => setDueOn(event.currentTarget.value)}
          />
        </label>
        <label>
          Stage
          <select
            value={stage}
            disabled={busy}
            onChange={(event) => setStage(event.currentTarget.value)}
          >
            <option value="">No stage</option>
            {stages.map((page) => (
              <option key={page} value={page}>
                {PROJECT_PAGE_LABELS[page]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea
            value={notes}
            rows={3}
            disabled={busy}
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
        </label>
        {problem === null ? null : (
          <p className="task-dialog__problem" role="alert">
            {problem}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => void submit()}>
            Add task
          </button>
        </footer>
      </div>
    </div>
  );
}
