CREATE TABLE session_refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'used', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE UNIQUE INDEX session_refresh_tokens_active_session_idx
  ON session_refresh_tokens (session_id)
  WHERE status = 'active';

CREATE INDEX session_refresh_tokens_expiry_idx
  ON session_refresh_tokens (expires_at)
  WHERE status = 'active';
