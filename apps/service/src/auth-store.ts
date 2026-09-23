import type { AccountEmailKind } from "@kiwi/contracts";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

export interface StoredAccount {
  id: string;
  email: string;
  verified: boolean;
  status: "active" | "suspended" | "deleting" | "deleted";
}

export interface StoredCredential extends StoredAccount {
  verifier: string;
  parameterVersion: number;
}

export interface AccountCreationResult {
  account: StoredAccount;
  created: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type SessionRotationResult =
  { kind: "authenticated"; account: StoredAccount } | { kind: "invalid" } | { kind: "reuse" };

export interface AccountAuthStore {
  createOrReadAccount(input: {
    id: string;
    emailId: string;
    email: string;
    emailKind: AccountEmailKind;
    givenName: string;
    familyName: string;
    phone: string;
    verifier: string;
    parameterVersion: number;
    now: Date;
  }): Promise<AccountCreationResult>;
  findCredential(email: string): Promise<StoredCredential | null>;
  findUnverifiedAccount(email: string): Promise<StoredAccount | null>;
  issueEmailVerification(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  consumeEmailVerification(input: {
    email: string;
    tokenHash: string;
    now: Date;
  }): Promise<StoredAccount | null>;
  issuePasswordReset(input: {
    id: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string | null>;
  consumePasswordReset(input: {
    email: string;
    tokenHash: string;
    verifier: string;
    parameterVersion: number;
    now: Date;
  }): Promise<StoredAccount | null>;
  createSession(input: {
    id: string;
    refreshId: string;
    userId: string;
    deviceName: string;
    accessTokenHash: string;
    expiresAt: Date;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
    now: Date;
  }): Promise<void>;
  rotateSession(input: {
    refreshTokenHash: string;
    nextRefreshId: string;
    nextRefreshTokenHash: string;
    nextRefreshExpiresAt: Date;
    accessTokenHash: string;
    accessExpiresAt: Date;
    now: Date;
  }): Promise<SessionRotationResult>;
  revokeSession(refreshTokenHash: string, now: Date): Promise<boolean>;
  takeRateLimit(input: {
    scope: string;
    subjectHash: string;
    maximum: number;
    windowMs: number;
    now: Date;
  }): Promise<RateLimitResult>;
  recordSecurityEvent(input: {
    id: string;
    userId: string | null;
    eventType: string;
    outcome: string;
    now: Date;
  }): Promise<void>;
  cancelRecoverableDeletion(userId: string, now: Date): Promise<boolean>;
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Account storage returned invalid ${name}.`);
  return value;
}

function readAccount(row: Readonly<Record<string, unknown>>): StoredAccount {
  const status = requiredString(row, "status");
  if (
    status !== "active" &&
    status !== "suspended" &&
    status !== "deleting" &&
    status !== "deleted"
  ) {
    throw new Error("Account storage returned an invalid status.");
  }
  return {
    id: requiredString(row, "id"),
    email: requiredString(row, "primary_email"),
    verified: row["email_verified_at"] !== null,
    status,
  };
}

const SECURITY_NOTICE_LABELS: Readonly<Record<string, string>> = {
  "account.password_reset": "Password reset",
  "account.password_created": "Password sign-in added",
  "account.password_change": "Password changed",
  "account.password_removed": "Password sign-in removed",
  "account.google_link": "Google sign-in linked",
  "account.google_unlink": "Google sign-in unlinked",
  "account.orcid_link": "ORCID sign-in linked",
  "account.orcid_unlink": "ORCID sign-in unlinked",
  "account.additional_email_verification": "Email address added",
  "account.primary_email_changed": "Primary email changed",
  "account.notification_email_changed": "Notification email changed",
  "account.email_removed": "Email address removed",
  "account.session_revoked": "Device session revoked",
  "account.other_sessions_revoked": "Other device sessions revoked",
  "account.deletion_requested": "Account deletion scheduled",
  "account.deletion_cancelled": "Account deletion cancelled",
};

const CONNECTION_NOTICE_PROVIDERS: Readonly<Record<string, string>> = {
  github: "GitHub",
  zotero: "Zotero",
  mendeley: "Mendeley",
  osf: "Open Science Framework",
  figshare: "figshare",
  zenodo: "Zenodo",
};

function securityNoticeLabel(eventType: string): string | undefined {
  const known = SECURITY_NOTICE_LABELS[eventType];
  if (known !== undefined) return known;
  const match = /^account\.connection_([a-z]+)_(added|removed|reauthorization_required)$/u.exec(
    eventType,
  );
  if (match === null) return undefined;
  const provider = CONNECTION_NOTICE_PROVIDERS[match[1] ?? ""];
  const action = match[2];
  if (provider === undefined) return undefined;
  if (action === "added") return `${provider} connected account added`;
  if (action === "removed") return `${provider} connected account removed`;
  return `${provider} connected account requires authorization`;
}

async function queryAccount(executor: SqlExecutor, email: string) {
  const result = await executor.query(
    `SELECT id, primary_email, status, email_verified_at
       FROM user_accounts
      WHERE primary_email = $1`,
    [email],
  );
  const row = result.rows[0];
  return row === undefined ? null : readAccount(row);
}

function readDate(value: unknown, name: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Account storage returned invalid ${name}.`);
  return date;
}

export function createPostgresAccountAuthStore(database: ServiceDatabase): AccountAuthStore {
  return {
    async createOrReadAccount(input): Promise<AccountCreationResult> {
      return database.transaction(async (executor) => {
        const inserted = await executor.query(
          `INSERT INTO user_accounts
             (id, primary_email, given_name, family_name, phone, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
           ON CONFLICT (primary_email) DO NOTHING
           RETURNING id, primary_email, status, email_verified_at`,
          [input.id, input.email, input.givenName, input.familyName, input.phone, input.now],
        );
        const row = inserted.rows[0];
        if (row !== undefined) {
          await executor.query(
            `INSERT INTO password_credentials
               (user_id, verifier, parameter_version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4)`,
            [input.id, input.verifier, input.parameterVersion, input.now],
          );
          await executor.query(
            `INSERT INTO account_emails (id, user_id, address, kind, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [input.emailId, input.id, input.email, input.emailKind, input.now],
          );
          return { account: readAccount(row), created: true };
        }
        const existing = await queryAccount(executor, input.email);
        if (existing === null) throw new Error("Account creation did not resolve an account.");
        return { account: existing, created: false };
      });
    },

    async findCredential(email): Promise<StoredCredential | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT a.id, a.primary_email, a.status, a.email_verified_at,
                  p.verifier, p.parameter_version
             FROM user_accounts a
             JOIN password_credentials p ON p.user_id = a.id
            WHERE a.primary_email = $1`,
          [email],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const parameterVersion = row["parameter_version"];
        if (typeof parameterVersion !== "number") {
          throw new Error("Account storage returned invalid password parameters.");
        }
        return {
          ...readAccount(row),
          verifier: requiredString(row, "verifier"),
          parameterVersion,
        };
      });
    },

    async findUnverifiedAccount(email): Promise<StoredAccount | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id, primary_email, status, email_verified_at
             FROM user_accounts
            WHERE primary_email = $1
              AND status = 'active'
              AND email_verified_at IS NULL`,
          [email],
        );
        const row = result.rows[0];
        return row === undefined ? null : readAccount(row);
      });
    },

    async issueEmailVerification(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `UPDATE email_verifications
              SET consumed_at = $2
            WHERE user_id = $1 AND consumed_at IS NULL`,
          [input.userId, input.now],
        );
        await executor.query(
          `INSERT INTO email_verifications
             (id, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.userId, input.tokenHash, input.expiresAt, input.now],
        );
      });
    },

    async consumeEmailVerification(input): Promise<StoredAccount | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT v.id AS verification_id, a.id, a.primary_email, a.status, a.email_verified_at
             FROM email_verifications v
             JOIN user_accounts a ON a.id = v.user_id
            WHERE a.primary_email = $1
              AND v.token_hash = $2
              AND v.consumed_at IS NULL
              AND v.expires_at > $3
            FOR UPDATE OF v, a`,
          [input.email, input.tokenHash, input.now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        await executor.query("UPDATE email_verifications SET consumed_at = $2 WHERE id = $1", [
          requiredString(row, "verification_id"),
          input.now,
        ]);
        await executor.query(
          `UPDATE user_accounts
              SET email_verified_at = COALESCE(email_verified_at, $2), updated_at = $2
            WHERE id = $1`,
          [requiredString(row, "id"), input.now],
        );
        await executor.query(
          `UPDATE account_emails
              SET verified_at = COALESCE(verified_at, $3),
                  is_primary = true,
                  receives_notifications = true
            WHERE user_id = $1 AND address = $2`,
          [requiredString(row, "id"), input.email, input.now],
        );
        const userId = requiredString(row, "id");
        const accepted = await executor.query(
          `UPDATE workspace_invitations
              SET status = 'accepted'
            WHERE email = $1 AND status = 'pending' AND expires_at > $2
          RETURNING id, workspace_id, role`,
          [input.email, input.now],
        );
        for (const invitation of accepted.rows) {
          const workspaceId = requiredString(invitation, "workspace_id");
          const invitationId = requiredString(invitation, "id");
          const invitationRole = requiredString(invitation, "role");
          await executor.query(
            `INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [workspaceId, userId, invitationRole, input.now],
          );
          await executor.query(
            `INSERT INTO account_notifications
               (id, user_id, category, kind, title, detail, workspace_id,
                dedupe_key, created_at)
             SELECT gen_random_uuid(), $1, 'workspace_invitations', 'workspace_invitation',
                    'Workspace invitation',
                    'You joined ' || title || ' as ' || $2 || '.',
                    id, $3, $4
               FROM service_workspaces WHERE id = $5
             ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
            [
              userId,
              invitationRole,
              `workspace-invitation:${invitationId}`,
              input.now,
              workspaceId,
            ],
          );
        }
        return { ...readAccount(row), verified: true };
      });
    },

    async issuePasswordReset(input): Promise<string | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id
             FROM user_accounts
            WHERE primary_email = $1 AND status = 'active' AND email_verified_at IS NOT NULL
            FOR UPDATE`,
          [input.email],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const userId = requiredString(row, "id");
        await executor.query(
          `UPDATE password_resets
              SET consumed_at = $2
            WHERE user_id = $1 AND consumed_at IS NULL`,
          [userId, input.now],
        );
        await executor.query(
          `INSERT INTO password_resets
             (id, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, userId, input.tokenHash, input.expiresAt, input.now],
        );
        return userId;
      });
    },

    async consumePasswordReset(input): Promise<StoredAccount | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT r.id AS reset_id, a.id, a.primary_email, a.status, a.email_verified_at
             FROM password_resets r
             JOIN user_accounts a ON a.id = r.user_id
            WHERE a.primary_email = $1
              AND r.token_hash = $2
              AND r.consumed_at IS NULL
              AND r.expires_at > $3
              AND a.status = 'active'
            FOR UPDATE OF r, a`,
          [input.email, input.tokenHash, input.now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const userId = requiredString(row, "id");
        await executor.query("UPDATE password_resets SET consumed_at = $2 WHERE id = $1", [
          requiredString(row, "reset_id"),
          input.now,
        ]);
        // An account created through Google or ORCID has no password row at all, so
        // recovery has to be able to write the first one rather than only replace one.
        await executor.query(
          `INSERT INTO password_credentials
             (user_id, verifier, parameter_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (user_id) DO UPDATE
             SET verifier = EXCLUDED.verifier,
                 parameter_version = EXCLUDED.parameter_version,
                 updated_at = EXCLUDED.updated_at`,
          [userId, input.verifier, input.parameterVersion, input.now],
        );
        await executor.query(
          "UPDATE device_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
          [userId, input.now],
        );
        return readAccount(row);
      });
    },

