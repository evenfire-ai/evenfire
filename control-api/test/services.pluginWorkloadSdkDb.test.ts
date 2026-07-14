import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  consumePeriodQuota,
  resolveRecipientProfiles,
} from '../src/services/pluginWorkloadSdkDb.js'

// Mock the pg pool so we can inspect the exact SQL + bind parameters that the
// real consumePeriodQuota produces (the quota-tracker test mocks
// consumePeriodQuota itself, so it never exercises this SQL/param path).
vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [{ prompt_bridge_count: 1 }], rowCount: 1 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

/** Highest $N placeholder referenced in a SQL string. */
function maxPlaceholder(sql: string): number {
  const matches = sql.match(/\$(\d+)/g) ?? []
  return matches.reduce((max, p) => Math.max(max, Number(p.slice(1))), 0)
}

describe('consumePeriodQuota — SQL bind parameter contract', () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockClear()
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ prompt_bridge_count: 1 }],
      rowCount: 1,
    } as never)
  })

  // Regression: a malformed bind array (more params than placeholders) makes
  // node-postgres throw "bind message supplies N parameters, but prepared
  // statement requires M", which silently breaks every quota consumption.
  it('binds exactly as many params as the SQL references (foldEagerUsage=false → no $6)', async () => {
    await consumePeriodQuota('ns', 'name', 'promptBridge', 3, new Date(0), false)
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).not.toContain('$6')
    expect(params).toHaveLength(maxPlaceholder(sql))
    expect(params).toHaveLength(5)
  })

  it('binds the eager period as $6 only when folding eager usage (foldEagerUsage=true)', async () => {
    await consumePeriodQuota(
      'ns',
      'name',
      'promptBridge',
      3,
      new Date('2026-06-10T12:00:00Z'),
      true
    )
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('$6')
    expect(params).toHaveLength(maxPlaceholder(sql))
    expect(params).toHaveLength(6)
  })
})

describe('resolveRecipientProfiles', () => {
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'

  beforeEach(() => {
    vi.mocked(pool.query).mockReset()
  })

  it('returns [] without querying when no ref is a UUID', async () => {
    const result = await resolveRecipientProfiles(['not-a-uuid', ''])
    expect(result).toEqual([])
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('resolves the email handle preserving input order and binds only the UUID refs', async () => {
    // EvenFire users are identified by email — the picker shows it. DB returns
    // rows out of order, so the resolver must re-order by input.
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        { id: U2, email: 'bob@clerum.io' },
        { id: U1, email: 'ada@clerum.io' },
      ],
      rowCount: 2,
    } as never)
    const result = await resolveRecipientProfiles([U1, U2])
    expect(result).toEqual([
      { userRef: U1, displayName: 'ada@clerum.io' },
      { userRef: U2, displayName: 'bob@clerum.io' },
    ])
    const [, params] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual([[U1, U2]])
  })

  it('drops a ref that no longer resolves to a user — never shows a bare UUID', async () => {
    // A deleted/unknown granted user has no row; it must be omitted, not echoed
    // as a UUID (the UUID is the internal id we never surface in the picker).
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: U1, email: 'ada@clerum.io' }],
      rowCount: 1,
    } as never)
    const result = await resolveRecipientProfiles([U1, U2])
    expect(result).toEqual([{ userRef: U1, displayName: 'ada@clerum.io' }])
  })

  it('drops a user row with a null email', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: U1, email: null }],
      rowCount: 1,
    } as never)
    const result = await resolveRecipientProfiles([U1])
    expect(result).toEqual([])
  })
})
