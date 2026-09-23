import type { ServiceDatabase, SqlExecutor } from "./database.js";

export interface AccountDeletionFinalizationResult {
  finalized: number;
  ownership_blocked: number;
}

export interface AccountDeletionService {
  finalizeExpired(now?: Date, maximum?: number): Promise<AccountDeletionFinalizationResult>;
}

function string(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Account deletion storage returned invalid ${key}.`);
  }
  return value;
}

async function lockOwnedWorkspaces(executor: SqlExecutor, userId: string): Promise<void> {
  const workspaces = await executor.query(
    `SELECT workspace_id
       FROM workspace_memberships
      WHERE user_id = $1 AND role = 'owner'
      ORDER BY workspace_id`,
    [userId],
  );
  for (const row of workspaces.rows) {
    await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `workspace:${string(row, "workspace_id")}`,
    ]);
  }
}

async function hasSoleOwnership(executor: SqlExecutor, userId: string): Promise<boolean> {
  const result = await executor.query(
    `SELECT 1
       FROM workspace_memberships owned
      WHERE owned.user_id = $1
        AND owned.role = 'owner'
        AND NOT EXISTS (
          SELECT 1
            FROM workspace_memberships peer
            JOIN user_accounts account ON account.id = peer.user_id
           WHERE peer.workspace_id = owned.workspace_id
             AND peer.user_id <> $1
             AND peer.role = 'owner'
             AND account.status = 'active'
        )
      LIMIT 1`,
    [userId],
  );
  return result.rows.length > 0;
}

async function eraseAccount(executor: SqlExecutor, userId: string, now: Date): Promise<void> {
  const addresses = await executor.query("SELECT address FROM account_emails WHERE user_id = $1", [
    userId,
  ]);
  const emailAddresses = addresses.rows.map((row) => string(row, "address"));
  const deletedAddress = `deleted+${userId}@accounts.invalid`;

  if (emailAddresses.length > 0) {
    await executor.query(
      "DELETE FROM notification_email_outbox WHERE recipient = ANY($1::text[])",
      [emailAddresses],
    );
    await executor.query(
      `DELETE FROM workspace_invitations
        WHERE email = ANY($1::text[]) AND status = 'pending'`,
      [emailAddresses],
    );
    await executor.query(
      `UPDATE workspace_invitations
          SET email = $2
        WHERE email = ANY($1::text[])`,
      [emailAddresses, deletedAddress],
    );
  }

  // Remove current authorization and personal data before releasing the email address.
  // Historical workspace events retain only the stable opaque user id.
  await executor.query("DELETE FROM project_memberships WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM workspace_memberships WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM connection_transactions WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM connected_accounts WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM account_notification_preferences WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM account_notifications WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM account_avatars WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM oidc_auth_transactions WHERE link_user_id = $1", [userId]);
  await executor.query("DELETE FROM external_identities WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM password_resets WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM password_credentials WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM device_sessions WHERE user_id = $1", [userId]);
  await executor.query("DELETE FROM account_emails WHERE user_id = $1", [userId]);
  await executor.query("UPDATE account_security_events SET user_id = NULL WHERE user_id = $1", [
    userId,
  ]);
  await executor.query("DELETE FROM account_deletion_requests WHERE user_id = $1", [userId]);
  await executor.query(
    `UPDATE user_accounts
        SET primary_email = $2,
            given_name = NULL,
            family_name = NULL,
            phone = NULL,
            email_verified_at = NULL,
            status = 'deleted',
            deleted_at = $3,
            updated_at = $3
      WHERE id = $1`,
    [userId, deletedAddress, now],
  );
}

export function createAccountDeletionService(database: ServiceDatabase): AccountDeletionService {
  return {
    async finalizeExpired(now = new Date(), maximum = 20) {
      const boundedMaximum = Math.max(1, Math.min(100, Math.trunc(maximum)));
      return database.transaction(async (executor) => {
        const expired = await executor.query(
          `SELECT request.user_id
             FROM account_deletion_requests request
             JOIN user_accounts account ON account.id = request.user_id
            WHERE request.recover_until <= $1
              AND account.status = 'deleting'
            ORDER BY request.recover_until
            LIMIT $2
            FOR UPDATE OF request, account SKIP LOCKED`,
          [now, boundedMaximum],
        );
        let finalized = 0;
        let ownershipBlocked = 0;
        for (const row of expired.rows) {
          const userId = string(row, "user_id");
          await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `account-deletion:${userId}`,
          ]);
          await lockOwnedWorkspaces(executor, userId);
          if (await hasSoleOwnership(executor, userId)) {
            ownershipBlocked += 1;
            continue;
          }
          await eraseAccount(executor, userId, now);
          finalized += 1;
        }
        return { finalized, ownership_blocked: ownershipBlocked };
      });
    },
  };
}
