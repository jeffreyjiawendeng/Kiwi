import { describe, expect, it } from "vitest";
import {
  isAccountNotificationsResult,
  readAccountNotificationSelection,
} from "./account-notifications.js";

describe("account notifications contract", () => {
  it("accepts bounded notification snapshots and selections", () => {
    expect(readAccountNotificationSelection({ notification_id: "notification-1" })).toEqual({
      notification_id: "notification-1",
    });
    expect(
      isAccountNotificationsResult({
        status: "ok",
        unread_count: 1,
        notifications: [
          {
            id: "notification-1",
            category: "workspace_invitations",
            title: "Workspace invitation",
            detail: "You joined a workspace.",
            workspace_id: "workspace-1",
            created_at: "2026-08-24T12:00:00.000Z",
            read: false,
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects expanded selections and notification payloads", () => {
    expect(
      readAccountNotificationSelection({ notification_id: "notification-1", user_id: "other" }),
    ).toBeNull();
    expect(
      isAccountNotificationsResult({
        status: "ok",
        unread_count: 1,
        notifications: [{ id: "notification-1", body_html: "<script>" }],
      }),
    ).toBe(false);
  });
});
