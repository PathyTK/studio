import pg from 'pg';

/** Minimal async database interface: Postgres in production (`pg`), PGlite (in-process Postgres) in tests. */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>; // several statements, no parameters
  close?(): Promise<void>;
}

export function pgDb(connectionString: string): Db {
  // A small pool: every serverless instance holds its own connections. Use a pooled connection string
  // (Neon: the "-pooler" host) when running on Vercel.
  // pg treats sslmode=require/prefer/verify-ca as verify-full today and will change that in v9: say so explicitly.
  connectionString = connectionString.replace(/([?&])sslmode=(require|prefer|verify-ca)(?=&|$)/, '$1sslmode=verify-full');
  const pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', e => console.error('postgres pool error', e.message));
  return {
    async query(sql, params) { return (await pool.query(sql, params as any[])).rows; },
    async exec(sql) { await pool.query(sql); },
    close: () => pool.end(),
  };
}

// Timestamps are milliseconds in DOUBLE PRECISION columns: exact up to 2^53 and returned as plain JS numbers by every driver.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT,
  password_hash  TEXT,                              -- null for Google-only accounts
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_sub     TEXT UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verify_tokens (          -- only a hash of the emailed token is stored
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at DOUBLE PRECISION NOT NULL,
  used_at    DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS sessions (               -- only a hash of the cookie token is stored
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS slide_annotations (      -- one document per user and slide (all of that slide's shapes)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slide_path TEXT NOT NULL,
  data       JSONB NOT NULL,                        -- array of W3C annotations (Annotorious)
  count      INTEGER NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,             -- ms since epoch: the newer copy wins on sync
  PRIMARY KEY (user_id, slide_path)
);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS rate_limits (            -- shared by all serverless instances (fixed windows)
  key          TEXT PRIMARY KEY,
  window_start DOUBLE PRECISION NOT NULL,
  count        INTEGER NOT NULL
);
`;

const ready = new WeakMap<Db, Promise<void>>();
/** Creates the tables on first use (idempotent), once per process. */
export function ensureSchema(db: Db): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = db.exec(SCHEMA).catch(e => { ready.delete(db); throw e; });
    ready.set(db, p);
  }
  return p;
}
