import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_FILENAME,
  permitsMutation,
  type TrustLevel,
  type WorkspaceManifest,
  type WorkspaceProblem,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "@kiwi/contracts";
import { writeFileAtomic, writeFileExclusive } from "./atomic.js";
import { newManifest, readManifest, serializeManifest, type NewManifestInput } from "./manifest.js";
import { WORKSPACE_DIRECTORIES, canonicalRoot, checkWorkspacePath } from "./paths.js";

export class WorkspaceError extends Error {
  readonly kind: WorkspaceErrorKind;
  readonly detail: Record<string, string | number | boolean>;

  constructor(
    kind: WorkspaceErrorKind,
    message: string,
    detail: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.kind = kind;
    this.detail = detail;
  }
}

export type WorkspaceErrorKind =
  "path_denied" | "not_found" | "already_exists" | "not_writable" | "invalid";

export interface CreateWorkspaceInput extends Omit<NewManifestInput, "now"> {
  root: string;
  now: string;
}

const KIWI_README = `# .kiwi

Kiwi keeps event history, checkpoints, trash, and in-progress transaction records here.

Everything in this folder is part of the workspace and belongs in a backup. Caches,
search indexes, logs, and secrets are stored outside the workspace and are always
rebuildable.

Do not edit files in transactions/ by hand. It is normally empty.
`;

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function requireUsablePath(root: string): string {
  const check = checkWorkspacePath(root);
  if (!check.ok) {
    throw new WorkspaceError("path_denied", "That folder path cannot be used for a workspace.", {
      reason: check.reason ?? "unknown",
    });
  }
  return canonicalRoot(root);
}

/**
 * Creates the folder layout, then writes the manifest last and exclusively. A folder
 * without a manifest is not a workspace, so an interrupted create leaves an ordinary
 * directory rather than a half-formed one.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
  const root = requireUsablePath(input.root);
  const manifestPath = join(root, MANIFEST_FILENAME);

  if (await pathExists(manifestPath)) {
    throw new WorkspaceError("already_exists", "That folder already holds a Kiwi workspace.", {
      workspace_root: "<path>",
    });
  }

  await mkdir(root, { recursive: true });

  if (!(await isWritable(root))) {
    throw new WorkspaceError("not_writable", "Kiwi cannot write to that folder.");
  }

  for (const directory of WORKSPACE_DIRECTORIES) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, ".kiwi", "README.md"), KIWI_README, "utf8");

  const manifest = newManifest(input);
  await writeFileExclusive(manifestPath, serializeManifest(manifest));

  return {
    workspaceId: manifest.workspace_id,
    title: manifest.title,
    root,
    formatVersion: manifest.format_version,
    status: "ready",
    trust: "trusted",
    writable: true,
    problems: [],
  };
}

export interface OpenWorkspaceInput {
  root: string;
  trust: TrustLevel;
}

export async function openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceSummary> {
  const root = requireUsablePath(input.root);
  const manifestPath = join(root, MANIFEST_FILENAME);

  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  const report = readManifest(raw);

  const problems = [...report.problems];
  let status: WorkspaceStatus = report.status;

  if (status === "ready" && !(await isWritable(root))) {
    status = "read_only";
    problems.push({
      rule: "root.read_only",
      path: "/",
      detail: "The workspace folder is read-only. Kiwi will not change it.",
      severity: "warning",
    });
  }

  const manifest = report.manifest;
  return {
    workspaceId: manifest?.workspace_id ?? "",
    title: manifest?.title ?? "",
    root,
    formatVersion: manifest?.format_version ?? "",
    status,
    trust: input.trust,
    writable: permitsMutation(status, input.trust),
    problems,
  };
}

export interface HealthReport {
  root: string;
  status: WorkspaceStatus;
  manifestPresent: boolean;
  rootWritable: boolean;
  missingDirectories: string[];
  pendingTransactions: number;
  problems: WorkspaceProblem[];
}

/**
 * Inspects a workspace without changing it. A health check never repairs, so a user can
 * read the report before deciding.
 */
