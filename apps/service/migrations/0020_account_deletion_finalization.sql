-- Historical workspace events keep an opaque actor identifier after personal data is
-- erased. The account row therefore becomes a non-signable tombstone instead of being
-- physically removed and breaking those references.
ALTER TABLE user_accounts
  DROP CONSTRAINT user_accounts_status_check;

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_status_check
  CHECK (status IN ('active', 'suspended', 'deleting', 'deleted'));

ALTER TABLE user_accounts
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_deleted_state_check
  CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL) OR
    (status <> 'deleted' AND deleted_at IS NULL)
  );
