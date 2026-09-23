import { createHash, randomUUID } from "node:crypto";
import type {
  StructuredSyncChange,
  StructuredSyncResult,
  StructuredSyncSubmitRequest,
} from "@kiwi/contracts";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

function digest(value: string): string {
  return createHash("sha256").update(`access_token\u0000${value}`, "utf8").digest("hex");
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return typeof value === "string" ? value.normalize("NFC") : value;
}

function canonicalSnapshotHash(snapshot: Record<string, unknown>): string {
  const semantic = { ...snapshot };
  delete semantic["content_hash"];
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized(semantic)), "utf8")
    .digest("hex")}`;
}

function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Structured sync returned invalid ${key}.`);
  return value;
}

function number(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`Structured sync returned invalid ${key}.`);
  return value;
}

function snapshot(row: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Structured sync returned invalid ${key}.`);
  }
  return value as Record<string, unknown>;
}

async function accountId(executor: SqlExecutor, accessToken: string, now: Date) {
  const result = await executor.query(
    `SELECT s.user_id
       FROM device_sessions s JOIN user_accounts a ON a.id = s.user_id
      WHERE s.access_token_hash = $1 AND s.access_expires_at > $2
        AND s.revoked_at IS NULL AND a.status = 'active'`,
    [digest(accessToken), now],
  );
  return result.rows[0] === undefined ? null : text(result.rows[0], "user_id");
}

async function workspaceRole(executor: SqlExecutor, workspaceId: string, userId: string) {
  const result = await executor.query(
    "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return typeof result.rows[0]?.["role"] === "string" ? result.rows[0]["role"] : null;
}

const failure = (
  code: Extract<StructuredSyncResult, { status: "error" }>["code"],
  message: string,
): StructuredSyncResult => ({ status: "error", code, message });

async function replay(
  executor: SqlExecutor,
  workspaceId: string,
  commandId: string,
): Promise<StructuredSyncResult | null> {
  const stored = await executor.query(
    `SELECT s.*, c.base_version AS conflict_base_version, c.base_hash AS conflict_base_hash,
            c.current_version, c.current_hash, c.current_snapshot,
            c.incoming_version, c.incoming_hash, c.incoming_snapshot
       FROM structured_sync_submissions s
       LEFT JOIN structured_sync_conflicts c ON c.id = s.conflict_id
      WHERE s.command_id = $1`,
    [commandId],
  );
  const row = stored.rows[0];
  if (row === undefined) return null;
  if (text(row, "workspace_id") !== workspaceId)
    return failure("forbidden", "That command identifier belongs to another workspace.");
  if (row["outcome"] === "accepted") {
    return {
      status: "accepted",
      sequence: number(row, "sequence"),
      actor_id: text(row, "actor_id"),
      object_id: text(row, "object_id"),
      version: number(row, "proposed_version"),
      content_hash: text(row, "proposed_hash"),
      replayed: true,
    };
  }
  return {
    status: "conflict",
    sequence: number(row, "sequence"),
    conflict_id: text(row, "conflict_id"),
    object_id: text(row, "object_id"),
    base_version: number(row, "conflict_base_version"),
    base_hash: row["conflict_base_hash"] === null ? null : text(row, "conflict_base_hash"),
    current: {
      version: number(row, "current_version"),
      content_hash: text(row, "current_hash"),
      snapshot: snapshot(row, "current_snapshot"),
    },
    incoming: {
      version: number(row, "incoming_version"),
      content_hash: text(row, "incoming_hash"),
      snapshot: snapshot(row, "incoming_snapshot"),
    },
    replayed: true,
  };
}

export interface WorkspaceSyncService {
  submit(accessToken: string, input: StructuredSyncSubmitRequest): Promise<StructuredSyncResult>;
  pull(
    accessToken: string,
    input: { workspace_id: string; after_sequence: number; limit: number },
  ): Promise<StructuredSyncResult>;
}

export function createWorkspaceSyncService(database: ServiceDatabase): WorkspaceSyncService {
  return {
    async submit(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await accountId(executor, accessToken, now);
        if (userId === null) return failure("forbidden", "Your session is no longer authorized.");
        const role = await workspaceRole(executor, input.workspace_id, userId);
        if (role === null) return failure("forbidden", "You cannot access this workspace.");
        if (!(["owner", "admin", "editor"] as string[]).includes(role)) {
          return failure("forbidden", "Your workspace role cannot publish changes.");
        }
        const prior = await replay(executor, input.workspace_id, input.command_id);
        if (prior !== null) return prior;
        if (
          input.proposed.version !== input.base_version + 1 ||
          input.proposed.snapshot["id"] !== input.object_id ||
          input.proposed.snapshot["version"] !== input.proposed.version ||
          input.proposed.snapshot["content_hash"] !== input.proposed.content_hash ||
          canonicalSnapshotHash(input.proposed.snapshot) !== input.proposed.content_hash
        ) {
          return failure(
            "invalid_input",
            "The proposed object envelope is not internally consistent.",
          );
        }

        const currentResult = await executor.query(
          `SELECT version, content_hash, snapshot FROM structured_sync_objects
            WHERE workspace_id = $1 AND object_id = $2 FOR UPDATE`,
          [input.workspace_id, input.object_id],
        );
        const current = currentResult.rows[0];
        if (input.resolves_conflict_id !== undefined) {
          const unresolved = await executor.query(
            `SELECT id FROM structured_sync_conflicts
              WHERE id = $1 AND workspace_id = $2 AND object_id = $3 AND resolved_at IS NULL`,
            [input.resolves_conflict_id, input.workspace_id, input.object_id],
          );
          if (unresolved.rows.length === 0)
            return failure("not_found", "That conflict is no longer available to resolve.");
        }
        if (current === undefined && (input.base_version !== 0 || input.base_hash !== null)) {
          return failure("not_found", "The expected base object is not synchronized.");
        }

        const matches =
          current === undefined ||
          (number(current, "version") === input.base_version &&
            text(current, "content_hash") === input.base_hash);
        if (!matches && current !== undefined) {
          const conflictId = randomUUID();
          await executor.query(
            `INSERT INTO structured_sync_conflicts
              (id, workspace_id, object_id, command_id, base_version, base_hash,
               current_version, current_hash, current_snapshot,
               incoming_version, incoming_hash, incoming_snapshot, actor_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              conflictId,
              input.workspace_id,
              input.object_id,
              input.command_id,
              input.base_version,
              input.base_hash,
              number(current, "version"),
              text(current, "content_hash"),
              snapshot(current, "snapshot"),
              input.proposed.version,
              input.proposed.content_hash,
              input.proposed.snapshot,
              userId,
              now,
            ],
          );
          const inserted = await executor.query(
            `INSERT INTO structured_sync_submissions
              (command_id, workspace_id, object_id, base_version, base_hash,
               proposed_version, proposed_hash, proposed_snapshot, actor_id,
               outcome, conflict_id, accepted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'conflict',$10,$11)
             RETURNING sequence`,
            [
              input.command_id,
              input.workspace_id,
              input.object_id,
              input.base_version,
              input.base_hash,
              input.proposed.version,
              input.proposed.content_hash,
              input.proposed.snapshot,
              userId,
              conflictId,
              now,
            ],
          );
          return {
            status: "conflict",
            sequence: number(inserted.rows[0]!, "sequence"),
            conflict_id: conflictId,
            object_id: input.object_id,
            base_version: input.base_version,
            base_hash: input.base_hash,
            current: {
              version: number(current, "version"),
              content_hash: text(current, "content_hash"),
              snapshot: snapshot(current, "snapshot"),
            },
            incoming: input.proposed,
            replayed: false,
          };
        }

        const inserted = await executor.query(
          `INSERT INTO structured_sync_submissions
            (command_id, workspace_id, object_id, base_version, base_hash,
             proposed_version, proposed_hash, proposed_snapshot, actor_id, outcome, accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10) RETURNING sequence`,
          [
            input.command_id,
            input.workspace_id,
            input.object_id,
            input.base_version,
            input.base_hash,
            input.proposed.version,
            input.proposed.content_hash,
            input.proposed.snapshot,
            userId,
            now,
          ],
        );
        await executor.query(
          `INSERT INTO structured_sync_objects
            (workspace_id, object_id, version, content_hash, snapshot, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (workspace_id, object_id) DO UPDATE
             SET version = EXCLUDED.version, content_hash = EXCLUDED.content_hash,
                 snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
          [
            input.workspace_id,
            input.object_id,
            input.proposed.version,
            input.proposed.content_hash,
            input.proposed.snapshot,
            now,
          ],
        );
        if (input.resolves_conflict_id !== undefined) {
          await executor.query(
            `UPDATE structured_sync_conflicts SET resolved_at = $3, resolved_by_command_id = $4
              WHERE id = $1 AND workspace_id = $2 AND object_id = $5 AND resolved_at IS NULL`,
            [
              input.resolves_conflict_id,
              input.workspace_id,
              now,
              input.command_id,
              input.object_id,
            ],
          );
        }
        return {
          status: "accepted",
          sequence: number(inserted.rows[0]!, "sequence"),
          actor_id: userId,
          object_id: input.object_id,
          version: input.proposed.version,
          content_hash: input.proposed.content_hash,
          replayed: false,
        };
      });
    },

    async pull(accessToken, input) {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await accountId(executor, accessToken, now);
        if (
          userId === null ||
          (await workspaceRole(executor, input.workspace_id, userId)) === null
        ) {
          return failure("forbidden", "You cannot access this workspace.");
        }
        const result = await executor.query(
          `SELECT sequence, command_id, workspace_id, object_id, base_version, base_hash,
                  proposed_version, proposed_hash, proposed_snapshot, actor_id, accepted_at
             FROM structured_sync_submissions
            WHERE workspace_id = $1 AND outcome = 'accepted' AND sequence > $2
            ORDER BY sequence LIMIT $3`,
          [input.workspace_id, input.after_sequence, input.limit],
        );
        const changes: StructuredSyncChange[] = result.rows.map((row) => ({
          sequence: number(row, "sequence"),
          command_id: text(row, "command_id"),
          workspace_id: text(row, "workspace_id"),
          object_id: text(row, "object_id"),
          base_version: number(row, "base_version"),
          base_hash: row["base_hash"] === null ? null : text(row, "base_hash"),
          proposed: {
            version: number(row, "proposed_version"),
            content_hash: text(row, "proposed_hash"),
            snapshot: snapshot(row, "proposed_snapshot"),
          },
          actor_id: text(row, "actor_id"),
          accepted_at: new Date(String(row["accepted_at"])).toISOString(),
        }));
        return {
          status: "changes",
          changes,
          next_sequence: changes.at(-1)?.sequence ?? input.after_sequence,
        };
      });
    },
  };
}
