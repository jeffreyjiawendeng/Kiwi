export const WORKSPACE_COLLABORATION_PATHS = {
  register: "/v1/workspaces/register",
  snapshot: "/v1/workspaces/settings",
  invite: "/v1/workspaces/invitations",
  revokeInvitation: "/v1/workspaces/invitations/revoke",
  updateMember: "/v1/workspaces/members/update",
  removeMember: "/v1/workspaces/members/remove",
  createProject: "/v1/projects/create",
  updateProject: "/v1/projects/update",
} as const;

export type CollaborationRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

export interface WorkspaceCollaborationSnapshot {
  workspace: { id: string; title: string; role: CollaborationRole };
  members: Array<{
    user_id: string;
    email: string;
    display_name: string;
    phone: string | null;
    role: CollaborationRole;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: CollaborationRole;
    status: "pending" | "accepted" | "revoked" | "expired";
    expires_at: string;
  }>;
  projects: Array<{
    id: string;
    name: string;
    sensitivity: "public" | "internal" | "confidential" | "restricted";
    review_required: boolean;
    member_overrides: Array<{
      user_id: string;
      display_name: string;
      workspace_role: CollaborationRole;
      project_role: CollaborationRole;
    }>;
  }>;
}

export type WorkspaceCollaborationResult =
  | { status: "ok"; settings: WorkspaceCollaborationSnapshot }
  | { status: "queued" }
  | {
      status: "error";
      code: "invalid_input" | "forbidden" | "not_found" | "last_owner" | "service_unavailable";
      message: string;
    };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readWorkspaceCollaborationRequest(value: unknown): Record<string, unknown> | null {
  const input = object(value);
  if (input === null || typeof input["workspace_id"] !== "string") return null;
  return input["workspace_id"].length >= 1 && input["workspace_id"].length <= 100 ? input : null;
}
