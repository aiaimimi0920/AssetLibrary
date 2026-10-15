CREATE TABLE auth_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_transactions_expiry ON auth_transactions(expires_at);
CREATE TABLE auth_sessions (
  session_hash TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  access_token TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
