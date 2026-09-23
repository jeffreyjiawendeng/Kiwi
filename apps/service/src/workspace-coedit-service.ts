import { createHash } from "node:crypto";
import type { CoeditSyncResult, CoeditWireOperation, CoeditSyncRequest } from "@kiwi/contracts";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

function digest(value: string): string {
  return createHash("sha256").update(`access_token\u0000${value}`, "utf8").digest("hex");
}

function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Coediting returned invalid ${key}.`);
  return value;
}

function number(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`Coediting returned invalid ${key}.`);
  return value;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function actor(executor: SqlExecutor, token: string, now: Date): Promise<string | null> {
  const result = await executor.query(
    `SELECT s.user_id
       FROM device_sessions s JOIN user_accounts a ON a.id = s.user_id
      WHERE s.access_token_hash = $1 AND s.access_expires_at > $2
        AND s.revoked_at IS NULL AND a.status = 'active'`,
    [digest(token), now],
  );
  return result.rows[0] === undefined ? null : text(result.rows[0], "user_id");
}

async function role(executor: SqlExecutor, workspaceId: string, userId: string) {
  const result = await executor.query(
    "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return typeof result.rows[0]?.["role"] === "string" ? result.rows[0]["role"] : null;
}

const forbidden = (): CoeditSyncResult => ({
  status: "error",
  code: "forbidden",
  message: "You cannot collaborate in this workspace.",
});

type PushRequest = Extract<CoeditSyncRequest, { operations: unknown }>;
type PullRequest = Extract<CoeditSyncRequest, { after_sequence: unknown }>;
type PresenceRequest = Extract<CoeditSyncRequest, { cursor: unknown }>;
type DocumentsRequest = Exclude<CoeditSyncRequest, { document_id: unknown }>;

export interface WorkspaceCoeditService {
  push(accessToken: string, input: PushRequest): Promise<CoeditSyncResult>;
  pull(accessToken: string, input: PullRequest): Promise<CoeditSyncResult>;
  presence(accessToken: string, input: PresenceRequest): Promise<CoeditSyncResult>;
  documents(accessToken: string, input: DocumentsRequest): Promise<CoeditSyncResult>;
}

export function createWorkspaceCoeditService(database: ServiceDatabase): WorkspaceCoeditService {
  return {
    async push(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await actor(executor, accessToken, now);
        if (userId === null) return forbidden();
        const currentRole = await role(executor, input.workspace_id, userId);
        if (!["owner", "admin", "editor"].includes(currentRole ?? "")) return forbidden();
        const accepted: Array<{ operation_id: string; sequence: number }> = [];
        for (const operation of input.operations) {
          if (operation.actor_id !== `account:${userId}`) return forbidden();
          const inserted = await executor.query(
            `INSERT INTO coedit_operations
              (workspace_id, document_id, operation_id, actor_id, lamport, operation, accepted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (operation_id) DO NOTHING RETURNING sequence`,
            [
              input.workspace_id,
              input.document_id,
              operation.operation_id,
              userId,
              operation.lamport,
              operation,
              now,
            ],
          );
          if (inserted.rows[0] !== undefined) {
            accepted.push({
              operation_id: operation.operation_id,
              sequence: number(inserted.rows[0], "sequence"),
            });
            continue;
          }
          const existing = await executor.query(
            "SELECT sequence, operation FROM coedit_operations WHERE operation_id = $1",
            [operation.operation_id],
          );
          const row = existing.rows[0]!;
          if (stable(row["operation"]) !== stable(operation)) {
            return {
              status: "error",
              code: "invalid_input",
              message: "An operation identifier was reused with different content.",
            };
          }
          accepted.push({
            operation_id: operation.operation_id,
            sequence: number(row, "sequence"),
          });
        }
        return { status: "operations_accepted", accepted };
      });
    },

    async pull(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await actor(executor, accessToken, now);
        if (userId === null || (await role(executor, input.workspace_id, userId)) === null)
          return forbidden();
        const result = await executor.query(
          `SELECT sequence, operation FROM coedit_operations
            WHERE workspace_id = $1 AND document_id = $2 AND sequence > $3
            ORDER BY sequence LIMIT $4`,
          [input.workspace_id, input.document_id, input.after_sequence, input.limit],
        );
        const operations = result.rows.map((row) => ({
          sequence: number(row, "sequence"),
          operation: row["operation"] as CoeditWireOperation,
        }));
        return {
          status: "operations",
          operations,
          next_sequence: operations.at(-1)?.sequence ?? input.after_sequence,
        };
      });
    },

    async presence(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await actor(executor, accessToken, now);
        if (userId === null || (await role(executor, input.workspace_id, userId)) === null)
          return forbidden();
        const expiresAt = new Date(now.getTime() + 30_000);
        await executor.query(
          `INSERT INTO coedit_presence
            (workspace_id, document_id, actor_id, sequence, cursor_position, updated_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (workspace_id, document_id, actor_id) DO UPDATE
             SET sequence = EXCLUDED.sequence, cursor_position = EXCLUDED.cursor_position,
                 updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at
           WHERE coedit_presence.sequence < EXCLUDED.sequence`,
          [
            input.workspace_id,
            input.document_id,
            userId,
            input.sequence,
            input.cursor,
            now,
            expiresAt,
          ],
        );
        await executor.query("DELETE FROM coedit_presence WHERE expires_at <= $1", [now]);
        const result = await executor.query(
          `SELECT actor_id, sequence, cursor_position, expires_at FROM coedit_presence
            WHERE workspace_id = $1 AND document_id = $2 AND expires_at > $3 ORDER BY actor_id`,
          [input.workspace_id, input.document_id, now],
        );
        return {
          status: "presence",
          collaborators: result.rows.map((row) => ({
            actor_id: `account:${text(row, "actor_id")}`,
            sequence: number(row, "sequence"),
            cursor: number(row, "cursor_position"),
            expires_at: new Date(String(row["expires_at"])).toISOString(),
          })),
        };
      });
    },

    async documents(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await actor(executor, accessToken, now);
        if (userId === null || (await role(executor, input.workspace_id, userId)) === null)
          return forbidden();
        const result = await executor.query(
          `SELECT DISTINCT document_id FROM coedit_operations
            WHERE workspace_id = $1 ORDER BY document_id`,
          [input.workspace_id],
        );
        return {
          status: "documents",
          document_ids: result.rows.map((row) => text(row, "document_id")),
        };
      });
    },
  };
}
