ALTER TABLE connection_transactions
  ADD COLUMN poll_interval_seconds integer CHECK (
    poll_interval_seconds IS NULL OR poll_interval_seconds BETWEEN 1 AND 300
  ),
  ADD COLUMN next_poll_at timestamptz;

ALTER TABLE connection_transactions
  ADD CONSTRAINT connection_transactions_poll_pair_check
  CHECK (
    (poll_interval_seconds IS NULL AND next_poll_at IS NULL) OR
    (poll_interval_seconds IS NOT NULL AND next_poll_at IS NOT NULL)
  );
