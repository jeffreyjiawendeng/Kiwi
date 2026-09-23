ALTER TABLE external_identities
  DROP CONSTRAINT external_identities_provider_check;

ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_provider_check
  CHECK (provider IN ('google', 'orcid'));

-- ORCID never returns an email claim, so the column has to accept its absence.
ALTER TABLE external_identities
  ALTER COLUMN provider_email DROP NOT NULL;

ALTER TABLE external_identities
  ADD COLUMN display_label text;

ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_one_per_provider
  UNIQUE (user_id, provider);

ALTER TABLE google_auth_transactions RENAME TO oidc_auth_transactions;

ALTER INDEX google_auth_transactions_expiry_idx RENAME TO oidc_auth_transactions_expiry_idx;

ALTER TABLE oidc_auth_transactions
  ADD COLUMN provider text NOT NULL DEFAULT 'google';

ALTER TABLE oidc_auth_transactions
  ALTER COLUMN provider DROP DEFAULT;

ALTER TABLE oidc_auth_transactions
  ADD CONSTRAINT oidc_auth_transactions_provider_check
  CHECK (provider IN ('google', 'orcid'));

-- A transaction started from Account Settings attaches the identity to this account
-- instead of resolving or creating one.
ALTER TABLE oidc_auth_transactions
  ADD COLUMN link_user_id uuid REFERENCES user_accounts(id) ON DELETE CASCADE;