export async function checkWorkspaceHealth(root: string): Promise<HealthReport> {
  const canonical = requireUsablePath(root);
  const manifestPath = join(canonical, MANIFEST_FILENAME);
  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  const report = readManifest(raw);

  const missingDirectories: string[] = [];
  for (const directory of WORKSPACE_DIRECTORIES) {
    if (!(await pathExists(join(canonical, directory)))) missingDirectories.push(directory);
  }

  const transactionsDir = join(canonical, ".kiwi", "transactions");
  const pending = await readdir(transactionsDir).catch(() => [] as string[]);

  const problems = [...report.problems];
  if (missingDirectories.length > 0) {
    problems.push({
      rule: "layout.missing_directories",
      path: "/",
      detail: `${missingDirectories.length} expected folders are missing. Repair recreates them empty.`,
      severity: "warning",
    });
  }
  if (pending.length > 0) {
    problems.push({
      rule: "transactions.pending",
      path: "/.kiwi/transactions",
      detail: `${pending.length} interrupted write records are present.`,
      severity: "warning",
    });
  }

  return {
    root: canonical,
    status: report.status,
    manifestPresent: raw !== null,
    rootWritable: await isWritable(canonical),
    missingDirectories,
    pendingTransactions: pending.length,
    problems,
  };
}

/** Recreates missing empty folders. It never writes, moves, or deletes a record. */
export async function repairWorkspaceLayout(root: string): Promise<string[]> {
  const canonical = requireUsablePath(root);
  const health = await checkWorkspaceHealth(canonical);

  if (!health.manifestPresent) {
    throw new WorkspaceError("not_found", "That folder is not a Kiwi workspace.");
  }
  if (!health.rootWritable) {
    throw new WorkspaceError("not_writable", "Kiwi cannot write to that folder.");
  }

  for (const directory of health.missingDirectories) {
    await mkdir(join(canonical, directory), { recursive: true });
  }
  return health.missingDirectories;
}

export async function touchManifest(root: string, now: string): Promise<WorkspaceManifest> {
  const canonical = requireUsablePath(root);
  const manifestPath = join(canonical, MANIFEST_FILENAME);
  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  const report = readManifest(raw);

  if (report.manifest === null || report.status !== "ready") {
    throw new WorkspaceError("invalid", "Kiwi will not write to a workspace it cannot validate.", {
      status: report.status,
    });
  }

  // Unknown fields survive because the parsed manifest is spread rather than rebuilt.
  const updated: WorkspaceManifest = { ...report.manifest, updated_at: now };
  await writeFileAtomic(manifestPath, serializeManifest(updated));
  return updated;
}

export async function renameWorkspace(
  root: string,
  title: string,
  now: string,
): Promise<WorkspaceSummary> {
  const canonical = requireUsablePath(root);
  const manifestPath = join(canonical, MANIFEST_FILENAME);
  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  const report = readManifest(raw);
  const normalizedTitle = title.trim().normalize("NFC");
  if (report.manifest === null || report.status !== "ready") {
    throw new WorkspaceError("invalid", "Kiwi will not write to a workspace it cannot validate.", {
      status: report.status,
    });
  }
  if (normalizedTitle === "" || normalizedTitle.length > 200) {
    throw new WorkspaceError("invalid", "Enter a workspace name between 1 and 200 characters.");
  }
  if (!(await isWritable(canonical))) {
    throw new WorkspaceError("not_writable", "Kiwi cannot write to that folder.");
  }
  const updated: WorkspaceManifest = {
    ...report.manifest,
    title: normalizedTitle,
    updated_at: now,
  };
  await writeFileAtomic(manifestPath, serializeManifest(updated));
  return {
    workspaceId: updated.workspace_id,
    title: updated.title,
    root: canonical,
    formatVersion: updated.format_version,
    status: "ready",
    trust: "trusted",
    writable: true,
    problems: [],
  };
}

export async function workspaceModifiedAt(root: string): Promise<string | null> {
  const info = await stat(join(canonicalRoot(root), MANIFEST_FILENAME)).catch(() => null);
  return info === null ? null : info.mtime.toISOString();
}
