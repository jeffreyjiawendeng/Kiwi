CREATE TABLE structured_sync_objects (
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, object_id)
);

CREATE TABLE structured_sync_conflicts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  base_version integer NOT NULL CHECK (base_version >= 0),
  base_hash text,
  current_version integer NOT NULL,
  current_hash text NOT NULL,
  current_snapshot jsonb NOT NULL,
  incoming_version integer NOT NULL,
  incoming_hash text NOT NULL,
  incoming_snapshot jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_accounts(id),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by_command_id uuid
);

CREATE TABLE structured_sync_submissions (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  command_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES service_workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  base_version integer NOT NULL CHECK (base_version >= 0),
  base_hash text,
  proposed_version integer NOT NULL CHECK (proposed_version >= 1),
  proposed_hash text NOT NULL,
  proposed_snapshot jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES user_accounts(id),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'conflict')),
  conflict_id uuid REFERENCES structured_sync_conflicts(id),
  accepted_at timestamptz NOT NULL
);

CREATE INDEX structured_sync_pull_idx
  ON structured_sync_submissions (workspace_id, sequence)
  WHERE outcome = 'accepted';
