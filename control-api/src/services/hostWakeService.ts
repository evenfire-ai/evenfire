import { pool } from '../db.js'

/**
 * Monotonic wake-generation counter for stateless Hosts.
 *
 * Why Postgres and not the Host CR annotation: the admin facade full-replaces
 * Host metadata, so a read-modify-write on the annotation could be clobbered
 * (lost update). The generation is bumped here atomically and only PROJECTED
 * onto the `clerum.io/wake-requested` annotation — the annotation is
 * write-only from control-api's perspective.
 *
 * Coalescence design (documented invariant):
 *   - EVERY wake bumps the generation (strictly monotonic, race-free under
 *     concurrency: the single INSERT ... ON CONFLICT DO UPDATE statement is
 *     serialized by the row lock).
 *   - Only the caller whose statement MOVES `last_projected_at` (because the
 *     previous projection is older than the coalescence window, or none
 *     exists) gets `shouldProject: true` and patches the annotation. Callers
 *     inside the window skip the patch: the annotation may then lag behind
 *     the latest generation, which is safe — a projection within the window
 *     already changed the annotation value and triggers HCC's wake/cancel
 *     reconcile. N concurrent wakes therefore produce exactly 1 annotation
 *     patch while every caller still receives its own valid generation.
 *
 * NOW() is per-statement-stable in Postgres, so the RETURNING comparison
 * `last_projected_at = NOW()` is true exactly when THIS statement claimed the
 * projection slot.
 */

export type WakeGenerationBump = {
  generation: number
  shouldProject: boolean
}

export async function bumpWakeGeneration(
  hostRef: string,
  coalesceWindowMs: number
): Promise<WakeGenerationBump> {
  if (!hostRef) {
    throw new Error('bumpWakeGeneration: hostRef is required')
  }
  if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0) {
    throw new Error('bumpWakeGeneration: coalesceWindowMs must be a non-negative number')
  }

  const result = await pool.query(
    `INSERT INTO host_wake_generations (host_ref, generation, updated_at, last_projected_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (host_ref) DO UPDATE
       SET generation = host_wake_generations.generation + 1,
           updated_at = NOW(),
           last_projected_at = CASE
             WHEN host_wake_generations.last_projected_at IS NULL
               OR host_wake_generations.last_projected_at
                  <= NOW() - make_interval(secs => $2::double precision / 1000.0)
             THEN NOW()
             ELSE host_wake_generations.last_projected_at
           END
     RETURNING generation, (last_projected_at = NOW()) AS should_project`,
    [hostRef, coalesceWindowMs]
  )

  const row = (result.rows?.[0] ?? null) as {
    generation: number | string
    should_project: boolean
  } | null
  // Fail loud: a wake that cannot record its generation must not pretend it
  // did — the caller would otherwise report a wakeGeneration that HCC never
  // sees. No fallback by design.
  if (!row) {
    throw new Error(`host_wake_generations upsert returned no row for host ${hostRef}`)
  }

  return {
    generation: Number(row.generation),
    shouldProject: row.should_project === true,
  }
}
