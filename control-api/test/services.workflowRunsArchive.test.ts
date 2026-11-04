import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
// Import AFTER vi.mock() so the service picks up the mocked modules.
import { archiveTerminalRuns } from '../src/services/workflowRunsArchiveService.js'

/**
 * Tests for `workflowRunsArchiveService.archiveTerminalRuns`.
 *
 * The service acquires a session-scoped `pg_try_advisory_lock` on a client
 * obtained via `pool.connect()`, then drives batch transactions on that same
 * client (so the lock stays alive for the whole sweep). We mock `pool.connect`
 * to return a programmable fake client and route queries by SQL regex.
 *
 * Post-commit, the service best-effort deletes the child WorkflowRecipe via a
 * `K8sGateway.deleteResource(...)` — we assert the call count + status-code
 * handling (404 = not_found, other = error) without throwing.
 */

type LockQueryResult = { rows: Array<{ acquired: boolean }>; rowCount: number }
type AnyQueryResult = { rows: unknown[]; rowCount: number | null }
type RunRow = {
  run_id: string
  child_recipe_name: string | null
  child_recipe_namespace: string | null
}

// ─── Mock state ────────────────────────────────────────────────────────────

const eligibleRuns: RunRow[] = []
let lockAcquired = true // flip to false to simulate contention from another replica
let batchErrorMode: 'none' | 'throw-on-insert-audit' = 'none'
const clientQuery = vi.fn(
  async (sql: unknown, params?: unknown[]): Promise<AnyQueryResult | LockQueryResult> => {
    const text = typeof sql === 'string' ? sql : ''

    // Advisory lock acquisition
    if (/pg_try_advisory_lock/i.test(text)) {
      return { rows: [{ acquired: lockAcquired }], rowCount: 1 }
    }
    if (/pg_advisory_unlock/i.test(text)) {
      return { rows: [], rowCount: 1 }
    }

    // Transaction boundary statements are no-ops in the mock
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(text.trim())) {
      return { rows: [], rowCount: null }
    }

    // SELECT eligible terminal runs (drain the shared array in batches)
    if (
      /SELECT run_id, child_recipe_name, child_recipe_namespace\s+FROM workflow_runs/i.test(text)
    ) {
      const limit = Number(params?.[1] ?? 0)
      const batch = eligibleRuns.splice(0, limit)
      return { rows: batch, rowCount: batch.length }
    }

    // Copy INSERT — optionally throw to exercise the ROLLBACK path
    if (/INSERT INTO workflow_runs_audit/i.test(text)) {
      if (batchErrorMode === 'throw-on-insert-audit') {
        throw new Error('simulated audit insert failure')
      }
      const ids = (params?.[0] as string[]) ?? []
      return { rows: [], rowCount: ids.length }
    }
    if (/INSERT INTO workflow_run_step_audit/i.test(text)) {
      return { rows: [], rowCount: 0 }
    }

    // Live DELETE
    if (/DELETE FROM workflow_runs WHERE run_id = ANY/i.test(text)) {
      const ids = (params?.[0] as string[]) ?? []
      return { rows: [], rowCount: ids.length }
    }

    return { rows: [], rowCount: null }
  }
)
const clientRelease = vi.fn()
const mockConnect = vi.fn(async () => ({
  query: clientQuery,
  release: clientRelease,
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: () => mockConnect(),
  },
  withTransaction: vi.fn(),
}))

// Silence logger — observability is covered by integration, not unit tests.
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ─── Fake gateway ──────────────────────────────────────────────────────────

type DeleteError = Error & { statusCode?: number }

