-- A preferred name added a third name field that no Kiwi surface distinguished from the
-- given name. Any value already entered moves into the given name so no display name is
-- lost, and only accounts that never entered a given name are affected.
UPDATE user_accounts
   SET given_name = preferred_name
 WHERE preferred_name IS NOT NULL AND given_name IS NULL;

ALTER TABLE user_accounts DROP COLUMN preferred_name;
