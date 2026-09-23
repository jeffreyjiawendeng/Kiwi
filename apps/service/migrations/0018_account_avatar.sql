-- One avatar per account, stored by the digest of its bytes. Replacing an avatar writes a
-- new digest, so a cached copy is never mistaken for the current one.
CREATE TABLE account_avatars (
  user_id uuid PRIMARY KEY REFERENCES user_accounts(id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),
  bytes bytea NOT NULL,
  updated_at timestamptz NOT NULL
);
