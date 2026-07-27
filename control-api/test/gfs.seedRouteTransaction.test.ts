import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSeed } from '../src/routes/gfs/seed.js'

const state = vi.hoisted(() => {
  const events: string[] = []
  const db = {
    query: vi.fn(async (text: string) => {
      if (text.includes('pg_advisory_xact_lock')) {
        events.push('advisory')
        return { rows: [] }
      }
      if (text.includes('ORDER BY resource_id FOR UPDATE')) {
        events.push('root-lock')
        return { rows: [] }
      }
      if (text.includes('INSERT INTO gfs_resources')) {
        events.push('insert')
        if (state.failInsert) throw new Error('insert_failed')
        return { rows: [{ resource_id: 'root-1' }] }
      }
      return { rows: [] }
    }),
  }
  return { db, events, failInsert: false }
})

vi.mock('../src/db.js', () => ({
  withTransaction: vi.fn(async (work: (db: typeof state.db) => Promise<unknown>) => {
    state.events.push('begin')
    try {
      const result = await work(state.db)
      state.events.push('commit')
      return result
    } catch (error) {
      state.events.push('rollback')
      throw error
    }
  }),
}))

vi.mock('../src/middleware/internalControlJwt.js', () => ({
  requireInternalControlJwt: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

function response() {
  return {
    code: 0,
    body: undefined as unknown,
    status(code: number) {
      this.code = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
}

describe('gfs seed route transaction boundary', () => {
  beforeEach(() => {
    state.events.length = 0
    state.failInsert = false
    state.db.query.mockClear()
  })

  it('uses one transaction client for lock and seed publication', async () => {
    const res = response()
    await handleSeed({ body: { drive: 'main', rootDirectories: [] } } as never, res as never)
    expect(res.code).toBe(200)
    expect(state.events).toEqual(['begin', 'advisory', 'root-lock', 'insert', 'commit'])
    expect(state.db.query).toHaveBeenCalledTimes(3)
  })

  it('rolls back when seed publication fails', async () => {
    state.failInsert = true
    const res = response()
    await expect(
      handleSeed({ body: { drive: 'main', rootDirectories: [] } } as never, res as never)
    ).rejects.toThrow('insert_failed')
    expect(state.events).toEqual(['begin', 'advisory', 'root-lock', 'insert', 'rollback'])
    expect(res.code).toBe(0)
  })
})
