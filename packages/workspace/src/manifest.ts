import {
  MANIFEST_SCHEMA_URI,
  SCHEMAS,
  WORKSPACE_FORMAT_VERSION,
  type WorkspaceManifest,
  type WorkspaceProblem,
  type WorkspaceStatus,
} from "@kiwi/contracts";
import { createValidator, toFieldProblems, type Validator } from "@kiwi/commands";

export interface ManifestReport {
  manifest: WorkspaceManifest | null;
  status: WorkspaceStatus;
  problems: WorkspaceProblem[];
}

let sharedValidator: Validator | null = null;

function validator(): Validator {
  sharedValidator ??= createValidator();
  return sharedValidator;
}

function majorOf(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

/**
 * Serializes with sorted keys, two-space indentation, and a trailing newline so two
 * writes of the same content produce identical bytes.
 */
export function serializeManifest(manifest: WorkspaceManifest): string {
  return `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

export interface NewManifestInput {
  workspaceId: string;
  title: string;
  now: string;
  locale?: string;
  timeZone?: string;
  profiles?: string[];
}

export function newManifest(input: NewManifestInput): WorkspaceManifest {
  return {
    $schema: MANIFEST_SCHEMA_URI,
    format_version: WORKSPACE_FORMAT_VERSION,
    workspace_id: input.workspaceId,
    title: input.title,
    created_at: input.now,
    updated_at: input.now,
    default_locale: input.locale ?? "en-US",
    default_time_zone: input.timeZone ?? "UTC",
    enabled_profiles: input.profiles ?? [],
    required_extensions: [],
    schema_packs: [],
    sensitivity_default: "internal",
    features: {},
  };
}

/**
 * Reads a manifest that may be absent, unparsable, invalid, or written by a newer Kiwi.
 * Each outcome maps to a distinct startup status so the interface can offer the right
 * action. A future major version is never rewritten.
 */
export function readManifest(raw: string | null): ManifestReport {
  if (raw === null) {
    return {
      manifest: null,
      status: "workspace_missing",
      problems: [
        {
          rule: "manifest.missing",
          path: "/",
          detail: "This folder has no kiwi.workspace.json.",
          severity: "error",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      manifest: null,
      status: "repair_required",
      problems: [
        {
          rule: "manifest.unparsable",
          path: "/",
          detail: "kiwi.workspace.json is not valid JSON.",
          severity: "error",
        },
      ],
    };
  }

  const validate = validator().compile(SCHEMAS.workspaceManifest);
  if (!validate(parsed)) {
    return {
      manifest: null,
      status: "repair_required",
      problems: toFieldProblems(validate.errors).map((problem) => ({
        rule: `manifest.${problem.rule}`,
        path: problem.path,
        detail: problem.detail,
        severity: "error" as const,
      })),
    };
  }

  const manifest = parsed as WorkspaceManifest;
  const declared = majorOf(manifest.format_version);
  const supported = majorOf(WORKSPACE_FORMAT_VERSION);

  if (Number.isNaN(declared)) {
    return {
      manifest,
      status: "repair_required",
      problems: [
        {
          rule: "manifest.format_version",
          path: "/format_version",
          detail: "The format version is not a semantic version.",
          severity: "error",
        },
      ],
    };
  }

  if (declared > supported) {
    return {
      manifest,
      status: "future_schema",
      problems: [
        {
          rule: "manifest.future_major",
          path: "/format_version",
          detail: `This workspace uses format ${manifest.format_version}. This build writes ${WORKSPACE_FORMAT_VERSION}.`,
          severity: "error",
        },
      ],
    };
  }

  if (declared < supported) {
    return {
      manifest,
      status: "migration_required",
      problems: [
        {
          rule: "manifest.older_major",
          path: "/format_version",
          detail: `This workspace uses format ${manifest.format_version} and needs migration.`,
          severity: "error",
        },
      ],
    };
  }

  return { manifest, status: "ready", problems: [] };
}
