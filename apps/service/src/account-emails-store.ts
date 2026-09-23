import {
  MAXIMUM_ACCOUNT_EMAILS,
  type AccountEmailKind,
  type AccountEmailSummary,
} from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";

export type AddEmailResult =
  | { kind: "added"; emailId: string }
  | { kind: "already_yours" }
  | { kind: "claimed_elsewhere" }
  | { kind: "limit_reached" };

export type VerifyEmailResult =
  { kind: "verified"; address: string } | { kind: "invalid_code" } | { kind: "claimed_elsewhere" };

export type PromoteEmailResult =
  { kind: "promoted"; address: string } | { kind: "not_verified" } | { kind: "not_found" };

export type RemoveEmailResult = { kind: "removed" } | { kind: "primary" } | { kind: "not_found" };

export interface AccountEmailsStore {
  list(userId: string): Promise<AccountEmailSummary[]>;
  add(input: {
    id: string;
    userId: string;
    address: string;
    kind: AccountEmailKind;
    now: Date;
  }): Promise<AddEmailResult>;
  issueVerification(input: {
    id: string;
    emailId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string | null>;
  consumeVerification(input: {
    emailId: string;
    userId: string;
    tokenHash: string;
    now: Date;
  }): Promise<VerifyEmailResult>;
  promote(input: { emailId: string; userId: string; now: Date }): Promise<PromoteEmailResult>;
  setNotifications(input: { emailId: string; userId: string }): Promise<PromoteEmailResult>;
  remove(input: { emailId: string; userId: string }): Promise<RemoveEmailResult>;
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Email storage returned invalid ${name}.`);
  return value;
}

function readKind(value: unknown): AccountEmailKind {
  if (value !== "personal" && value !== "institutional") {
    throw new Error("Email storage returned an invalid address kind.");
  }
  return value;
}

export function createPostgresAccountEmailsStore(database: ServiceDatabase): AccountEmailsStore {
  return {
    async list(userId): Promise<AccountEmailSummary[]> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id, address, kind, verified_at, is_primary, receives_notifications
             FROM account_emails
            WHERE user_id = $1
            ORDER BY is_primary DESC, created_at`,
          [userId],
        );
        return result.rows.map((row) => ({
          id: requiredString(row, "id"),
          address: requiredString(row, "address"),
          kind: readKind(row["kind"]),
          verified: row["verified_at"] !== null,
          primary: row["is_primary"] === true,
          receives_notifications: row["receives_notifications"] === true,
        }));
      });
    },

    async add(input): Promise<AddEmailResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `email:${input.address}`,
        ]);
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const existing = await executor.query(
          "SELECT user_id, verified_at FROM account_emails WHERE address = $1",
          [input.address],
        );
        for (const row of existing.rows) {
          if (requiredString(row, "user_id") === input.userId) return { kind: "already_yours" };
          if (row["verified_at"] !== null) return { kind: "claimed_elsewhere" };
        }
        const count = await executor.query(
          "SELECT count(*) AS total FROM account_emails WHERE user_id = $1",
          [input.userId],
        );
        if (Number(count.rows[0]?.["total"] ?? 0) >= MAXIMUM_ACCOUNT_EMAILS) {
          return { kind: "limit_reached" };
        }
        await executor.query(
          `INSERT INTO account_emails (id, user_id, address, kind, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.userId, input.address, input.kind, input.now],
        );
        return { kind: "added", emailId: input.id };
      });
    },

    async issueVerification(input): Promise<string | null> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const owned = await executor.query(
          `SELECT address FROM account_emails
            WHERE id = $1 AND user_id = $2 AND verified_at IS NULL
            FOR UPDATE`,
          [input.emailId, input.userId],
        );
        const row = owned.rows[0];
        if (row === undefined) return null;
        await executor.query(
          `UPDATE account_email_verifications
              SET consumed_at = $2
            WHERE email_id = $1 AND consumed_at IS NULL`,
          [input.emailId, input.now],
        );
        await executor.query(
          `INSERT INTO account_email_verifications
             (id, email_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.emailId, input.tokenHash, input.expiresAt, input.now],
        );
        return requiredString(row, "address");
      });
    },

    async consumeVerification(input): Promise<VerifyEmailResult> {
      return database.transaction(async (executor) => {
        const candidate = await executor.query(
          `SELECT address FROM account_emails
            WHERE id = $1 AND user_id = $2 AND verified_at IS NULL`,
          [input.emailId, input.userId],
        );
        const candidateRow = candidate.rows[0];
        if (candidateRow === undefined) return { kind: "invalid_code" };
        const address = requiredString(candidateRow, "address");
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`email:${address}`]);
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const consumed = await executor.query(
          `UPDATE account_email_verifications v
              SET consumed_at = $4
             FROM account_emails e
            WHERE v.email_id = e.id
              AND e.id = $1
              AND e.user_id = $2
              AND v.token_hash = $3
              AND v.consumed_at IS NULL
              AND v.expires_at > $4
          RETURNING e.address`,
          [input.emailId, input.userId, input.tokenHash, input.now],
        );
        const row = consumed.rows[0];
        if (row === undefined) return { kind: "invalid_code" };
        if (requiredString(row, "address") !== address) {
          throw new Error("Email storage changed an address during verification.");
        }
        const claimed = await executor.query(
          `SELECT id FROM account_emails
            WHERE address = $1 AND verified_at IS NOT NULL AND user_id <> $2`,
          [address, input.userId],
        );
        if (claimed.rows.length > 0) return { kind: "claimed_elsewhere" };
        await executor.query("UPDATE account_emails SET verified_at = $2 WHERE id = $1", [
          input.emailId,
          input.now,
        ]);
        return { kind: "verified", address };
      });
    },

    async promote(input): Promise<PromoteEmailResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const target = await executor.query(
          "SELECT address, verified_at FROM account_emails WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [input.emailId, input.userId],
        );
        const row = target.rows[0];
        if (row === undefined) return { kind: "not_found" };
        if (row["verified_at"] === null) return { kind: "not_verified" };
        const address = requiredString(row, "address");
        // The partial unique index allows one primary row per account, so the previous
        // primary has to be cleared before the new one is set.
        await executor.query(
          "UPDATE account_emails SET is_primary = false WHERE user_id = $1 AND is_primary",
          [input.userId],
        );
        await executor.query("UPDATE account_emails SET is_primary = true WHERE id = $1", [
          input.emailId,
        ]);
        await executor.query(
          "UPDATE user_accounts SET primary_email = $2, updated_at = $3 WHERE id = $1",
          [input.userId, address, input.now],
        );
        return { kind: "promoted", address };
      });
    },

    async setNotifications(input): Promise<PromoteEmailResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const target = await executor.query(
          "SELECT address, verified_at FROM account_emails WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [input.emailId, input.userId],
        );
        const row = target.rows[0];
        if (row === undefined) return { kind: "not_found" };
        if (row["verified_at"] === null) return { kind: "not_verified" };
        await executor.query(
          "UPDATE account_emails SET receives_notifications = false WHERE user_id = $1 AND receives_notifications",
          [input.userId],
        );
        await executor.query(
          "UPDATE account_emails SET receives_notifications = true WHERE id = $1",
          [input.emailId],
        );
        return { kind: "promoted", address: requiredString(row, "address") };
      });
    },

    async remove(input): Promise<RemoveEmailResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-emails:${input.userId}`,
        ]);
        const target = await executor.query(
          "SELECT is_primary, receives_notifications FROM account_emails WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [input.emailId, input.userId],
        );
        const row = target.rows[0];
        if (row === undefined) return { kind: "not_found" };
        if (row["is_primary"] === true) return { kind: "primary" };
        await executor.query("DELETE FROM account_emails WHERE id = $1", [input.emailId]);
        if (row["receives_notifications"] === true) {
          // Notifications fall back to the primary address rather than stopping.
          await executor.query(
            "UPDATE account_emails SET receives_notifications = true WHERE user_id = $1 AND is_primary",
            [input.userId],
          );
        }
        return { kind: "removed" };
      });
    },
  };
}
