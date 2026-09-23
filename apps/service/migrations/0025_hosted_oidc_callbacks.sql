ALTER TABLE oidc_auth_transactions
  ADD COLUMN callback_state_hash char(64);

UPDATE oidc_auth_transactions
   SET callback_state_hash = state_hash
 WHERE callback_state_hash IS NULL;

ALTER TABLE oidc_auth_transactions
  ALTER COLUMN callback_state_hash SET NOT NULL;

CREATE UNIQUE INDEX oidc_auth_transactions_callback_state_idx
  ON oidc_auth_transactions (callback_state_hash);
