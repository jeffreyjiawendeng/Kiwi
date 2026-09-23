import { useCallback, useEffect, useRef, useState } from "react";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  readTask,
  type ProjectPage,
  type TaskBody,
  type TaskStatus,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * Reading and writing tasks, for every surface that shows them.
 *
 * The board, the table, and the Dashboard's own work are one list asked for three ways. They
 * share this so that ticking something off means the same thing on each of them: one call, one
 * reload, one place a refusal gets its words. Three near-copies of the same six writes would
 * drift, and the first anybody would hear of it is a task that came back on one screen and not
 * on another.
 */

export interface TaskView {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  created_at: string;
  updated_at: string;
  task: TaskBody;
}

/**
 * Tasks out of a command result, read defensively.
 *
 * A row a newer build wrote, or an older one, is not a reason to show an empty page. What cannot
 * be read as a task is left out and the rest of the list still arrives, which is the difference
 * between one task missing and every task missing.
 */
export function readTaskViews(data: Record<string, unknown> | undefined): TaskView[] {
  const rows = data?.["tasks"];
  if (!Array.isArray(rows)) return [];
  const views: TaskView[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const id = entry["id"];
    const title = entry["title"];
    const version = entry["version"];
    const hash = entry["content_hash"];
    const created = entry["created_at"];
    const updated = entry["updated_at"];
    const task = readTask(entry["task"]);
    if (task === null || typeof id !== "string" || typeof title !== "string") continue;
    views.push({
      id,
      version: typeof version === "number" ? version : 1,
      content_hash: typeof hash === "string" ? hash : "",
      title,
      created_at: typeof created === "string" ? created : "",
      updated_at: typeof updated === "string" ? updated : "",
      task,
    });
  }
  return views;
}

export interface TaskColumn {
  status: TaskStatus;
  label: string;
  tasks: TaskView[];
}

/**
 * The board's columns, always all four.
 *
 * An empty column is not nothing to show: it is where work goes, and a board that hides Blocked
 * until something is blocked has nowhere to drag the first one.
 */
export function boardColumns(tasks: readonly TaskView[]): TaskColumn[] {
  return TASK_STATUSES.map((status) => ({
    status,
    label: TASK_STATUS_LABELS[status],
    tasks: tasks.filter((entry) => entry.task.status === status),
  }));
}

export function taskTitles(tasks: readonly TaskView[]): Map<string, string> {
  return new Map(tasks.map((entry) => [entry.id, entry.title]));
}

/**
 * What a task is waiting for, by name.
 *
 * A card that says it is blocked and will not say by what is a card somebody has to go looking
 * behind. A wait on something outside the list being shown -- another project's task, or one
 * that has been deleted -- is said as much rather than shown as a bare id.
 */
export function waitingOn(task: TaskView, titles: ReadonlyMap<string, string>): string[] {
  return task.task.blocked_by.map((id) => titles.get(id) ?? "a task that is not on this board");
}

export interface NewTask {
  title: string;
  assigneeId?: string | null;
  dueOn?: string | null;
  stage?: ProjectPage | null;
  notes?: string;
  /** The paper, note, or dataset the work is on. */
  forObjectId?: string;
}

/** An absent field is left as it was. Null clears the ones that can be empty. */
export interface TaskChanges {
  title?: string;
  status?: TaskStatus;
  assigneeId?: string | null;
  dueOn?: string | null;
  stage?: ProjectPage | null;
  blockedBy?: string[];
  notes?: string;
}

export interface TaskScope {
  workspaceId: string;
  /** The project whose tasks these are, or null for everything in the workspace. */
  projectId?: string | null;
  /**
   * Only work assigned to the person reading.
   *
   * Asked about the caller rather than named, because the account doing the asking is already in
   * the command's context and a renderer that had to name one could name the wrong one.
   */
  mine?: boolean;
  /** Only the tasks on one object, which is what a paper's Links dock asks for. */
  objectId?: string | null;
}

export interface TaskBoard {
  tasks: TaskView[];
  /** True until the first answer only. A reload does not blank the screen it is refreshing. */
  loading: boolean;
  busy: boolean;
  /** What the last write was refused for, in the words the command used. */
  error: string | null;
  reload(): Promise<void>;
  dismissError(): void;
  create(input: NewTask): Promise<boolean>;
  update(taskId: string, changes: TaskChanges): Promise<boolean>;
  complete(taskId: string): Promise<boolean>;
  reopen(taskId: string): Promise<boolean>;
  block(taskId: string, blockerId: string): Promise<boolean>;
  unblock(taskId: string, blockerId: string): Promise<boolean>;
  link(taskId: string, objectId: string): Promise<boolean>;
  unlink(taskId: string, objectId: string): Promise<boolean>;
  remove(task: TaskView): Promise<boolean>;
}

async function invoke(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult> {
  const bridge = readBridge();
  if (bridge === null) throw new Error("The desktop bridge is unavailable.");
  const requestId = crypto.randomUUID();
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command,
    args,
  });
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return "That did not go through. Nothing was changed.";
}

