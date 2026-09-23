import {
  deriveDisplayName,
  isProfileComplete,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFAULTS,
  type AccountAvatarSummary,
  type AccountExport,
  type AccountProfile,
  type AvatarMediaType,
  type AccountSettingsSnapshot,
  type NotificationCategory,
  type NotificationPreference,
} from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";

export interface AccountAccessContext {
  accountId: string;
  sessionId: string;
  lastAuthenticatedAt: Date;
}

export interface AccountSettingsStore {
  authenticate(accessTokenHash: string, now: Date): Promise<AccountAccessContext | null>;
  reauthenticateSession(accountId: string, sessionId: string, now: Date): Promise<boolean>;
  snapshot(context: AccountAccessContext): Promise<AccountSettingsSnapshot>;
  updateProfile(accountId: string, profile: AccountProfile, now: Date): Promise<void>;
  revokeSession(
    accountId: string,
    currentSessionId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean>;
  revokeOtherSessions(accountId: string, currentSessionId: string, now: Date): Promise<void>;
  requestDeletion(accountId: string, now: Date, recoverUntil: Date): Promise<RequestDeletionResult>;
  primaryEmail(accountId: string): Promise<string | null>;
  passwordCredential(accountId: string): Promise<StoredPasswordCredential | null>;
  setPassword(input: {
    accountId: string;
    verifier: string;
    parameterVersion: number;
    currentSessionId: string;
    now: Date;
  }): Promise<void>;
  removePassword(input: { accountId: string }): Promise<RemovePasswordResult>;
  setNotificationPreference(input: {
    accountId: string;
    preference: NotificationPreference;
    now: Date;
  }): Promise<void>;
  exportAccount(context: AccountAccessContext, now: Date): Promise<AccountExport>;
  readAvatar(accountId: string): Promise<StoredAvatar | null>;
  setAvatar(input: {
    accountId: string;
    contentHash: string;
    mediaType: AvatarMediaType;
    bytes: Uint8Array;
    now: Date;
  }): Promise<void>;
  removeAvatar(accountId: string): Promise<void>;
}

export interface StoredAvatar {
  contentHash: string;
  mediaType: AvatarMediaType;
  bytes: Buffer;
}

export interface StoredPasswordCredential {
  verifier: string;
  parameterVersion: number;
}

export type RemovePasswordResult =
  { kind: "removed" } | { kind: "not_set" } | { kind: "last_method" };

export type RequestDeletionResult =
  { kind: "requested" } | { kind: "ownership_required"; workspaces: string[] };

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string")
    throw new Error(`Account settings storage returned invalid ${name}.`);
  return value;
}

function optionalString(row: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new Error(`Account settings storage returned invalid ${name}.`);
  return value;
}

function readDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new Error("Account settings storage returned invalid time.");
  return date;
}

// A stored row overrides the category default. Every category is always reported, so a
// category added later needs no backfill and no migration of existing accounts.
function readNotifications(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): NotificationPreference[] {
  const stored = new Map<string, boolean>();
  for (const row of rows) {
    const category = row["category"];
    if (typeof category === "string" && typeof row["email"] === "boolean") {
      stored.set(category, row["email"]);
    }
  }
  return NOTIFICATION_CATEGORIES.map((category: NotificationCategory) => ({
    category,
    email: stored.get(category) ?? NOTIFICATION_DEFAULTS[category],
  }));
}

function readAvatarMediaTypeColumn(value: unknown): AvatarMediaType {
  if (value !== "image/png" && value !== "image/jpeg" && value !== "image/webp") {
    throw new Error("Account settings storage returned an invalid avatar media type.");
  }
  return value;
}

function readAvatarSummary(
  row: Readonly<Record<string, unknown>> | undefined,
): AccountAvatarSummary | null {
  return row === undefined
    ? null
    : {
        content_hash: requiredString(row, "content_hash"),
        media_type: readAvatarMediaTypeColumn(row["media_type"]),
      };
}

const ACTIVITY_RESOLUTION_MS = 60 * 1_000;

