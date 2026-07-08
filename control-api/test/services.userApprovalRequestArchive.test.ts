import { beforeEach, describe, expect, it, vi } from 'vitest'
import { millisUntilNext02UTC } from '../src/services/userApprovalRequestArchiveCron.js'
import {
  archiveTerminalApprovals,
  countArchiveCandidates,
} from '../src/services/userApprovalRequestArchiveService.js'

/**
 * Tests for `userApprovalRequestArchiveService.archiveTerminalApprovals` +
 * `userApprovalRequestArchiveCron.millisUntilNext02UTC`.
 *
 * The service hits the DB via `withTransaction` (transactional SELECT FOR UPDATE
 * + INSERT INTO archive + INSERT typed-intent archive + DELETE FROM source).
 * We mock `withTransaction` so the callback runs against a fake `db.query`
 * that simulates a finite pool of archive-eligible rows drained in batches of N.
 */

type Row = { id: string }

const mockPoolQuery = vi.fn()

const eligibleRows: Row[] = []

const mockTransactionQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/SELECT id FROM workflow_approval_requests/i.test(text)) {
    const limit = Number(params?.[1] ?? 0)
    const batch = eligibleRows.splice(0, limit)
    return { rows: batch, rowCount: batch.length }
  }
  if (/INSERT INTO workflow_approval_requests_archive/i.test(text)) {
    const ids = (params?.[0] as string[]) ?? []
    return { rows: [], rowCount: ids.length }
  }
  if (/INSERT INTO workflow_approval_trigger_intents_archive/i.test(text)) {
    const ids = (params?.[0] as string[]) ?? []
    return { rows: [], rowCount: ids.length }
  }
  if (/DELETE FROM workflow_approval_requests WHERE id = ANY/i.test(text)) {
    const ids = (params?.[0] as string[]) ?? []
    return { rows: [], rowCount: ids.length }
  }
  return { rows: [], rowCount: 0 }
})

const mockWithTransaction = vi.fn(
  async (cb: (db: { query: typeof mockTransactionQuery }) => Promise<unknown>) => {
    return cb({ query: mockTransactionQuery })
  }
)

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: (cb: (db: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    mockWithTransaction(cb),
}))

