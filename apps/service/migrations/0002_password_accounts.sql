CREATE TABLE user_accounts (
  id uuid PRIMARY KEY,
  primary_email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (primary_email = lower(primary_email)),
  CHECK (length(primary_email) BETWEEN 3 AND 254)
);

CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES user_accounts(id) ON DELETE CASCADE,
  verifier text NOT NULL,
  parameter_version integer NOT NULL CHECK (parameter_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE email_verifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX email_verifications_active_user_idx
  ON email_verifications (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE password_resets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX password_resets_active_user_idx
  ON password_resets (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE device_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 120),
  access_token_hash char(64) NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX device_sessions_active_user_idx
  ON device_sessions (user_id, last_authenticated_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE auth_rate_limits (
  scope text NOT NULL,
  subject_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  PRIMARY KEY (scope, subject_hash)
);

CREATE TABLE account_security_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX account_security_events_user_time_idx
  ON account_security_events (user_id, occurred_at DESC);
