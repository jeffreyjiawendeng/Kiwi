ALTER TABLE connected_accounts
  ADD COLUMN authorization_status text NOT NULL DEFAULT 'active'
  CHECK (authorization_status IN ('active', 'reauthorization_required')),
  ADD COLUMN refresh_attempts integer NOT NULL DEFAULT 0 CHECK (refresh_attempts >= 0),
  ADD COLUMN refresh_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN refresh_locked_until timestamptz,
  ADD COLUMN last_refreshed_at timestamptz,
  ADD COLUMN last_refresh_error text CHECK (
    last_refresh_error IS NULL OR length(last_refresh_error) <= 500
  );

CREATE INDEX connected_accounts_refresh_ready_idx
  ON connected_accounts (refresh_available_at, access_expires_at)
  WHERE refresh_secret IS NOT NULL AND authorization_status = 'active';
