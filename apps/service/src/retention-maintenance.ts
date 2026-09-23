import type { RetentionPolicy } from "./config.js";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RetentionMaintenanceResult {
  authentication_artifacts: number;
  delivered_email: number;
  notifications: number;
  security_events: number;
}

export interface RetentionMaintenance {
  run(now?: Date, maximumPerCollection?: number): Promise<RetentionMaintenanceResult>;
}

async function deleteRows(
  executor: SqlExecutor,
  text: string,
  cutoff: Date,
  maximum: number,
): Promise<number> {
  const result = await executor.query(text, [cutoff, maximum]);
  return result.rows.length;
}

export function createRetentionMaintenance(
  database: ServiceDatabase,
  policy: RetentionPolicy,
): RetentionMaintenance {
  return {
    async run(now = new Date(), maximumPerCollection = 500) {
      const maximum = Math.max(1, Math.min(5_000, Math.trunc(maximumPerCollection)));
      const authenticationCutoff = new Date(
        now.getTime() - policy.authenticationArtifactsDays * DAY_MS,
      );
      const deliveredEmailCutoff = new Date(now.getTime() - policy.deliveredEmailDays * DAY_MS);
      const notificationsCutoff = new Date(now.getTime() - policy.notificationsDays * DAY_MS);
      const securityEventsCutoff = new Date(now.getTime() - policy.securityEventsDays * DAY_MS);

      return database.transaction(async (executor) => {
        let authenticationArtifacts = 0;
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM email_verifications
            WHERE id IN (
              SELECT id FROM email_verifications
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM password_resets
            WHERE id IN (
              SELECT id FROM password_resets
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM account_email_verifications
            WHERE id IN (
              SELECT id FROM account_email_verifications
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM oidc_auth_transactions
            WHERE id IN (
              SELECT id FROM oidc_auth_transactions
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM connection_transactions
            WHERE id IN (
              SELECT id FROM connection_transactions
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM auth_rate_limits
            WHERE (scope, subject_hash) IN (
              SELECT scope, subject_hash FROM auth_rate_limits
               WHERE window_started_at < $1
               ORDER BY window_started_at
               LIMIT $2
            )
          RETURNING subject_hash`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM session_refresh_tokens
            WHERE id IN (
              SELECT id FROM session_refresh_tokens
               WHERE expires_at < $1
               ORDER BY expires_at
               LIMIT $2
            )
          RETURNING id`,
          authenticationCutoff,
          maximum,
        );
        authenticationArtifacts += await deleteRows(
          executor,
          `DELETE FROM device_sessions session
            WHERE session.id IN (
              SELECT candidate.id
                FROM device_sessions candidate
               WHERE COALESCE(candidate.revoked_at, candidate.access_expires_at) < $1
                 AND NOT EXISTS (
                   SELECT 1 FROM session_refresh_tokens token
                    WHERE token.session_id = candidate.id
                 )
               ORDER BY COALESCE(candidate.revoked_at, candidate.access_expires_at)
               LIMIT $2
            )
          RETURNING session.id`,
          authenticationCutoff,
          maximum,
        );

        const deliveredEmail = await deleteRows(
          executor,
          `DELETE FROM notification_email_outbox
            WHERE id IN (
              SELECT id FROM notification_email_outbox
               WHERE delivered_at < $1
               ORDER BY delivered_at
               LIMIT $2
            )
          RETURNING id`,
          deliveredEmailCutoff,
          maximum,
        );
        const notifications = await deleteRows(
          executor,
          `DELETE FROM account_notifications
            WHERE id IN (
              SELECT id FROM account_notifications
               WHERE created_at < $1
               ORDER BY created_at
               LIMIT $2
            )
          RETURNING id`,
          notificationsCutoff,
          maximum,
        );
        const securityEvents = await deleteRows(
          executor,
          `DELETE FROM account_security_events
            WHERE id IN (
              SELECT id FROM account_security_events
               WHERE occurred_at < $1
               ORDER BY occurred_at
               LIMIT $2
            )
          RETURNING id`,
          securityEventsCutoff,
          maximum,
        );

        return {
          authentication_artifacts: authenticationArtifacts,
          delivered_email: deliveredEmail,
          notifications,
          security_events: securityEvents,
        };
      });
    },
  };
}
