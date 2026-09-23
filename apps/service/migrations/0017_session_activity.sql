-- last_authenticated_at answers when a credential was last proved. It does not answer
-- when a session was last used, which is what tells its owner whether a device that is
-- still signed in is still theirs.
ALTER TABLE device_sessions ADD COLUMN last_seen_at timestamptz;

UPDATE device_sessions SET last_seen_at = last_authenticated_at WHERE last_seen_at IS NULL;

ALTER TABLE device_sessions ALTER COLUMN last_seen_at SET NOT NULL;

CREATE INDEX device_sessions_activity_idx
  ON device_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
