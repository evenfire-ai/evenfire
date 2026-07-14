/**
 * WRC leader election via session-scoped Postgres advisory lock.
 *
 * Plan §ADR-001: zero K8s-API load for coordination. Session-scoped advisory
 * locks are released automatically on TCP disconnect, so a crashed leader is
 * cleaned up by Postgres without any timeout/lease renewal machinery.
 *
 *   key = hashtext('wrc-leader-v1')
 *   SELECT pg_try_advisory_lock($key)   -> true = we are the leader
 *
 * The dedicated client (from `pool.connect()`) is the lock holder. We keep it
 * open for as long as this replica holds leadership. A TCP-level ping every
 * `leaderPollMs` doubles as a liveness probe: if the probe throws, we treat
 * the session as dead and re-enter the election.
 *
 * Per ADR-001 rollback path: feature flag `WRC_LEADER_STRATEGY=pg_advisory|k8s_lease`
 * lives at the caller — this module only implements the pg_advisory path.
 */
import type { PoolClient } from 'pg'
import { connectDedicated } from '../db.js'
import { type Logger, createLogger } from '../observability/logger.js'

const LEADER_KEY_SQL = "hashtext('wrc-leader-v1')"

export interface LeaderElectionOptions {
  /** Unique per-replica identifier; ends up stamped in workflow_runs.owner_instance_id. */
  instanceId: string
  /** How often to re-probe when NOT the leader (ms). */
  pollMs: number
  /** How often to ping the held session to detect silent disconnects (ms). */
  livenessMs?: number
  /** Hooks — fire-and-forget. */
  onBecomeLeader?: (instanceId: string) => void
  onLoseLeadership?: (instanceId: string, reason: string) => void
  /** Injection seams for tests. */
  connect?: () => Promise<PoolClient>
  logger?: Logger
}

export interface LeaderElection {
  start(): void
  stop(): Promise<void>
  isLeader(): boolean
  getInstanceId(): string
}

/**
 * Build a leader election instance. Call `start()` to kick off the background
 * acquisition loop. `stop()` releases the lock (if held) and halts the loop.
 *
 * Semantics:
 *  - At most one replica holds the lock at any time (Postgres guarantee).
 *  - A crashed leader's lock is released when Postgres closes the session
 *    (TCP keepalive ~60s on most deployments).
 *  - After a failed acquisition, the loop retries every `pollMs`.
 *  - If the live session throws during liveness probe, we release locally and
 *    re-enter the election.
 */
export function createLeaderElection(opts: LeaderElectionOptions): LeaderElection {
  const log = opts.logger ?? createLogger('wrc', 'leader-election:' + opts.instanceId)
  const connect = opts.connect ?? connectDedicated
  const livenessMs = opts.livenessMs ?? Math.max(5_000, Math.floor(opts.pollMs / 2))

  let leader = false
  let client: PoolClient | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  let stopped = true

  async function releaseLocal(reason: string): Promise<void> {
    if (!leader && !client) return
    const wasLeader = leader
    leader = false
    if (livenessTimer) {
      clearInterval(livenessTimer)
      livenessTimer = null
    }
    if (client) {
      try {
        // Best-effort; if the connection is dead this will throw — we swallow.
        await client.query('SELECT pg_advisory_unlock(' + LEADER_KEY_SQL + ')')
      } catch {
        /* connection may already be gone */
      }
      try {
        client.release()
      } catch {
        /* idempotent */
      }
      client = null
    }
    if (wasLeader) {
      log.info('leadership released', { reason })
      opts.onLoseLeadership?.(opts.instanceId, reason)
    }
  }

  async function tryAcquire(): Promise<boolean> {
    let c: PoolClient
    try {
      c = await connect()
    } catch (err) {
      log.warn('leader connect failed', { err: err instanceof Error ? err.message : String(err) })
      return false
    }
    try {
      const res = await c.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(' + LEADER_KEY_SQL + ') AS acquired'
      )
      const acquired = Boolean(res.rows[0]?.acquired)
      if (!acquired) {
        // Return the client to the pool — another replica holds the lock.
        c.release()
        return false
      }
      // Stamp the session so `GET /admin/workflows/leader` can surface the
      // instance_id via pg_stat_activity.application_name (Plan §4F).
      // Failure here is non-fatal: we still hold the lock and can process runs;
      // the admin endpoint will just show a blank instance_id.
      try {
        await c.query('SET application_name = $1', ['wrc-' + opts.instanceId])
      } catch (err) {
        log.warn('failed to set application_name', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
      client = c
      leader = true
      log.info('leadership acquired')
      opts.onBecomeLeader?.(opts.instanceId)
      startLivenessProbe()
      return true
    } catch (err) {
      try {
        c.release()
      } catch {
        /* idempotent */
      }
      log.warn('leader acquire error', { err: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  function startLivenessProbe(): void {
    if (livenessTimer) return
    livenessTimer = setInterval(() => {
      if (!leader || !client) return
      // Fire-and-forget probe; on failure drop leadership and re-enter election.
      client
        .query('SELECT 1')
        .then(() => {
          /* healthy */
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          void releaseLocal('liveness probe failed: ' + reason).then(() => {
            if (!stopped) scheduleTick(0)
          })
        })
    }, livenessMs)
    // Do not hold the Node event loop open just for pings.
    if (typeof livenessTimer.unref === 'function') livenessTimer.unref()
  }

  function scheduleTick(delayMs: number): void {
    if (stopped) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      pollTimer = null
      void tick().catch(err => {
        log.error('leader tick crashed', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }, delayMs)
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (!leader) {
      await tryAcquire()
    }
    // Always re-arm — even when leader we keep the timer alive so that after
    // a session loss we fall back into acquisition promptly.
    scheduleTick(leader ? opts.pollMs : opts.pollMs)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      scheduleTick(0)
    },

    async stop() {
      stopped = true
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      // Any in-flight tick checks `stopped` before doing real work, so we
      // don't need to await it — releasing the lock is safe because tick()'s
      // only effect post-stop is a no-op early return.
      await releaseLocal('stop() called')
    },

    isLeader() {
      return leader
    },

    getInstanceId() {
      return opts.instanceId
    },
  }
}
