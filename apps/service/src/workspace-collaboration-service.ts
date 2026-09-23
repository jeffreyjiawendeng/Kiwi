import { createHash, randomUUID } from "node:crypto";
import {
  deriveDisplayName,
  type AccountProfile,
  type CollaborationRole,
  type WorkspaceCollaborationResult,
  type WorkspaceCollaborationSnapshot,
} from "@kiwi/contracts";
import type { ServiceDatabase, SqlExecutor } from "./database.js";

const NAME_COLUMNS = "a.given_name, a.family_name, a.phone";

function memberProfile(row: Readonly<Record<string, unknown>>): AccountProfile {
  const part = (name: string): string | null => {
    const value = row[name];
    return typeof value === "string" ? value : null;
  };
  return {
    given_name: part("given_name"),
    family_name: part("family_name"),
    phone: part("phone"),
  };
}

const ROLES: readonly CollaborationRole[] = ["owner", "admin", "editor", "commenter", "viewer"];
const MANAGERS: readonly CollaborationRole[] = ["owner", "admin"];
const ROLE_AUTHORITY: Readonly<Record<CollaborationRole, number>> = {
  owner: 5,
  admin: 4,
  editor: 3,
  commenter: 2,
  viewer: 1,
};

function digest(value: string): string {
  return createHash("sha256").update(`access_token\u0000${value}`, "utf8").digest("hex");
}

