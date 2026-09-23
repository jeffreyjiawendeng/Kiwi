ALTER TABLE user_accounts
  ADD COLUMN given_name text,
  ADD COLUMN family_name text,
  ADD COLUMN preferred_name text,
  ADD COLUMN pronouns text;

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_given_name_length
  CHECK (given_name IS NULL OR length(given_name) BETWEEN 1 AND 80);

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_family_name_length
  CHECK (family_name IS NULL OR length(family_name) BETWEEN 1 AND 80);

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_preferred_name_length
  CHECK (preferred_name IS NULL OR length(preferred_name) BETWEEN 1 AND 80);

ALTER TABLE user_accounts
  ADD CONSTRAINT user_accounts_pronouns_length
  CHECK (pronouns IS NULL OR length(pronouns) BETWEEN 1 AND 40);

-- The existing display_name is the name collaborators already see, so it becomes the
-- preferred name rather than being split into parts that were never separately entered.
UPDATE user_accounts SET preferred_name = display_name WHERE display_name IS NOT NULL;

ALTER TABLE user_accounts DROP COLUMN display_name;
