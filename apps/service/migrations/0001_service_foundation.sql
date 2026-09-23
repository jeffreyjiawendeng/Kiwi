CREATE TABLE service_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO service_metadata (key, value)
VALUES ('service_generation', 'account-collaboration-v1');
