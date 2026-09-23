import { app } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import type { WorkspaceSummary } from "@kiwi/contracts";
import type { Logger } from "@kiwi/diagnostics";
import {
  acquireLock,
  fileRecentStore,
  fileTrustStore,
  releaseLock,
  type RecentStore,
  type SessionPaths,
  type TrustStore,
} from "@kiwi/workspace";

export function electronSessionPaths(): SessionPaths {
  const localRoot = join(app.getPath("userData"), "workspaces");
  return {
    workspaceState: (workspaceId) => join(localRoot, workspaceId),
    userData: () => app.getPath("userData"),
  };
}

export function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export interface WindowSession {
  windowId: number;
  summary: WorkspaceSummary;
  openedAt: string;
}

export interface SessionRegistry {
  bind(windowId: number, summary: WorkspaceSummary): Promise<BindResult>;
  release(windowId: number): Promise<void>;
  forWindow(windowId: number): WindowSession | null;
  openWorkspaceIds(): string[];
  /** The root of an open workspace, or null when it is not open in this process. */
  rootFor(workspaceId: string): string | null;
  trust: TrustStore;
  recent: RecentStore;
}

export type BindResult =
  { bound: true; session: WindowSession } | { bound: false; reason: "locked"; heldByPid: number };

/**
 * One workspace is active per window. A workspace already open in this application is
 * shared rather than locked twice, but a workspace held by another Kiwi process is
 * refused so two processes cannot write the same canonical files.
 */
export function createSessionRegistry(
  paths: SessionPaths,
  logger: Logger,
  isAlive: (pid: number) => boolean = processIsAlive,
): SessionRegistry {
  const byWindow = new Map<number, WindowSession>();

  function windowsUsing(workspaceId: string, exceptWindowId?: number): number[] {
    return [...byWindow.entries()]
      .filter(
        ([id, session]) => session.summary.workspaceId === workspaceId && id !== exceptWindowId,
      )
      .map(([id]) => id);
  }

  return {
    trust: fileTrustStore(paths),
    recent: fileRecentStore(paths),

    async bind(windowId, summary) {
      const previous = byWindow.get(windowId);
      if (previous !== undefined && previous.summary.workspaceId !== summary.workspaceId) {
        await this.release(windowId);
      }

      if (summary.workspaceId !== "" && windowsUsing(summary.workspaceId, windowId).length === 0) {
        const result = await acquireLock(
          paths,
          {
            workspaceId: summary.workspaceId,
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            host: hostname(),
          },
          isAlive,
        );

        if (!result.acquired) {
          logger.warn("workspace.locked", { held_by_pid: result.heldBy?.pid ?? 0 });
          return { bound: false, reason: "locked", heldByPid: result.heldBy?.pid ?? 0 };
        }
      }

      const session: WindowSession = {
        windowId,
        summary,
        openedAt: new Date().toISOString(),
      };
      byWindow.set(windowId, session);
      logger.info("workspace.bound", {
        window_id: windowId,
        workspace_status: summary.status,
        writable: summary.writable,
      });
      return { bound: true, session };
    },

    async release(windowId) {
      const session = byWindow.get(windowId);
      if (session === undefined) return;
      byWindow.delete(windowId);

      const { workspaceId } = session.summary;
      if (workspaceId !== "" && windowsUsing(workspaceId).length === 0) {
        await releaseLock(paths, workspaceId);
      }
      logger.info("workspace.released", { window_id: windowId });
    },

    forWindow(windowId) {
      return byWindow.get(windowId) ?? null;
    },

    openWorkspaceIds() {
      return [...new Set([...byWindow.values()].map((session) => session.summary.workspaceId))]
        .filter((id) => id !== "")
        .sort();
    },

    rootFor(workspaceId) {
      if (workspaceId === "") return null;
      for (const session of byWindow.values()) {
        if (session.summary.workspaceId === workspaceId) return session.summary.root;
      }
      return null;
    },
  };
}
