CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  provider_subject text NOT NULL,
  provider_email text NOT NULL,
  created_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX external_identities_user_idx ON external_identities (user_id);

CREATE TABLE google_auth_transactions (
  id uuid PRIMARY KEY,
  state_hash char(64) NOT NULL UNIQUE,
  nonce_hash char(64) NOT NULL,
  code_challenge text NOT NULL CHECK (length(code_challenge) BETWEEN 43 AND 128),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 20 AND 500),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX google_auth_transactions_expiry_idx
  ON google_auth_transactions (expires_at)
  WHERE consumed_at IS NULL;
