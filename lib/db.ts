import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Lazy Neon client. We do NOT initialize at module load because
 * `neon()` throws if DATABASE_URL is unset, which would crash
 * `next build` whenever env vars aren't available yet.
 *
 * DO NOT wrap this in a JS Proxy — that breaks libraries that
 * introspect the client (see vercel-storage skill warning).
 */
let _sql: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Run `vercel env pull .env.local` or set it in your environment.",
    );
  }
  _sql = neon(url);
  return _sql;
}

/**
 * Single-user app (Nick only). We key the state row by a constant
 * id so future-Nick can add multi-user later without a migration.
 */
export const SPIROS_USER_ID = "nick";

let _schemaReady = false;

/**
 * Idempotent schema bootstrap. Called from API routes before any
 * read/write. Cached per-process so we don't hit the network on
 * every request.
 */
export async function ensureSchema(): Promise<void> {
  if (_schemaReady) return;
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS spiros_state (
      user_id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  _schemaReady = true;
}
