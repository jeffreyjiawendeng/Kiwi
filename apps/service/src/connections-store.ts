import type { ConnectedAccountSummary, ConnectedProviderId } from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";
import type { SecretCipher } from "./secret-crypto.js";

export interface StoredConnectionTransaction {
  id: string;
  userId: string;
  provider: ConnectedProviderId;
  codeVerifier: string | null;
  deviceCodeHash: string | null;
  pollIntervalSeconds: number | null;
  nextPollAt: Date | null;
  oauthRequestToken: string | null;
  oauthRequestSecret: string | null;
}

export interface RefreshableConnection {
  id: string;
  userId: string;
  provider: ConnectedProviderId;
  refreshSecret: string;
}

export interface ConnectionsStore {
  list(userId: string): Promise<ConnectedAccountSummary[]>;
  beginTransaction(input: {
    id: string;
    userId: string;
    provider: ConnectedProviderId;
    stateHash: string;
    codeVerifier: string | null;
    deviceCodeHash: string | null;
    pollIntervalSeconds: number | null;
    nextPollAt: Date | null;
    oauthRequestToken: string | null;
    oauthRequestSecret: string | null;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  readTransaction(input: {
    id: string;
    userId: string;
    now: Date;
  }): Promise<StoredConnectionTransaction | null>;
  consumeByState(input: {
    stateHash: string;
    now: Date;
  }): Promise<StoredConnectionTransaction | null>;
  consumeById(input: { id: string; now: Date }): Promise<boolean>;
  scheduleDevicePoll(input: {
    id: string;
    intervalSeconds: number;
    nextPollAt: Date;
  }): Promise<void>;
  save(input: {
    id: string;
    userId: string;
    provider: ConnectedProviderId;
    externalAccountId: string;
    externalAccountLabel: string;
    scopes: string;
    accessSecret: string;
    refreshSecret: string | null;
    accessExpiresAt: Date | null;
    now: Date;
  }): Promise<void>;
  readSecret(input: { userId: string; provider: ConnectedProviderId }): Promise<string | null>;
  remove(input: { userId: string; provider: ConnectedProviderId }): Promise<boolean>;
  protectLegacySecrets(maximum?: number): Promise<number>;
  claimRefreshable(input: {
    now: Date;
    refreshBefore: Date;
    maximum: number;
  }): Promise<RefreshableConnection[]>;
  completeRefresh(input: {
    id: string;
    accessSecret: string;
    refreshSecret: string | null;
    accessExpiresAt: Date | null;
    scopes: string | null;
    now: Date;
  }): Promise<void>;
  failRefresh(input: { id: string; permanent: boolean; reason: string; now: Date }): Promise<void>;
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Connection storage returned invalid ${name}.`);
  return value;
}

function readProvider(value: unknown): ConnectedProviderId {
  const providers = ["github", "zotero", "mendeley", "osf", "figshare", "zenodo"];
  if (typeof value !== "string" || !providers.includes(value)) {
    throw new Error("Connection storage returned an invalid provider.");
  }
  return value as ConnectedProviderId;
}

function readTransactionRow(row: Readonly<Record<string, unknown>>): StoredConnectionTransaction {
  const verifier = row["code_verifier"];
  const deviceHash = row["device_code_hash"];
  const pollInterval = row["poll_interval_seconds"];
  const nextPoll = row["next_poll_at"];
  const oauthToken = row["oauth_request_token"];
  const oauthSecret = row["oauth_request_secret"];
  return {
    id: requiredString(row, "id"),
    userId: requiredString(row, "user_id"),
    provider: readProvider(row["provider"]),
    codeVerifier: typeof verifier === "string" ? verifier : null,
    deviceCodeHash: typeof deviceHash === "string" ? deviceHash : null,
    pollIntervalSeconds: typeof pollInterval === "number" ? pollInterval : null,
    nextPollAt: nextPoll === null || nextPoll === undefined ? null : new Date(String(nextPoll)),
    oauthRequestToken: typeof oauthToken === "string" ? oauthToken : null,
    oauthRequestSecret: typeof oauthSecret === "string" ? oauthSecret : null,
  };
}

function secretContext(
  userId: string,
  provider: ConnectedProviderId,
  purpose: "access" | "device" | "oauth-secret" | "oauth-token" | "refresh" | "verifier",
): string {
  return `${userId}:${provider}:${purpose}`;
}

function decryptStored(cipher: SecretCipher, value: string | null, context: string): string | null {
  if (value === null) return null;
  return cipher.encrypted(value) ? cipher.decrypt(value, context) : value;
}

export function createPostgresConnectionsStore(
  database: ServiceDatabase,
  cipher: SecretCipher,
): ConnectionsStore {
  return {
    async list(userId): Promise<ConnectedAccountSummary[]> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT provider, external_account_label, scopes, connected_at, authorization_status
             FROM connected_accounts
            WHERE user_id = $1
            ORDER BY provider`,
          [userId],
        );
        return result.rows.map((row) => ({
          provider: readProvider(row["provider"]),
          account_label: requiredString(row, "external_account_label"),
          scopes: requiredString(row, "scopes"),
          connected_at: new Date(String(row["connected_at"])).toISOString(),
          authorization_status:
            row["authorization_status"] === "reauthorization_required"
              ? ("reauthorization_required" as const)
              : ("active" as const),
        }));
      });
    },

    async beginTransaction(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `INSERT INTO connection_transactions
             (id, user_id, provider, state_hash, code_verifier, device_code_hash,
              poll_interval_seconds, next_poll_at, oauth_request_token,
              oauth_request_secret, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            input.id,
            input.userId,
            input.provider,
            input.stateHash,
            input.codeVerifier === null
              ? null
              : cipher.encrypt(
                  input.codeVerifier,
                  secretContext(input.userId, input.provider, "verifier"),
                ),
            input.deviceCodeHash === null
              ? null
              : cipher.encrypt(
                  input.deviceCodeHash,
                  secretContext(input.userId, input.provider, "device"),
                ),
            input.pollIntervalSeconds,
            input.nextPollAt,
            input.oauthRequestToken === null
              ? null
              : cipher.encrypt(
                  input.oauthRequestToken,
                  secretContext(input.userId, input.provider, "oauth-token"),
                ),
            input.oauthRequestSecret === null
              ? null
              : cipher.encrypt(
                  input.oauthRequestSecret,
                  secretContext(input.userId, input.provider, "oauth-secret"),
                ),
            input.expiresAt,
            input.now,
          ],
        );
      });
    },

    async readTransaction(input): Promise<StoredConnectionTransaction | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id, user_id, provider, code_verifier, device_code_hash,
                  poll_interval_seconds, next_poll_at, oauth_request_token,
                  oauth_request_secret
             FROM connection_transactions
            WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > $3`,
          [input.id, input.userId, input.now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const transaction = readTransactionRow(row);
        return {
          ...transaction,
          codeVerifier: decryptStored(
            cipher,
            transaction.codeVerifier,
            secretContext(transaction.userId, transaction.provider, "verifier"),
          ),
          deviceCodeHash: decryptStored(
            cipher,
            transaction.deviceCodeHash,
            secretContext(transaction.userId, transaction.provider, "device"),
          ),
          oauthRequestToken: decryptStored(
            cipher,
            transaction.oauthRequestToken,
            secretContext(transaction.userId, transaction.provider, "oauth-token"),
          ),
          oauthRequestSecret: decryptStored(
            cipher,
            transaction.oauthRequestSecret,
            secretContext(transaction.userId, transaction.provider, "oauth-secret"),
          ),
        };
      });
    },

    async consumeByState(input): Promise<StoredConnectionTransaction | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `UPDATE connection_transactions
              SET consumed_at = $2
            WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2
          RETURNING id, user_id, provider, code_verifier, device_code_hash,
                    poll_interval_seconds, next_poll_at, oauth_request_token,
                    oauth_request_secret`,
          [input.stateHash, input.now],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const transaction = readTransactionRow(row);
        return {
          ...transaction,
          codeVerifier: decryptStored(
            cipher,
            transaction.codeVerifier,
            secretContext(transaction.userId, transaction.provider, "verifier"),
          ),
          deviceCodeHash: decryptStored(
            cipher,
            transaction.deviceCodeHash,
            secretContext(transaction.userId, transaction.provider, "device"),
          ),
          oauthRequestToken: decryptStored(
            cipher,
            transaction.oauthRequestToken,
            secretContext(transaction.userId, transaction.provider, "oauth-token"),
          ),
          oauthRequestSecret: decryptStored(
            cipher,
            transaction.oauthRequestSecret,
            secretContext(transaction.userId, transaction.provider, "oauth-secret"),
          ),
        };
      });
    },

    async consumeById(input): Promise<boolean> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `UPDATE connection_transactions
              SET consumed_at = $2
            WHERE id = $1 AND consumed_at IS NULL
          RETURNING id`,
          [input.id, input.now],
        );
        return result.rows.length === 1;
      });
    },

    async scheduleDevicePoll(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          `UPDATE connection_transactions
              SET poll_interval_seconds = $2, next_poll_at = $3
            WHERE id = $1 AND consumed_at IS NULL`,
          [input.id, input.intervalSeconds, input.nextPollAt],
        );
      });
    },

    async save(input): Promise<void> {
      await database.transaction(async (executor) => {
        await executor.query(
          // refresh_available_at is written from the caller's clock rather than left to the
          // column default, so a stored connection is scheduled against the same clock the
          // rest of the service reads. The update branch below already does this, and an
          // insert that disagreed would schedule its first refresh against database time.
          `INSERT INTO connected_accounts
             (id, user_id, provider, external_account_id, external_account_label, scopes,
              access_secret, refresh_secret, access_expires_at, connected_at,
              refresh_available_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
           ON CONFLICT (user_id, provider) DO UPDATE
             SET external_account_id = EXCLUDED.external_account_id,
                 external_account_label = EXCLUDED.external_account_label,
                 scopes = EXCLUDED.scopes,
                 access_secret = EXCLUDED.access_secret,
                 refresh_secret = EXCLUDED.refresh_secret,
                 access_expires_at = EXCLUDED.access_expires_at,
                 connected_at = EXCLUDED.connected_at,
                 authorization_status = 'active',
                 refresh_attempts = 0,
                 refresh_available_at = EXCLUDED.connected_at,
                 refresh_locked_until = NULL,
                 last_refresh_error = NULL`,
          [
            input.id,
            input.userId,
            input.provider,
            input.externalAccountId,
            input.externalAccountLabel,
            input.scopes,
            cipher.encrypt(
              input.accessSecret,
              secretContext(input.userId, input.provider, "access"),
            ),
            input.refreshSecret === null
              ? null
              : cipher.encrypt(
                  input.refreshSecret,
                  secretContext(input.userId, input.provider, "refresh"),
                ),
            input.accessExpiresAt,
            input.now,
          ],
        );
      });
    },

    async readSecret(input): Promise<string | null> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          "SELECT access_secret FROM connected_accounts WHERE user_id = $1 AND provider = $2",
          [input.userId, input.provider],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const stored = requiredString(row, "access_secret");
        const plaintext = decryptStored(
          cipher,
          stored,
          secretContext(input.userId, input.provider, "access"),
        );
        if (!cipher.encrypted(stored) && plaintext !== null) {
          await executor.query(
            "UPDATE connected_accounts SET access_secret = $3 WHERE user_id = $1 AND provider = $2",
            [
              input.userId,
              input.provider,
              cipher.encrypt(plaintext, secretContext(input.userId, input.provider, "access")),
            ],
          );
        }
        return plaintext;
      });
    },

    async remove(input): Promise<boolean> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          "DELETE FROM connected_accounts WHERE user_id = $1 AND provider = $2 RETURNING id",
          [input.userId, input.provider],
        );
        return result.rows.length === 1;
      });
    },

    async protectLegacySecrets(maximum = 100): Promise<number> {
      const boundedMaximum = Math.max(1, Math.min(1_000, Math.trunc(maximum)));
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id, user_id, provider, access_secret, refresh_secret
             FROM connected_accounts
            WHERE access_secret NOT LIKE 'v1.%'
               OR (refresh_secret IS NOT NULL AND refresh_secret NOT LIKE 'v1.%')
            ORDER BY connected_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [boundedMaximum],
        );
        for (const row of result.rows) {
          const id = requiredString(row, "id");
          const userId = requiredString(row, "user_id");
          const provider = readProvider(row["provider"]);
          const access = requiredString(row, "access_secret");
          const refresh = typeof row["refresh_secret"] === "string" ? row["refresh_secret"] : null;
          await executor.query(
            `UPDATE connected_accounts
                SET access_secret = $2, refresh_secret = $3
              WHERE id = $1`,
            [
              id,
              cipher.encrypted(access)
                ? access
                : cipher.encrypt(access, secretContext(userId, provider, "access")),
              refresh === null || cipher.encrypted(refresh)
                ? refresh
                : cipher.encrypt(refresh, secretContext(userId, provider, "refresh")),
            ],
          );
        }
        const transactions = await executor.query(
          `SELECT id, user_id, provider, code_verifier, device_code_hash,
                  oauth_request_token, oauth_request_secret
             FROM connection_transactions
            WHERE (code_verifier IS NOT NULL AND code_verifier NOT LIKE 'v1.%')
               OR (device_code_hash IS NOT NULL AND device_code_hash NOT LIKE 'v1.%')
               OR (oauth_request_token IS NOT NULL AND oauth_request_token NOT LIKE 'v1.%')
               OR (oauth_request_secret IS NOT NULL AND oauth_request_secret NOT LIKE 'v1.%')
            ORDER BY created_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [boundedMaximum],
        );
        for (const row of transactions.rows) {
          const id = requiredString(row, "id");
          const userId = requiredString(row, "user_id");
          const provider = readProvider(row["provider"]);
          const verifier = typeof row["code_verifier"] === "string" ? row["code_verifier"] : null;
          const device =
            typeof row["device_code_hash"] === "string" ? row["device_code_hash"] : null;
          const oauthToken =
            typeof row["oauth_request_token"] === "string" ? row["oauth_request_token"] : null;
          const oauthSecret =
            typeof row["oauth_request_secret"] === "string" ? row["oauth_request_secret"] : null;
          await executor.query(
            `UPDATE connection_transactions
                SET code_verifier = $2, device_code_hash = $3,
                    oauth_request_token = $4, oauth_request_secret = $5
              WHERE id = $1`,
            [
              id,
              verifier === null || cipher.encrypted(verifier)
                ? verifier
                : cipher.encrypt(verifier, secretContext(userId, provider, "verifier")),
              device === null || cipher.encrypted(device)
                ? device
                : cipher.encrypt(device, secretContext(userId, provider, "device")),
              oauthToken === null || cipher.encrypted(oauthToken)
                ? oauthToken
                : cipher.encrypt(oauthToken, secretContext(userId, provider, "oauth-token")),
              oauthSecret === null || cipher.encrypted(oauthSecret)
                ? oauthSecret
                : cipher.encrypt(oauthSecret, secretContext(userId, provider, "oauth-secret")),
            ],
          );
        }
        await executor.query(
          `DELETE FROM connection_transactions
            WHERE expires_at < CURRENT_TIMESTAMP
               OR (consumed_at IS NOT NULL AND consumed_at < CURRENT_TIMESTAMP - interval '1 day')`,
        );
        return result.rows.length + transactions.rows.length;
      });
    },

    async claimRefreshable(input): Promise<RefreshableConnection[]> {
      return database.transaction(async (executor) => {
        const boundedMaximum = Math.max(1, Math.min(100, Math.trunc(input.maximum)));
        const lockedUntil = new Date(input.now.getTime() + 60_000);
        const result = await executor.query(
          `WITH candidates AS (
             SELECT id
               FROM connected_accounts
              WHERE authorization_status = 'active'
                AND refresh_secret IS NOT NULL
                AND access_expires_at IS NOT NULL
                AND access_expires_at <= $2
                AND refresh_available_at <= $1
                AND (refresh_locked_until IS NULL OR refresh_locked_until <= $1)
              ORDER BY access_expires_at
              LIMIT $3
              FOR UPDATE SKIP LOCKED
           )
           UPDATE connected_accounts account
              SET refresh_locked_until = $4,
                  refresh_attempts = account.refresh_attempts + 1
             FROM candidates
            WHERE account.id = candidates.id
          RETURNING account.id, account.user_id, account.provider, account.refresh_secret`,
          [input.now, input.refreshBefore, boundedMaximum, lockedUntil],
        );
        return result.rows.map((row) => {
          const userId = requiredString(row, "user_id");
          const provider = readProvider(row["provider"]);
          const storedRefresh = requiredString(row, "refresh_secret");
          return {
            id: requiredString(row, "id"),
            userId,
            provider,
            refreshSecret:
              decryptStored(cipher, storedRefresh, secretContext(userId, provider, "refresh")) ??
              "",
          };
        });
      });
    },

    async completeRefresh(input): Promise<void> {
      await database.transaction(async (executor) => {
        const current = await executor.query(
          "SELECT user_id, provider FROM connected_accounts WHERE id = $1 FOR UPDATE",
          [input.id],
        );
        const row = current.rows[0];
        if (row === undefined) return;
        const userId = requiredString(row, "user_id");
        const provider = readProvider(row["provider"]);
        await executor.query(
          `UPDATE connected_accounts
              SET access_secret = $2,
                  refresh_secret = COALESCE($3, refresh_secret),
                  access_expires_at = $4,
                  scopes = COALESCE($5, scopes),
                  authorization_status = 'active',
                  refresh_attempts = 0,
                  refresh_available_at = $6,
                  refresh_locked_until = NULL,
                  last_refreshed_at = $6,
                  last_refresh_error = NULL
            WHERE id = $1`,
          [
            input.id,
            cipher.encrypt(input.accessSecret, secretContext(userId, provider, "access")),
            input.refreshSecret === null
              ? null
              : cipher.encrypt(input.refreshSecret, secretContext(userId, provider, "refresh")),
            input.accessExpiresAt,
            input.scopes,
            input.now,
          ],
        );
      });
    },

    async failRefresh(input): Promise<void> {
      await database.transaction(async (executor) => {
        const current = await executor.query(
          "SELECT refresh_attempts FROM connected_accounts WHERE id = $1 FOR UPDATE",
          [input.id],
        );
        const attempts = Number(current.rows[0]?.["refresh_attempts"] ?? 1);
        const retrySeconds = Math.min(3_600, 30 * 2 ** Math.min(7, Math.max(1, attempts)));
        const retry = new Date(input.now.getTime() + retrySeconds * 1_000);
        await executor.query(
          `UPDATE connected_accounts
              SET authorization_status = CASE WHEN $2 THEN 'reauthorization_required'
                                              ELSE authorization_status END,
                  refresh_available_at = CASE WHEN $2 THEN refresh_available_at ELSE $4 END,
                  refresh_locked_until = NULL,
                  last_refresh_error = $3
            WHERE id = $1`,
          [input.id, input.permanent, input.reason.slice(0, 500), retry],
        );
      });
    },
  };
}
