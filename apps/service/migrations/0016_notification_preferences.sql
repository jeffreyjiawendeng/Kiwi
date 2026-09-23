-- Delivery is stored per category, and only for the categories a person has changed.
-- A missing row is the category default, so adding a category never needs a backfill.
CREATE TABLE account_notification_preferences (
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (
    category IN ('workspace_invitations', 'collaboration', 'synchronization', 'product')
  ),
  email boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, category)
);
