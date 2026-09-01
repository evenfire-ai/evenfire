/**
 * Anti-race reservations in the budget "danger zone" (.specs/feat-token-budgets
 * §0.8, §2.3, §5.4).
 *
 * The P1 budget-check is read-only: two tasks launched at nearly the same time
 * read the SAME `spent` (TOCTOU + rollup lag ~1-2 min) and both pass → overspend.
 * This module bounds that race with an EPHEMERAL, TTL'd reservation that is only
 * taken when a matching `block` budget is close to its limit ("danger zone":
 * `remaining < max_task_amount`). Outside the danger zone the check stays a pure
 * pull with zero extra lock/transaction overhead (identical to P1).
 *
 * Serialization: each danger-zone budget is evaluated inside ONE transaction
 * holding `pg_advisory_xact_lock(hashtext(budget_id::text))`, so two simultaneous
 * checks of the same budget are ordered — the second sees the first's reservation
 * in `pending` and is denied. The advisory lock is released automatically when
 * the transaction commits/rolls back (xact-scoped), so a crash can never leak it.
 *
 * Fail-open safety (§0.2): every reservation carries `expires_at = NOW() + TTL`.
 * The pending-sum query filters `expires_at > NOW()`, so an expired reservation
 * stops counting immediately even before the sweep deletes it. A stuck task never
 * blocks a budget permanently — by the time the TTL elapses, the real spend has
 * landed in the rollups, so the next check sees the truth without double-counting.
 *
 * SECURITY: all SQL is parameterized. The advisory-lock key is
 * `hashtext($budgetId::text)` computed in Postgres over the UUID we already
 * loaded from `token_budgets`; no caller input reaches it.
 */
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { toNumber } from './definitions.js'

/**
 * Reservation TTL in seconds (§9.8a: ~2-3× the rollup lag, ~5 min). Centralized
 * in config.ts (BUDGET_RESERVATION_TTL_SECONDS) alongside the sweep interval.
 */
export const BUDGET_RESERVATION_TTL_SECONDS = config.budgetReservationTtlSeconds

/** Minimal transaction client shape — pg's PoolClient satisfies it. */
export type ReservationTxClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
  release?: () => void
}

/** Minimal connector shape — pg's Pool satisfies it. */
export type ReservationConnector = {
  connect: () => Promise<ReservationTxClient>
}

export type DangerZoneReserveInput = {
  budgetId: string
  /** The budget's limit_amount (already a JS number). */
  limit: number
  /** Period spend from the rollups (§3.2), computed outside the lock. */
  spent: number
  /** Minimum remaining required to allow a new task (§3.3). */
  minStart: number
  /** The budget's max_task_amount — the estimated per-task spend to reserve. */
  estAmount: number
  /** Correlation id from mcp-host so it can release early (may be null). */
  taskRef: string | null
  /**
   * The caller's host binding (`claims.hostRefs[0]`, already bound to the body's
   * `host_ref` by the /check claim-binding). Persisted so /internal/budgets/
   * release can only free reservations owned by the SAME host (§5.4). May be
   * null for callers that predate the binding — such rows are only reclaimable
   * by the TTL sweep, never by an early release.
   */
  hostRef: string | null
}

export type DangerZoneReserveResult =
  | { decision: 'allow'; reservationId: string }
  | { decision: 'deny' }

/**
 * Serialized danger-zone decision + reservation for ONE budget (§5.4 steps 2-5).
 *
 * Inside a single transaction holding the per-budget advisory lock:
 *   1. pending = SUM(est_amount) of still-active reservations for this budget.
 *   2. effective_remaining = limit - spent - pending.
 *   3. deny if effective_remaining < min_start; otherwise INSERT a reservation
 *      (est_amount = max_task_amount, expires_at = NOW() + TTL, task_ref) and allow.
 *
 * Throws on infrastructure failure — the caller decides how to degrade (the
 * check degrades to the P1 pull decision, never a silent bypass; see check.ts).
 */
export async function reserveInDangerZone(
  input: DangerZoneReserveInput,
  connector: ReservationConnector = pool,
  existingClient?: ReservationTxClient
): Promise<DangerZoneReserveResult> {
  if (existingClient) {
    return decideDangerZoneReservation(existingClient, input)
  }

  const client = await connector.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    const result = await decideDangerZoneReservation(client, input)
    await client.query('COMMIT')
    inTransaction = false
    return result
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore rollback failure; the original error is what matters
      }
    }
    throw err
  } finally {
    client.release?.()
  }
}

