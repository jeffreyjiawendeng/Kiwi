import { isAbsolute, normalize, resolve, sep } from "node:path";

export const WORKSPACE_DIRECTORIES = [
  "objects",
  "objects/projects",
  "objects/sources",
  "objects/notes",
  "objects/claims",
  "objects/protocols",
  "objects/runs",
  "objects/datasets",
  "objects/outputs",
  "relations",
  "assets",
  "templates",
  "views",
  ".kiwi",
  ".kiwi/events",
  ".kiwi/checkpoints",
  ".kiwi/trash",
  ".kiwi/transactions",
] as const;

// Windows reserves these names in every directory, with or without an extension.
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export type PathRejection =
  "not_absolute" | "reserved_name" | "trailing_dot_or_space" | "too_long" | "control_character";

export interface PathCheck {
  ok: boolean;
  reason?: PathRejection;
}

/**
 * A workspace root is user supplied. It is checked before any filesystem call so an
 * unusable path fails with a specific reason rather than an operating system error.
 */
export function checkWorkspacePath(candidate: string): PathCheck {
  if (!isAbsolute(candidate)) return { ok: false, reason: "not_absolute" };
  if (candidate.length > 240) return { ok: false, reason: "too_long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    return { ok: false, reason: "control_character" };
  }

  for (const segment of normalize(candidate).split(sep)) {
    if (segment === "") continue;
    const base = segment.split(".")[0] ?? "";
    if (RESERVED_WINDOWS_NAMES.has(base.toLowerCase())) {
      return { ok: false, reason: "reserved_name" };
    }
    if (/[ .]$/.test(segment)) return { ok: false, reason: "trailing_dot_or_space" };
  }

  return { ok: true };
}

export function canonicalRoot(candidate: string): string {
  return resolve(normalize(candidate));
}

/** True when target is the root itself or sits beneath it. */
export function isInsideRoot(root: string, target: string): boolean {
  const base = canonicalRoot(root);
  const path = canonicalRoot(target);
  return path === base || path.startsWith(base + sep);
}
