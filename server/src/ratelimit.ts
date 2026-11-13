import type { Db } from './db.js';

/**
 * Fixed-window counter kept in Postgres so every serverless instance shares it
 * (in-memory counters would reset on each cold start and differ per instance).
 */
export async function allow(db: Db, key: string, windowMs: number, max: number, now = Date.now()): Promise<boolean> {
  const rows = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2::double precision, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < $2::double precision - $3::double precision THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $2::double precision - $3::double precision THEN $2::double precision ELSE rate_limits.window_start END
     RETURNING count`,
    [key, now, windowMs]);
  return rows[0].count <= max;
}
