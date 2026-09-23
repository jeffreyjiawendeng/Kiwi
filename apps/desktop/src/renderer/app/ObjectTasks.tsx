import { useMemo, useState } from "react";
import { TASK_STATUS_LABELS, localDate } from "@kiwi/contracts";
import { useTasks } from "./tasks.js";
import { dueLabel, sortTasks } from "./task-views.js";

/**
 * The work on one thing, beside the thing itself.
 *
 * A task is usually about something -- read this paper, check that dataset, answer the question
 * in this note -- and the board is where it is tracked, not where it is remembered. Somebody
 * looking at a paper wants to know what is outstanding on it without going to the Tasks page and
 * reading sixty rows for the four that are about what is in front of them.
 *
 * So this is the same list asked with `object_id`, and the two writes that make the connection:
 * a task made here is made on this object, and a task that exists elsewhere can be put on it.
 * Taking one off retracts the link and leaves the task alone -- the work did not stop being work
 * because it stopped being about this paper.
 */

export interface ObjectTasksProps {
  workspaceId: string;
  /** Where the picker looks for a task that already exists. Null looks across the workspace. */
  projectId?: string | null;
  objectId: string;
  /** What the object is called, for the words on a button that acts on it. */
  objectTitle: string;
  writable: boolean;
  /** Today, where the person is. Passed in so a test can be about a particular day. */
  today?: string | undefined;
}

export function ObjectTasks({
  workspaceId,
  projectId = null,
  objectId,
  objectTitle,
  writable,
  today = localDate(new Date()),
}: ObjectTasksProps): React.JSX.Element {
  const board = useTasks({ workspaceId, objectId });
  const [title, setTitle] = useState("");
  const [picking, setPicking] = useState(false);

  // Due first, the way every other list of tasks is ordered. Nothing here consults an assignee,
  // so the empty list of them is the honest argument rather than a stub.
  const rows = useMemo(() => sortTasks(board.tasks, "due", "ascending", []), [board.tasks]);
  const already = useMemo(() => new Set(board.tasks.map((entry) => entry.id)), [board.tasks]);

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const wanted = title.trim();
    // An empty title is a person who pressed the button early, not a task called nothing.
    if (wanted === "") return;
    if (await board.create({ title: wanted, forObjectId: objectId })) setTitle("");
  }

  async function attach(taskId: string): Promise<void> {
    if (await board.link(taskId, objectId)) setPicking(false);
  }

  return (
    <section className="dock__tasks" aria-labelledby="dock-tasks-title">
      <h4 id="dock-tasks-title">Work on this</h4>

      {board.error === null ? null : (
        <p className="dock__quiet" role="alert">
          {board.error}
          <button type="button" onClick={board.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {board.loading ? (
        <p className="dock__quiet">Reading the tasks on this</p>
      ) : rows.length === 0 ? (
        <p className="dock__quiet">No task is on this yet.</p>
      ) : (
        <ul className="dock__list">
          {rows.map((task) => (
            <li key={task.id}>
              <div>
                <strong>{task.title}</strong>
                {/* The state and the date, in words. A dock is too narrow for a colour to be
                    the only thing carrying either of them. */}
                <span>
                  {TASK_STATUS_LABELS[task.task.status]}
                  {dueLabel(task.task, today) === null ? "" : `, ${dueLabel(task.task, today)}`}
                </span>
              </div>
              <button
                type="button"
                disabled={!writable || board.busy}
                onClick={() => void board.unlink(task.id, objectId)}
                aria-label={`Take ${task.title} off ${objectTitle}`}
              >
                Take off
              </button>
            </li>
          ))}
        </ul>
      )}

      {!writable ? null : (
        <div className="dock__tasks-add">
          <form onSubmit={(event) => void add(event)}>
            <input
              type="text"
              value={title}
              aria-label={`A task on ${objectTitle}`}
              placeholder="Something to do about this"
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" disabled={board.busy || title.trim() === ""}>
              Add
            </button>
          </form>

          {/* The picker is only built when it is asked for. It reads every task in the project to
              fill one menu, and that is a question worth asking once somebody wants it answered
              rather than every time this dock opens on a paper. */}
          {picking ? (
            <TaskPicker
              workspaceId={workspaceId}
              projectId={projectId}
              already={already}
              busy={board.busy}
              onAttach={(taskId) => void attach(taskId)}
              onClose={() => setPicking(false)}
            />
          ) : (
            <button type="button" className="dock__tasks-pick" onClick={() => setPicking(true)}>
              Put an existing task on this
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface TaskPickerProps {
  workspaceId: string;
  projectId: string | null;
  /** What is on the object already, so the menu cannot offer a link that would be refused. */
  already: ReadonlySet<string>;
  busy: boolean;
  onAttach: (taskId: string) => void;
  onClose: () => void;
}

function TaskPicker({
  workspaceId,
  projectId,
  already,
  busy,
  onAttach,
  onClose,
}: TaskPickerProps): React.JSX.Element {
  const pool = useTasks({ workspaceId, projectId });
  const [chosen, setChosen] = useState("");

  // By title, because this is somebody looking for a task they know the name of. The board's
  // order answers what is next; a menu answers where is the one I mean.
  const choices = useMemo(
    () =>
      sortTasks(
        pool.tasks.filter((entry) => !already.has(entry.id)),
        "title",
        "ascending",
        [],
      ),
    [pool.tasks, already],
  );

  return (
    <div className="dock__tasks-picker">
      {pool.loading ? (
        <p className="dock__quiet">Reading the project's tasks</p>
      ) : choices.length === 0 ? (
        <p className="dock__quiet">Every task there is is on this already.</p>
      ) : (
        <select
          aria-label="A task to put on this"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">Choose a task</option>
          {choices.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title} ({TASK_STATUS_LABELS[task.task.status]})
            </option>
          ))}
        </select>
      )}
      <button type="button" disabled={chosen === "" || busy} onClick={() => onAttach(chosen)}>
        Put it on
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