export function useTasks(scope: TaskScope): TaskBoard {
  const { workspaceId } = scope;
  const projectId = scope.projectId ?? null;
  const objectId = scope.objectId ?? null;
  const mine = scope.mine === true;

  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which read the screen is waiting for.
   *
   * Two reads can be in the air at once -- a project switched while the last one is still out,
   * a write's reload racing a manual one -- and the one that started last is the one being
   * asked about. An earlier answer landing afterwards would put back the list it replaced.
   */
  const asked = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const ticket = (asked.current += 1);
    try {
      const result = await invoke(workspaceId, "kiwi.task.list", {
        ...(projectId === null ? {} : { project_id: projectId }),
        ...(objectId === null ? {} : { object_id: objectId }),
        ...(mine ? { mine: true } : {}),
      });
      if (ticket !== asked.current) return;
      if (result.error !== undefined) setError(result.error.message);
      else {
        setTasks(readTaskViews(result.data));
        setError(null);
      }
    } catch (cause) {
      if (ticket === asked.current) setError(failureMessage(cause));
    } finally {
      if (ticket === asked.current) setLoading(false);
    }
  }, [workspaceId, projectId, objectId, mine]);

  useEffect(() => {
    // A different project's tasks are not this one's. They go now rather than sitting there
    // looking like an answer while the real one is still being asked for.
    setTasks([]);
    setLoading(true);
    void reload();
  }, [reload]);

  const run = useCallback(
    async (command: string, args: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        const result = await invoke(workspaceId, command, args);
        if (result.error !== undefined) {
          setError(result.error.message);
          return false;
        }
        await reload();
        return true;
      } catch (cause) {
        setError(failureMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, reload],
  );

  const create = useCallback(
    (input: NewTask): Promise<boolean> =>
      run("kiwi.task.create", {
        title: input.title,
        ...(input.assigneeId === undefined ? {} : { assignee_id: input.assigneeId }),
        ...(input.dueOn === undefined ? {} : { due_on: input.dueOn }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.forObjectId === undefined ? {} : { for_object_id: input.forObjectId }),
      }),
    [run],
  );

  const update = useCallback(
    (taskId: string, changes: TaskChanges): Promise<boolean> =>
      run("kiwi.task.update", {
        task_id: taskId,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.status === undefined ? {} : { status: changes.status }),
        ...(changes.assigneeId === undefined ? {} : { assignee_id: changes.assigneeId }),
        ...(changes.dueOn === undefined ? {} : { due_on: changes.dueOn }),
        ...(changes.stage === undefined ? {} : { stage: changes.stage }),
        ...(changes.blockedBy === undefined ? {} : { blocked_by: changes.blockedBy }),
        ...(changes.notes === undefined ? {} : { notes: changes.notes }),
      }),
    [run],
  );

  const complete = useCallback(
    (taskId: string): Promise<boolean> => run("kiwi.task.complete", { task_id: taskId }),
    [run],
  );

  const reopen = useCallback(
    (taskId: string): Promise<boolean> => run("kiwi.task.reopen", { task_id: taskId }),
    [run],
  );

  /**
   * Waiting is changed by sending the whole list, which is what the command takes.
   *
   * Working out the new list here is what saves a board card from having to know that adding one
   * wait means resending all of them -- and from getting it wrong, which reads as the other
   * waits being cancelled by somebody who only meant to add one.
   */
  const waiting = useCallback(
    (taskId: string, next: (blockedBy: string[]) => string[] | null): Promise<boolean> => {
      const current = tasks.find((entry) => entry.id === taskId);
      if (current === undefined) {
        setError("That task is not here any more. Reload to see what changed.");
        return Promise.resolve(false);
      }
      const blockedBy = next(current.task.blocked_by);
      // Nothing to send is not a failure: it is a wait that was already recorded.
      if (blockedBy === null) return Promise.resolve(true);
      return update(taskId, { blockedBy });
    },
    [tasks, update],
  );

  const block = useCallback(
    (taskId: string, blockerId: string): Promise<boolean> =>
      waiting(taskId, (blockedBy) =>
        blockedBy.includes(blockerId) ? null : [...blockedBy, blockerId],
      ),
    [waiting],
  );

  const unblock = useCallback(
    (taskId: string, blockerId: string): Promise<boolean> =>
      waiting(taskId, (blockedBy) =>
        blockedBy.includes(blockerId) ? blockedBy.filter((id) => id !== blockerId) : null,
      ),
    [waiting],
  );

  const link = useCallback(
    (taskId: string, objectFor: string): Promise<boolean> =>
      run("kiwi.task.link", { task_id: taskId, object_id: objectFor }),
    [run],
  );

  const unlink = useCallback(
    (taskId: string, objectFor: string): Promise<boolean> =>
      run("kiwi.task.unlink", { task_id: taskId, object_id: objectFor }),
    [run],
  );

  // Deleting is the one task write that carries a version, because it is the one that destroys
  // something somebody else may have been relying on.
  const remove = useCallback(
    (task: TaskView): Promise<boolean> =>
      run("kiwi.task.delete", {
        task_id: task.id,
        expected_version: task.version,
        expected_hash: task.content_hash,
      }),
    [run],
  );

  const dismissError = useCallback((): void => setError(null), []);

  return {
    tasks,
    loading,
    busy,
    error,
    reload,
    dismissError,
    create,
    update,
    complete,
    reopen,
    block,
    unblock,
    link,
    unlink,
    remove,
  };
}
