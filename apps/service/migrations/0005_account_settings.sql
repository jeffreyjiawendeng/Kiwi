ALTER TABLE user_accounts
  ADD COLUMN display_name text;

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_display_name_length
  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80);

CREATE TABLE account_deletion_requests (
  user_id uuid PRIMARY KEY REFERENCES user_accounts(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL,
  recover_until timestamptz NOT NULL,
  CHECK (recover_until > requested_at)
);
