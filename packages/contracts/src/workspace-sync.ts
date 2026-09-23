export const WORKSPACE_SYNC_PATHS = {
  submit: "/v1/sync/structured/submit",
  pull: "/v1/sync/structured/pull",
} as const;

export interface StructuredSyncProposal {
  version: number;
  content_hash: string;
  snapshot: Record<string, unknown>;
}

export interface StructuredSyncSubmitRequest {
  workspace_id: string;
  command_id: string;
  object_id: string;
  base_version: number;
  base_hash: string | null;
  proposed: StructuredSyncProposal;
  resolves_conflict_id?: string;
}

export interface StructuredSyncChange extends StructuredSyncSubmitRequest {
  sequence: number;
  actor_id: string;
  accepted_at: string;
}

export type StructuredSyncResult =
  | {
      status: "accepted";
      sequence: number;
      actor_id: string;
      object_id: string;
      version: number;
      content_hash: string;
      replayed: boolean;
    }
  | {
      status: "conflict";
      sequence: number;
      conflict_id: string;
      object_id: string;
      base_version: number;
      base_hash: string | null;
      current: StructuredSyncProposal;
      incoming: StructuredSyncProposal;
      replayed: boolean;
    }
  | {
      status: "changes";
      changes: StructuredSyncChange[];
      next_sequence: number;
    }
  | {
      status: "error";
      code: "invalid_input" | "forbidden" | "not_found" | "service_unavailable";
      message: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function readStructuredSyncRequest(
  path: string,
  value: unknown,
):
  | StructuredSyncSubmitRequest
  | { workspace_id: string; after_sequence: number; limit: number }
  | null {
  const input = record(value);
  if (input === null || !identifier(input["workspace_id"])) return null;
  if (path === WORKSPACE_SYNC_PATHS.pull) {
    const after = input["after_sequence"];
    const limit = input["limit"] ?? 100;
    return Number.isSafeInteger(after) &&
      Number(after) >= 0 &&
      Number.isInteger(limit) &&
      Number(limit) >= 1 &&
      Number(limit) <= 500
      ? { workspace_id: input["workspace_id"], after_sequence: Number(after), limit: Number(limit) }
      : null;
  }
  if (path !== WORKSPACE_SYNC_PATHS.submit) return null;
  const proposed = record(input["proposed"]);
  const baseHash = input["base_hash"];
  if (
    !identifier(input["command_id"]) ||
    !identifier(input["object_id"]) ||
    !Number.isInteger(input["base_version"]) ||
    Number(input["base_version"]) < 0 ||
    !(baseHash === null || hash(baseHash)) ||
    proposed === null ||
    !Number.isInteger(proposed["version"]) ||
    Number(proposed["version"]) < 1 ||
    !hash(proposed["content_hash"]) ||
    record(proposed["snapshot"]) === null
  )
    return null;
  const resolves = input["resolves_conflict_id"];
  if (resolves !== undefined && !identifier(resolves)) return null;
  return {
    workspace_id: input["workspace_id"],
    command_id: input["command_id"],
    object_id: input["object_id"],
    base_version: Number(input["base_version"]),
    base_hash: baseHash,
    proposed: {
      version: Number(proposed["version"]),
      content_hash: proposed["content_hash"],
      snapshot: proposed["snapshot"] as Record<string, unknown>,
    },
    ...(resolves === undefined ? {} : { resolves_conflict_id: resolves }),
  };
}
