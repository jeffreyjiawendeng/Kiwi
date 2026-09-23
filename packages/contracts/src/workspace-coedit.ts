export const WORKSPACE_COEDIT_PATHS = {
  push: "/v1/sync/coedit/push",
  pull: "/v1/sync/coedit/pull",
  presence: "/v1/sync/coedit/presence",
  documents: "/v1/sync/coedit/documents",
} as const;

export type CoeditWireOperation =
  | {
      document_id: string;
      operation_id: string;
      actor_id: string;
      lamport: number;
      kind: "insert";
      after_id: string | null;
      text: string;
      document_title?: string;
    }
  | {
      document_id: string;
      operation_id: string;
      actor_id: string;
      lamport: number;
      kind: "delete";
      target_ids: string[];
    };

export type CoeditSyncRequest =
  | { workspace_id: string; document_id: string; operations: CoeditWireOperation[] }
  | { workspace_id: string; document_id: string; after_sequence: number; limit: number }
  | { workspace_id: string; document_id: string; sequence: number; cursor: number }
  | { workspace_id: string };

export type CoeditSyncResult =
  | { status: "operations_accepted"; accepted: Array<{ operation_id: string; sequence: number }> }
  | {
      status: "operations";
      operations: Array<{ sequence: number; operation: CoeditWireOperation }>;
      next_sequence: number;
    }
  | {
      status: "presence";
      collaborators: Array<{
        actor_id: string;
        sequence: number;
        cursor: number;
        expires_at: string;
      }>;
    }
  | { status: "documents"; document_ids: string[] }
  | {
      status: "error";
      code: "invalid_input" | "forbidden" | "service_unavailable";
      message: string;
    };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 150;
}

function operation(value: unknown, documentId: string): CoeditWireOperation | null {
  const item = object(value);
  if (
    item === null ||
    item["document_id"] !== documentId ||
    !id(item["operation_id"]) ||
    !id(item["actor_id"]) ||
    !Number.isSafeInteger(item["lamport"]) ||
    Number(item["lamport"]) < 1
  )
    return null;
  if (item["kind"] === "insert") {
    if (
      !(item["after_id"] === null || id(item["after_id"])) ||
      typeof item["text"] !== "string" ||
      item["text"].length < 1 ||
      item["text"].length > 10_000
    )
      return null;
    if (
      item["document_title"] !== undefined &&
      (!id(item["document_title"]) || String(item["document_title"]).length > 200)
    )
      return null;
    return item as unknown as CoeditWireOperation;
  }
  if (
    item["kind"] !== "delete" ||
    !Array.isArray(item["target_ids"]) ||
    item["target_ids"].length > 10_000 ||
    !item["target_ids"].every(id)
  )
    return null;
  return item as unknown as CoeditWireOperation;
}

export function readCoeditSyncRequest(path: string, value: unknown): CoeditSyncRequest | null {
  const input = object(value);
  if (input === null || !id(input["workspace_id"])) return null;
  const workspaceId = input["workspace_id"];
  if (path === WORKSPACE_COEDIT_PATHS.documents) return { workspace_id: workspaceId };
  if (!id(input["document_id"])) return null;
  const documentId = input["document_id"];
  if (path === WORKSPACE_COEDIT_PATHS.push) {
    if (!Array.isArray(input["operations"]) || input["operations"].length > 500) return null;
    const operations = input["operations"].map((item) => operation(item, documentId));
    return operations.some((item) => item === null)
      ? null
      : {
          workspace_id: workspaceId,
          document_id: documentId,
          operations: operations as CoeditWireOperation[],
        };
  }
  if (path === WORKSPACE_COEDIT_PATHS.pull) {
    const limit = Number(input["limit"] ?? 500);
    return Number.isSafeInteger(input["after_sequence"]) &&
      Number(input["after_sequence"]) >= 0 &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 1000
      ? {
          workspace_id: workspaceId,
          document_id: documentId,
          after_sequence: Number(input["after_sequence"]),
          limit,
        }
      : null;
  }
  if (path !== WORKSPACE_COEDIT_PATHS.presence) return null;
  return Number.isSafeInteger(input["sequence"]) &&
    Number(input["sequence"]) >= 1 &&
    Number.isSafeInteger(input["cursor"]) &&
    Number(input["cursor"]) >= 0
    ? {
        workspace_id: workspaceId,
        document_id: documentId,
        sequence: Number(input["sequence"]),
        cursor: Number(input["cursor"]),
      }
    : null;
}