export function createPostgresAccountSettingsStore(
  database: ServiceDatabase,
): AccountSettingsStore {
  return {
    async authenticate(accessTokenHash, now): Promise<AccountAccessContext | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT s.id AS session_id, s.user_id, s.last_authenticated_at, s.last_seen_at
             FROM device_sessions s
             JOIN user_accounts a ON a.id = s.user_id
            WHERE s.access_token_hash = $1
              AND s.access_expires_at > $2
              AND s.revoked_at IS NULL
              AND a.status = 'active'`,
          [accessTokenHash, now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const sessionId = requiredString(row, "session_id");
        // One write per minute at most. Recording every request would turn every read of
        // account settings into a write.
        if (now.getTime() - readDate(row["last_seen_at"]).getTime() >= ACTIVITY_RESOLUTION_MS) {
          await executor.query("UPDATE device_sessions SET last_seen_at = $2 WHERE id = $1", [
            sessionId,
            now,
          ]);
        }
        return {
          accountId: requiredString(row, "user_id"),
          sessionId,
          lastAuthenticatedAt: readDate(row["last_authenticated_at"]),
        };
      });
    },

    async reauthenticateSession(accountId, sessionId, now): Promise<boolean> {
      return database.transaction(async (executor) => {
        const updated = await executor.query(
          `UPDATE device_sessions
              SET last_authenticated_at = $3,
                  last_seen_at = GREATEST(last_seen_at, $3)
            WHERE id = $1
              AND user_id = $2
              AND revoked_at IS NULL
              AND access_expires_at > $3
          RETURNING id`,
          [sessionId, accountId, now],
        );
        return updated.rows.length === 1;
      });
    },

    async snapshot(context): Promise<AccountSettingsSnapshot> {
      return database.transaction(async (executor) => {
        const accountResult = await executor.query(
          `SELECT a.id, a.primary_email, a.given_name, a.family_name,
                  a.phone, a.email_verified_at,
                  EXISTS (SELECT 1 FROM password_credentials p WHERE p.user_id = a.id) AS has_password,
                  EXISTS (SELECT 1 FROM external_identities e WHERE e.user_id = a.id AND e.provider = 'google') AS has_google,
                  EXISTS (SELECT 1 FROM external_identities e WHERE e.user_id = a.id AND e.provider = 'orcid') AS has_orcid,
                  d.recover_until
             FROM user_accounts a
             LEFT JOIN account_deletion_requests d ON d.user_id = a.id
            WHERE a.id = $1`,
          [context.accountId],
        );
        const row = accountResult.rows[0];
        if (row === undefined || row["email_verified_at"] === null) {
          throw new Error("Account settings could not resolve the account.");
        }
        const sessionsResult = await executor.query(
          `SELECT id, device_name, created_at, last_authenticated_at, last_seen_at
             FROM device_sessions
            WHERE user_id = $1 AND revoked_at IS NULL
            ORDER BY last_seen_at DESC`,
          [context.accountId],
        );
        // The account event log already records every sign-in, link, and password change.
        // Reading a bounded, recent window back makes that history visible to its owner.
        const activityResult = await executor.query(
          `SELECT id, event_type, outcome, occurred_at
             FROM account_security_events
            WHERE user_id = $1
            ORDER BY occurred_at DESC
            LIMIT 25`,
          [context.accountId],
        );
        // Sole ownership is what deletion cannot resolve on its own, so it is listed by
        // name. Everything else is counted.
        const ownedResult = await executor.query(
          `SELECT w.id, w.title,
                  (SELECT count(*)
                     FROM workspace_memberships peer
                     JOIN user_accounts peer_account ON peer_account.id = peer.user_id
                    WHERE peer.workspace_id = w.id
                      AND peer.role = 'owner'
                      AND peer.user_id <> $1
                      AND peer_account.status = 'active') AS other_owners
             FROM service_workspaces w
             JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $1
            WHERE m.role = 'owner'
            ORDER BY w.title
            LIMIT 100`,
          [context.accountId],
        );
        const impactResult = await executor.query(
          `SELECT
             (SELECT count(*) FROM workspace_memberships
               WHERE user_id = $1 AND role <> 'owner')::integer AS shared_workspaces,
             (SELECT count(*) FROM account_emails WHERE user_id = $1)::integer AS addresses,
             (SELECT count(*) FROM connected_accounts WHERE user_id = $1)::integer AS connections`,
          [context.accountId],
        );
        const avatarResult = await executor.query(
          "SELECT content_hash, media_type FROM account_avatars WHERE user_id = $1",
          [context.accountId],
        );
        const notificationResult = await executor.query(
          "SELECT category, email FROM account_notification_preferences WHERE user_id = $1",
          [context.accountId],
        );
        const emailResult = await executor.query(
          `SELECT id, address, kind, verified_at, is_primary, receives_notifications
             FROM account_emails
            WHERE user_id = $1
            ORDER BY is_primary DESC, created_at`,
          [context.accountId],
        );
        const methods: Array<"google" | "orcid" | "password"> = [];
        if (row["has_google"] === true) methods.push("google");
        if (row["has_orcid"] === true) methods.push("orcid");
        if (row["has_password"] === true) methods.push("password");
        const recoverUntil = row["recover_until"];
        const primaryEmail = requiredString(row, "primary_email");
        const profile: AccountProfile = {
          given_name: optionalString(row, "given_name"),
          family_name: optionalString(row, "family_name"),
          phone: optionalString(row, "phone"),
        };
        return {
          account: {
            id: requiredString(row, "id"),
            email: primaryEmail,
            profile,
            display_name: deriveDisplayName(profile, primaryEmail),
            profile_complete: isProfileComplete(profile),
            email_verified: true,
            avatar: readAvatarSummary(avatarResult.rows[0]),
          },
          sign_in_methods: methods,
          sessions: sessionsResult.rows.map((session) => ({
            id: requiredString(session, "id"),
            device_name: requiredString(session, "device_name"),
            current: requiredString(session, "id") === context.sessionId,
            started_at: readDate(session["created_at"]).toISOString(),
            last_authenticated_at: readDate(session["last_authenticated_at"]).toISOString(),
            last_seen_at: readDate(session["last_seen_at"]).toISOString(),
          })),
          emails: emailResult.rows.map((entry) => ({
            id: requiredString(entry, "id"),
            address: requiredString(entry, "address"),
            kind:
              entry["kind"] === "institutional"
                ? ("institutional" as const)
                : ("personal" as const),
            verified: entry["verified_at"] !== null,
            primary: entry["is_primary"] === true,
            receives_notifications: entry["receives_notifications"] === true,
          })),
          security_activity: activityResult.rows.map((entry) => ({
            id: requiredString(entry, "id"),
            event: requiredString(entry, "event_type"),
            outcome: requiredString(entry, "outcome"),
            occurred_at: readDate(entry["occurred_at"]).toISOString(),
          })),
          notifications: readNotifications(notificationResult.rows),
          deletion_impact: {
            sole_owner_workspaces: ownedResult.rows
              .filter((row) => Number(row["other_owners"] ?? 0) === 0)
              .map((row) => ({
                id: requiredString(row, "id"),
                title: requiredString(row, "title"),
              })),
            shared_workspaces: Number(impactResult.rows[0]?.["shared_workspaces"] ?? 0),
            addresses: Number(impactResult.rows[0]?.["addresses"] ?? 0),
            connections: Number(impactResult.rows[0]?.["connections"] ?? 0),
          },
          deletion:
            recoverUntil === null
              ? { status: "none" }
              : { status: "pending", recover_until: readDate(recoverUntil).toISOString() },
        };
      });
    },

    async updateProfile(accountId, profile, now): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `UPDATE user_accounts
              SET given_name = $2, family_name = $3, phone = $4, updated_at = $5
            WHERE id = $1`,
          [accountId, profile.given_name, profile.family_name, profile.phone, now],
        );
      });
    },

    async revokeSession(accountId, currentSessionId, sessionId, now): Promise<boolean> {
      if (currentSessionId === sessionId) return false;
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `UPDATE device_sessions
              SET revoked_at = $4
            WHERE id = $1 AND user_id = $2 AND id <> $3 AND revoked_at IS NULL
          RETURNING id`,
          [sessionId, accountId, currentSessionId, now],
        );
        if (result.rows.length === 0) return false;
        await executor.query(
          "UPDATE session_refresh_tokens SET status = 'revoked' WHERE session_id = $1 AND status = 'active'",
          [sessionId],
        );
        return true;
      });
    },

    async revokeOtherSessions(accountId, currentSessionId, now): Promise<void> {
      await database.transaction(async (executor) => {
        const revoked = await executor.query(
          `UPDATE device_sessions
              SET revoked_at = $3
            WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
          RETURNING id`,
          [accountId, currentSessionId, now],
        );
        const ids = revoked.rows.map((row) => requiredString(row, "id"));
        if (ids.length > 0) {
          await executor.query(
            "UPDATE session_refresh_tokens SET status = 'revoked' WHERE session_id = ANY($1::uuid[]) AND status = 'active'",
            [ids],
          );
        }
      });
    },

    async primaryEmail(accountId): Promise<string | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          "SELECT primary_email FROM user_accounts WHERE id = $1 AND status = 'active'",
          [accountId],
        );
        const row = result.rows[0];
        return row === undefined ? null : requiredString(row, "primary_email");
      });
    },

    async passwordCredential(accountId): Promise<StoredPasswordCredential | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          "SELECT verifier, parameter_version FROM password_credentials WHERE user_id = $1",
          [accountId],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const parameterVersion = row["parameter_version"];
        if (typeof parameterVersion !== "number") {
          throw new Error("Account settings storage returned invalid password parameters.");
        }
        return { verifier: requiredString(row, "verifier"), parameterVersion };
      });
    },

    async setPassword(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO password_credentials
             (user_id, verifier, parameter_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (user_id) DO UPDATE
             SET verifier = EXCLUDED.verifier,
                 parameter_version = EXCLUDED.parameter_version,
                 updated_at = EXCLUDED.updated_at`,
          [input.accountId, input.verifier, input.parameterVersion, input.now],
        );
        // A new password ends every other session. The session that set it stays, so the
        // person who made the change is not signed out of the window they made it in.
        const revoked = await executor.query(
          `UPDATE device_sessions
              SET revoked_at = $3
            WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
          RETURNING id`,
          [input.accountId, input.currentSessionId, input.now],
        );
        const ids = revoked.rows.map((row) => requiredString(row, "id"));
        if (ids.length > 0) {
          await executor.query(
            "UPDATE session_refresh_tokens SET status = 'revoked' WHERE session_id = ANY($1::uuid[]) AND status = 'active'",
            [ids],
          );
        }
      });
    },

    async removePassword(input): Promise<RemovePasswordResult> {
      return database.transaction(async (executor) => {
        const remaining = await executor.query(
          `SELECT
             EXISTS (SELECT 1 FROM password_credentials WHERE user_id = $1) AS has_password,
             EXISTS (
               SELECT 1 FROM external_identities
                WHERE user_id = $1 AND provider = 'google'
             ) AS has_google`,
          [input.accountId],
        );
        const row = remaining.rows[0];
        if (row === undefined || row["has_password"] !== true) return { kind: "not_set" };
        if (row["has_google"] !== true) return { kind: "last_method" };
        await executor.query("DELETE FROM password_credentials WHERE user_id = $1", [
          input.accountId,
        ]);
        return { kind: "removed" };
      });
    },

    async readAvatar(accountId): Promise<StoredAvatar | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          "SELECT content_hash, media_type, bytes FROM account_avatars WHERE user_id = $1",
          [accountId],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const bytes = row["bytes"];
        if (!Buffer.isBuffer(bytes)) {
          throw new Error("Account settings storage returned invalid avatar bytes.");
        }
        return {
          contentHash: requiredString(row, "content_hash"),
          mediaType: readAvatarMediaTypeColumn(row["media_type"]),
          bytes,
        };
      });
    },

    async setAvatar(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO account_avatars
             (user_id, content_hash, media_type, byte_size, bytes, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
             SET content_hash = EXCLUDED.content_hash,
                 media_type = EXCLUDED.media_type,
                 byte_size = EXCLUDED.byte_size,
                 bytes = EXCLUDED.bytes,
                 updated_at = EXCLUDED.updated_at`,
          [
            input.accountId,
            input.contentHash,
            input.mediaType,
            input.bytes.byteLength,
            Buffer.from(input.bytes),
            input.now,
          ],
        );
      });
    },

    async removeAvatar(accountId): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query("DELETE FROM account_avatars WHERE user_id = $1", [accountId]);
      });
    },

    async exportAccount(context, now): Promise<AccountExport> {
      const snapshot = await this.snapshot(context);
      return database.transaction(async (executor) => {
        const accountResult = await executor.query(
          "SELECT created_at FROM user_accounts WHERE id = $1",
          [context.accountId],
        );
        // The snapshot bounds security activity to a readable window. An export is the
        // account's own record, so it carries the whole log.
        const activityResult = await executor.query(
          `SELECT id, event_type, outcome, occurred_at
             FROM account_security_events
            WHERE user_id = $1
            ORDER BY occurred_at DESC
            LIMIT 5000`,
          [context.accountId],
        );
        const connectionResult = await executor.query(
          `SELECT provider, external_account_label, connected_at
             FROM connected_accounts
            WHERE user_id = $1
            ORDER BY provider`,
          [context.accountId],
        );
        const workspaceResult = await executor.query(
          `SELECT w.id, w.title, m.role, m.joined_at
             FROM workspace_memberships m
             JOIN service_workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = $1
            ORDER BY w.title`,
          [context.accountId],
        );
        const created = accountResult.rows[0]?.["created_at"];
        return {
          format: "kiwi.account-export.v1",
          generated_at: now.toISOString(),
          account: {
            id: snapshot.account.id,
            primary_email: snapshot.account.email,
            given_name: snapshot.account.profile.given_name,
            family_name: snapshot.account.profile.family_name,
            phone: snapshot.account.profile.phone,
            created_at: created === undefined ? now.toISOString() : readDate(created).toISOString(),
          },
          emails: snapshot.emails,
          sign_in_methods: [...snapshot.sign_in_methods],
          connected_accounts: connectionResult.rows.map((row) => ({
            provider: requiredString(row, "provider"),
            account_label: requiredString(row, "external_account_label"),
            connected_at: readDate(row["connected_at"]).toISOString(),
          })),
          sessions: snapshot.sessions,
          security_activity: activityResult.rows.map((row) => ({
            id: requiredString(row, "id"),
            event: requiredString(row, "event_type"),
            outcome: requiredString(row, "outcome"),
            occurred_at: readDate(row["occurred_at"]).toISOString(),
          })),
          notifications: snapshot.notifications,
          workspaces: workspaceResult.rows.map((row) => ({
            id: requiredString(row, "id"),
            title: requiredString(row, "title"),
            role: requiredString(row, "role"),
            joined_at: readDate(row["joined_at"]).toISOString(),
          })),
        };
      });
    },

    async setNotificationPreference(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO account_notification_preferences (user_id, category, email, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, category) DO UPDATE
             SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at`,
          [input.accountId, input.preference.category, input.preference.email, input.now],
        );
      });
    },

    async requestDeletion(accountId, now, recoverUntil): Promise<RequestDeletionResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account-deletion:${accountId}`,
        ]);
        const owned = await executor.query(
          `SELECT workspace_id
             FROM workspace_memberships
            WHERE user_id = $1 AND role = 'owner'
            ORDER BY workspace_id`,
          [accountId],
        );
        for (const row of owned.rows) {
          await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `workspace:${requiredString(row, "workspace_id")}`,
          ]);
        }
        const blockers = await executor.query(
          `SELECT w.title
             FROM workspace_memberships owned
             JOIN service_workspaces w ON w.id = owned.workspace_id
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
            ORDER BY w.title`,
          [accountId],
        );
        if (blockers.rows.length > 0) {
          return {
            kind: "ownership_required",
            workspaces: blockers.rows.map((row) => requiredString(row, "title")),
          };
        }
        await executor.query(
          "UPDATE user_accounts SET status = 'deleting', updated_at = $2 WHERE id = $1",
          [accountId, now],
        );
        await executor.query(
          `INSERT INTO account_deletion_requests (user_id, requested_at, recover_until)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE
             SET requested_at = EXCLUDED.requested_at, recover_until = EXCLUDED.recover_until`,
          [accountId, now, recoverUntil],
        );
        await executor.query(
          "UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1",
          [accountId, now],
        );
        await executor.query(
          `UPDATE session_refresh_tokens t
              SET status = 'revoked'
             FROM device_sessions s
            WHERE t.session_id = s.id AND s.user_id = $1 AND t.status = 'active'`,
          [accountId],
        );
        return { kind: "requested" };
      });
    },
  };
}
