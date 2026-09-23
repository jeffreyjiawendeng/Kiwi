import type { AccountRegistrationProfile } from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";
import type { StoredAccount } from "./auth-store.js";
import type { OidcProviderId } from "./auth-fixtures.js";
import type { SecretCipher } from "./secret-crypto.js";

export interface StoredIdentityAuthorization {
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
}

export type OidcIdentityResolution =
  | { kind: "account"; account: StoredAccount }
  | { kind: "link_required" }
  | { kind: "unknown_identity" };

export type OidcLinkResult =
  { kind: "linked" } | { kind: "already_linked_here" } | { kind: "claimed_elsewhere" };

export type OidcUnlinkResult =
  | { kind: "unlinked"; revocationSecret: string | null }
  | { kind: "not_linked" }
  | { kind: "last_method" };

export interface OidcTransaction {
  provider: OidcProviderId;
  linkUserId: string | null;
  reauthSessionId: string | null;
}

export interface OidcProviderCallback {
  provider: OidcProviderId;
  redirectUri: string;
}

export interface OidcAuthStore {
  beginTransaction(input: {
    id: string;
    provider: OidcProviderId;
    linkUserId: string | null;
    reauthSessionId: string | null;
    stateHash: string;
    callbackStateHash: string;
    nonceHash: string;
    codeChallenge: string;
    redirectUri: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  consumeTransaction(input: {
    stateHash: string;
    nonceHash: string;
    codeChallenge: string;
    redirectUri: string;
    now: Date;
  }): Promise<OidcTransaction | null>;
  providerCallback(input: {
    callbackStateHash: string;
    now: Date;
  }): Promise<OidcProviderCallback | null>;
  resolveIdentity(input: {
    provider: OidcProviderId;
    accountId: string;
    emailId: string;
    identityId: string;
    subject: string;
    email: string | null;
    displayLabel: string | null;
    registrationProfile: AccountRegistrationProfile | null;
    authorization: StoredIdentityAuthorization | null;
    now: Date;
  }): Promise<OidcIdentityResolution>;
  linkIdentity(input: {
    provider: OidcProviderId;
    identityId: string;
    userId: string;
    subject: string;
    email: string | null;
    displayLabel: string | null;
    authorization: StoredIdentityAuthorization | null;
    now: Date;
  }): Promise<OidcLinkResult>;
  reauthenticateIdentity(input: {
    provider: OidcProviderId;
    subject: string;
    userId: string;
    sessionId: string;
    authorization: StoredIdentityAuthorization | null;
    now: Date;
  }): Promise<boolean>;
  unlinkIdentity(input: { provider: OidcProviderId; userId: string }): Promise<OidcUnlinkResult>;
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Identity storage returned invalid ${name}.`);
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
    throw new Error("Identity storage returned an invalid account status.");
  }
  return {
    id: requiredString(row, "id"),
    email: requiredString(row, "primary_email"),
    verified: row["email_verified_at"] !== null,
    status,
  };
}

function readProvider(value: unknown): OidcProviderId {
  if (value !== "google" && value !== "orcid") {
    throw new Error("Identity storage returned an invalid provider.");
  }
  return value;
}

function secretContext(identityId: string, kind: "access" | "refresh"): string {
  return `identity:${identityId}:${kind}`;
}

function protectAuthorization(
  cipher: SecretCipher,
  identityId: string,
  authorization: StoredIdentityAuthorization | null,
): [string | null, string | null, string | null] {
  return authorization === null
    ? [null, null, null]
    : [
        cipher.encrypt(authorization.accessToken, secretContext(identityId, "access")),
        authorization.refreshToken === null
          ? null
          : cipher.encrypt(authorization.refreshToken, secretContext(identityId, "refresh")),
        authorization.scopes,
      ];
}

export function createPostgresOidcAuthStore(
  database: ServiceDatabase,
  cipher: SecretCipher,
): OidcAuthStore {
  return {
    async beginTransaction(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO oidc_auth_transactions
             (id, provider, link_user_id, reauth_session_id, state_hash, callback_state_hash,
              nonce_hash, code_challenge, redirect_uri, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            input.id,
            input.provider,
            input.linkUserId,
            input.reauthSessionId,
            input.stateHash,
            input.callbackStateHash,
            input.nonceHash,
            input.codeChallenge,
            input.redirectUri,
            input.expiresAt,
            input.now,
          ],
        );
      });
    },

    async providerCallback(input): Promise<OidcProviderCallback | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT provider, redirect_uri
             FROM oidc_auth_transactions
            WHERE callback_state_hash = $1
              AND consumed_at IS NULL
              AND expires_at > $2`,
          [input.callbackStateHash, input.now],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : {
              provider: readProvider(row["provider"]),
              redirectUri: requiredString(row, "redirect_uri"),
            };
      });
    },

    async consumeTransaction(input): Promise<OidcTransaction | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `UPDATE oidc_auth_transactions
              SET consumed_at = $5
            WHERE state_hash = $1
              AND nonce_hash = $2
              AND code_challenge = $3
              AND redirect_uri = $4
              AND consumed_at IS NULL
              AND expires_at > $5
          RETURNING provider, link_user_id, reauth_session_id`,
          [input.stateHash, input.nonceHash, input.codeChallenge, input.redirectUri, input.now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const linkUserId = row["link_user_id"];
        const reauthSessionId = row["reauth_session_id"];
        return {
          provider: readProvider(row["provider"]),
          linkUserId: typeof linkUserId === "string" ? linkUserId : null,
          reauthSessionId: typeof reauthSessionId === "string" ? reauthSessionId : null,
        };
      });
    },

    async resolveIdentity(input): Promise<OidcIdentityResolution> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${input.provider}:${input.subject}`,
        ]);
        const linked = await executor.query(
          `SELECT a.id, a.primary_email, a.status, a.email_verified_at,
                  e.id AS identity_id
             FROM external_identities e
             JOIN user_accounts a ON a.id = e.user_id
            WHERE e.provider = $1 AND e.provider_subject = $2
            FOR UPDATE OF e, a`,
          [input.provider, input.subject],
        );
        const linkedRow = linked.rows[0];
        if (linkedRow !== undefined) {
          const identityId = requiredString(linkedRow, "identity_id");
          const [accessCiphertext, refreshCiphertext, scopes] = protectAuthorization(
            cipher,
            identityId,
            input.authorization,
          );
          await executor.query(
            `UPDATE external_identities
                SET last_authenticated_at = $3,
                    access_secret_ciphertext = COALESCE($4, access_secret_ciphertext),
                    refresh_secret_ciphertext = COALESCE($5, refresh_secret_ciphertext),
                    authorization_scopes = COALESCE($6, authorization_scopes)
              WHERE provider = $1 AND provider_subject = $2`,
            [input.provider, input.subject, input.now, accessCiphertext, refreshCiphertext, scopes],
          );
          return { kind: "account", account: readAccount(linkedRow) };
        }

        // A provider that does not supply a verified email cannot create an account,
        // because a Kiwi account requires one verified address.
        if (input.email === null) return { kind: "unknown_identity" };

        const matchingEmail = await executor.query(
          `SELECT id FROM user_accounts WHERE primary_email = $1 FOR UPDATE`,
          [input.email],
        );
        if (matchingEmail.rows.length > 0) return { kind: "link_required" };
        if (input.registrationProfile === null) return { kind: "unknown_identity" };

        await executor.query(
          `INSERT INTO user_accounts
             (id, primary_email, given_name, family_name, phone, status,
              email_verified_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6)`,
          [
            input.accountId,
            input.email,
            input.registrationProfile.given_name,
            input.registrationProfile.family_name,
            input.registrationProfile.phone,
            input.now,
          ],
        );
        await executor.query(
          `INSERT INTO account_emails
             (id, user_id, address, kind, verified_at, is_primary,
              receives_notifications, created_at)
           VALUES ($1, $2, $3, 'personal', $4, true, true, $4)`,
          [input.emailId, input.accountId, input.email, input.now],
        );
        const [accessCiphertext, refreshCiphertext, scopes] = protectAuthorization(
          cipher,
          input.identityId,
          input.authorization,
        );
        await executor.query(
          `INSERT INTO external_identities
             (id, user_id, provider, provider_subject, provider_email, display_label,
              created_at, last_authenticated_at, access_secret_ciphertext,
              refresh_secret_ciphertext, authorization_scopes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
          [
            input.identityId,
            input.accountId,
            input.provider,
            input.subject,
            input.email,
            input.displayLabel,
            input.now,
            accessCiphertext,
            refreshCiphertext,
            scopes,
          ],
        );
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
            [workspaceId, input.accountId, invitationRole, input.now],
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
              input.accountId,
              invitationRole,
              `workspace-invitation:${invitationId}`,
              input.now,
              workspaceId,
            ],
          );
        }
        return {
          kind: "account",
          account: { id: input.accountId, email: input.email, verified: true, status: "active" },
        };
      });
    },

    async linkIdentity(input): Promise<OidcLinkResult> {
      return database.transaction(async (executor) => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${input.provider}:${input.subject}`,
        ]);
        const existing = await executor.query(
          `SELECT id, user_id FROM external_identities
            WHERE provider = $1 AND provider_subject = $2 FOR UPDATE`,
          [input.provider, input.subject],
        );
        const owner = existing.rows[0];
        if (owner !== undefined) {
          if (requiredString(owner, "user_id") !== input.userId) {
            return { kind: "claimed_elsewhere" };
          }
          const identityId = requiredString(owner, "id");
          const [accessCiphertext, refreshCiphertext, scopes] = protectAuthorization(
            cipher,
            identityId,
            input.authorization,
          );
          await executor.query(
            `UPDATE external_identities
                SET last_authenticated_at = $3,
                    access_secret_ciphertext = COALESCE($4, access_secret_ciphertext),
                    refresh_secret_ciphertext = COALESCE($5, refresh_secret_ciphertext),
                    authorization_scopes = COALESCE($6, authorization_scopes)
              WHERE provider = $1 AND provider_subject = $2`,
            [input.provider, input.subject, input.now, accessCiphertext, refreshCiphertext, scopes],
          );
          return { kind: "already_linked_here" };
        }
        const [accessCiphertext, refreshCiphertext, scopes] = protectAuthorization(
          cipher,
          input.identityId,
          input.authorization,
        );
        const inserted = await executor.query(
          `INSERT INTO external_identities
             (id, user_id, provider, provider_subject, provider_email, display_label,
              created_at, last_authenticated_at, access_secret_ciphertext,
              refresh_secret_ciphertext, authorization_scopes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)
           ON CONFLICT (user_id, provider) DO NOTHING
           RETURNING id`,
          [
            input.identityId,
            input.userId,
            input.provider,
            input.subject,
            input.email,
            input.displayLabel,
            input.now,
            accessCiphertext,
            refreshCiphertext,
            scopes,
          ],
        );
        // A different subject already occupies this provider slot for the account.
        return inserted.rows.length === 1 ? { kind: "linked" } : { kind: "claimed_elsewhere" };
      });
    },

    async reauthenticateIdentity(input): Promise<boolean> {
      return database.transaction(async (executor) => {
        const matched = await executor.query(
          `SELECT e.id
             FROM external_identities e
             JOIN device_sessions s ON s.id = $4 AND s.user_id = e.user_id
            WHERE e.provider = $1
              AND e.provider_subject = $2
              AND e.user_id = $3
              AND s.revoked_at IS NULL
              AND s.access_expires_at > $5
            FOR UPDATE OF e, s`,
          [input.provider, input.subject, input.userId, input.sessionId, input.now],
        );
        if (matched.rows.length !== 1) return false;
        const identityId = requiredString(matched.rows[0]!, "id");
        const [accessCiphertext, refreshCiphertext, scopes] = protectAuthorization(
          cipher,
          identityId,
          input.authorization,
        );
        await executor.query(
          `UPDATE external_identities
              SET last_authenticated_at = $4,
                  access_secret_ciphertext = COALESCE($5, access_secret_ciphertext),
                  refresh_secret_ciphertext = COALESCE($6, refresh_secret_ciphertext),
                  authorization_scopes = COALESCE($7, authorization_scopes)
            WHERE provider = $1 AND provider_subject = $2 AND user_id = $3`,
          [
            input.provider,
            input.subject,
            input.userId,
            input.now,
            accessCiphertext,
            refreshCiphertext,
            scopes,
          ],
        );
        await executor.query(
          "UPDATE device_sessions SET last_authenticated_at = $3 WHERE id = $1 AND user_id = $2",
          [input.sessionId, input.userId, input.now],
        );
        return true;
      });
    },

    async unlinkIdentity(input): Promise<OidcUnlinkResult> {
      return database.transaction(async (executor) => {
        const account = await executor.query(
          "SELECT id FROM user_accounts WHERE id = $1 FOR UPDATE",
          [input.userId],
        );
        if (account.rows.length === 0) return { kind: "not_linked" };

        const methods = await executor.query(
          `SELECT
             (SELECT count(*) FROM external_identities WHERE user_id = $1) AS identities,
             (SELECT count(*) FROM password_credentials WHERE user_id = $1) AS passwords,
             (SELECT count(*) FROM external_identities
               WHERE user_id = $1 AND provider = 'google') AS google_identities,
             (SELECT count(*) FROM external_identities
               WHERE user_id = $1 AND provider = $2) AS matching`,
          [input.userId, input.provider],
        );
        const row = methods.rows[0];
        if (row === undefined) return { kind: "not_linked" };
        const identities = Number(row["identities"]);
        const passwords = Number(row["passwords"]);
        const googleIdentities = Number(row["google_identities"]);
        const matching = Number(row["matching"]);
        if (matching === 0) return { kind: "not_linked" };
        if (
          (input.provider === "google" && passwords === 0) ||
          (input.provider === "orcid" && identities + passwords <= 1) ||
          googleIdentities + passwords === 0
        ) {
          return { kind: "last_method" };
        }

        const identity = await executor.query(
          `DELETE FROM external_identities
            WHERE user_id = $1 AND provider = $2
          RETURNING id, access_secret_ciphertext, refresh_secret_ciphertext`,
          [input.userId, input.provider],
        );
        const deleted = identity.rows[0];
        if (deleted === undefined) return { kind: "not_linked" };
        const identityId = requiredString(deleted, "id");
        const refresh = deleted["refresh_secret_ciphertext"];
        const access = deleted["access_secret_ciphertext"];
        const selected =
          typeof refresh === "string" ? refresh : typeof access === "string" ? access : null;
        const kind = typeof refresh === "string" ? "refresh" : "access";
        return {
          kind: "unlinked",
          revocationSecret:
            selected === null ? null : cipher.decrypt(selected, secretContext(identityId, kind)),
        };
      });
    },
  };
}
