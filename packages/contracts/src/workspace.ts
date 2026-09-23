export const WORKSPACE_FORMAT_VERSION = "1.0.0";

export const MANIFEST_FILENAME = "kiwi.workspace.json";

export const MANIFEST_SCHEMA_URI = "https://kiwi-research.org/schemas/workspace/1-0-0.json";

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export interface WorkspaceManifest {
  $schema: string;
  format_version: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  default_locale?: string;
  default_time_zone?: string;
  enabled_profiles?: string[];
  required_extensions?: Record<string, unknown>[];
  schema_packs?: string[];
  sensitivity_default?: Sensitivity;
  features?: Record<string, unknown>;
  [unknownField: string]: unknown;
}

/** Startup states from 03_Engineering_Specification/01_System_Architecture.md. */
export const WORKSPACE_STATUSES = [
  "ready",
  "read_only",
  "migration_required",
  "future_schema",
  "repair_required",
  "projection_rebuilding",
  "workspace_missing",
  "conflict_blocked",
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export type TrustLevel = "trusted" | "restricted";

export interface WorkspaceProblem {
  /** Stable identifier so the interface can offer a specific repair. */
  rule: string;
  path: string;
  detail: string;
  severity: "error" | "warning";
}

export interface WorkspaceSummary {
  workspaceId: string;
  title: string;
  root: string;
  formatVersion: string;
  status: WorkspaceStatus;
  trust: TrustLevel;
  writable: boolean;
  problems: WorkspaceProblem[];
}

export interface RecentWorkspace {
  workspaceId: string;
  title: string;
  root: string;
  lastOpenedAt: string;
}

export function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return typeof value === "string" && (WORKSPACE_STATUSES as readonly string[]).includes(value);
}

export function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary["workspaceId"] === "string" &&
    typeof summary["title"] === "string" &&
    typeof summary["root"] === "string" &&
    typeof summary["formatVersion"] === "string" &&
    isWorkspaceStatus(summary["status"]) &&
    (summary["trust"] === "trusted" || summary["trust"] === "restricted") &&
    typeof summary["writable"] === "boolean" &&
    Array.isArray(summary["problems"])
  );
}

/** A status that permits canonical mutation. ENG-ARCH-008 governs the rest. */
export function permitsMutation(status: WorkspaceStatus, trust: TrustLevel): boolean {
  return status === "ready" && trust === "trusted";
}
