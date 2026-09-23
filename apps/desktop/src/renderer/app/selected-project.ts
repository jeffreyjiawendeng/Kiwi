import type { ProjectTarget } from "./ProjectHome.js";

/**
 * Which project was open when Kiwi last closed.
 *
 * Persisted so that signing in returns to the work rather than to a chooser. Home is a screen
 * above the projects, not a step on the way into one.
 *
 * It lives in its own file because a second window reads it too. A detached document has to
 * resolve the same project settings its parent is showing -- a citation style that differs
 * between two windows on one manuscript is two windows disagreeing about the paper.
 */
export const SELECTED_PROJECT_KEY = "kiwi.project.selected";

export function readSelectedProject(): ProjectTarget | null {
  try {
    const raw = window.localStorage.getItem(SELECTED_PROJECT_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<ProjectTarget>;
    return typeof value.workspaceId === "string" &&
      typeof value.root === "string" &&
      typeof value.projectId === "string"
      ? { workspaceId: value.workspaceId, root: value.root, projectId: value.projectId }
      : null;
  } catch {
    return null;
  }
}

export function writeSelectedProject(target: ProjectTarget | null): void {
  try {
    if (target === null) window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    else window.localStorage.setItem(SELECTED_PROJECT_KEY, JSON.stringify(target));
  } catch {
    // A browser profile that refuses storage still has to run. The cost is landing on Home.
  }
}
