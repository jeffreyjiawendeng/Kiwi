import type {
  AccountNotification,
  AccountNotificationsResult,
  NotificationCategory,
} from "@kiwi/contracts";
import type { ServiceDatabase } from "./database.js";

export interface NotificationMailDelivery {
  send(input: { recipient: string; subject: string; body: string }): Promise<void>;
}

export interface AccountNotificationsService {
  list(userId: string): Promise<AccountNotificationsResult>;
  markRead(userId: string, notificationId: string, now?: Date): Promise<AccountNotificationsResult>;
  dismiss(userId: string, notificationId: string, now?: Date): Promise<AccountNotificationsResult>;
  deliverPending(delivery: NotificationMailDelivery, now?: Date): Promise<number>;
}

function requiredString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Notification storage returned invalid ${key}.`);
  return value;
}

function readCategory(value: unknown): NotificationCategory {
  if (
    value !== "workspace_invitations" &&
    value !== "collaboration" &&
    value !== "synchronization" &&
    value !== "product"
  ) {
    throw new Error("Notification storage returned an invalid category.");
  }
  return value;
}

function failure(code: "invalid_input" | "forbidden" | "service_unavailable", message: string) {
  return { status: "error" as const, code, message };
}

export function createAccountNotificationsService(
  database: ServiceDatabase,
): AccountNotificationsService {
  async function update(
    userId: string,
    notificationId: string,
    column: "read_at" | "dismissed_at",
    now: Date,
  ): Promise<AccountNotificationsResult> {
    return database.transaction(async (executor) => {
      const changed = await executor.query(
        `UPDATE account_notifications SET ${column} = COALESCE(${column}, $3)
          WHERE id = $1 AND user_id = $2 AND dismissed_at IS NULL RETURNING id`,
        [notificationId, userId, now],
      );
      return changed.rows.length === 1
        ? { status: "updated" }
        : failure("invalid_input", "That notification is no longer available.");
    });
  }

  return {
    async list(userId): Promise<AccountNotificationsResult> {
      return database.transaction(async (executor) => {
        const result = await executor.query(
          `SELECT id, category, title, detail, workspace_id, created_at, read_at
             FROM account_notifications
            WHERE user_id = $1 AND dismissed_at IS NULL
            ORDER BY created_at DESC
            LIMIT 100`,
          [userId],
        );
        const notifications: AccountNotification[] = result.rows.map((row) => {
          const workspaceId = row["workspace_id"];
          const createdAt = row["created_at"];
          const date = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
          if (Number.isNaN(date.getTime())) {
            throw new Error("Notification storage returned an invalid created_at.");
          }
          return {
            id: requiredString(row, "id"),
            category: readCategory(row["category"]),
            title: requiredString(row, "title"),
            detail: requiredString(row, "detail"),
            ...(typeof workspaceId === "string" ? { workspace_id: workspaceId } : {}),
            created_at: date.toISOString(),
            read: row["read_at"] !== null,
          };
        });
        return {
          status: "ok",
          notifications,
          unread_count: notifications.filter((notification) => !notification.read).length,
        };
      });
    },

    markRead(userId, notificationId, now = new Date()) {
      return update(userId, notificationId, "read_at", now);
    },

    dismiss(userId, notificationId, now = new Date()) {
      return update(userId, notificationId, "dismissed_at", now);
    },

    async deliverPending(delivery, now = new Date()): Promise<number> {
      const claimed = await database.transaction(async (executor) => {
        const result = await executor.query(
          `WITH ready AS (
             SELECT id FROM notification_email_outbox
              WHERE delivered_at IS NULL
                AND available_at <= $1
                AND (locked_until IS NULL OR locked_until <= $1)
              ORDER BY available_at, created_at
              LIMIT 20
              FOR UPDATE SKIP LOCKED
           )
           UPDATE notification_email_outbox o
              SET locked_until = $2,
                  attempts = attempts + 1
             FROM ready
            WHERE o.id = ready.id
          RETURNING o.id, o.recipient, o.subject, o.body, o.attempts`,
          [now, new Date(now.getTime() + 60_000)],
        );
        return result.rows.map((row) => ({
          id: requiredString(row, "id"),
          recipient: requiredString(row, "recipient"),
          subject: requiredString(row, "subject"),
          body: requiredString(row, "body"),
          attempts: Number(row["attempts"]),
        }));
      });
      let delivered = 0;
      for (const message of claimed) {
        try {
          await delivery.send(message);
          await database.transaction(async (executor) => {
            await executor.query(
              `UPDATE notification_email_outbox
                  SET delivered_at = $2, locked_until = NULL, last_error = NULL
                WHERE id = $1`,
              [message.id, new Date()],
            );
          });
          delivered += 1;
        } catch (cause) {
          const retryMinutes = Math.min(60, 2 ** Math.min(message.attempts, 5));
          const reason = cause instanceof Error ? cause.message.slice(0, 500) : "delivery failed";
          await database.transaction(async (executor) => {
            await executor.query(
              `UPDATE notification_email_outbox
                  SET available_at = $2, locked_until = NULL, last_error = $3
                WHERE id = $1`,
              [message.id, new Date(now.getTime() + retryMinutes * 60_000), reason],
            );
          });
        }
      }
      return delivered;
    },
  };
}