    async createSession(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO device_sessions
             (id, user_id, device_name, access_token_hash, access_expires_at,
              created_at, last_authenticated_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
          [
            input.id,
            input.userId,
            input.deviceName,
            input.accessTokenHash,
            input.expiresAt,
            input.now,
          ],
        );
        await executor.query(
          `INSERT INTO session_refresh_tokens
             (id, session_id, token_hash, status, expires_at, created_at)
           VALUES ($1, $2, $3, 'active', $4, $5)`,
          [input.refreshId, input.id, input.refreshTokenHash, input.refreshExpiresAt, input.now],
        );
      });
    },

    async rotateSession(input): Promise<SessionRotationResult> {
      return database.transaction(async (executor) => {
        const found = await executor.query(
          `SELECT t.id AS token_id, t.status AS token_status, t.expires_at AS refresh_expires_at,
                  s.id AS session_id, s.revoked_at,
                  a.id, a.primary_email, a.status, a.email_verified_at
             FROM session_refresh_tokens t
             JOIN device_sessions s ON s.id = t.session_id
             JOIN user_accounts a ON a.id = s.user_id
            WHERE t.token_hash = $1
            FOR UPDATE OF t, s, a`,
          [input.refreshTokenHash],
        );
        const row = found.rows[0];
        if (row === undefined) return { kind: "invalid" };
        const sessionId = requiredString(row, "session_id");
        const tokenStatus = requiredString(row, "token_status");
        if (tokenStatus === "used") {
          await executor.query(
            "UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1",
            [sessionId, input.now],
          );
          await executor.query(
            "UPDATE session_refresh_tokens SET status = 'revoked' WHERE session_id = $1 AND status = 'active'",
            [sessionId],
          );
          return { kind: "reuse" };
        }
        if (
          tokenStatus !== "active" ||
          row["revoked_at"] !== null ||
          readDate(row["refresh_expires_at"], "refresh expiry") <= input.now
        ) {
          return { kind: "invalid" };
        }
        const account = readAccount(row);
        if (!account.verified || account.status !== "active") return { kind: "invalid" };
        await executor.query(
          "UPDATE session_refresh_tokens SET status = 'used', used_at = $2 WHERE id = $1",
          [requiredString(row, "token_id"), input.now],
        );
        await executor.query(
          `INSERT INTO session_refresh_tokens
             (id, session_id, token_hash, status, expires_at, created_at)
           VALUES ($1, $2, $3, 'active', $4, $5)`,
          [
            input.nextRefreshId,
            sessionId,
            input.nextRefreshTokenHash,
            input.nextRefreshExpiresAt,
            input.now,
          ],
        );
        await executor.query(
          `UPDATE device_sessions
              SET access_token_hash = $2,
                  access_expires_at = $3,
                  last_seen_at = $4
            WHERE id = $1`,
          [sessionId, input.accessTokenHash, input.accessExpiresAt, input.now],
        );
        return { kind: "authenticated", account };
      });
    },

    async revokeSession(refreshTokenHash, now): Promise<boolean> {
      return database.transaction(async (executor) => {
        const found = await executor.query(
          `SELECT session_id
             FROM session_refresh_tokens
            WHERE token_hash = $1
            FOR UPDATE`,
          [refreshTokenHash],
        );
        const row = found.rows[0];
        if (row === undefined) return false;
        const sessionId = requiredString(row, "session_id");
        await executor.query(
          "UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1",
          [sessionId, now],
        );
        await executor.query(
          "UPDATE session_refresh_tokens SET status = 'revoked' WHERE session_id = $1 AND status = 'active'",
          [sessionId],
        );
        return true;
      });
    },

    async takeRateLimit(input): Promise<RateLimitResult> {
      return database.transaction(async (executor) => {
        const resetBefore = new Date(input.now.getTime() - input.windowMs);
        const result = await executor.query(
          `INSERT INTO auth_rate_limits
             (scope, subject_hash, window_started_at, attempt_count)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (scope, subject_hash) DO UPDATE
             SET attempt_count = CASE
                   WHEN auth_rate_limits.window_started_at <= $4 THEN 1
                   ELSE auth_rate_limits.attempt_count + 1
                 END,
                 window_started_at = CASE
                   WHEN auth_rate_limits.window_started_at <= $4 THEN $3
                   ELSE auth_rate_limits.window_started_at
                 END
           RETURNING attempt_count, window_started_at`,
          [input.scope, input.subjectHash, input.now, resetBefore],
        );
        const row = result.rows[0];
        const count = row?.["attempt_count"];
        if (typeof count !== "number" || row === undefined) {
          throw new Error("Account storage returned an invalid rate limit.");
        }
        const started = readDate(row["window_started_at"], "rate-limit window");
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((started.getTime() + input.windowMs - input.now.getTime()) / 1_000),
        );
        return { allowed: count <= input.maximum, retryAfterSeconds };
      });
    },

    // A deletion is a scheduled state, not an erasure. Anyone who can still authenticate
    // inside the recovery window is the account holder, so authenticating restores it.
    async cancelRecoverableDeletion(userId, now): Promise<boolean> {
      return database.transaction(async (executor) => {
        const pending = await executor.query(
          `DELETE FROM account_deletion_requests
            WHERE user_id = $1 AND recover_until > $2
          RETURNING user_id`,
          [userId, now],
        );
        if (pending.rows.length === 0) return false;
        await executor.query(
          "UPDATE user_accounts SET status = 'active', updated_at = $2 WHERE id = $1",
          [userId, now],
        );
        return true;
      });
    },

    async recordSecurityEvent(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO account_security_events
             (id, user_id, event_type, outcome, occurred_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.userId, input.eventType, input.outcome, input.now],
        );
        const label = securityNoticeLabel(input.eventType);
        if (
          input.userId !== null &&
          label !== undefined &&
          (input.outcome === "succeeded" ||
            input.outcome === "accepted" ||
            input.outcome === "attention_required")
        ) {
          await executor.query(
            `INSERT INTO notification_email_outbox
               (id, recipient, subject, body, available_at, created_at)
             SELECT gen_random_uuid(), address, 'Kiwi account security notice',
                    $2 || '. If you did not make this change, reset your password and review active sessions in Kiwi.',
                    $3, $3
               FROM account_emails
              WHERE user_id = $1 AND verified_at IS NOT NULL`,
            [input.userId, label, input.now],
          );
        }
      });
    },
  };
}
