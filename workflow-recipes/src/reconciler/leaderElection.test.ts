import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { type LeaderElection, createLeaderElection } from './leaderElection.js'

/**
 * Tests for `createLeaderElection` — the Postgres-advisory-lock-based WRC
 * leader election (plan §ADR-001).
 *
 * Shape we care about:
 *  - A single client is held for the duration of leadership (session-scoped
 *    lock ⇒ auto-release on TCP close).
 *  - When `pg_try_advisory_lock` returns FALSE, we release the client back to
 *    the pool and retry after `pollMs`.
 *  - The liveness probe (`SELECT 1`) demotes the replica on failure and
 *    re-enters the election.
 *  - `stop()` unlocks and releases the client.
 *
 * We inject a fake `connect()` that returns a programmable client so we never
 * touch a real Postgres instance here.
 */

type QueryFn = (sql: unknown, params?: unknown[]) => Promise<unknown>

interface FakeClient {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function makeClient(handle: QueryFn): FakeClient {
  return {
    query: vi.fn(handle),
    release: vi.fn(),
  }
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: () => silentLogger(),
  }
}

// `setImmediate` is faked by vi.useFakeTimers() — use process.nextTick, which
// is NOT faked, so awaiting it actually drains pending microtasks.
const flush = () => new Promise<void>(resolve => process.nextTick(resolve))

describe('createLeaderElection', () => {
  let instances: LeaderElection[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    instances = []
  })

  afterEach(async () => {
    // Switch to real timers BEFORE stopping — stop() may await the lock
    // release, which under fake timers can deadlock waiting for a scheduled
    // tick that never fires.
    vi.useRealTimers()
    for (const inst of instances) {
      try {
        await inst.stop()
      } catch {
        /* best-effort cleanup */
      }
    }
    vi.restoreAllMocks()
  })

  function spawn(opts: Parameters<typeof createLeaderElection>[0]): LeaderElection {
    const inst = createLeaderElection(opts)
    instances.push(inst)
    return inst
  }

  it('acquires the lock when pg_try_advisory_lock returns true', async () => {
    const client = makeClient(async sql => {
      if (/pg_try_advisory_lock/i.test(String(sql))) {
        return { rows: [{ acquired: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = vi.fn(async () => client as unknown as PoolClient)
    const onBecomeLeader = vi.fn()

    const inst = spawn({
      instanceId: 'wrc-a',
      pollMs: 10_000,
      connect,
      logger: silentLogger(),
      onBecomeLeader,
    })

    inst.start()
    await flush()
    // setTimeout(0) schedules immediately; drain it.
    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(inst.isLeader()).toBe(true)
    expect(onBecomeLeader).toHaveBeenCalledWith('wrc-a')
    // Client must NOT have been released — the lock must stay alive on this session.
    expect(client.release).not.toHaveBeenCalled()
  })

  it('returns the client to the pool and retries when another replica holds the lock', async () => {
    let attempts = 0
    const client = makeClient(async sql => {
      if (/pg_try_advisory_lock/i.test(String(sql))) {
        attempts += 1
        // First probe: contention. Second probe: we get it.
        return { rows: [{ acquired: attempts >= 2 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = vi.fn(async () => client as unknown as PoolClient)

    const inst = spawn({
      instanceId: 'wrc-b',
      pollMs: 5_000,
      connect,
      logger: silentLogger(),
    })

    inst.start()
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(inst.isLeader()).toBe(false)
    // On the losing probe the client was returned to the pool.
    expect(client.release).toHaveBeenCalledTimes(1)

    // Advance to the next poll.
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()

    expect(inst.isLeader()).toBe(true)
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('releases the lock and client on stop()', async () => {
    const calls: string[] = []
    const client = makeClient(async sql => {
      const text = String(sql)
      calls.push(text)
      if (/pg_try_advisory_lock/i.test(text)) {
        return { rows: [{ acquired: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = vi.fn(async () => client as unknown as PoolClient)
    const onLose = vi.fn()

    const inst = spawn({
      instanceId: 'wrc-c',
      pollMs: 10_000,
      connect,
      logger: silentLogger(),
      onLoseLeadership: onLose,
    })

    inst.start()
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(inst.isLeader()).toBe(true)

    // Switch to real timers so the awaited stop() actually completes.
    vi.useRealTimers()
    await inst.stop()

    expect(inst.isLeader()).toBe(false)
    expect(calls.some(s => /pg_advisory_unlock/i.test(s))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(onLose).toHaveBeenCalledWith('wrc-c', 'stop() called')
  })

  it('demotes and re-enters the election when the liveness probe throws', async () => {
    // Two clients: the first session dies, the second acquires.
    let pingCalls = 0
    const deadClient = makeClient(async sql => {
      const text = String(sql)
      if (/pg_try_advisory_lock/i.test(text)) {
        return { rows: [{ acquired: true }], rowCount: 1 }
      }
      if (/SELECT 1/i.test(text)) {
        pingCalls += 1
        throw new Error('connection terminated')
      }
      return { rows: [], rowCount: 0 }
    })
    const freshClient = makeClient(async sql => {
      if (/pg_try_advisory_lock/i.test(String(sql))) {
        return { rows: [{ acquired: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    let conn = 0
    const connect = vi.fn(async () => {
      conn += 1
      return (conn === 1 ? deadClient : freshClient) as unknown as PoolClient
    })

    const inst = spawn({
      instanceId: 'wrc-d',
      pollMs: 10_000,
      livenessMs: 1_000,
      connect,
      logger: silentLogger(),
    })

    inst.start()
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(inst.isLeader()).toBe(true)

    // Trigger the liveness probe — the dead client throws.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    await flush()

    // Demoted, then next tick re-acquires via the fresh client.
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()

    expect(pingCalls).toBeGreaterThanOrEqual(1)
    expect(conn).toBeGreaterThanOrEqual(2)
    expect(inst.isLeader()).toBe(true)
  })

  it('treats connect() failures as lost election (retries without crashing)', async () => {
    const connect = vi.fn(async () => {
      throw new Error('pool exhausted')
    })

    const inst = spawn({
      instanceId: 'wrc-e',
      pollMs: 3_000,
      connect,
      logger: silentLogger(),
    })

    inst.start()
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    await flush()

    expect(inst.isLeader()).toBe(false)
    expect(connect).toHaveBeenCalled()

    // The loop must survive and retry — not throw unhandled.
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('exposes instanceId for stamping onto workflow_runs.owner_instance_id', () => {
    const inst = spawn({
      instanceId: 'wrc-owner-xyz',
      pollMs: 10_000,
      connect: vi.fn(
        async () => makeClient(async () => ({ rows: [], rowCount: 0 })) as unknown as PoolClient
      ),
      logger: silentLogger(),
    })
    expect(inst.getInstanceId()).toBe('wrc-owner-xyz')
  })
})
