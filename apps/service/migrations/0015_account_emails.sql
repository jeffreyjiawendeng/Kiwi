CREATE TABLE account_emails (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 254),
  kind text NOT NULL CHECK (kind IN ('personal', 'institutional')),
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  receives_notifications boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, address)
);

-- An address may prove control of exactly one account at a time. Unverified rows are not
-- constrained, so two people may both claim an address until one of them verifies it.
CREATE UNIQUE INDEX account_emails_verified_address_idx
  ON account_emails (address)
  WHERE verified_at IS NOT NULL;

CREATE UNIQUE INDEX account_emails_primary_idx
  ON account_emails (user_id)
  WHERE is_primary;

CREATE UNIQUE INDEX account_emails_notifications_idx
  ON account_emails (user_id)
  WHERE receives_notifications;

-- The primary address and the notification address must both be verified.
ALTER TABLE account_emails
  ADD CONSTRAINT account_emails_primary_is_verified
  CHECK (NOT is_primary OR verified_at IS NOT NULL);

ALTER TABLE account_emails
  ADD CONSTRAINT account_emails_notifications_verified
  CHECK (NOT receives_notifications OR verified_at IS NOT NULL);

-- Every existing account already holds one verified primary address on user_accounts.
INSERT INTO account_emails
  (id, user_id, address, kind, verified_at, is_primary, receives_notifications, created_at)
SELECT gen_random_uuid(),
       a.id,
       a.primary_email,
       'personal',
       COALESCE(a.email_verified_at, a.created_at),
       true,
       true,
       a.created_at
  FROM user_accounts a;

CREATE TABLE account_email_verifications (
  id uuid PRIMARY KEY,
  email_id uuid NOT NULL REFERENCES account_emails(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX account_email_verifications_expiry_idx
  ON account_email_verifications (expires_at)
  WHERE consumed_at IS NULL;