async function decideDangerZoneReservation(
  client: ReservationTxClient,
  input: DangerZoneReserveInput
): Promise<DangerZoneReserveResult> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.budgetId])

  const pendingParams: unknown[] = [input.budgetId]
  let selfExclusion = ''
  if (input.taskRef) {
    pendingParams.push(input.taskRef)
    selfExclusion = ' AND task_ref IS DISTINCT FROM $2'
  }
  const pendingRes = await client.query(
    `SELECT COALESCE(SUM(est_amount), 0) AS pending
       FROM budget_pending_reservations
      WHERE budget_id = $1 AND expires_at > NOW()${selfExclusion}`,
    pendingParams
  )
  const pending = toNumber((pendingRes.rows[0] as { pending?: unknown } | undefined)?.pending)
  const effectiveRemaining = input.limit - input.spent - pending

  if (effectiveRemaining < input.minStart) {
    return { decision: 'deny' }
  }

  const insertRes = await client.query(
    `INSERT INTO budget_pending_reservations (budget_id, est_amount, task_ref, host_ref, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 second'))
     RETURNING id`,
    [input.budgetId, input.estAmount, input.taskRef, input.hostRef, BUDGET_RESERVATION_TTL_SECONDS]
  )
  const reservationId = String((insertRes.rows[0] as { id: unknown }).id)
  return { decision: 'allow', reservationId }
}

export async function getActiveReservation(
  db: { query: ReservationTxClient['query'] },
  input: { reservationId: string; hostRef: string }
): Promise<{ id: string } | null> {
  const result = await db.query(
    `SELECT id::text AS id
       FROM budget_pending_reservations
      WHERE id = $1 AND host_ref = $2 AND expires_at > NOW()
      LIMIT 1`,
    [input.reservationId, input.hostRef]
  )
  const row = result.rows[0] as { id?: unknown } | undefined
  return row?.id ? { id: String(row.id) } : null
}

export type ReleaseReservationInput = {
  reservationId?: string | null
  taskRef?: string | null
  /**
   * The caller's host binding (`claims.hostRefs[0]`, validated by the route's
   * claim-binding against the body's `host_ref`). REQUIRED: every DELETE is
   * scoped with `AND host_ref = $N`, so a caller can only free reservations it
   * owns — a valid token for host A can never release host B's reservation
   * (§5.4). Rows written before host_ref existed carry NULL and never match this
   * equality, so they are reclaimable only by the TTL sweep — acceptable, as
   * reservations are ephemeral.
   */
  hostRef: string
}

/**
 * Delete reservation(s) early when mcp-host signals task completion (§5.4).
 * Idempotent: deleting an already-gone (or already-expired-and-swept) row is a
 * no-op. Returns the number of rows removed. At least one of `reservationId` /
 * `taskRef` must be provided (validated by the route's zod schema).
 *
 * A `task_ref` may have produced several reservations (one per danger-zone
 * budget), so releasing by `task_ref` clears them all in a single statement.
 *
 * Every DELETE is additionally scoped by `host_ref` so a caller can only free
 * its OWN reservations — releasing another host's reservation matches 0 rows.
 */
export async function releaseReservation(
  input: ReleaseReservationInput,
  db: { query: ReservationTxClient['query'] } = pool
): Promise<number> {
  const reservationId =
    typeof input.reservationId === 'string' && input.reservationId.length > 0
      ? input.reservationId
      : null
  const taskRef =
    typeof input.taskRef === 'string' && input.taskRef.length > 0 ? input.taskRef : null
  const hostRef = input.hostRef

  if (reservationId && taskRef) {
    const res = await db.query(
      `DELETE FROM budget_pending_reservations WHERE (id = $1 OR task_ref = $2) AND host_ref = $3`,
      [reservationId, taskRef, hostRef]
    )
    return res.rowCount ?? 0
  }
  if (reservationId) {
    const res = await db.query(
      `DELETE FROM budget_pending_reservations WHERE id = $1 AND host_ref = $2`,
      [reservationId, hostRef]
    )
    return res.rowCount ?? 0
  }
  if (taskRef) {
    const res = await db.query(
      `DELETE FROM budget_pending_reservations WHERE task_ref = $1 AND host_ref = $2`,
      [taskRef, hostRef]
    )
    return res.rowCount ?? 0
  }
  return 0
}

/**
 * Sweep expired reservations (§5.4, §9.7). Pure cleanup: the pending-sum query
 * already filters `expires_at > NOW()`, so an expired row never counts even if
 * the sweep hasn't run yet. Idempotent; safe to run on any interval.
 */
export async function sweepExpiredReservations(
  db: { query: ReservationTxClient['query'] } = pool
): Promise<number> {
  const res = await db.query(`DELETE FROM budget_pending_reservations WHERE expires_at <= NOW()`)
  return res.rowCount ?? 0
}