describe('archiveTerminalApprovals', () => {
  beforeEach(() => {
    eligibleRows.length = 0
    mockTransactionQuery.mockClear()
    mockWithTransaction.mockClear()
    mockPoolQuery.mockReset()
  })

  it('archives zero rows when the eligible set is empty', async () => {
    const total = await archiveTerminalApprovals(180, 500)
    expect(total).toBe(0)
    // Only the SELECT should fire (one batch → 0 rows → loop exits).
    expect(mockTransactionQuery).toHaveBeenCalledTimes(1)
  })

  it('archives all eligible rows in a single batch when count <= batchSize', async () => {
    for (let i = 0; i < 50; i++) eligibleRows.push({ id: `id-${i}` })
    const total = await archiveTerminalApprovals(180, 500)
    expect(total).toBe(50)
    // One full cycle: SELECT → archive INSERT → intent archive INSERT → DELETE.
    // Then one more SELECT returning 0.
    const selectCalls = mockTransactionQuery.mock.calls.filter(([sql]) =>
      /SELECT id FROM workflow_approval_requests/i.test(String(sql))
    )
    const insertCalls = mockTransactionQuery.mock.calls.filter(([sql]) =>
      /INSERT INTO workflow_approval_requests_archive/i.test(String(sql))
    )
    const deleteCalls = mockTransactionQuery.mock.calls.filter(([sql]) =>
      /DELETE FROM workflow_approval_requests/i.test(String(sql))
    )
    const intentArchiveCalls = mockTransactionQuery.mock.calls.filter(([sql]) =>
      /INSERT INTO workflow_approval_trigger_intents_archive/i.test(String(sql))
    )
    expect(selectCalls.length).toBe(2)
    expect(insertCalls.length).toBe(1)
    expect(intentArchiveCalls.length).toBe(1)
    expect(deleteCalls.length).toBe(1)
  })

  it('copies typed trigger intent to the archive idempotently before deleting active rows', async () => {
    eligibleRows.push({ id: 'typed-intent-row' })

    await archiveTerminalApprovals(180, 500)

    const archiveInsertIndex = mockTransactionQuery.mock.calls.findIndex(([sql]) =>
      /INSERT INTO workflow_approval_requests_archive/i.test(String(sql))
    )
    const intentArchiveIndex = mockTransactionQuery.mock.calls.findIndex(([sql]) =>
      /INSERT INTO workflow_approval_trigger_intents_archive/i.test(String(sql))
    )
    const deleteIndex = mockTransactionQuery.mock.calls.findIndex(([sql]) =>
      /DELETE FROM workflow_approval_requests/i.test(String(sql))
    )

    expect(archiveInsertIndex).toBeGreaterThan(-1)
    expect(intentArchiveIndex).toBeGreaterThan(archiveInsertIndex)
    expect(deleteIndex).toBeGreaterThan(intentArchiveIndex)
    const intentArchiveSql = String(mockTransactionQuery.mock.calls[intentArchiveIndex]?.[0])
    expect(intentArchiveSql).toContain('ON CONFLICT (approval_request_id) DO NOTHING')
    expect(mockTransactionQuery.mock.calls[intentArchiveIndex]?.[1]).toEqual([['typed-intent-row']])
  })

  it('drains eligible rows across multiple batches', async () => {
    // 1200 rows, batch size 500 → 3 non-empty batches + 1 empty drain.
    for (let i = 0; i < 1200; i++) eligibleRows.push({ id: `id-${i}` })
    const total = await archiveTerminalApprovals(180, 500)
    expect(total).toBe(1200)
    const selectCalls = mockTransactionQuery.mock.calls.filter(([sql]) =>
      /SELECT id FROM workflow_approval_requests/i.test(String(sql))
    )
    expect(selectCalls.length).toBe(4) // 500 + 500 + 200 + 0
  })

  it('passes olderThanDays through to the SELECT as the first parameter', async () => {
    eligibleRows.push({ id: 'only-row' })
    await archiveTerminalApprovals(180, 500)
    const selectCall = mockTransactionQuery.mock.calls.find(([sql]) =>
      /SELECT id FROM workflow_approval_requests/i.test(String(sql))
    )
    expect(selectCall).toBeDefined()
    const params = selectCall?.[1] as unknown[]
    expect(params[0]).toBe(180)
    expect(params[1]).toBe(500)
  })

  it('uses 180-day default when olderThanDays is omitted', async () => {
    eligibleRows.push({ id: 'default-row' })
    await archiveTerminalApprovals()
    const selectCall = mockTransactionQuery.mock.calls.find(([sql]) =>
      /SELECT id FROM workflow_approval_requests/i.test(String(sql))
    )
    const params = selectCall?.[1] as unknown[]
    expect(params[0]).toBe(180)
  })

  it('propagates DB errors from the transaction up to the caller', async () => {
    mockTransactionQuery.mockRejectedValueOnce(new Error('deadlock detected'))
    await expect(archiveTerminalApprovals(180, 500)).rejects.toThrow('deadlock detected')
  })

  it('safety-bounds the loop at 100 batches (50k rows per run)', async () => {
    // 100 batches × 500 rows = 50,000 rows max per run.
    for (let i = 0; i < 51_000; i++) eligibleRows.push({ id: `id-${i}` })
    const total = await archiveTerminalApprovals(180, 500)
    // Exactly 100 batches * 500 rows = 50,000
    expect(total).toBe(50_000)
    // 1000 rows should still be waiting for the next run.
    expect(eligibleRows.length).toBe(1_000)
  })
})

describe('countArchiveCandidates', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('returns the COUNT from the eligibility query', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 42 }], rowCount: 1 })
    const n = await countArchiveCandidates(180)
    expect(n).toBe(42)
    const callArgs = mockPoolQuery.mock.calls[0]
    const params = callArgs[1] as unknown[]
    expect(params[0]).toBe(180)
  })
})

describe('millisUntilNext02UTC', () => {
  it('returns positive millis until the next 02:00 UTC boundary when now < 02:00', () => {
    const now = Date.UTC(2026, 3, 17, 1, 30, 0, 0) // 01:30 UTC
    const ms = millisUntilNext02UTC(now)
    expect(ms).toBe(30 * 60 * 1000) // 30 minutes
  })

  it('schedules tomorrow when now >= 02:00 UTC today', () => {
    const now = Date.UTC(2026, 3, 17, 10, 0, 0, 0) // 10:00 UTC
    const ms = millisUntilNext02UTC(now)
    // 24h - 10h + 2h = 16h
    expect(ms).toBe(16 * 60 * 60 * 1000)
  })

  it('schedules exactly at 2am today when now is well before 02:00', () => {
    const now = Date.UTC(2026, 3, 17, 0, 0, 0, 0) // midnight
    const ms = millisUntilNext02UTC(now)
    expect(ms).toBe(2 * 60 * 60 * 1000)
  })
})