function string(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Workspace service returned invalid ${key}.`);
  return value;
}

function role(value: unknown): CollaborationRole | null {
  return typeof value === "string" && ROLES.includes(value as CollaborationRole)
    ? (value as CollaborationRole)
    : null;
}

async function actor(executor: SqlExecutor, token: string, now: Date) {
  const result = await executor.query(
    `SELECT s.user_id
       FROM device_sessions s JOIN user_accounts a ON a.id = s.user_id
      WHERE s.access_token_hash = $1 AND s.access_expires_at > $2
        AND s.revoked_at IS NULL AND a.status = 'active'`,
    [digest(token), now],
  );
  const row = result.rows[0];
  return row === undefined ? null : string(row, "user_id");
}

async function actorRole(executor: SqlExecutor, workspaceId: string, userId: string) {
  const result = await executor.query(
    "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return role(result.rows[0]?.["role"]);
}

async function snapshot(
  executor: SqlExecutor,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceCollaborationSnapshot | null> {
  const workspace = await executor.query(
    `SELECT w.id, w.title, m.role
       FROM service_workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id
      WHERE w.id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  const row = workspace.rows[0];
  const currentRole = role(row?.["role"]);
  if (row === undefined || currentRole === null) return null;
  const members = await executor.query(
    `SELECT a.id AS user_id, a.primary_email, ${NAME_COLUMNS}, m.role
       FROM workspace_memberships m JOIN user_accounts a ON a.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY m.joined_at`,
    [workspaceId],
  );
  const invitations = await executor.query(
    `SELECT id, email, role, status, expires_at FROM workspace_invitations
      WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  const projects = await executor.query(
    `SELECT id, name, sensitivity, review_required FROM workspace_projects
      WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  const projectMembers = await executor.query(
    `SELECT pm.project_id, pm.user_id, a.primary_email, ${NAME_COLUMNS},
            wm.role AS workspace_role, pm.role AS project_role
       FROM project_memberships pm
       JOIN workspace_projects p ON p.id = pm.project_id
       JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id AND wm.user_id = pm.user_id
       JOIN user_accounts a ON a.id = pm.user_id
      WHERE p.workspace_id = $1
      ORDER BY a.primary_email`,
    [workspaceId],
  );
  return {
    workspace: { id: string(row, "id"), title: string(row, "title"), role: currentRole },
    members: members.rows.map((member) => {
      const email = string(member, "primary_email");
      const profile = memberProfile(member);
      return {
        user_id: string(member, "user_id"),
        email,
        display_name: deriveDisplayName(profile, email),
        phone: profile.phone,
        role: role(member["role"]) ?? "viewer",
      };
    }),
    invitations: invitations.rows.map((invite) => ({
      id: string(invite, "id"),
      email: string(invite, "email"),
      role: (role(invite["role"]) ?? "viewer") as Exclude<CollaborationRole, "owner">,
      status: string(invite, "status") as "pending" | "accepted" | "revoked" | "expired",
      expires_at: new Date(String(invite["expires_at"])).toISOString(),
    })),
    projects: projects.rows.map((project) => ({
      id: string(project, "id"),
      name: string(project, "name"),
      sensitivity: string(project, "sensitivity") as
        "public" | "internal" | "confidential" | "restricted",
      review_required: project["review_required"] === true,
      member_overrides: projectMembers.rows
        .filter((member) => member["project_id"] === project["id"])
        .map((member) => ({
          user_id: string(member, "user_id"),
          display_name: deriveDisplayName(memberProfile(member), string(member, "primary_email")),
          workspace_role: role(member["workspace_role"]) ?? "viewer",
          project_role: role(member["project_role"]) ?? "viewer",
        })),
    })),
  };
}

const failure = (
  code: Extract<WorkspaceCollaborationResult, { status: "error" }>["code"],
  message: string,
): WorkspaceCollaborationResult => ({ status: "error", code, message });

export interface WorkspaceCollaborationService {
  execute(
    path: string,
    accessToken: string,
    input: Record<string, unknown>,
  ): Promise<WorkspaceCollaborationResult>;
}

export function createWorkspaceCollaborationService(
  database: ServiceDatabase,
): WorkspaceCollaborationService {
  return {
    async execute(path, accessToken, input): Promise<WorkspaceCollaborationResult> {
      return database.transaction(async (executor) => {
        const now = new Date();
        const userId = await actor(executor, accessToken, now);
        if (userId === null) return failure("forbidden", "Your session is no longer authorized.");
        const workspaceId = typeof input["workspace_id"] === "string" ? input["workspace_id"] : "";
        if (workspaceId === "") return failure("invalid_input", "Choose a valid workspace.");
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `workspace:${workspaceId}`,
        ]);

        if (path.endsWith("/register")) {
          const title = typeof input["title"] === "string" ? input["title"].trim() : "";
          if (title === "" || title.length > 200)
            return failure("invalid_input", "Enter a workspace name.");
          const created = await executor.query(
            `INSERT INTO service_workspaces (id, title, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
            [workspaceId, title, userId, now],
          );
          if (created.rows.length === 0) {
            const existingRole = await actorRole(executor, workspaceId, userId);
            if (existingRole === null)
              return failure("forbidden", "This workspace is already owned by another account.");
            await executor.query(
              "UPDATE service_workspaces SET title = $2, updated_at = $3 WHERE id = $1",
              [workspaceId, title, now],
            );
          } else {
            await executor.query(
              `INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
             VALUES ($1, $2, 'owner', $3) ON CONFLICT DO NOTHING`,
              [workspaceId, userId, now],
            );
          }
        } else {
          const currentRole = await actorRole(executor, workspaceId, userId);
          if (currentRole === null)
            return failure("forbidden", "You do not have access to this workspace.");
          await executor.query(
            `UPDATE workspace_invitations SET status = 'expired'
              WHERE workspace_id = $1 AND status = 'pending' AND expires_at <= $2`,
            [workspaceId, now],
          );
          if (path.endsWith("/settings")) {
            const settings = await snapshot(executor, workspaceId, userId);
            return settings === null
              ? failure("not_found", "Workspace settings were not found.")
              : { status: "ok", settings };
          }
          if (!MANAGERS.includes(currentRole))
            return failure("forbidden", "Your workspace role cannot make this change.");
          if (path.endsWith("/invitations/revoke")) {
            const invitationId =
              typeof input["invitation_id"] === "string" ? input["invitation_id"] : "";
            const revoked = await executor.query(
              `UPDATE workspace_invitations SET status = 'revoked'
                WHERE id = $1 AND workspace_id = $2 AND status = 'pending' RETURNING id`,
              [invitationId, workspaceId],
            );
            if (revoked.rows.length === 0)
              return failure("not_found", "That pending invitation was not found.");
          } else if (path.endsWith("/invitations")) {
            const email =
              typeof input["email"] === "string" ? input["email"].trim().toLowerCase() : "";
            const inviteRole = role(input["role"]);
            if (email === "" || inviteRole === null || inviteRole === "owner")
              return failure("invalid_input", "Enter an email and assignable role.");
            const inviteId = randomUUID();
            const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
            const invited = await executor.query(
              "SELECT id FROM user_accounts WHERE primary_email = $1 AND status = 'active'",
              [email],
            );
            const invitedId = invited.rows[0]?.["id"];
            const status = typeof invitedId === "string" ? "accepted" : "pending";
            await executor.query(
              `INSERT INTO workspace_invitations (id, workspace_id, email, role, status, expires_at, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [inviteId, workspaceId, email, inviteRole, status, expires, userId, now],
            );
            if (typeof invitedId === "string") {
              await executor.query(
                `INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
                [workspaceId, invitedId, inviteRole, now],
              );
              const notificationId = randomUUID();
              await executor.query(
                `INSERT INTO account_notifications
                   (id, user_id, category, kind, title, detail, workspace_id,
                    dedupe_key, created_at)
                 SELECT $1, $2, 'workspace_invitations', 'workspace_invitation',
                        'Workspace invitation',
                        'You were added to ' || title || ' as ' || $3 || '.',
                        id, $4, $5
                   FROM service_workspaces WHERE id = $6`,
                [
                  notificationId,
                  invitedId,
                  inviteRole,
                  `workspace-invitation:${inviteId}`,
                  now,
                  workspaceId,
                ],
              );
              await executor.query(
                `INSERT INTO notification_email_outbox
                   (id, recipient, subject, body, available_at, created_at)
                 SELECT $1, e.address, 'Kiwi workspace invitation',
                        'You were added to a Kiwi workspace. Open Kiwi to review your access.',
                        $2, $2
                   FROM account_emails e
                  WHERE e.user_id = $3
                    AND e.receives_notifications
                    AND COALESCE(
                      (SELECT p.email FROM account_notification_preferences p
                        WHERE p.user_id = $3 AND p.category = 'workspace_invitations'),
                      true
                    )`,
                [randomUUID(), now, invitedId],
              );
            } else {
              await executor.query(
                `INSERT INTO notification_email_outbox
                   (id, recipient, subject, body, available_at, created_at)
                 VALUES ($1, $2, 'Kiwi workspace invitation',
                         'You were invited to a Kiwi workspace. Create or sign in to your Kiwi account with this email address to join.',
                         $3, $3)`,
                [randomUUID(), email, now],
              );
            }
          } else if (path.endsWith("/members/update") || path.endsWith("/members/remove")) {
            const target = typeof input["user_id"] === "string" ? input["user_id"] : "";
            const existing = await actorRole(executor, workspaceId, target);
            if (existing === null)
              return failure("not_found", "That collaborator is no longer a member.");
            const remainingOwners = await executor.query(
              `SELECT count(*)::integer AS count
                 FROM workspace_memberships membership
                 JOIN user_accounts account ON account.id = membership.user_id
                WHERE membership.workspace_id = $1
                  AND membership.role = 'owner'
                  AND membership.user_id <> $2
                  AND account.status = 'active'`,
              [workspaceId, target],
            );
            if (existing === "owner" && remainingOwners.rows[0]?.["count"] === 0)
              return failure("last_owner", "Transfer ownership before changing the last owner.");
            if (path.endsWith("/members/remove")) {
              await executor.query(
                "DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
                [workspaceId, target],
              );
            } else {
              const nextRole = role(input["role"]);
              if (nextRole === null || (nextRole === "owner" && currentRole !== "owner"))
                return failure("forbidden", "Only an owner can assign that role.");
              await executor.query(
                "UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
                [workspaceId, target, nextRole],
              );
            }
          } else if (path.endsWith("/projects/create")) {
            const name = typeof input["name"] === "string" ? input["name"].trim() : "";
            if (name === "") return failure("invalid_input", "Enter a project name.");
            await executor.query(
              `INSERT INTO workspace_projects (id, workspace_id, name, sensitivity, review_required, created_at, updated_at)
               VALUES ($1, $2, $3, 'internal', false, $4, $4)`,
              [randomUUID(), workspaceId, name, now],
            );
          } else if (path.endsWith("/projects/update")) {
            const projectId = typeof input["project_id"] === "string" ? input["project_id"] : "";
            const sensitivity =
              typeof input["sensitivity"] === "string" &&
              ["public", "internal", "confidential", "restricted"].includes(input["sensitivity"])
                ? input["sensitivity"]
                : null;
            if (
              projectId === "" ||
              sensitivity === null ||
              typeof input["review_required"] !== "boolean"
            )
              return failure("invalid_input", "Choose valid project policy settings.");
            const memberUserId =
              typeof input["member_user_id"] === "string" ? input["member_user_id"] : null;
            const projectRole = memberUserId === null ? null : role(input["member_role"]);
            if (memberUserId !== null) {
              const workspaceRole = await actorRole(executor, workspaceId, memberUserId);
              if (
                workspaceRole === null ||
                projectRole === null ||
                ROLE_AUTHORITY[projectRole] > ROLE_AUTHORITY[workspaceRole]
              ) {
                return failure(
                  "forbidden",
                  "Project access can narrow a workspace role, but it cannot expand it.",
                );
              }
            }
            const updated = await executor.query(
              `UPDATE workspace_projects SET sensitivity = $3, review_required = $4, updated_at = $5
                WHERE id = $1 AND workspace_id = $2 RETURNING id`,
              [projectId, workspaceId, sensitivity, input["review_required"], now],
            );
            if (updated.rows.length === 0)
              return failure("not_found", "That project was not found in this workspace.");
            if (memberUserId !== null && projectRole !== null) {
              await executor.query(
                `INSERT INTO project_memberships (project_id, user_id, role)
                 SELECT id, $3, $4 FROM workspace_projects WHERE id = $1 AND workspace_id = $2
                 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
                [projectId, workspaceId, memberUserId, projectRole],
              );
            }
          }
        }
        const settings = await snapshot(executor, workspaceId, userId);
        return settings === null
          ? failure("not_found", "Workspace settings were not found.")
          : { status: "ok", settings };
      });
    },
  };
}