function makeGateway(
  deleteImpl: (plural: string, name: string, ns?: string) => Promise<unknown>
): K8sGateway {
  return {
    deleteResource: vi.fn(deleteImpl),
  } as unknown as K8sGateway
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('archiveTerminalRuns', () => {
  beforeEach(() => {
    eligibleRuns.length = 0
    lockAcquired = true
    batchErrorMode = 'none'
    clientQuery.mockClear()
    clientRelease.mockClear()
    mockConnect.mockClear()
  })

  it('archives eligible terminal runs and deletes each child recipe post-commit', async () => {
    eligibleRuns.push(
      {
        run_id: 'uuid-1',
        child_recipe_name: 'recipe-1',
        child_recipe_namespace: 'sandbox-recipes',
      },
      { run_id: 'uuid-2', child_recipe_name: 'recipe-2', child_recipe_namespace: 'sandbox-recipes' }
    )
    const deleteResource = vi.fn(async () => ({}))
    const gateway = makeGateway(deleteResource)

    const total = await archiveTerminalRuns(gateway)

    expect(total).toBe(2)
    // Transaction shape: BEGIN → SELECT → INSERT audit → INSERT step audit → DELETE → COMMIT,
    // then one more drain SELECT returning 0 rows.
    const selectCalls = clientQuery.mock.calls.filter(([sql]) =>
      /SELECT run_id, child_recipe_name/i.test(String(sql))
    )
    expect(selectCalls.length).toBe(2) // drain batch + empty-tail
    expect(String(selectCalls[0]?.[0])).toContain('COALESCE(ttl_seconds_after_finished, $1)')
    const insertAuditCalls = clientQuery.mock.calls.filter(([sql]) =>
      /INSERT INTO workflow_runs_audit/i.test(String(sql))
    )
    expect(insertAuditCalls.length).toBe(1)
    expect(String(insertAuditCalls[0]?.[0])).toContain('wr.started_at')
    expect(String(insertAuditCalls[0]?.[0])).toContain('wr.completed_at - wr.started_at')
    expect(String(insertAuditCalls[0]?.[0])).not.toContain('wr.completed_at - wr.created_at')
    const deleteCalls = clientQuery.mock.calls.filter(([sql]) =>
      /DELETE FROM workflow_runs/i.test(String(sql))
    )
    expect(deleteCalls.length).toBe(1)

    // Child recipe deletes happen AFTER the SQL commit, once per archived row.
    expect(deleteResource).toHaveBeenCalledTimes(2)
    expect(deleteResource).toHaveBeenCalledWith('workflowrecipes', 'recipe-1', 'sandbox-recipes')
    expect(deleteResource).toHaveBeenCalledWith('workflowrecipes', 'recipe-2', 'sandbox-recipes')

    // Lock hygiene: acquired, released, and client returned to the pool.
    const lockCalls = clientQuery.mock.calls.filter(([sql]) =>
      /pg_try_advisory_lock|pg_advisory_unlock/i.test(String(sql))
    )
    expect(lockCalls.length).toBe(2)
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when another replica holds the advisory lock', async () => {
    lockAcquired = false
    eligibleRuns.push({
      run_id: 'uuid-contended',
      child_recipe_name: 'recipe-contended',
      child_recipe_namespace: 'sandbox-recipes',
    })
    const deleteResource = vi.fn(async () => ({}))
    const gateway = makeGateway(deleteResource)

    const total = await archiveTerminalRuns(gateway)

    expect(total).toBe(0)
    // Only the lock probe ran — no SELECT/INSERT/DELETE against workflow_runs.
    const nonLockQueries = clientQuery.mock.calls.filter(
      ([sql]) => !/pg_try_advisory_lock|pg_advisory_unlock/i.test(String(sql))
    )
    expect(nonLockQueries.length).toBe(0)
    // The unreleased lock must NOT be unlocked (we never acquired it).
    const unlockCalls = clientQuery.mock.calls.filter(([sql]) =>
      /pg_advisory_unlock/i.test(String(sql))
    )
    expect(unlockCalls.length).toBe(0)
    expect(deleteResource).not.toHaveBeenCalled()
    // Client is ALWAYS released so it returns to the pool.
    expect(clientRelease).toHaveBeenCalledTimes(1)
    // Eligible row is still waiting for the next sweep.
    expect(eligibleRuns.length).toBe(1)
  })

  it('treats 404 NotFound on child delete as success (not_found), not as a sweep failure', async () => {
    eligibleRuns.push({
      run_id: 'uuid-orphan',
      child_recipe_name: 'recipe-gone',
      child_recipe_namespace: 'sandbox-recipes',
    })
    const notFoundErr: DeleteError = Object.assign(new Error('not found'), { statusCode: 404 })
    const deleteResource = vi.fn(async () => {
      throw notFoundErr
    })
    const gateway = makeGateway(deleteResource)

    const total = await archiveTerminalRuns(gateway)

    expect(total).toBe(1)
    expect(deleteResource).toHaveBeenCalledTimes(1)
    // Lock released + client returned despite K8s 404.
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('continues the sweep when one child delete fails with a non-404 error', async () => {
    eligibleRuns.push(
      { run_id: 'uuid-a', child_recipe_name: 'rec-a', child_recipe_namespace: 'sandbox-recipes' },
      { run_id: 'uuid-b', child_recipe_name: 'rec-b', child_recipe_namespace: 'sandbox-recipes' }
    )
    const serverErr: DeleteError = Object.assign(new Error('500 internal'), { statusCode: 500 })
    const deleteResource = vi.fn(async (_plural: string, name: string) => {
      if (name === 'rec-a') throw serverErr
      return {}
    })
    const gateway = makeGateway(deleteResource)

    // Must NOT throw — child delete is best-effort and the SQL is already committed.
    const total = await archiveTerminalRuns(gateway)

    expect(total).toBe(2)
    expect(deleteResource).toHaveBeenCalledTimes(2)
  })

  it('rolls back the batch transaction and surfaces the error when INSERT audit fails', async () => {
    eligibleRuns.push({
      run_id: 'uuid-fail',
      child_recipe_name: 'rec-fail',
      child_recipe_namespace: 'sandbox-recipes',
    })
    batchErrorMode = 'throw-on-insert-audit'
    const deleteResource = vi.fn(async () => ({}))
    const gateway = makeGateway(deleteResource)

    await expect(archiveTerminalRuns(gateway)).rejects.toThrow('simulated audit insert failure')

    // Rollback must fire; commit must NOT.
    const rollbackCalls = clientQuery.mock.calls.filter(([sql]) =>
      /^ROLLBACK$/i.test(String(sql).trim())
    )
    const commitCalls = clientQuery.mock.calls.filter(([sql]) =>
      /^COMMIT$/i.test(String(sql).trim())
    )
    expect(rollbackCalls.length).toBe(1)
    expect(commitCalls.length).toBe(0)

    // No child delete fired (SQL did not commit → no archived children to clean up).
    expect(deleteResource).not.toHaveBeenCalled()

    // Lock + client are still released in the finally block.
    const unlockCalls = clientQuery.mock.calls.filter(([sql]) =>
      /pg_advisory_unlock/i.test(String(sql))
    )
    expect(unlockCalls.length).toBe(1)
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('preserves FK safety guard and trigger_source preservation in the audit INSERT SQL', async () => {
    // This is a contract test: if someone removes the `EXISTS (SELECT 1 FROM users ...)`
    // guard, user-session runs with a stale/missing actor_id will violate the FK on
    // workflow_runs_audit.triggerer_user_id → users(id). Likewise, if the
    // `trigger_source IN ('schedule','autonomous')` CASE is removed, autonomous runs
    // will be mis-attributed as 'onDemand' in the audit log.
    eligibleRuns.push({
      run_id: 'uuid-contract',
      child_recipe_name: 'rec-contract',
      child_recipe_namespace: 'sandbox-recipes',
    })
    const gateway = makeGateway(async () => ({}))

    await archiveTerminalRuns(gateway)

    const auditInsert = clientQuery.mock.calls.find(([sql]) =>
      /INSERT INTO workflow_runs_audit/i.test(String(sql))
    )
    expect(auditInsert).toBeDefined()
    const sql = String(auditInsert![0])

    // FK safety: only keep actor_id when the user row still exists.
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+users\s+WHERE\s+id\s*=\s*wr\.actor_id\s*\)/i
    )
    expect(sql).toMatch(/wr\.actor_type\s*=\s*'user'/i)

    // Trigger-source preservation: autonomous + schedule must pass through.
    expect(sql).toMatch(/wr\.trigger_source\s+IN\s*\(\s*'schedule'\s*,\s*'autonomous'\s*\)/i)
    expect(sql).toMatch(/ELSE\s+'onDemand'/i)
  })

  it('respects maxBatches as a safety rail (100 × batchSize per sweep)', async () => {
    // 250 eligible rows, batch 5, maxBatches 3 → we should process exactly 15.
    for (let i = 0; i < 250; i++) {
      eligibleRuns.push({
        run_id: `uuid-${i}`,
        child_recipe_name: null,
        child_recipe_namespace: null,
      })
    }
    const gateway = makeGateway(async () => ({}))

    const total = await archiveTerminalRuns(gateway, { batchSize: 5, maxBatches: 3 })

    expect(total).toBe(15)
    // 235 rows still queued for the next sweep.
    expect(eligibleRuns.length).toBe(235)
  })
})
