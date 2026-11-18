CREATE TABLE IF NOT EXISTS oura_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(session_id)
);

CREATE TABLE IF NOT EXISTS oura_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  history_cursor TEXT,
  next_sync_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS oura_connections_due
  ON oura_connections(next_sync_at) WHERE sync_state <> 'reconnect';

CREATE TABLE IF NOT EXISTS oura_daily (
  user_id TEXT NOT NULL REFERENCES oura_connections(user_id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sleep_score REAL,
  readiness_score REAL,
  activity_score REAL,
  sleep_minutes REAL,
  deep_minutes REAL,
  rem_minutes REAL,
  hrv REAL,
  lowest_pulse REAL,
  temperature_delta REAL,
  steps REAL,
  PRIMARY KEY(user_id, day)
);

CREATE TABLE IF NOT EXISTS account_invites (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_attempts_time ON auth_attempts(occurred_at);
