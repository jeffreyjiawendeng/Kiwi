import { useEffect, useState } from "react";
import { readBridge, type RendererWorkspaceCollaborationSnapshot } from "./bridge.js";

/**
 * The last thing the account service said about a workspace, and when it said it.
 *
 * Two surfaces ask for this and neither of them owns it: the assignee menu, which needs names to
 * put on tasks, and the Members page, which is the roster itself. Kept in one place so that the
 * second one to ask opens with the answer already in it rather than replaying the same wait.
 *
 * It lives for as long as the window does and no longer. Writing an access list to disk is a
 * different decision -- it would have to be cleared on sign-out, kept out of backups, and thought
 * about per account -- and it is not made here. The cost is that a window opened offline has
 * nothing to show, which is the honest state on a machine that has not spoken to the service since
 * it started.
 */

export interface RememberedSnapshot {
  snapshot: RendererWorkspaceCollaborationSnapshot;
  /** When it was answered. Anything shown from here has to say this, or it is passing for current. */
  at: Date;
}

const remembered = new Map<string, RememberedSnapshot>();

export function rememberCollaborationSnapshot(
  workspaceId: string,
  snapshot: RendererWorkspaceCollaborationSnapshot,
  at: Date,
): void {
  remembered.set(workspaceId, { snapshot, at });
}

export function recallCollaborationSnapshot(workspaceId: string): RememberedSnapshot | null {
  return remembered.get(workspaceId) ?? null;
}

/** Forgets what the workspaces answered. For tests, and for signing out. */
export function forgetCollaborationSnapshots(): void {
  remembered.clear();
}

/**
 * The roster for a workspace, asked for once and shared by everything that needs names.
 *
 * Three surfaces read it and none of them owns it: the assignee menu, the Members page, and the
 * presence row. Asking here rather than in each of them is what keeps three copies of the same
 * request from going out when a window opens, and what lets the second surface to be opened start
 * with everybody already in it.
 *
 * A service that cannot be reached answers `null`, which every caller has to handle anyway: a
 * window opened offline has never had an answer to hold on to.
 */
export function useCollaborationSnapshot(
  workspaceId: string,
): RendererWorkspaceCollaborationSnapshot | null {
  const [answered, setAnswered] = useState<{
    workspaceId: string;
    settings: RendererWorkspaceCollaborationSnapshot;
  } | null>(null);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null || workspaceId === "") return;
    let active = true;
    void (async () => {
      try {
        const result = await bridge.manageWorkspaceCollaboration({
          action: "snapshot",
          input: { workspace_id: workspaceId },
        });
        if (!active || result.status !== "ok") return;
        rememberCollaborationSnapshot(workspaceId, result.settings, new Date());
        setAnswered({ workspaceId, settings: result.settings });
      } catch {
        // An unreachable service is not a failure of this list. It is a smaller list, which is
        // the honest answer offline, and the caller has nothing useful to do about it.
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  // A workspace that has just been switched to must not be shown the last one's people, so what
  // was answered counts only while it is about the workspace being asked about.
  return (
    (answered?.workspaceId === workspaceId ? answered.settings : undefined) ??
    recallCollaborationSnapshot(workspaceId)?.snapshot ??
    null
  );
}
