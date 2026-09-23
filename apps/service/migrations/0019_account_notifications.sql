CREATE TABLE account_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (
    category IN ('workspace_invitations', 'collaboration', 'synchronization', 'product')
  ),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail text NOT NULL CHECK (length(detail) <= 1000),
  workspace_id uuid REFERENCES service_workspaces(id) ON DELETE SET NULL,
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  dismissed_at timestamptz
);

CREATE UNIQUE INDEX account_notifications_dedupe_idx
  ON account_notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX account_notifications_pending_idx
  ON account_notifications (user_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE TABLE notification_email_outbox (
  id uuid PRIMARY KEY,
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_until timestamptz,
  delivered_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at timestamptz NOT NULL
);

CREATE INDEX notification_email_outbox_ready_idx
  ON notification_email_outbox (available_at)
  WHERE delivered_at IS NULL;
