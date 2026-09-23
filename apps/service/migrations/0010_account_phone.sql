ALTER TABLE user_accounts
  ADD COLUMN phone text;

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_phone_form
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,18}$');
