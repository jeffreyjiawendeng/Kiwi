ALTER TABLE external_identities
  ADD COLUMN access_secret_ciphertext text,
  ADD COLUMN refresh_secret_ciphertext text,
  ADD COLUMN authorization_scopes text;

ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_authorization_pair_check
  CHECK (
    (access_secret_ciphertext IS NULL AND refresh_secret_ciphertext IS NULL AND authorization_scopes IS NULL)
    OR
    (access_secret_ciphertext IS NOT NULL AND authorization_scopes IS NOT NULL)
  );

ALTER TABLE external_identities
  ADD CONSTRAINT external_identities_authorization_bounds_check
  CHECK (
    (access_secret_ciphertext IS NULL OR length(access_secret_ciphertext) BETWEEN 20 AND 22000)
    AND (refresh_secret_ciphertext IS NULL OR length(refresh_secret_ciphertext) BETWEEN 20 AND 22000)
    AND (authorization_scopes IS NULL OR length(authorization_scopes) BETWEEN 1 AND 1000)
  );
