CREATE TABLE coedit_operations (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES user_accounts(id),
  lamport bigint NOT NULL CHECK (lamport >= 1),
  operation jsonb NOT NULL,
  accepted_at timestamptz NOT NULL
);

CREATE INDEX coedit_operations_pull_idx
  ON coedit_operations (workspace_id, document_id, sequence);

CREATE TABLE coedit_presence (
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_accounts(id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  cursor_position integer NOT NULL CHECK (cursor_position >= 0),
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, document_id, actor_id)
);
