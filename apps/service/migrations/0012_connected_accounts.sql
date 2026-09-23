CREATE TABLE connected_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (
    provider IN ('github', 'zotero', 'mendeley', 'osf', 'figshare', 'zenodo')
  ),
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 255),
  external_account_label text NOT NULL CHECK (length(external_account_label) BETWEEN 1 AND 255),
  scopes text NOT NULL CHECK (length(scopes) <= 500),
  access_secret text NOT NULL,
  refresh_secret text,
  access_expires_at timestamptz,
  connected_at timestamptz NOT NULL,
  UNIQUE (user_id, provider)
);

CREATE INDEX connected_accounts_user_idx ON connected_accounts (user_id);

CREATE TABLE connection_transactions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state_hash char(64) NOT NULL UNIQUE,
  code_verifier text,
  device_code_hash char(64),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX connection_transactions_expiry_idx
  ON connection_transactions (expires_at)
  WHERE consumed_at IS NULL;
