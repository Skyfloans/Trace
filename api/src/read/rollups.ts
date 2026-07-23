import type { Pool } from "pg";

const readinessCache = new WeakMap<
  Pool,
  { ready: boolean; expiresAt: number }
>();
const displayReadinessCache = new WeakMap<
  Pool,
  { ready: boolean; expiresAt: number }
>();
const displayFilterReadinessCache = new WeakMap<
  Pool,
  { ready: boolean; expiresAt: number }
>();
const displayImpactReadinessCache = new WeakMap<
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

export async function displayErrorReadModelReady(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = displayReadinessCache.get(pool);
  if (cached && cached.expiresAt > now) return cached.ready;

  const relation = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.trace_read_model_state')::text AS relation",
  );
  if (!relation.rows[0]?.relation) {
    displayReadinessCache.set(pool, {
      ready: false,
      expiresAt: now + readinessTtlMs,
    });
    return false;
  }

  const marker = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM trace_read_model_state
       WHERE key = 'display_error_read_model_v1'
     ) AS ready`,
  );
  const ready = marker.rows[0]?.ready === true;
  displayReadinessCache.set(pool, { ready, expiresAt: now + readinessTtlMs });
  return ready;
}

export async function displayErrorRollupFiltersReady(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = displayFilterReadinessCache.get(pool);
  if (cached && cached.expiresAt > now) return cached.ready;

  const marker = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM trace_read_model_state
       WHERE key = 'display_error_rollup_filters_v1'
     ) AS ready`,
  );
  const ready = marker.rows[0]?.ready === true;
  displayFilterReadinessCache.set(pool, {
    ready,
    expiresAt: now + readinessTtlMs,
  });
  return ready;
}

export async function displayErrorImpactsReady(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = displayImpactReadinessCache.get(pool);
  if (cached && cached.expiresAt > now) return cached.ready;

  const marker = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM trace_read_model_state
       WHERE key = 'display_error_impacts_v1'
     ) AS ready`,
  );
  const ready = marker.rows[0]?.ready === true;
  displayImpactReadinessCache.set(pool, {
    ready,
    expiresAt: now + readinessTtlMs,
  });
  return ready;
}
