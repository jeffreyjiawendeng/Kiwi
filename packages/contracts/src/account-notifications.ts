import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "./account-settings.js";

export const ACCOUNT_NOTIFICATION_PATHS = {
  list: "/v1/account/notifications",
  read: "/v1/account/notifications/read",
  dismiss: "/v1/account/notifications/dismiss",
} as const;

export interface AccountNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  detail: string;
  workspace_id?: string;
  created_at: string;
  read: boolean;
}

export type AccountNotificationsResult =
  | { status: "ok"; notifications: AccountNotification[]; unread_count: number }
  | { status: "updated" }
  | {
      status: "error";
      code: "invalid_input" | "forbidden" | "service_unavailable";
      message: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readAccountNotificationSelection(
  value: unknown,
): { notification_id: string } | null {
  const input = record(value);
  const id = input?.["notification_id"];
  return input !== null &&
    Object.keys(input).every((key) => key === "notification_id") &&
    typeof id === "string" &&
    id.length >= 1 &&
    id.length <= 100
    ? { notification_id: id }
    : null;
}

export function isAccountNotificationsResult(value: unknown): value is AccountNotificationsResult {
  const result = record(value);
  if (result === null) return false;
  if (result["status"] === "updated") return Object.keys(result).length === 1;
  if (result["status"] === "error") {
    return (
      Object.keys(result).every((key) => ["status", "code", "message"].includes(key)) &&
      ["invalid_input", "forbidden", "service_unavailable"].includes(String(result["code"])) &&
      typeof result["message"] === "string" &&
      result["message"].length >= 1 &&
      result["message"].length <= 500
    );
  }
  if (result["status"] !== "ok") return false;
  const notifications = result["notifications"];
  return (
    Object.keys(result).every((key) => ["status", "notifications", "unread_count"].includes(key)) &&
    Array.isArray(notifications) &&
    notifications.length <= 100 &&
    Number.isInteger(result["unread_count"]) &&
    (result["unread_count"] as number) >= 0 &&
    notifications.every((value) => {
      const item = record(value);
      return (
        item !== null &&
        Object.keys(item).every((key) =>
          ["id", "category", "title", "detail", "workspace_id", "created_at", "read"].includes(key),
        ) &&
        typeof item["id"] === "string" &&
        item["id"].length >= 1 &&
        item["id"].length <= 100 &&
        NOTIFICATION_CATEGORIES.includes(item["category"] as NotificationCategory) &&
        typeof item["title"] === "string" &&
        item["title"].length >= 1 &&
        item["title"].length <= 200 &&
        typeof item["detail"] === "string" &&
        item["detail"].length <= 1_000 &&
        (item["workspace_id"] === undefined ||
          (typeof item["workspace_id"] === "string" && item["workspace_id"].length <= 100)) &&
        typeof item["created_at"] === "string" &&
        item["created_at"].length <= 50 &&
        typeof item["read"] === "boolean"
      );
    })
  );
}
