ALTER TABLE connection_transactions
  ADD COLUMN oauth_request_token text,
  ADD COLUMN oauth_request_secret text;

ALTER TABLE connection_transactions
  ADD CONSTRAINT connection_transactions_oauth_request_pair_check
  CHECK (
    (oauth_request_token IS NULL AND oauth_request_secret IS NULL) OR
    (oauth_request_token IS NOT NULL AND oauth_request_secret IS NOT NULL)
  );
