CREATE TABLE service_workspaces (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES user_accounts(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES user_accounts(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE workspace_projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  review_required boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE project_memberships (
  project_id uuid NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE workspace_sync_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES user_accounts(id),
  idempotency_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  accepted_at timestamptz NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
