ALTER TABLE oidc_auth_transactions
  ADD COLUMN reauth_session_id uuid REFERENCES device_sessions(id) ON DELETE CASCADE;

ALTER TABLE oidc_auth_transactions
  ADD CONSTRAINT oidc_auth_transactions_one_account_action
  CHECK (link_user_id IS NULL OR reauth_session_id IS NULL);
