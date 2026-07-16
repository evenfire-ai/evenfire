import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpWakeGeneration } from '../src/services/hostWakeService.js'

/**
 * Unit tests for the Postgres-backed monotonic wake-generation counter
 * (src/services/hostWakeService.ts).
 *
 * The atomicity guarantee lives in the SINGLE SQL statement (INSERT ... ON
 * CONFLICT DO UPDATE ... RETURNING): Postgres serializes concurrent upserts
 * on the row lock, so the SQL-contract test pins the load-bearing clauses and
 * the concurrency test verifies the service is a pure pass-through of the
 * DB-returned generation (no read-modify-write in JS that could reorder or
 * duplicate values).
 */

const dbMock = vi.hoisted(() => ({
  pool: { query: vi.fn() },
}))

vi.mock('../src/db.js', () => dbMock)

describe('bumpWakeGeneration', () => {
  beforeEach(() => {
    dbMock.pool.query.mockReset()
  })

  it('issues a single atomic upsert with the load-bearing SQL clauses', async () => {
    dbMock.pool.query.mockResolvedValue({ rows: [{ generation: 1, should_project: true }] })

    await bumpWakeGeneration('chatllm', 2000)

    expect(dbMock.pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = dbMock.pool.query.mock.calls[0]
    // Atomic bump: one statement, monotonic increment, no SELECT-then-UPDATE.
    expect(sql).toContain('INSERT INTO host_wake_generations')
    expect(sql).toContain('ON CONFLICT (host_ref) DO UPDATE')
    expect(sql).toContain('generation = host_wake_generations.generation + 1')
    expect(sql).toContain('RETURNING generation')
    // Coalescence claim folded into the same statement.
    expect(sql).toContain('last_projected_at')
    expect(sql).toContain('should_project')
    expect(params).toEqual(['chatllm', 2000])
  })

  it('never reads the annotation or issues a separate SELECT (write-only projection source)', async () => {
    dbMock.pool.query.mockResolvedValue({ rows: [{ generation: 4, should_project: false }] })

    await bumpWakeGeneration('chatllm', 2000)

    // Exactly one round trip; the generation comes from RETURNING, never from
    // a prior read of the row or of the Host annotation.
    expect(dbMock.pool.query).toHaveBeenCalledTimes(1)
    expect(String(dbMock.pool.query.mock.calls[0][0]).trimStart().startsWith('INSERT')).toBe(true)
  })

  it('returns strictly increasing unique generations under parallel bumps', async () => {
    // Simulate the DB's row-lock serialization: each statement observes the
    // previous committed generation. The service must pass every value
    // through untouched.
    let generation = 0
    dbMock.pool.query.mockImplementation(async () => {
      generation += 1
      return { rows: [{ generation, should_project: generation === 1 }] }
    })

    const results = await Promise.all(
      Array.from({ length: 25 }, () => bumpWakeGeneration('chatllm', 2000))
    )

    const generations = results.map(r => r.generation)
    expect(new Set(generations).size).toBe(25)
    expect(Math.min(...generations)).toBe(1)
    expect(Math.max(...generations)).toBe(25)
    // Exactly one caller claimed the projection slot.
    expect(results.filter(r => r.shouldProject)).toHaveLength(1)
  })

  it('coerces BIGINT string generations to numbers and preserves shouldProject=false', async () => {
    dbMock.pool.query.mockResolvedValue({ rows: [{ generation: '12', should_project: false }] })

    const result = await bumpWakeGeneration('chatllm', 500)

    expect(result).toEqual({ generation: 12, shouldProject: false })
  })

  it('fails loud when the upsert returns no row', async () => {
    dbMock.pool.query.mockResolvedValue({ rows: [] })

    await expect(bumpWakeGeneration('chatllm', 2000)).rejects.toThrow(
      'host_wake_generations upsert returned no row for host chatllm'
    )
  })

  it('propagates DB errors instead of falling back', async () => {
    dbMock.pool.query.mockRejectedValue(new Error('connection refused'))

    await expect(bumpWakeGeneration('chatllm', 2000)).rejects.toThrow('connection refused')
  })

  it('rejects an empty hostRef before touching the DB', async () => {
    await expect(bumpWakeGeneration('', 2000)).rejects.toThrow('hostRef is required')
    expect(dbMock.pool.query).not.toHaveBeenCalled()
  })

  it('rejects a negative or non-finite coalescence window before touching the DB', async () => {
    await expect(bumpWakeGeneration('chatllm', -1)).rejects.toThrow(
      'coalesceWindowMs must be a non-negative number'
    )
    await expect(bumpWakeGeneration('chatllm', Number.NaN)).rejects.toThrow(
      'coalesceWindowMs must be a non-negative number'
    )
    expect(dbMock.pool.query).not.toHaveBeenCalled()
  })
})
