import type { Pool } from "pg";

const readinessCache = new WeakMap<
  Pool,
  { ready: boolean; expiresAt: number }
>();

const readinessTtlMs = 15_000;

export async function liveErrorGroupRollupsReady(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = readinessCache.get(pool);
  if (cached && cached.expiresAt > now) return cached.ready;

  const relation = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.trace_read_model_state')::text AS relation",
  );
  if (!relation.rows[0]?.relation) {
    readinessCache.set(pool, { ready: false, expiresAt: now + readinessTtlMs });
    return false;
  }

  const marker = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM trace_read_model_state
       WHERE key = 'live_error_group_rollups_v1'
     ) AS ready`,
  );
  const ready = marker.rows[0]?.ready === true;
  readinessCache.set(pool, { ready, expiresAt: now + readinessTtlMs });
  return ready;
}
